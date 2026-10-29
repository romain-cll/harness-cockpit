import { rmSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli';
import { daemonFiles, SESSION_EVENTS } from '../src/index';
import { connectTo, listenFake, listenSilent, makeHome, registerCleanup, shellOptions, startDaemon, until } from './helpers';

// COCKPIT-56: the `cockpit` CLI. `runCli(argv, env, { stdout, stderr, exit })` is the logic of the
// entry in `apps/cli/src/main.ts`, which only passes `process.argv.slice(2)`, `process.env`, the
// process's stdout and stderr and `process.exit`; it resolves once it has called `exit`.
//
// Assumed here: `status <event>` reads `COCKPIT_SOCKET`, `COCKPIT_SESSION_ID` and the token next to
// the socket, posts to the status endpoint and always calls `exit(0)` with nothing written; any
// other usage writes the usage line to stderr and calls `exit(2)`.

registerCleanup();

const USAGE = 'usage: cockpit status <working|waiting|finished>';
const TOKEN = 'a'.repeat(64);

async function runCliWith(argv: string[], env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  await runCli(argv, env as NodeJS.ProcessEnv, {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    exit: (code: number) => void exits.push(code),
  });
  return { out: out.join(''), err: err.join(''), exits };
}

async function start() {
  const daemon = await startDaemon();
  const connection = await connectTo(daemon.files.socket);
  const sessionId = 'session-1';
  await connection.client.spawn({ ...shellOptions, kind: 'session', sessionId });
  return { ...daemon, connection, sessionId, env: { COCKPIT_SOCKET: daemon.files.socket, COCKPIT_SESSION_ID: sessionId } };
}

describe('cockpit status', () => {
  test.each(SESSION_EVENTS)('AC1 — %s: the daemon\'s clients receive it for the session, list shows it as the last status, and the CLI exits 0 with no output', async (event) => {
    const { connection, sessionId, env } = await start();

    expect(await runCliWith(['status', event], env)).toEqual({ out: '', err: '', exits: [0] });

    await until(() => connection.statuses.length === 1, 'the status event');
    expect(connection.statuses).toEqual([{ sessionId, event }]);
    expect((await connection.client.list()).find((entry) => entry.sessionId === sessionId)?.status).toBe(event);
  });

  test.each([
    ['COCKPIT_SOCKET unset', (env: Record<string, string>) => ({ ...env, COCKPIT_SOCKET: undefined })],
    ['COCKPIT_SOCKET empty', (env: Record<string, string>) => ({ ...env, COCKPIT_SOCKET: '' })],
    ['COCKPIT_SESSION_ID unset', (env: Record<string, string>) => ({ ...env, COCKPIT_SESSION_ID: undefined })],
    ['COCKPIT_SESSION_ID empty', (env: Record<string, string>) => ({ ...env, COCKPIT_SESSION_ID: '' })],
    ['a session id that is not a session of the daemon', (env: Record<string, string>) => ({ ...env, COCKPIT_SESSION_ID: 'nobody' })],
  ])('AC2 — %s: exit 0, no output, and no client receives an event', async (_label, change) => {
    const { connection, env } = await start();

    expect(await runCliWith(['status', 'working'], change(env))).toEqual({ out: '', err: '', exits: [0] });

    expect(connection.statuses).toEqual([]);
  });

  test('AC2 — no .token next to the socket: exit 0, no output, and no client receives an event', async () => {
    const { connection, env, files } = await start();
    rmSync(files.token);

    expect(await runCliWith(['status', 'working'], env)).toEqual({ out: '', err: '', exits: [0] });

    expect(connection.statuses).toEqual([]);
  });

  test('AC2 — no listener at the socket path (the daemon is gone): exit 0 and no output', async () => {
    const { env, daemon } = await start();
    await daemon.close();

    expect(await runCliWith(['status', 'working'], env)).toEqual({ out: '', err: '', exits: [0] });
  });

  test('AC3 — a socket that accepts connections and never answers: exit 0 within 3 s and no output', async () => {
    const home = makeHome();
    const files = daemonFiles(home, 1, 'aaaa1111');
    await listenSilent(files.socket);
    writeFileSync(files.token, TOKEN);

    const started = Date.now();
    const result = await runCliWith(['status', 'working'], { COCKPIT_SOCKET: files.socket, COCKPIT_SESSION_ID: 'session-1' });

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result).toEqual({ out: '', err: '', exits: [0] });
  });
});

describe('cockpit usage', () => {
  test.each([
    ['no argument', []],
    ['an unknown command', ['frobnicate']],
    ['status with no event', ['status']],
    ['status with a value other than the three events', ['status', 'sleeping']],
    ['status working with an extra argument', ['status', 'working', 'extra']],
  ])('AC4 — %s: the usage on stderr, exit 2, and nothing sent to the daemon', async (_label, argv) => {
    const home = makeHome();
    const files = daemonFiles(home, 1, 'aaaa1111');
    const requests: Array<string | undefined> = [];
    await listenFake(files.socket, ({ authorization, socket }) => {
      requests.push(authorization);
      socket.destroy();
    });
    writeFileSync(files.token, TOKEN);

    const result = await runCliWith(argv, { COCKPIT_SOCKET: files.socket, COCKPIT_SESSION_ID: 'session-1' });

    expect(result.exits).toEqual([2]);
    expect(result.err.trim()).toBe(USAGE);
    expect(result.out).toBe('');
    // A request, had there been one, would have reached the server by now.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toEqual([]);
  });
});
