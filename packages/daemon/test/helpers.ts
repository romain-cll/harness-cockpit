import { spawn as spawnProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
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

export function send(
  socketPath: string,
  { method = 'POST', path = '/session-events', authorization, body, headers = {} }: { method?: string; path?: string; authorization?: string; body?: string; headers?: Record<string, string> },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const all: Record<string, string> = { ...headers };
    if (authorization !== undefined) all.authorization = authorization;
    const req = httpRequest({ socketPath, method, path, headers: all }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

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
