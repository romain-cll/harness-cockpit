import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SESSION_EVENTS, startControlServer } from '../src/index';

// Real sockets in short temporary folders: macOS limits a socket path to 103 bytes.

type Handler = (event: { sessionId: string; event: string }) => boolean;

const folders: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await Promise.resolve(close()).catch(() => {});
  for (const folder of folders.splice(0)) {
    chmodSync(folder, 0o700);
    rmSync(folder, { recursive: true, force: true });
  }
});

function makeFolder() {
  const folder = mkdtempSync(join(tmpdir(), 'ck-'));
  folders.push(folder);
  return folder;
}

async function start(onSessionEvent: Handler = () => true, dir = makeFolder()) {
  const server = await startControlServer({ dir, onSessionEvent });
  closers.push(() => server.close());
  return { dir, server, token: readFileSync(join(dir, 'control.token'), 'utf8') };
}

interface Answer {
  status: number;
  text: string;
}

function send(
  socketPath: string,
  { method = 'POST', path = '/session-events', authorization, body }: { method?: string; path?: string; authorization?: string; body?: string },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (authorization !== undefined) headers.authorization = authorization;
    const req = httpRequest({ socketPath, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// A process listens on the path and is killed with SIGKILL, so nothing unlinks the socket.
async function leaveStaleSocket(socketPath: string) {
  const child = spawn(
    process.execPath,
    ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('listening'))", socketPath],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  closers.push(() => void child.kill('SIGKILL'));
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('listening') && resolve());
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  expect(statSync(socketPath).isSocket(), 'the stale socket is still there').toBe(true);
}

const post = (socketPath: string, token: string, body: unknown) =>
  send(socketPath, { authorization: `Bearer ${token}`, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('files (AC1)', () => {
  test('AC1 — control.sock and control.token are created with mode 0600, the token being 64 lowercase hex characters and nothing else', async () => {
    const { dir, server, token } = await start();

    expect(server.socketPath).toBe(join(dir, 'control.sock'));
    expect(statSync(server.socketPath).isSocket()).toBe(true);
    expect(statSync(server.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'control.token')).isFile()).toBe(true);
    expect(statSync(join(dir, 'control.token')).mode & 0o777).toBe(0o600);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(dir).sort()).toEqual(['control.sock', 'control.token']);
  });

  test('AC1 — a second start on the same folder writes a different token', async () => {
    const first = await start();
    await first.server.close();
    const second = await start(undefined, first.dir);

    expect(second.token).toMatch(/^[0-9a-f]{64}$/);
    expect(second.token).not.toBe(first.token);
  });
});

describe('authentication (AC2)', () => {
  const wrongToken = 'a'.repeat(64);
  const headers: Array<[string, (token: string) => string | undefined]> = [
    ['no Authorization header', () => undefined],
    ['an empty one', () => ''],
    ['a Basic scheme', (token) => `Basic ${token}`],
    ['Bearer with no token', () => 'Bearer'],
    ['the token with no scheme', (token) => token],
    ['Bearer with a wrong token', () => `Bearer ${wrongToken}`],
    ['Bearer with a shorter token', (token) => `Bearer ${token.slice(0, 63)}`],
    ['Bearer with a longer token', (token) => `Bearer ${token}0`],
  ];

  test.each(headers)('AC2 — %s gets 401 with an empty body and the handler is not called, whatever the method, path or body', async (_label, header) => {
    const handler = vi.fn<Handler>(() => true);
    const { server, token } = await start(handler);
    const authorization = header(token);
    const valid = JSON.stringify({ sessionId: 's-1', event: 'working' });

    for (const attempt of [
      { method: 'POST', path: '/session-events', body: valid },
      { method: 'POST', path: '/session-events', body: 'not json' },
      { method: 'GET', path: '/session-events' },
      { method: 'POST', path: '/other', body: valid },
      { method: 'DELETE', path: '/' },
    ]) {
      const answer = await send(server.socketPath, { ...attempt, authorization });
      expect(answer, `${attempt.method} ${attempt.path}`).toEqual({ status: 401, text: '' });
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('POST /session-events (AC3, AC4, AC5)', () => {
  test.each(['working', 'waiting', 'finished'])('AC3 — event %s gets 204 with an empty body and the handler receives { sessionId, event }', async (event) => {
    expect([...SESSION_EVENTS].sort()).toEqual(['finished', 'waiting', 'working']);
    const handler = vi.fn<Handler>(() => true);
    const { server, token } = await start(handler);

    const answer = await post(server.socketPath, token, { sessionId: 'a1b2', event });

    expect(answer).toEqual({ status: 204, text: '' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ sessionId: 'a1b2', event });
  });

  test('AC4 — a session the handler does not know gets 404 { "error": "unknown session" }', async () => {
    const handler = vi.fn<Handler>(() => false);
    const { server, token } = await start(handler);

    const answer = await post(server.socketPath, token, { sessionId: 'nobody', event: 'working' });

    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.text)).toEqual({ error: 'unknown session' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ sessionId: 'nobody', event: 'working' });
  });

  test.each([
    ['not JSON', 'not json'],
    ['an empty body', ''],
    ['an array', '[]'],
    ['a string', '"working"'],
    ['null', 'null'],
    ['no sessionId', '{"event":"working"}'],
    ['a sessionId that is not a string', '{"sessionId":1,"event":"working"}'],
    ['no event', '{"sessionId":"a"}'],
    ['an event that is not one of the three', '{"sessionId":"a","event":"sleeping"}'],
    ['an event that is not a string', '{"sessionId":"a","event":1}'],
    ['another field', '{"sessionId":"a","event":"working","extra":true}'],
  ])('AC5 — %s gets 400 with an error reason and the handler is not called', async (_label, body) => {
    const handler = vi.fn<Handler>(() => true);
    const { server, token } = await start(handler);

    const answer = await post(server.socketPath, token, body);

    expect(answer.status).toBe(400);
    const parsed = JSON.parse(answer.text) as { error?: unknown };
    expect(typeof parsed.error).toBe('string');
    expect((parsed.error as string).length).toBeGreaterThan(0);
    expect(Object.keys(parsed)).toEqual(['error']);
    expect(handler).not.toHaveBeenCalled();
  });

  test('AC5 — a body above 64 KiB gets 413 and the connection is closed without reading the rest', async () => {
    const handler = vi.fn<Handler>(() => true);
    const { server, token } = await start(handler);

    // 66 KiB sent of a body that announces 10 MB: a server that waits for the whole body never answers.
    const outcome = await new Promise<{ head: string; closed: boolean }>((resolve) => {
      const socket = connect(server.socketPath);
      let received = '';
      let closed = false;
      const finish = () => resolve({ head: received, closed });
      const failsafe = setTimeout(finish, 5_000);
      socket.on('data', (chunk) => (received += chunk.toString('latin1')));
      // The server may reset the connection while the client still writes.
      socket.on('error', () => {});
      socket.on('close', () => {
        closed = true;
        clearTimeout(failsafe);
        finish();
      });
      socket.write(
        `POST /session-events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Length: 10000000\r\n\r\n`,
      );
      socket.write(Buffer.alloc(66 * 1024, 'a'));
    });

    expect(outcome.head.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 413\b/);
    expect(outcome.closed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('routing (AC6)', () => {
  test.each([
    ['GET', '/session-events'],
    ['PUT', '/session-events'],
    ['DELETE', '/session-events'],
    ['POST', '/other'],
    ['POST', '/'],
    ['GET', '/'],
  ])('AC6 — %s %s with the token gets 404 { "error": "not found" } and the handler is not called', async (method, path) => {
    const handler = vi.fn<Handler>(() => true);
    const { server, token } = await start(handler);

    const answer = await send(server.socketPath, {
      method,
      path,
      authorization: `Bearer ${token}`,
      body: method === 'POST' ? JSON.stringify({ sessionId: 'a', event: 'working' }) : undefined,
    });

    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.text)).toEqual({ error: 'not found' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('an existing path (AC7)', () => {
  test('AC7 — a stale socket (a killed process left it) is replaced, a new token is written and the endpoint listens', async () => {
    const dir = makeFolder();
    const socketPath = join(dir, 'control.sock');
    await leaveStaleSocket(socketPath);
    writeFileSync(join(dir, 'control.token'), 'old-token', { mode: 0o600 });

    const handler = vi.fn<Handler>(() => true);
    const { token } = await start(handler, dir);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, 'control.token')).mode & 0o777).toBe(0o600);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(await post(socketPath, token, { sessionId: 'a', event: 'working' })).toEqual({ status: 204, text: '' });
  });

  test('AC7 — a socket that accepts a connection (another Cockpit) makes the start reject with "another Cockpit holds <path>" and leaves the socket and the token untouched', async () => {
    const dir = makeFolder();
    const socketPath = join(dir, 'control.sock');
    const tokenPath = join(dir, 'control.token');
    const other: Server = createServer();
    await new Promise<void>((resolve) => other.listen(socketPath, resolve));
    closers.push(() => new Promise<void>((resolve) => other.close(() => resolve())));
    writeFileSync(tokenPath, 'f'.repeat(64), { mode: 0o600 });
    const before = { socket: statSync(socketPath).ino, mode: statSync(tokenPath).mode, token: readFileSync(tokenPath, 'utf8') };

    await expect(startControlServer({ dir, onSessionEvent: () => true })).rejects.toThrow(`another Cockpit holds ${socketPath}`);

    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(statSync(socketPath).ino).toBe(before.socket);
    expect(readFileSync(tokenPath, 'utf8')).toBe(before.token);
    expect(statSync(tokenPath).mode).toBe(before.mode);
    // The other app's socket still accepts connections.
    await new Promise<void>((resolve, reject) => {
      const probe = connect(socketPath, () => {
        probe.destroy();
        resolve();
      });
      probe.on('error', reject);
    });
  });

  test('AC7 — a regular file at the path makes the start reject and stays as it was', async () => {
    const dir = makeFolder();
    const socketPath = join(dir, 'control.sock');
    writeFileSync(socketPath, 'not a socket');

    await expect(startControlServer({ dir, onSessionEvent: () => true })).rejects.toThrow();

    expect(statSync(socketPath).isFile()).toBe(true);
    expect(readFileSync(socketPath, 'utf8')).toBe('not a socket');
    expect(existsSync(join(dir, 'control.token'))).toBe(false);
  });

  test('AC7 — a folder at the path makes the start reject and stays as it was', async () => {
    const dir = makeFolder();
    const socketPath = join(dir, 'control.sock');
    mkdirSync(socketPath);
    writeFileSync(join(socketPath, 'inside'), 'kept');

    await expect(startControlServer({ dir, onSessionEvent: () => true })).rejects.toThrow();

    expect(statSync(socketPath).isDirectory()).toBe(true);
    expect(readFileSync(join(socketPath, 'inside'), 'utf8')).toBe('kept');
    expect(existsSync(join(dir, 'control.token'))).toBe(false);
  });
});

describe('start failures (AC10)', () => {
  test('AC10 — a socket path longer than macOS allows makes the start reject', async () => {
    const parent = makeFolder();
    const dir = join(parent, 'x'.repeat(120));
    mkdirSync(dir);

    await expect(startControlServer({ dir, onSessionEvent: () => true })).rejects.toThrow();
  });

  test.skipIf(process.getuid?.() === 0)('AC10 — a folder that cannot be written makes the start reject', async () => {
    const dir = makeFolder();
    chmodSync(dir, 0o500);

    await expect(startControlServer({ dir, onSessionEvent: () => true })).rejects.toThrow();

    chmodSync(dir, 0o700);
    expect(readdirSync(dir)).toEqual([]);
  });

  // The unlink runs in the probe's error listener: a failure there must reject the start, not
  // escape as an uncaught exception that leaves the start pending (the app would open no window).
  test.skipIf(process.getuid?.() === 0)('AC10 — a stale socket that cannot be unlinked (read-only folder) makes the start reject', async () => {
    const dir = makeFolder();
    const socketPath = join(dir, 'control.sock');
    await leaveStaleSocket(socketPath);
    chmodSync(dir, 0o500);

    await expect(startControlServer({ dir, onSessionEvent: () => true })).rejects.toMatchObject({ code: 'EACCES' });

    chmodSync(dir, 0o700);
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(readdirSync(dir)).toEqual(['control.sock']);
  });
});

describe('Electron boundary (AC12)', () => {
  const srcDir = join(import.meta.dirname, '..', 'src');

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
    });
  }

  test('AC12 — no source imports or requires electron', () => {
    const files = sources(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const pattern = /(from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"`]electron(\/[^'"`]*)?['"`]/;
    for (const file of files) {
      expect(pattern.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });
});
