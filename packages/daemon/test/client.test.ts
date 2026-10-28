import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { connectDaemon, daemonFiles, ensureDaemon, runDaemon } from '../src/index';
import { BUILD, collectUncaught, listenFake, listenSilent, makeHome, onCleanup, registerCleanup, startDaemon, UNAUTHORIZED, UPGRADED, until } from './helpers';

// `ensureDaemon` with a fake `spawn`: the child is whatever the test makes of it (a daemon
// started in this process, or a process that dies). A real detached Electron is the app tests'.

registerCleanup();

function fakeSpawn(home: string, behave: (child: EventEmitter) => void) {
  const calls: number[] = [];
  const spawn = () => {
    calls.push(calls.length);
    const child = new EventEmitter();
    behave(child);
    return child;
  };
  return { spawn, calls, home };
}

// A fake child that is a daemon started in this process; `daemons` collects the handles.
const startsDaemon = (home: string, daemons: Array<{ close(): Promise<void> }> = []) => () => {
  void runDaemon({ home, build: BUILD }).then((daemon) => {
    daemons.push(daemon);
    onCleanup(() => daemon.close());
  });
};

describe('ensureDaemon', () => {
  test('AC1 — with no daemon of the build it spawns one and returns a connected client; a second call reuses it without spawning', async () => {
    const home = makeHome();
    const fake = fakeSpawn(home, startsDaemon(home));

    const client = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    onCleanup(() => client.close());

    expect(fake.calls).toHaveLength(1);
    expect(await client.hello(BUILD)).toMatchObject({ protocol: 1, build: BUILD });

    const again = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    onCleanup(() => again.close());
    expect(fake.calls).toHaveLength(1);
    expect((await again.hello(BUILD)).pid).toBe((await client.hello(BUILD)).pid);
  });

  test('AC1 — with a daemon of the build already running it connects without spawning', async () => {
    const { home } = await startDaemon();
    const fake = fakeSpawn(home, () => {});

    const client = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    onCleanup(() => client.close());

    expect(fake.calls).toHaveLength(0);
  });

  test('AC10 — a child that exits before the daemon listens rejects with the last line of the log', async () => {
    const home = makeHome();
    mkdirSync(home, { recursive: true });
    const { log } = daemonFiles(home, 1, BUILD);
    const reason = `Error: listen EADDRINUSE: address already in use ${home}/daemon-1-${BUILD}.sock`;
    // The log is appended to: it holds the lines of an earlier run.
    writeFileSync(log, 'Error: an earlier run failed\n');
    const fake = fakeSpawn(home, (child) => {
      appendFileSync(log, `starting\n${reason}\n`);
      setTimeout(() => child.emit('exit', 1, null), 20);
    });

    const failure = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn }).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain(reason);
    expect(failure?.message).not.toContain('starting');
    expect(failure?.message).not.toContain('an earlier run');
  });
});

describe('a daemon that dies (AC12)', () => {
  test('AC12 — the client reports the close when the daemon goes away, and the next ensureDaemon starts a new one', async () => {
    const home = makeHome();
    const daemons: Array<{ close(): Promise<void> }> = [];
    const fake = fakeSpawn(home, startsDaemon(home, daemons));
    const client = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    let closed = false;
    client.onClose(() => (closed = true));
    await until(() => daemons.length === 1, 'the daemon handle');

    await daemons[0]!.close();

    await until(() => closed, 'onClose');
    const next = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    onCleanup(() => next.close());
    expect(fake.calls).toHaveLength(2);
    expect(await next.hello(BUILD)).toMatchObject({ protocol: 1, build: BUILD });
  });
});

// A daemon that exits before it listens: the reason comes from this run's output only (AC21).
describe('a daemon that exits before it listens (AC21)', () => {
  const failureOf = async (prepare: (log: string) => void, exit: [number | null, string | null]) => {
    const home = makeHome();
    mkdirSync(home, { recursive: true });
    const { log } = daemonFiles(home, 1, BUILD);
    prepare(log);
    const fake = fakeSpawn(home, (child) => void setTimeout(() => child.emit('exit', ...exit), 20));
    return ensureDaemon({ home, build: BUILD, spawn: fake.spawn }).then(
      () => undefined,
      (error: Error) => error.message,
    );
  };
  const earlier = (log: string) => writeFileSync(log, 'Error: listen EADDRINUSE from an earlier run\n');

  test('AC21 — a child that exits with a code and writes nothing: "the background service exited with code <n> before listening", never a line of the earlier run', async () => {
    expect(await failureOf(earlier, [7, null])).toBe('the background service exited with code 7 before listening');
  });

  test('AC21 — a child killed by a signal and writing nothing: "the background service was killed by <signal> before listening"', async () => {
    expect(await failureOf(earlier, [null, 'SIGKILL'])).toBe('the background service was killed by SIGKILL before listening');
  });

  test('AC21 — with no log file at all the reason is the exit code as well', async () => {
    expect(await failureOf(() => {}, [3, null])).toBe('the background service exited with code 3 before listening');
  });
});

// A daemon that does not answer (AC18) and one that answers 401 and goes (AC17), as fake servers.
describe('connectDaemon against a server that is not a daemon', () => {
  const fakeDaemon = () => {
    const home = makeHome();
    const files = daemonFiles(home, 1, BUILD);
    writeFileSync(files.token, 'a'.repeat(64));
    return { home, files };
  };

  test('AC18 — a socket that accepts and never answers: connectDaemon gives up after the timeout, with a reason naming the socket', async () => {
    const { files } = fakeDaemon();
    await listenSilent(files.socket);

    const failure = await connectDaemon(files.socket, { timeoutMs: 300 }).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toMatch(new RegExp(`^Cockpit's background service did not answer within [\\d.]+ s: ${files.socket}$`));
  }, 5_000);

  test('AC18 — hello that is never answered gives up after the timeout with the same reason', async () => {
    const { files } = fakeDaemon();
    await listenFake(files.socket, ({ socket }) => socket.write(UPGRADED));
    const client = await connectDaemon(files.socket, { timeoutMs: 300 });
    onCleanup(() => client.close());

    const failure = await client.hello(BUILD).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toMatch(new RegExp(`^Cockpit's background service did not answer within [\\d.]+ s: ${files.socket}$`));
  }, 5_000);

  test('AC18 — ensureDaemon on a socket that never answers rejects with that reason and starts no second daemon', async () => {
    const { home, files } = fakeDaemon();
    await listenSilent(files.socket);
    const fake = fakeSpawn(home, () => {});

    const failure = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn, timeoutMs: 300 }).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toMatch(new RegExp(`^Cockpit's background service did not answer within [\\d.]+ s: ${files.socket}$`));
    expect(fake.calls).toHaveLength(0);
  }, 5_000);

  test('AC17 — a server that answers 401 and destroys the connection: connectDaemon rejects with the 401 and nothing goes unhandled', async () => {
    const { files } = fakeDaemon();
    await listenFake(files.socket, ({ socket }) => {
      socket.write(UNAUTHORIZED);
      socket.destroy();
    });

    const { result, uncaught } = await collectUncaught(() =>
      connectDaemon(files.socket).then(
        () => undefined,
        (error: Error) => error,
      ),
    );

    expect(result?.message).toContain('401');
    expect(uncaught).toEqual([]);
  });

  test('AC17 — a server that destroys the connection at once: connectDaemon rejects and nothing goes unhandled', async () => {
    const { files } = fakeDaemon();
    await listenFake(files.socket, ({ socket }) => void socket.destroy());

    const { result, uncaught } = await collectUncaught(() =>
      connectDaemon(files.socket).then(
        () => undefined,
        (error: Error) => error,
      ),
    );

    expect(result).toBeInstanceOf(Error);
    expect(uncaught).toEqual([]);
  });

  test('AC19 — a 401 because the token was read before the winner wrote its own: connectDaemon reads the token again and connects', async () => {
    const { files } = fakeDaemon();
    writeFileSync(files.token, 'b'.repeat(64));
    const refused: Array<string | undefined> = [];
    await listenFake(files.socket, ({ socket, authorization }) => {
      if (authorization === `Bearer ${'a'.repeat(64)}`) return void socket.write(UPGRADED);
      refused.push(authorization);
      // The winner's token lands on disk right after.
      writeFileSync(files.token, 'a'.repeat(64));
      socket.end(UNAUTHORIZED);
    });

    const client = await connectDaemon(files.socket);
    onCleanup(() => client.close());

    expect(refused).toEqual([`Bearer ${'b'.repeat(64)}`]);
  });
});
