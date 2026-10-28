import { spawn as spawnProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect } from 'vitest';
import { connectDaemon, daemonFiles, runDaemon, type DaemonClient } from '../src/index';

// What the tests of this package assume of the API (the spec names the functions, not every
// signature). `../src/index` exports all of it.
//
// - `runDaemon({ home, build })` resolves once the daemon listens and its files are written, and
//   rejects with an Error whose message names the path at fault. It never calls `process.exit`:
//   its handle has `close()`, and a daemon that exits on its own (superseded, AC8) removes its
//   `.sock`, `.token` and `.pid` the same way (the entry exits the process).
// - `daemonFiles(home, protocol, build)` gives `{ socket, token, pid, log }`, absolute paths.
// - `connectDaemon(socketPath)` resolves a `DaemonClient`; the token is read from the `.token`
//   next to the socket. `DaemonClient`:
//     hello(build)            -> { protocol, build, pid }  (the daemon's; `build` is the client's)
//     spawn(options)          -> the terminal's id (an opaque value); rejects when refused
//     list()                  -> [{ id, kind, cwd, cols, rows, sessionId?, workspace?, status? }]
//     attach(id)              -> { cols, rows, screen, seq }
//     write(id, data), resize(id, cols, rows), kill(id)       (no answer awaited)
//     onData(({ id, seq, data }) => void), onExit(({ id, exitCode, signal }) => void),
//     onStatus(({ sessionId, event }) => void), onClose(() => void), close()
//   A client receives the data and exit events of the terminals it spawned or attached.
// - `spawn` options: { kind, command, args, cwd, env, cols, rows, sessionId?, workspace? }.

export const BUILD = 'aaaa1111';
export const OTHER_BUILD = 'bbbb2222';

export const shellOptions = {
  kind: 'shell' as const,
  command: '/bin/sh',
  args: [] as string[],
  cwd: homedir(),
  env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
};

const folders: string[] = [];
const closers: Array<() => Promise<unknown> | unknown> = [];

/** Registers the cleanup of everything the helpers made, after each test. */
export function registerCleanup(): void {
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => {});
    for (const folder of folders.splice(0)) {
      chmodSync(folder, 0o700);
      rmSync(folder, { recursive: true, force: true });
    }
  });
}

export const onCleanup = (close: () => Promise<unknown> | unknown) => void closers.push(close);

/** A short folder: macOS limits a socket path to 103 bytes. */
export function makeHome(): string {
  const folder = mkdtempSync(join(tmpdir(), 'ck-'));
  folders.push(folder);
  return folder;
}

export async function startDaemon(options: { home?: string; build?: string } = {}) {
  const home = options.home ?? makeHome();
  const build = options.build ?? BUILD;
  const daemon = await runDaemon({ home, build });
  onCleanup(() => daemon.close());
  return { home, build, daemon, files: daemonFiles(home, 1, build) };
}

export interface Connection {
  client: DaemonClient;
  data: Array<{ id: unknown; seq: number; data: string }>;
  exits: Array<{ id: unknown; exitCode: number | null; signal: number | null }>;
  statuses: Array<{ sessionId: string; event: string }>;
  closed: () => boolean;
  output: (id: unknown) => string;
}

export async function connectTo(socketPath: string, build = BUILD): Promise<Connection> {
  const client = await connectDaemon(socketPath);
  onCleanup(() => client.close());
  const connection: Connection = {
    client,
    data: [],
    exits: [],
    statuses: [],
    closed: () => closed,
    output: (id) =>
      connection.data
        .filter((chunk) => chunk.id === id)
        .map((chunk) => chunk.data)
        .join(''),
  };
  let closed = false;
  client.onData((event) => connection.data.push(event));
  client.onExit((event) => connection.exits.push(event));
  client.onStatus((event) => connection.statuses.push(event));
  client.onClose(() => (closed = true));
  await client.hello(build);
  return connection;
}

export async function until(condition: () => boolean | Promise<boolean>, what: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

export const waitForOutput = (connection: Connection, id: unknown, text: string, timeout?: number) =>
  until(() => connection.output(id).includes(text), `"${text}" in the output of terminal ${String(id)}`, timeout);

// eslint-disable-next-line no-control-regex
export const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>78]/g, '');

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const exists = (path: string) => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};

export interface Answer {
  status: number;
  text: string;
}

/**
 * One HTTP request over the socket. Settles with the answer, or rejects with the error that ended
 * the request before one came. A server that answers and closes before the body is written (a
 * `401`) makes the client's write fail (`EPIPE`, `ECONNRESET`): once there is an answer that error
 * is no news, and it never goes unhandled.
 */
export function send(
  socketPath: string,
  { method = 'POST', path = '/session-events', authorization, body, headers = {} }: { method?: string; path?: string; authorization?: string; body?: string | Buffer; headers?: Record<string, string> },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const all: Record<string, string> = { ...headers };
    if (authorization !== undefined) all.authorization = authorization;
    let answered = false;
    const req = httpRequest({ socketPath, method, path, headers: all, agent: false }, (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', () => {});
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (!answered) reject(error);
    });
    req.end(body);
  });
}

/** What a test of a server that closes early may see: the answer, or the error that came instead. */
export const sendOrError = (socketPath: string, options: Parameters<typeof send>[1]) =>
  send(socketPath, options).then(
    (answer) => ({ answer }),
    (error: NodeJS.ErrnoException) => ({ error }),
  );

/**
 * Runs `run`, then lets the event loop go on for a moment, and gives back what reached
 * `uncaughtException` or `unhandledRejection` meanwhile (vitest's own handlers are set aside so
 * the run does not report them: the test does, as an assertion).
 */
export async function collectUncaught<T>(run: () => Promise<T>): Promise<{ result: T; uncaught: unknown[] }> {
  const uncaught: unknown[] = [];
  const events: Array<'uncaughtException' | 'unhandledRejection'> = ['uncaughtException', 'unhandledRejection'];
  const emitter: NodeJS.EventEmitter = process;
  const saved = events.map((event) => [event, emitter.listeners(event) as Array<(...args: unknown[]) => void>] as const);
  for (const [event] of saved) emitter.removeAllListeners(event);
  const collect = (error: unknown) => void uncaught.push(error);
  for (const event of events) emitter.on(event, collect);
  try {
    const result = await run();
    await sleep(100);
    return { result, uncaught };
  } finally {
    for (const event of events) emitter.off(event, collect);
    for (const [event, listeners] of saved) for (const listener of listeners) emitter.on(event, listener);
  }
}

export interface FakeRequest {
  /** The `Authorization` header of the request. */
  authorization: string | undefined;
  socket: Socket;
}

/**
 * A server on `socketPath` that is not a daemon: it hands every request (the head, once it is
 * complete) to `onRequest`, which answers on the socket as the test wants. The connections are
 * destroyed with the test.
 */
export async function listenFake(socketPath: string, onRequest: (request: FakeRequest) => void): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (onRequest === NEVER) return;
    let head = '';
    socket.on('data', (chunk) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      const authorization = /^authorization: (.*)$/im.exec(head.slice(0, end))?.[1]?.trim();
      socket.removeAllListeners('data');
      onRequest({ authorization, socket });
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  onCleanup(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
}

const NEVER = (): void => {};
/** A server that accepts connections and never reads or answers, as a daemon stopped with SIGSTOP does. */
export const listenSilent = (socketPath: string) => listenFake(socketPath, NEVER);

export const UNAUTHORIZED = 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n';
export const UPGRADED = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: cockpit-1\r\n\r\n';

/** Leaves a socket nobody listens on, as a process killed with SIGKILL does. */
export async function leaveStaleSocket(socketPath: string): Promise<void> {
  const child = spawnProcess(
    process.execPath,
    ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('listening'))", socketPath],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  onCleanup(() => void child.kill('SIGKILL'));
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('listening') && resolve());
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  expect(statSync(socketPath).isSocket(), 'the stale socket is still there').toBe(true);
}
