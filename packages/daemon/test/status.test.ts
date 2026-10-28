import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { describe, expect, test } from 'vitest';
import { daemonFiles, SESSION_EVENTS, statusCommand } from '../src/index';
import { collectUncaught, connectTo, listenFake, makeHome, registerCleanup, send, sendOrError, shellOptions, startDaemon, UNAUTHORIZED, until } from './helpers';

// The session-events endpoint of the daemon (the control endpoint's rules, moved) and the
// shell line a harness hook runs against it.

registerCleanup();

async function start() {
  const daemon = await startDaemon();
  const connection = await connectTo(daemon.files.socket);
  const sessionId = 'session-1';
  await connection.client.spawn({ ...shellOptions, kind: 'session', sessionId });
  return { ...daemon, connection, sessionId, token: readFileSync(daemon.files.token, 'utf8') };
}

const post = (socket: string, token: string, body: unknown) =>
  send(socket, { authorization: `Bearer ${token}`, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('POST /session-events', () => {
  test.each(['working', 'waiting', 'finished'])('AC13 — event %s for a session of the daemon gets 204, reaches the client and shows as the last status in list', async (event) => {
    expect([...SESSION_EVENTS].sort()).toEqual(['finished', 'waiting', 'working']);
    const { files, token, connection, sessionId } = await start();

    expect(await post(files.socket, token, { sessionId, event })).toEqual({ status: 204, text: '' });

    await until(() => connection.statuses.length === 1, 'the status event');
    expect(connection.statuses).toEqual([{ sessionId, event }]);
    expect((await connection.client.list()).find((entry) => entry.sessionId === sessionId)?.status).toBe(event);
  });

  test('AC13 — an id that is not a session of the daemon gets 404 { "error": "unknown session" } and no event', async () => {
    const { files, token, connection } = await start();

    const answer = await post(files.socket, token, { sessionId: 'nobody', event: 'working' });

    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.text)).toEqual({ error: 'unknown session' });
    expect(connection.statuses).toEqual([]);
  });

  test.each([
    ['not JSON', 'not json'],
    ['an empty body', ''],
    ['an array', '[]'],
    ['no sessionId', '{"event":"working"}'],
    ['an event that is not one of the three', '{"sessionId":"session-1","event":"sleeping"}'],
    ['another field', '{"sessionId":"session-1","event":"working","extra":true}'],
  ])('AC13 — %s gets 400 with an error reason and no event', async (_label, body) => {
    const { files, token, connection } = await start();

    const answer = await post(files.socket, token, body);

    expect(answer.status).toBe(400);
    const parsed = JSON.parse(answer.text) as { error?: unknown };
    expect(Object.keys(parsed)).toEqual(['error']);
    expect(typeof parsed.error).toBe('string');
    expect(connection.statuses).toEqual([]);
  });

  test('AC13 — a body above 64 KiB gets 413 and the connection is closed without reading the rest', async () => {
    const { files, token } = await start();

    const outcome = await new Promise<{ head: string; closed: boolean }>((resolve) => {
      const socket = connect(files.socket);
      let received = '';
      let closed = false;
      const finish = () => resolve({ head: received, closed });
      const failsafe = setTimeout(finish, 5_000);
      socket.on('data', (chunk) => (received += chunk.toString('latin1')));
      socket.on('error', () => {});
      socket.on('close', () => {
        closed = true;
        clearTimeout(failsafe);
        finish();
      });
      socket.write(`POST /session-events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Length: 10000000\r\n\r\n`);
      socket.write(Buffer.alloc(66 * 1024, 'a'));
    });

    expect(outcome.head.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 413\b/);
    expect(outcome.closed).toBe(true);
  });

  test.each([
    ['GET', '/session-events'],
    ['POST', '/other'],
    ['GET', '/'],
  ])('AC13 — %s %s with the token gets 404 { "error": "not found" }', async (method, path) => {
    const { files, token } = await start();

    const answer = await send(files.socket, { method, path, authorization: `Bearer ${token}`, body: method === 'POST' ? '{}' : undefined });

    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.text)).toEqual({ error: 'not found' });
  });

  test.each([
    ['no Authorization header', () => undefined],
    ['a Basic scheme', (token: string) => `Basic ${token}`],
    ['the token with no scheme', (token: string) => token],
    ['a wrong token', () => `Bearer ${'a'.repeat(64)}`],
    ['a longer token', (token: string) => `Bearer ${token}0`],
  ])('AC13, AC14 — %s gets 401 with an empty body whatever the method, path or body, and no event', async (_label, header) => {
    const { files, token, connection, sessionId } = await start();
    const authorization = header(token);
    const valid = JSON.stringify({ sessionId, event: 'working' });

    for (const attempt of [
      { method: 'POST', path: '/session-events', body: valid },
      { method: 'GET', path: '/session-events' },
      { method: 'GET', path: '/attach' },
      { method: 'DELETE', path: '/' },
    ]) {
      expect(await send(files.socket, { ...attempt, authorization }), `${attempt.method} ${attempt.path}`).toEqual({ status: 401, text: '' });
    }
    // A body big enough that the daemon may answer, and close, before it is written (AC17): the
    // answer, or the write error that came instead, and nothing unhandled.
    const { result, uncaught } = await collectUncaught(() => sendOrError(files.socket, { authorization, body: Buffer.alloc(8 * 1024 * 1024, 'x') }));
    if ('answer' in result) expect(result.answer).toEqual({ status: 401, text: '' });
    else expect(['EPIPE', 'ECONNRESET']).toContain(result.error.code);
    expect(uncaught).toEqual([]);
    expect(connection.statuses).toEqual([]);
  });
});

describe('a server that answers 401 and closes before the body is written (AC17)', () => {
  test('AC17 — the request settles with the 401 or the write error, again and again, and no EPIPE or ECONNRESET goes unhandled', async () => {
    const home = makeHome();
    const { socket } = daemonFiles(home, 1, 'aaaa1111');
    await listenFake(socket, ({ socket: connection }) => {
      connection.write(UNAUTHORIZED);
      connection.destroy();
    });

    const { result, uncaught } = await collectUncaught(async () => {
      const outcomes = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        outcomes.push(await sendOrError(socket, { authorization: 'Bearer wrong', body: Buffer.alloc(8 * 1024 * 1024, 'x') }));
      }
      return outcomes;
    });

    for (const outcome of result) {
      if ('answer' in outcome) expect(outcome.answer).toEqual({ status: 401, text: '' });
      else expect(['EPIPE', 'ECONNRESET']).toContain(outcome.error.code);
    }
    expect(uncaught).toEqual([]);
  });
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runStatus(event: (typeof SESSION_EVENTS)[number], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', statusCommand(event)], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException & { code?: number }).code as number | undefined) : 0;
      resolve({ code: code ?? null, stdout, stderr });
    });
  });
}

describe('statusCommand', () => {
  test.each(SESSION_EVENTS)('AC13 — run by /bin/sh -c with COCKPIT_SOCKET (the daemon\'s .sock) and the session id, the daemon receives %s and the command exits 0 with no output', async (event) => {
    const { files, connection, sessionId } = await start();

    const run = await runStatus(event, { COCKPIT_SOCKET: files.socket, COCKPIT_SESSION_ID: sessionId });

    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    await until(() => connection.statuses.length === 1, 'the status event');
    expect(connection.statuses).toEqual([{ sessionId, event }]);
  });

  test('AC13 — with COCKPIT_SOCKET unset, with no listener (the daemon is gone) or with an unknown session it exits 0, prints nothing and sends no event', async () => {
    const { files, connection, sessionId, daemon } = await start();

    expect(await runStatus('working', { COCKPIT_SESSION_ID: sessionId })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await runStatus('finished', { COCKPIT_SOCKET: files.socket, COCKPIT_SESSION_ID: 'nobody' })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(connection.statuses).toEqual([]);

    await daemon.close();
    expect(await runStatus('waiting', { COCKPIT_SOCKET: files.socket, COCKPIT_SESSION_ID: sessionId })).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});
