import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

// The compiled binary itself, run by Bun's runtime: `packages/daemon/test/cli.test.ts` checks
// `runCli` in process under Node, and the desktop tests only see a report that succeeds. Turbo
// builds `dist/cockpit` before `test`.

const BINARY = resolve(import.meta.dirname, '../dist/cockpit');
const USAGE_LINES = ['cockpit status <working|waiting|finished>', 'cockpit setup [--then <command> [args…]]', 'cockpit teardown'];
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

function run(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string; err: string; ms: number }>((done, fail) => {
    const started = Date.now();
    const child = spawn(BINARY, args, { env: { PATH: process.env.PATH ?? '', ...env } });
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
