import { rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli';
import { daemonFiles, SESSION_EVENTS } from '../src/index';
import { connectTo, listenFake, listenSilent, makeHome, registerCleanup, sendOrError, shellOptions, startDaemon } from './helpers';

// COCKPIT-56: the `cockpit` CLI. `runCli(argv, env, { stdout, stderr, exit })` is the logic of the
// entry in `apps/cli/src/main.ts`, which only passes `process.argv.slice(2)`, `process.env`, the
// process's stdout and stderr and `process.exit`; it resolves once it has called `exit`.
//
// Assumed here: `status <event>` reads `COCKPIT_SOCKET`, `COCKPIT_SESSION_ID` and the token next to
// the socket, posts to the status endpoint and always calls `exit(0)` with nothing written; any
// other usage writes the usage line to stderr and calls `exit(2)`.

registerCleanup();

// COCKPIT-57: the usage lists the three commands (`--shell` stays out of it).
const USAGE_LINES = ['cockpit status <working|waiting|finished>', 'cockpit session-id', 'cockpit setup [--then <command> [args…]]', 'cockpit teardown'];
const TOKEN = 'a'.repeat(64);

// `stdin` is what a hook pipes to the CLI (COCKPIT-30): the harness's hook JSON, or the plain id of OpenCode's plugin.
async function runCliWith(argv: string[], env: Record<string, string | undefined>, stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  await runCli(argv, env as NodeJS.ProcessEnv, {
    stdin: Readable.from(stdin === '' ? [] : [Buffer.from(stdin)], { objectMode: false }),
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

    await connection.when(() => connection.statuses.length === 1);
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
    ['status with a setup event, which only the setup command reports', ['status', 'setup-running']],
    ['status with exited', ['status', 'exited']],
    ['session-id with no harness', ['session-id']],
  ])('AC12 — %s: the usage on stderr, exit 2, and nothing sent to the daemon', async (_label, argv) => {
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
    expect(result.err.startsWith('usage:')).toBe(true);
    for (const line of USAGE_LINES) expect(result.err).toContain(line);
    expect(result.err).not.toContain('--shell');
    expect(result.out).toBe('');
    // A request of the CLI, had there been one, was written before it exited: it reaches the server before
    // the test's own, sent on a connection opened after it.
    await sendOrError(files.socket, { authorization: 'witness' });
    expect(requests).toEqual(['witness']);
  });
});

// COCKPIT-30: `cockpit session-id <harness>` hands a hook's stdin to the harness's adapter and posts the opaque id it
// finds to the status endpoint. It exits 0 and writes nothing whatever happens, like `status`.

// A conversation id no harness would make: it must reach the daemon byte for byte (AC5).
const ODD_ID = 'not/a:uuid é';
const hookJson = (id: string) => JSON.stringify({ session_id: id, transcript_path: '/t.jsonl', cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
// What each harness pipes: Claude Code's and Codex's hooks get JSON, OpenCode's plugin writes the id and a newline.
const inputs: Array<[string, (id: string) => string]> = [
  ['claude-code', hookJson],
  ['codex', hookJson],
  ['opencode', (id) => `${id}\n`],
];

describe('cockpit session-id', () => {
  test.each(inputs)('AC1 — %s: the id its adapter finds in stdin reaches the daemon\'s clients as a harness-session status and shows in list, and the CLI exits 0 with no output', async (harness, input) => {
    const { connection, sessionId, env } = await start();

    expect(await runCliWith(['session-id', harness], env, input('conversation-1'))).toEqual({ out: '', err: '', exits: [0] });

    await connection.when(() => connection.statuses.length === 1);
    expect(connection.statuses).toEqual([{ sessionId, event: 'harness-session', harnessSessionId: 'conversation-1' }]);
    expect((await connection.client.list()).find((entry) => entry.sessionId === sessionId)).toMatchObject({ harnessSessionId: 'conversation-1' });
  });

  test.each(inputs)('AC5 — %s: an id that looks like no harness\'s goes through the CLI and the daemon byte for byte', async (harness, input) => {
    const { connection, sessionId, env } = await start();

    expect(await runCliWith(['session-id', harness], env, input(ODD_ID))).toEqual({ out: '', err: '', exits: [0] });

    await connection.when(() => connection.statuses.length === 1);
    expect(connection.statuses[0]).toEqual({ sessionId, event: 'harness-session', harnessSessionId: ODD_ID });
    expect((await connection.client.list()).find((entry) => entry.sessionId === sessionId)?.harnessSessionId).toBe(ODD_ID);
  });

  test('AC4 — a later report replaces the id in list: the last one wins', async () => {
    const { connection, sessionId, env } = await start();
    const stored = async () => (await connection.client.list()).find((entry) => entry.sessionId === sessionId)?.harnessSessionId;

    await runCliWith(['session-id', 'claude-code'], env, hookJson('first'));
    expect(await stored()).toBe('first');
    await runCliWith(['session-id', 'claude-code'], env, hookJson('second'));
    expect(await stored()).toBe('second');
  });

  test.each([
    ['COCKPIT_SOCKET unset', (env: Record<string, string>) => ({ ...env, COCKPIT_SOCKET: undefined })],
    ['COCKPIT_SOCKET empty', (env: Record<string, string>) => ({ ...env, COCKPIT_SOCKET: '' })],
    ['COCKPIT_SESSION_ID unset', (env: Record<string, string>) => ({ ...env, COCKPIT_SESSION_ID: undefined })],
    ['COCKPIT_SESSION_ID empty', (env: Record<string, string>) => ({ ...env, COCKPIT_SESSION_ID: '' })],
    ['a session id that is not a session of the daemon', (env: Record<string, string>) => ({ ...env, COCKPIT_SESSION_ID: 'nobody' })],
  ])('AC6 — %s: exit 0, no output, and no client receives an event', async (_label, change) => {
    const { connection, env } = await start();

    expect(await runCliWith(['session-id', 'claude-code'], change(env), hookJson('conversation-1'))).toEqual({ out: '', err: '', exits: [0] });

    expect(connection.statuses).toEqual([]);
  });

  test('AC6 — no .token next to the socket: exit 0, no output, and no client receives an event', async () => {
    const { connection, env, files } = await start();
    rmSync(files.token);

    expect(await runCliWith(['session-id', 'claude-code'], env, hookJson('conversation-1'))).toEqual({ out: '', err: '', exits: [0] });

    expect(connection.statuses).toEqual([]);
  });

  test('AC6 — no listener at the socket path (the daemon is gone): exit 0 and no output', async () => {
    const { env, daemon } = await start();
    await daemon.close();

    expect(await runCliWith(['session-id', 'claude-code'], env, hookJson('conversation-1'))).toEqual({ out: '', err: '', exits: [0] });
  });

  test.each([
    ['an unknown harness', 'frobnicate', hookJson('conversation-1')],
    ['claude-code with an empty stdin', 'claude-code', ''],
    ['claude-code with a stdin that is not JSON', 'claude-code', 'not json'],
    ['claude-code with a JSON array', 'claude-code', '[]'],
    ['claude-code with no session_id', 'claude-code', '{"hook_event_name":"UserPromptSubmit"}'],
    ['claude-code with an empty session_id', 'claude-code', '{"session_id":""}'],
    ['claude-code with a numeric session_id', 'claude-code', '{"session_id":7}'],
    ['codex with no session_id', 'codex', '{}'],
    ['codex with another spelling of the field', 'codex', '{"sessionId":"conversation-1"}'],
    ['opencode with an empty stdin', 'opencode', ''],
    ['opencode with blanks only', 'opencode', '  \n'],
  ])('AC6 — %s: exit 0, no output and nothing sent to the daemon', async (_label, harness, input) => {
    const home = makeHome();
    const files = daemonFiles(home, 1, 'aaaa1111');
    const requests: Array<string | undefined> = [];
    await listenFake(files.socket, ({ authorization, socket }) => {
      requests.push(authorization);
      socket.destroy();
    });
    writeFileSync(files.token, TOKEN);

    const result = await runCliWith(['session-id', harness], { COCKPIT_SOCKET: files.socket, COCKPIT_SESSION_ID: 'session-1' }, input);

    expect(result).toEqual({ out: '', err: '', exits: [0] });
    // A request of the CLI, had there been one, was written before it exited: it reaches the server before the
    // test's own, sent on a connection opened after it.
    await sendOrError(files.socket, { authorization: 'witness' });
    expect(requests).toEqual(['witness']);
  });
});
