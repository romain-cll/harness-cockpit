import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

// The compiled binary itself, run by Bun's runtime: `packages/daemon/test/cli.test.ts` checks
// `runCli` in process under Node, and the desktop tests only see a report that succeeds. Turbo
// builds `dist/cockpit` before `test`.

const BINARY = resolve(import.meta.dirname, '../dist/cockpit');
const USAGE_LINES = ['cockpit status <working|waiting|finished>', 'cockpit session-id', 'cockpit setup [--then <command> [args…]]', 'cockpit teardown'];
const TOKEN = 'a'.repeat(64);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

beforeAll(() => {
  if (!existsSync(BINARY)) throw new Error(`${BINARY} is missing: run bun run build in apps/cli first`);
});

/** A short folder: macOS limits a socket path to 103 bytes. */
function makeHome(): string {
  const folder = mkdtempSync(join(tmpdir(), 'ck-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

/** A socket that accepts connections and never answers; `connections` counts them. */
async function listenSilent(socketPath: string) {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => {});
  });
  await new Promise<void>((done) => server.listen(socketPath, done));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { connections: () => connections };
}

/** A daemon that records each request (`Authorization` header and body) and answers 204. */
async function listenRecording(socketPath: string) {
  const requests: Array<{ authorization: string | undefined; body: string }> = [];
  const server = createHttpServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization, body });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((done) => server.listen(socketPath, done));
  cleanups.push(() => void server.close());
  return { requests: () => requests };
}

// `input` is what a hook pipes to the binary's stdin; without it stdin stays open and unread, as before.
function run(args: string[], env: Record<string, string>, input?: string) {
  return new Promise<{ code: number | null; out: string; err: string; ms: number }>((done, fail) => {
    const started = Date.now();
    const child = spawn(BINARY, args, { env: { PATH: process.env.PATH ?? '', ...env } });
    if (input !== undefined) child.stdin.end(input);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', fail);
    child.on('close', (code) => done({ code, out, err, ms: Date.now() - started }));
  });
}

describe('cockpit status, the compiled binary', () => {
  test('no COCKPIT_SOCKET: exit 0 within 3 s and nothing on stdout or stderr', async () => {
    const result = await run(['status', 'working'], { COCKPIT_SESSION_ID: 'session-1' });

    expect(result).toMatchObject({ code: 0, out: '', err: '' });
    expect(result.ms).toBeLessThan(3_000);
  });

  test('a socket path with no listener: exit 0 within 3 s and nothing on stdout or stderr', async () => {
    const socket = join(makeHome(), 'daemon-1-aaaa1111.sock');
    writeFileSync(socket.replace(/\.sock$/, '.token'), TOKEN);

    const result = await run(['status', 'working'], { COCKPIT_SOCKET: socket, COCKPIT_SESSION_ID: 'session-1' });

    expect(result).toMatchObject({ code: 0, out: '', err: '' });
    expect(result.ms).toBeLessThan(3_000);
  });

  test('a daemon that accepts and never answers: exit 0 within 3 s and nothing on stdout or stderr', async () => {
    const socket = join(makeHome(), 'daemon-1-aaaa1111.sock');
    writeFileSync(socket.replace(/\.sock$/, '.token'), TOKEN);
    const server = await listenSilent(socket);

    const result = await run(['status', 'working'], { COCKPIT_SOCKET: socket, COCKPIT_SESSION_ID: 'session-1' });

    expect(server.connections()).toBe(1);
    expect(result).toMatchObject({ code: 0, out: '', err: '' });
    expect(result.ms).toBeLessThan(3_000);
  });

  test('AC12 — status working <extra>: the usage on stderr, exit 2, and no connection to the daemon', async () => {
    const socket = join(makeHome(), 'daemon-1-aaaa1111.sock');
    writeFileSync(socket.replace(/\.sock$/, '.token'), TOKEN);
    const server = await listenSilent(socket);

    const result = await run(['status', 'working', 'extra'], { COCKPIT_SOCKET: socket, COCKPIT_SESSION_ID: 'session-1' });

    expect(result).toMatchObject({ code: 2, out: '' });
    expect(result.err.startsWith('usage:')).toBe(true);
    for (const line of USAGE_LINES) expect(result.err).toContain(line);
    expect(server.connections()).toBe(0);
  });
});

// COCKPIT-30: Bun's `process.stdin` is what ships, so the stdin of a hook is read by the compiled binary once.
describe('cockpit session-id, the compiled binary', () => {
  const env = (socket: string) => ({ COCKPIT_SOCKET: socket, COCKPIT_SESSION_ID: 'session-1' });
  const socketIn = (home: string) => {
    const socket = join(home, 'daemon-1-aaaa1111.sock');
    writeFileSync(socket.replace(/\.sock$/, '.token'), TOKEN);
    return socket;
  };

  test.each([
    ['claude-code', (id: string) => JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'hello' })],
    ['codex', (id: string) => JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'hello' })],
    ['opencode', (id: string) => `${id}\n`],
  ])('AC1, AC5 — %s: the id read from stdin, an odd one byte for byte, is posted for the session with the token; exit 0 and nothing on stdout or stderr', async (harness, input) => {
    const socket = socketIn(makeHome());
    const daemon = await listenRecording(socket);

    const result = await run(['session-id', harness], env(socket), input('not/a:uuid é'));

    expect(result).toMatchObject({ code: 0, out: '', err: '' });
    expect(daemon.requests().map(({ authorization, body }) => ({ authorization, body: JSON.parse(body) as unknown }))).toEqual([
      { authorization: `Bearer ${TOKEN}`, body: { sessionId: 'session-1', event: 'harness-session', harnessSessionId: 'not/a:uuid é' } },
    ]);
  });

  test('AC6 — a stdin with no id: exit 0, nothing on stdout or stderr and nothing sent', async () => {
    const socket = socketIn(makeHome());
    const daemon = await listenRecording(socket);

    const result = await run(['session-id', 'claude-code'], env(socket), '{"hook_event_name":"UserPromptSubmit"}');

    expect(result).toMatchObject({ code: 0, out: '', err: '' });
    expect(daemon.requests()).toEqual([]);
  });

  test('AC6 — no COCKPIT_SOCKET: exit 0 within 3 s and nothing on stdout or stderr', async () => {
    const result = await run(['session-id', 'claude-code'], { COCKPIT_SESSION_ID: 'session-1' }, '{"session_id":"abc"}');

    expect(result).toMatchObject({ code: 0, out: '', err: '' });
    expect(result.ms).toBeLessThan(3_000);
  });

  test('AC6 — session-id with no argument: the usage on stderr, exit 2, and no connection to the daemon', async () => {
    const socket = socketIn(makeHome());
    const server = await listenSilent(socket);

    const result = await run(['session-id'], env(socket), '{"session_id":"abc"}');

    expect(result).toMatchObject({ code: 2, out: '' });
    expect(result.err.startsWith('usage:')).toBe(true);
    for (const line of USAGE_LINES) expect(result.err).toContain(line);
    expect(server.connections()).toBe(0);
  });
});

// COCKPIT-37 AC2: a command that needs the daemon starts it from the launch file the app wrote. The binary is what
// runs `child_process.spawn` with a fourth `stdio` pipe (the daemon's ready line) under Bun. The daemon is the real
// entry, run by the Bun that compiled the binary (it stands for the Electron binary that runs it in the app).
describe('cockpit project list, the compiled binary', () => {
  const BUN = resolve(import.meta.dirname, '../node_modules/.bin/bun');
  const DAEMON_SOURCE = resolve(import.meta.dirname, '../../../packages/daemon/src/index.ts');
  const BUILD = 'aaaa1111';

  test('AC2 — with the launch file the app wrote and no daemon running, the binary starts the daemon of its build (its .pid appears, it outlives the binary) and the command succeeds', async () => {
    const home = makeHome();
    const root = makeHome();
    const entry = join(root, 'daemon-entry.mjs');
    writeFileSync(entry, `import { reportReady, runDaemonEntry } from '${DAEMON_SOURCE}';\nvoid runDaemonEntry(process.argv, process.env, { stderr: process.stderr, exit: (code) => process.exit(code), ready: () => reportReady() });\n`);
    writeFileSync(join(home, 'daemon-launch.json'), JSON.stringify({ executable: BUN, bundle: entry, build: BUILD, stateDir: join(root, 'user-data'), cli: BINARY }));
    const pidFile = join(home, `daemon-1-${BUILD}.pid`);
    cleanups.push(() => {
      if (!existsSync(pidFile)) return;
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        // Already gone.
      }
    });
    expect(readdirSync(home).filter((name) => name.endsWith('.pid'))).toEqual([]);

    const result = await run(['project', 'list'], { COCKPIT_HOME: home, SHELL: '/bin/sh' });

    expect(result).toMatchObject({ code: 0, err: '' });
    expect(JSON.parse(result.out)).toEqual([]);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    // `run` settles once the binary has ended: the daemon, started detached, is still there.
    expect(() => process.kill(pid, 0)).not.toThrow();
  });
});
