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

/** Connects `createPtyClient` to `runPtyHost` and lets a test kill the "child". */
function connect() {
  const hostListeners: Listener[] = [];
  const childMessageListeners: Listener[] = [];
  const childExitListeners: Listener[] = [];

  // An error escaping a host listener is an uncaught exception in the utility
  // process: it dies, as it would for real.
  const hostErrors: unknown[] = [];
  const dieNow = (code = 1) => childExitListeners.forEach((l) => l(code));

  runPtyHost({
    on: (_event: 'message', listener: Listener) =>
      void hostListeners.push((...args: unknown[]) => {
        try {
          listener(...args);
        } catch (error) {
          hostErrors.push(error);
          dieNow();
        }
      }),
    postMessage: (message: unknown) => queueMicrotask(() => childMessageListeners.forEach((l) => l(message))),
  });

  const client = createPtyClient({
    postMessage: (message: unknown) => queueMicrotask(() => hostListeners.forEach((l) => l({ data: message }))),
    on: (event: 'message' | 'exit', listener: Listener) => {
      (event === 'message' ? childMessageListeners : childExitListeners).push(listener);
    },
  });

  const data = new Map<number, string>();
  const exits = new Map<number, PtyExit[]>();
  client.onData((id, chunk) => data.set(id, (data.get(id) ?? '') + chunk));
  client.onExit((id, exit) => exits.set(id, [...(exits.get(id) ?? []), exit]));

  return {
    client,
    output: (id: number) => data.get(id) ?? '',
    exitsOf: (id: number) => exits.get(id) ?? [],
    /** The utility process dies. */
    die: dieNow,
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

  test('AC5 — after the host died, spawn rejects with "pty host is not running"', async () => {
    const c = connect();
    c.die();

    await expect(c.client.spawn(shell)).rejects.toThrow('pty host is not running');
    await expect(c.client.spawn(shell)).rejects.toThrow('pty host is not running');
  });

  test('AC5 — a spawn still waiting for the host rejects when the host dies', async () => {
    const childExitListeners: Listener[] = [];
    // A child that never answers.
    const client = createPtyClient({
      postMessage: () => {},
      on: (event: 'message' | 'exit', listener: Listener) => {
        if (event === 'exit') childExitListeners.push(listener);
      },
    });

    const pending = client.spawn(shell);
    childExitListeners.forEach((l) => l(1));

    await expect(pending).rejects.toThrow();
  });

  test('AC5 — after the host died, write, resize and kill do nothing', async () => {
    const c = connect();
    const id = await c.client.spawn(shell);
    c.die();
    await until(() => c.exitsOf(id).length > 0, `the exit of session ${id}`);

    expect(() => {
      c.client.write(id, 'echo x\n');
      c.client.resize(id, 100, 30);
      c.client.kill(id);
    }).not.toThrow();
    await sleep(200);
    expect(c.exitsOf(id)).toHaveLength(1);
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
