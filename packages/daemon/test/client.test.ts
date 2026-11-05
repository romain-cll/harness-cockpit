import { EventEmitter } from 'node:events';
import { appendFileSync, constants, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { connectDaemon, daemonFiles, ensureDaemon, reportReady, runDaemon } from '../src/index';
import { encode, lineReader } from '../src/protocol';
import { BUILD, collectUncaught, fifo, listenFake, listenSilent, makeHome, onCleanup, registerCleanup, startDaemon, UNAUTHORIZED, UPGRADED } from './helpers';

// `ensureDaemon` with a fake `spawn`: the child is whatever the test makes of it (a daemon
// started in this process, or a process that dies). A real detached Electron is the app tests'.

registerCleanup();

afterEach(() => void vi.useRealTimers());

// The child's readiness pipe (fd 3) is a `PassThrough`: what the test writes to it is the daemon's ready line.
function fakeSpawn(home: string, behave: (child: EventEmitter, ready: PassThrough) => void) {
  const calls: number[] = [];
  const spawn = () => {
    calls.push(calls.length);
    const ready = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, ready] });
    behave(child, ready);
    return child;
  };
  return { spawn, calls, home };
}

/** The line a daemon writes when it is ready, as `reportReady` writes it on a real pipe. */
async function readyLine(): Promise<string> {
  const pipe = fifo();
  reportReady(openSync(pipe.path, constants.O_WRONLY));
  return `${await pipe.line()}\n`;
}

// A fake child that is a daemon started in this process, and says it is ready once it listens; `daemons`
// collects the handles, as the promises `runDaemon` returns.
const startsDaemon = (home: string, daemons: Array<Promise<{ close(): Promise<void> }>> = []) => (_child: EventEmitter, ready: PassThrough) => {
  const started = runDaemon({ home, build: BUILD });
  daemons.push(started);
  void started.then((daemon) => onCleanup(() => daemon.close()));
  void Promise.all([started, readyLine()]).then(([, line]) => ready.write(line));
};

const TOKEN = 'a'.repeat(64);

/** A server that is a daemon as far as the client can see: the token, the upgrade and `hello`. `requests` collects one entry per connection that asked. */
function listenProtocol(socketPath: string, requests: Array<string | undefined>) {
  return listenFake(socketPath, ({ socket, authorization }) => {
    requests.push(authorization);
    if (authorization !== `Bearer ${TOKEN}`) return void socket.end(UNAUTHORIZED);
    socket.write(UPGRADED);
    socket.on(
      'data',
      lineReader((message) => {
        const { id, type } = message as { id: number; type: string };
        if (type === 'hello') socket.write(encode({ id, result: { protocol: 1, build: BUILD, pid: 4242 } }));
      }),
    );
  });
}

// The fake child exits once `ensureDaemon` has its `exit` listener (it adds it right after `spawn` returns).
const exitsLater = (child: EventEmitter, ...exit: [number | null, string | null]) => void setImmediate(() => child.emit('exit', ...exit));

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

  test('AC1 — a child that writes the ready line once a server listens with its token on disk: a client said hello to, one connection made after the spawn', async () => {
    const home = makeHome();
    const files = daemonFiles(home, 1, BUILD);
    const requests: Array<string | undefined> = [];
    const line = await readyLine();
    const fake = fakeSpawn(home, (_child, ready) => {
      writeFileSync(files.token, TOKEN);
      void listenProtocol(files.socket, requests).then(() => ready.write(line));
    });

    const client = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    onCleanup(() => client.close());

    expect(await client.hello(BUILD)).toMatchObject({ protocol: 1, build: BUILD, pid: 4242 });
    expect(fake.calls).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  // The server listens, with its token, from the spawn: the child is alive and never says it is ready.
  const neverReady = async (logged?: string) => {
    const home = makeHome();
    mkdirSync(home, { recursive: true });
    const files = daemonFiles(home, 1, BUILD);
    writeFileSync(files.log, 'Error: an earlier run failed\n');
    const requests: Array<string | undefined> = [];
    let listening!: () => void;
    const up = new Promise<void>((resolve) => (listening = resolve));
    const fake = fakeSpawn(home, () => {
      writeFileSync(files.token, TOKEN);
      if (logged) appendFileSync(files.log, logged);
      void listenProtocol(files.socket, requests).then(listening);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const failing = ensureDaemon({ home, build: BUILD, spawn: fake.spawn }).then(
      (client) => (client.close(), undefined),
      (error: Error) => error,
    );
    await up;
    vi.advanceTimersByTime(15_000);
    return { failure: await failing, requests };
  };

  test('AC2 — a child alive that never writes the ready line, with a server listening: after 15 s ensureDaemon rejects with the last line the log got since the spawn, and the server got no connection', async () => {
    const { failure, requests } = await neverReady('starting\nthe background service is stuck\n');

    expect(failure?.message).toBe('the background service is stuck');
    expect(requests).toEqual([]);
  });

  test('AC2 — the log got nothing since the spawn: the rejection says the background service did not start within 15 s', async () => {
    const { failure, requests } = await neverReady();

    expect(failure?.message).toBe('the background service did not start within 15 s');
    expect(requests).toEqual([]);
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
      exitsLater(child, 1, null);
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
    const daemons: Array<Promise<{ close(): Promise<void> }>> = [];
    const fake = fakeSpawn(home, startsDaemon(home, daemons));
    const client = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    const closed = new Promise<void>((resolve) => client.onClose(resolve));
    const daemon = await daemons[0]!;

    await daemon.close();

    await closed;
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
    const fake = fakeSpawn(home, (child) => exitsLater(child, ...exit));
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

describe('a child that exits without the ready line while a daemon of the build answers (AC6)', () => {
  test('AC6 — ensureDaemon resolves a client connected to that daemon', async () => {
    const home = makeHome();
    const fake = fakeSpawn(home, (child) => {
      void runDaemon({ home, build: BUILD }).then((daemon) => {
        onCleanup(() => daemon.close());
        child.emit('exit', 1, null);
      });
    });

    const client = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    onCleanup(() => client.close());

    expect(await client.hello(BUILD)).toMatchObject({ protocol: 1, build: BUILD, pid: process.pid });
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

  // Only the product's timer is the test's clock (it runs when the daemon is known to be listening and
  // silent, so a slow machine cannot expire it early); sockets and files stay real.
  const advanceOnceSilent = async (arrived: Promise<void>, ms: number) => {
    await arrived;
    vi.advanceTimersByTime(ms);
  };

  test('AC18 — a socket that accepts and never answers: connectDaemon gives up after the timeout, with a reason naming the socket', async () => {
    const { files } = fakeDaemon();
    const { connected } = await listenSilent(files.socket);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const failing = connectDaemon(files.socket, { timeoutMs: 300 }).then(
      () => undefined,
      (error: Error) => error,
    );
    await advanceOnceSilent(connected, 300);
    const failure = await failing;

    expect(failure?.message).toMatch(new RegExp(`^Cockpit's background service did not answer within [\\d.]+ s: ${files.socket}$`));
  }, 5_000);

  test('AC18 — hello that is never answered gives up after the timeout with the same reason', async () => {
    const { files } = fakeDaemon();
    let helloSent!: () => void;
    const hello = new Promise<void>((resolve) => (helloSent = resolve));
    await listenFake(files.socket, ({ socket }) => {
      // The next bytes on the connection are the client's hello.
      socket.once('data', () => helloSent());
      socket.write(UPGRADED);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const client = await connectDaemon(files.socket, { timeoutMs: 300 });
    onCleanup(() => client.close());

    const failing = client.hello(BUILD).then(
      () => undefined,
      (error: Error) => error,
    );
    await advanceOnceSilent(hello, 300);
    const failure = await failing;

    expect(failure?.message).toMatch(new RegExp(`^Cockpit's background service did not answer within [\\d.]+ s: ${files.socket}$`));
  }, 5_000);

  test('AC18 — ensureDaemon on a socket that never answers rejects with that reason and starts no second daemon', async () => {
    const { home, files } = fakeDaemon();
    const { connected } = await listenSilent(files.socket);
    const fake = fakeSpawn(home, () => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const failing = ensureDaemon({ home, build: BUILD, spawn: fake.spawn, timeoutMs: 300 }).then(
      () => undefined,
      (error: Error) => error,
    );
    await advanceOnceSilent(connected, 300);
    const failure = await failing;

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

  test('AC3 — a socket that answers 401: connectDaemon rejects with the refusal after exactly one request, the token read once', async () => {
    const { files } = fakeDaemon();
    const refused: Array<string | undefined> = [];
    await listenFake(files.socket, ({ socket, authorization }) => {
      refused.push(authorization);
      // A second read of the token would find this one.
      writeFileSync(files.token, 'b'.repeat(64));
      socket.end(UNAUTHORIZED);
    });

    const failure = await connectDaemon(files.socket).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toBe('the background service refused the connection (HTTP 401)');
    expect(refused).toEqual([`Bearer ${'a'.repeat(64)}`]);
  });
});
