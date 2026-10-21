import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import { createPtyClient, type PtyExit, type PtySpawnOptions } from '../src/client';
import { runPtyHost } from '../src/host';

// Wires the host and the client through an in-memory pair of fake ports, with
// the real node-pty: no Electron, plain Node.

const shell: PtySpawnOptions = {
  command: '/bin/sh',
  args: [],
  cwd: homedir(),
  env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
};

type Listener = (...args: any[]) => void;

/**
 * Connects `createPtyClient` to `runPtyHost` and lets a test kill the "child".
 * The client gets a fork function (as in the app): each call starts a new fake
 * host, and the test sees how many were started.
 */
function connect() {
  interface FakeHost {
    /** What the host sends to the client, as if the utility process posted it. */
    emit(message: unknown): void;
    /** This host's utility process exits. */
    exit(code?: number): void;
  }
  const hosts: FakeHost[] = [];

  // An error escaping a host listener is an uncaught exception in the utility
  // process: it dies, as it would for real.
  const hostErrors: unknown[] = [];

  const fork = () => {
    const hostListeners: Listener[] = [];
    const childMessageListeners: Listener[] = [];
    const childExitListeners: Listener[] = [];
    const exit = (code = 1) => childExitListeners.forEach((l) => l(code));

    runPtyHost({
      on: (_event: 'message', listener: Listener) =>
        void hostListeners.push((...args: unknown[]) => {
          try {
            listener(...args);
          } catch (error) {
            hostErrors.push(error);
            exit();
          }
        }),
      postMessage: (message: unknown) => queueMicrotask(() => childMessageListeners.forEach((l) => l(message))),
    });

    hosts.push({ emit: (message) => childMessageListeners.forEach((l) => l(message)), exit });
    return {
      postMessage: (message: unknown) => queueMicrotask(() => hostListeners.forEach((l) => l({ data: message }))),
      on: (event: 'message' | 'exit', listener: Listener) => {
        (event === 'message' ? childMessageListeners : childExitListeners).push(listener);
      },
    };
  };

  const client = createPtyClient(fork);

  const data = new Map<number, string>();
  const exits = new Map<number, PtyExit[]>();
  client.onData((id, chunk) => data.set(id, (data.get(id) ?? '') + chunk));
  client.onExit((id, exit) => exits.set(id, [...(exits.get(id) ?? []), exit]));

  return {
    client,
    output: (id: number) => data.get(id) ?? '',
    exitsOf: (id: number) => exits.get(id) ?? [],
    /** The current utility process dies. */
    die: () => hosts.at(-1)!.exit(),
    /** Every host the client started, oldest first. */
    hosts,
    /** Errors that escaped the host's message listener (each one kills the host). */
    hostErrors,
  };
}

type Connection = ReturnType<typeof connect>;

async function until(condition: () => boolean, what: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

const waitForOutput = (c: Connection, id: number, text: string) =>
  until(() => c.output(id).includes(text), `"${text}" in the output of session ${id}`);

describe('pty host and client', () => {
  test('AC1 — spawn resolves to a numeric id and onData delivers the shell output for that id', async () => {
    const c = connect();
    const id = await c.client.spawn(shell);
    expect(typeof id).toBe('number');

    c.client.write(id, 'echo cockpit-$((6*7))\n');
    await waitForOutput(c, id, 'cockpit-42');

    c.client.kill(id);
  });

  test('AC1 — gives each session its own id and keeps their output apart', async () => {
    const c = connect();
    const first = await c.client.spawn(shell);
    const second = await c.client.spawn(shell);
    expect(second).not.toBe(first);

    c.client.write(first, 'echo only-$((1+1))-first\n');
    c.client.write(second, 'echo only-$((2+2))-second\n');
    await waitForOutput(c, first, 'only-2-first');
    await waitForOutput(c, second, 'only-4-second');
    expect(c.output(first)).not.toContain('only-4-second');
    expect(c.output(second)).not.toContain('only-2-first');

    c.client.kill(first);
    c.client.kill(second);
  });

  test('AC2 — resize changes the size the shell sees', async () => {
    const c = connect();
    const id = await c.client.spawn(shell);

    c.client.resize(id, 100, 30);
    c.client.write(id, 'stty size\n');
    await waitForOutput(c, id, '30 100');

    c.client.kill(id);
  });

  test('AC3 — kill fires onExit exactly once, and later calls on the id do nothing', async () => {
    const c = connect();
    const id = await c.client.spawn(shell);

    c.client.kill(id);
    await until(() => c.exitsOf(id).length > 0, `the exit of session ${id}`);

    expect(() => {
      c.client.write(id, 'echo late\n');
      c.client.resize(id, 120, 40);
      c.client.kill(id);
    }).not.toThrow();

    await sleep(500);
    expect(c.exitsOf(id)).toHaveLength(1);
    expect(c.output(id)).not.toContain('late\r\n');
  });

  test('AC3 — an id that was never spawned is ignored', async () => {
    const c = connect();
    expect(() => {
      c.client.write(9999, 'x');
      c.client.resize(9999, 10, 10);
      c.client.kill(9999);
    }).not.toThrow();
    await sleep(100);
    expect(c.exitsOf(9999)).toEqual([]);
  });

  test('AC4 — when the host dies, every open session exits with a null exit code', async () => {
    const c = connect();
    const first = await c.client.spawn(shell);
    const second = await c.client.spawn(shell);

    c.die();

    await until(() => c.exitsOf(first).length > 0 && c.exitsOf(second).length > 0, 'both sessions to exit');
    expect(c.exitsOf(first)).toEqual([{ exitCode: null, signal: null }]);
    expect(c.exitsOf(second)).toEqual([{ exitCode: null, signal: null }]);
  });

  test('AC4 — a session that already ended is not reported again when the host dies', async () => {
    const c = connect();
    const id = await c.client.spawn(shell);
    c.client.kill(id);
    await until(() => c.exitsOf(id).length > 0, `the exit of session ${id}`);

    c.die();

    await sleep(300);
    expect(c.exitsOf(id)).toHaveLength(1);
  });

  test('COCKPIT-24 AC9 — the client forks the host at creation, once, and not again while it runs', async () => {
    const c = connect();
    expect(c.hosts).toHaveLength(1);

    const first = await c.client.spawn(shell);
    const second = await c.client.spawn(shell);
    expect(c.hosts).toHaveLength(1);

    c.client.kill(first);
    c.client.kill(second);
  });

  test('COCKPIT-24 AC9 — after the host died, spawn forks a new host and resolves with an id no earlier session used', async () => {
    const c = connect();
    const first = await c.client.spawn(shell);
    const second = await c.client.spawn(shell);
    c.die();
    await until(() => c.exitsOf(first).length > 0 && c.exitsOf(second).length > 0, 'both sessions to exit');

    const third = await c.client.spawn(shell);
    expect(c.hosts).toHaveLength(2);
    expect([first, second]).not.toContain(third);
    expect(third).toBeGreaterThan(Math.max(first, second));

    c.client.write(third, 'echo cockpit-$((6*7))\n');
    await waitForOutput(c, third, 'cockpit-42');

    // Ids keep counting across hosts, more than once.
    c.die();
    await until(() => c.exitsOf(third).length > 0, `the exit of session ${third}`);
    const fourth = await c.client.spawn(shell);
    expect(fourth).toBeGreaterThan(third);
    expect(c.hosts).toHaveLength(3);

    c.client.kill(fourth);
  });

  test('COCKPIT-24 AC8 — spawns issued together after the host died share one new host', async () => {
    const c = connect();
    c.die();

    const ids = await Promise.all([c.client.spawn(shell), c.client.spawn(shell)]);

    expect(new Set(ids).size).toBe(2);
    expect(c.hosts).toHaveLength(2);
    ids.forEach((id) => c.client.kill(id));
  });

  test('COCKPIT-24 AC9 — write, resize and kill on an id of the dead host do nothing to the new sessions', async () => {
    const c = connect();
    const old = await c.client.spawn(shell);
    c.die();
    await until(() => c.exitsOf(old).length > 0, `the exit of session ${old}`);
    const fresh = await c.client.spawn(shell);

    expect(() => {
      c.client.write(old, 'echo from-old-id\n');
      c.client.resize(old, 100, 30);
      c.client.kill(old);
    }).not.toThrow();
    await sleep(300);

    expect(c.exitsOf(fresh)).toEqual([]);
    expect(c.output(fresh)).not.toContain('from-old-id');
    expect(c.exitsOf(old)).toHaveLength(1);

    // The new session still has its own size and still answers.
    c.client.write(fresh, 'stty size\n');
    await waitForOutput(c, fresh, '24 80');

    c.client.kill(fresh);
  });

  test('COCKPIT-24 AC9 — what the dead host still sends, or a second exit of it, is ignored once a new host runs', async () => {
    const c = connect();
    const old = await c.client.spawn(shell);
    c.die();
    await until(() => c.exitsOf(old).length > 0, `the exit of session ${old}`);
    const fresh = await c.client.spawn(shell);
    expect(c.hosts).toHaveLength(2);

    // The old process says something late, and exits again.
    c.hosts[0]!.emit({ type: 'data', id: old, data: 'late-from-old-host' });
    c.hosts[0]!.emit({ type: 'exit', id: old, exitCode: 0, signal: null });
    c.hosts[0]!.exit();
    await sleep(300);

    expect(c.output(old)).not.toContain('late-from-old-host');
    expect(c.exitsOf(old)).toHaveLength(1);
    // The new host is not taken for dead: its session lives and spawn does not fork a third host.
    expect(c.exitsOf(fresh)).toEqual([]);
    const another = await c.client.spawn(shell);
    expect(c.hosts).toHaveLength(2);
    c.client.write(another, 'echo still-$((3*3))\n');
    await waitForOutput(c, another, 'still-9');

    c.client.kill(fresh);
    c.client.kill(another);
  });

  test('COCKPIT-24 AC8 — a session that ended stays ended when the new host dies in turn', async () => {
    const c = connect();
    const old = await c.client.spawn(shell);
    c.die();
    await until(() => c.exitsOf(old).length > 0, `the exit of session ${old}`);
    const fresh = await c.client.spawn(shell);

    c.die();
    await until(() => c.exitsOf(fresh).length > 0, `the exit of session ${fresh}`);
    await sleep(200);

    expect(c.exitsOf(old)).toEqual([{ exitCode: null, signal: null }]);
    expect(c.exitsOf(fresh)).toEqual([{ exitCode: null, signal: null }]);
  });

  test('COCKPIT-24 AC9 — a spawn still waiting for the host rejects when the host dies, and the next spawn gets a new host', async () => {
    const childExitListeners: Listener[] = [];
    let forks = 0;
    // A child that never answers.
    const client = createPtyClient(() => {
      forks++;
      return {
        postMessage: () => {},
        on: (event: 'message' | 'exit', listener: Listener) => {
          if (event === 'exit') childExitListeners.push(listener);
        },
      };
    });

    const pending = client.spawn(shell);
    childExitListeners.forEach((l) => l(1));
    await expect(pending).rejects.toThrow();

    void client.spawn(shell).catch(() => {});
    expect(forks).toBe(2);
  });

  test('AC3b — resize with a zero or NaN size is ignored and the host keeps running', async () => {
    const c = connect();
    const target = await c.client.spawn(shell);
    const other = await c.client.spawn(shell);

    c.client.resize(target, 0, 0);
    c.client.resize(target, Number.NaN, Number.NaN);
    c.client.resize(target, -5, 30);
    c.client.resize(target, Number.POSITIVE_INFINITY, 30);
    await sleep(300);

    expect(c.hostErrors).toEqual([]);
    expect(c.exitsOf(other)).toEqual([]);
    expect(c.exitsOf(target)).toEqual([]);

    // The target still works, with its size unchanged.
    c.client.write(target, 'stty size\n');
    await waitForOutput(c, target, '24 80');
    expect(await c.client.spawn(shell)).toBeTypeOf('number');

    c.client.kill(target);
    c.client.kill(other);
  });

  test('AC3b — write, resize and kill right after kill, before its exit, leave the host running', async () => {
    const c = connect();
    const other = await c.client.spawn(shell);

    for (let i = 0; i < 5; i++) {
      const target = await c.client.spawn(shell);
      // All sent in the same tick: the host handles them before the exit arrives.
      c.client.kill(target);
      c.client.write(target, 'echo late\n');
      c.client.resize(target, 100, 30);
      c.client.resize(target, 0, 0);
      c.client.kill(target);
      await until(() => c.exitsOf(target).length > 0, `the exit of session ${target}`);
    }
    await sleep(300);

    expect(c.hostErrors).toEqual([]);
    expect(c.exitsOf(other)).toEqual([]);

    c.client.write(other, 'echo still-$((3*3))\n');
    await waitForOutput(c, other, 'still-9');
    expect(await c.client.spawn(shell)).toBeTypeOf('number');

    c.client.kill(other);
  });
});
