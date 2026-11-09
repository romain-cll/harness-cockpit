import { readdirSync, readFileSync, realpathSync, copyFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { describe, expect, test } from 'vitest';
import { daemonFiles } from '../src/index';
import { BUILD, connectTo, makeHome, onCleanup, registerCleanup, send, shellOptions, waitForOutput } from './helpers';
import { cockpit, jsonLine, launchOf, makeAgentFixture, startProjectDaemon, startStateDaemon, writeLaunchFile, type AgentFixture } from './state-helpers';

// COCKPIT-96: `cockpit terminal list|read|send` and `cockpit agent wait`. `runCli` in this process against a real
// daemon on real sockets and node-pty, stub programs in the terminals (a `sh -c` script that prints what it
// receives). Assumed of the API: `terminal list` prints the daemon's `list` as one JSON line; `terminal read <id>
// [--max-lines n]` prints plain text; `terminal send <id> [--text t] [--keys a,b]` prints `{"status":"sent",
// "statusCount"?}`; `agent wait <session> --until <word> [--after n] [--timeout s]` prints one JSON line.
//
// No test waits for a CLI command to have reached the daemon: `agent wait` lists, then follows the events that come
// after the answer, so a report posted before or after the list gives the same line. The one case that needs the
// order (a terminal that ends during a wait: before the list there is no terminal) goes through a proxy that
// says when the list answer has been forwarded.

registerCleanup();

const USAGE_LINES = { terminal: 'cockpit terminal', wait: 'cockpit agent wait' };

async function start(fixture: AgentFixture = makeAgentFixture()) {
  const daemon = await startStateDaemon({ fixture });
  const connection = await connectTo(daemon.socket);
  const token = readFileSync(daemonFiles(daemon.home, 1, BUILD).token, 'utf8');
  const run = (argv: string[]) => cockpit(argv, { home: daemon.home });
  /** A terminal of the daemon, owned by `connection` (which hears its output): `script` run by `sh -c`, or an interactive shell. */
  const spawn = (extra: Record<string, unknown> = {}, script?: string) =>
    connection.client.spawn({ ...shellOptions, ...(script !== undefined && { command: '/bin/sh', args: ['-c', script] }), ...extra } as Parameters<typeof connection.client.spawn>[0]);
  const post = async (body: object) => {
    const answer = await send(daemon.socket, { authorization: `Bearer ${token}`, body: JSON.stringify(body) });
    expect(answer.status).toBe(204);
  };
  /** The report a hook posts; resolves once this connection heard of it, so the daemon holds it. */
  const report = async (sessionId: string, event: 'working' | 'waiting' | 'finished') => {
    const before = connection.statuses.length;
    await post({ sessionId, event });
    await connection.when(() => connection.statuses.length > before);
  };
  return { fixture, ...daemon, connection, client: connection.client, run, spawn, post, report, token };
}

// A program that prints `ready`, then reads `count` raw bytes (a tty without echo or line editing, so the control
// bytes of the keys reach it as they are) and prints them in hex. `enableBracketedPaste` prints ESC [ ? 2004 h first.
const rawReader = (count: number, enableBracketedPaste: boolean) =>
  `${enableBracketedPaste ? "printf '\\033[?2004h'; " : ''}stty raw -echo; echo ready; bytes=$(dd bs=1 count=${count} 2>/dev/null | od -An -tx1 -v | tr -d ' \\n'); echo "bytes:$bytes:end"; exec cat`;
const bytesOf = (output: string) => /bytes:([0-9a-f]*):end/.exec(output)?.[1];
const hex = (text: string) => Buffer.from(text, 'latin1').toString('hex');

// A program reading one line in the terminal's default (cooked) mode.
const COOKED_READER = `echo ready; read -r line; printf 'got:[%s]\\n' "$line"; exec cat`;

// The titles of a turn, as in the turn-title tests: typed as octal escapes, so only the program's output holds the glyph.
const TURN_TITLES = { busy: '^[◐◑] ', idle: '^✳ ', marked: false };
const title = (glyph: 'busy' | 'idle') => `printf '\\033]0;${glyph === 'busy' ? '\\342\\227\\220' : '\\342\\234\\263'} Turn\\007'\n`;

describe('cockpit terminal list', () => {
  test('AC1 — prints one JSON line, the daemon\'s terminals: a shell and a session in a workspace, the session with its status and statusCount', async () => {
    const { run, spawn, report, client } = await start();
    const shell = await spawn({ kind: 'shell', workspace: '/work/space' });
    const session = await spawn({ kind: 'session', sessionId: 's1', workspace: '/work/space' });
    await report('s1', 'working');

    const result = await run(['terminal', 'list']);

    expect(result.exits).toEqual([0]);
    const listed = jsonLine(result.out);
    expect(listed).toEqual(JSON.parse(JSON.stringify(await client.list())));
    expect(listed.find((each: { id: number }) => each.id === shell)).toMatchObject({ id: shell, kind: 'shell', cwd: shellOptions.cwd, workspace: '/work/space' });
    expect(listed.find((each: { id: number }) => each.id === shell)).not.toHaveProperty('statusCount');
    expect(listed.find((each: { id: number }) => each.id === session)).toMatchObject({ id: session, kind: 'session', cwd: shellOptions.cwd, workspace: '/work/space', sessionId: 's1', status: 'working', statusCount: 1 });
  });
});

describe('cockpit terminal read', () => {
  const LONG = '0123456789'.repeat(10);
  const SCREEN = [
    ...Array.from({ length: 30 }, (_, index) => `n${index + 1}`),
    'red line',
    'green',
    LONG,
    'under end',
    'last line',
    'done',
  ];
  // 30 numbered lines (more than the 24 rows: scrollback), coloured lines, trailing spaces, and a line wider than the 80 columns.
  const SCRIPT = `i=1; while [ $i -le 30 ]; do echo n$i; i=$((i+1)); done; printf '\\033[31mred line\\033[0m\\n\\033[1;32mgreen\\033[0m   \\n${LONG}\\n\\033[4munder\\033[0m end\\nlast line\\ndone\\n'; exec cat`;

  test('AC2 — prints the scrollback and the screen as plain text: no escape sequence, the wide line as one line, no trailing space or empty line; --max-lines keeps the last lines', async () => {
    const { run, spawn, connection } = await start();
    const id = await spawn({}, SCRIPT);
    await waitForOutput(connection, id, 'done');

    const all = await run(['terminal', 'read', String(id)]);
    const last = await run(['terminal', 'read', String(id), '--max-lines', '2']);

    expect(all.exits).toEqual([0]);
    expect(all.err).toBe('');
    expect(all.out.replace(/\n$/, '')).toBe(SCREEN.join('\n'));
    expect(last.exits).toEqual([0]);
    expect(last.out.replace(/\n$/, '')).toBe(['last line', 'done'].join('\n'));
  });
});

describe('cockpit terminal read and send: refusals', () => {
  test.each([
    ['read', ['terminal', 'read', '999']],
    ['send', ['terminal', 'send', '999', '--keys', 'enter']],
  ])('AC3 — %s of a terminal that does not exist: "no terminal 999" on stderr, exit 1', async (_label, argv) => {
    const { run } = await start();

    const result = await run(argv);

    expect(result.exits).toEqual([1]);
    expect(result.err).toContain('no terminal 999');
    expect(result.out).toBe('');
  });

  test.each([
    ['read with no id', ['terminal', 'read']],
    ['read of an id that is not a number', ['terminal', 'read', 'abc']],
    ['read of the id 0', ['terminal', 'read', '0']],
    ['read of an id that is not an integer', ['terminal', 'read', '1.5']],
    ['read with --max-lines 0', ['terminal', 'read', '1', '--max-lines', '0']],
    ['read with --max-lines that is not a number', ['terminal', 'read', '1', '--max-lines', 'many']],
    ['read with --max-lines that is not an integer', ['terminal', 'read', '1', '--max-lines', '1.5']],
    ['send with neither --text nor --keys', ['terminal', 'send', '1']],
    ['send to an id that is not a number', ['terminal', 'send', 'abc', '--keys', 'enter']],
    ['send of an unknown key', ['terminal', 'send', '1', '--keys', 'bogus']],
    ['send of a list of keys with an unknown one', ['terminal', 'send', '1', '--keys', 'enter,bogus']],
  ])('AC3 — %s: the usage on stderr, exit 2, nothing started', async (_label, argv) => {
    const home = makeHome();

    const result = await cockpit(argv, { home });

    expect(result.exits).toEqual([2]);
    expect(result.err.startsWith('usage:')).toBe(true);
    expect(result.err).toContain(USAGE_LINES.terminal);
    expect(result.out).toBe('');
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('cockpit terminal send', () => {
  test('AC4 — text then Enter reaches a program that did not enable bracketed paste as the line, and the command prints sent, with statusCount for a session only', async () => {
    const { run, spawn, report, connection } = await start();
    const shell = await spawn({}, COOKED_READER);
    const session = await spawn({ kind: 'session', sessionId: 's1' }, COOKED_READER);
    await report('s1', 'working');
    await waitForOutput(connection, shell, 'ready');
    await waitForOutput(connection, session, 'ready');

    const toShell = await run(['terminal', 'send', String(shell), '--text', 'hello', '--keys', 'enter']);
    const toSession = await run(['terminal', 'send', String(session), '--text', 'hello', '--keys', 'enter']);

    expect(toShell.exits).toEqual([0]);
    expect(jsonLine(toShell.out)).toEqual({ status: 'sent' });
    expect(toSession.exits).toEqual([0]);
    expect(jsonLine(toSession.out)).toEqual({ status: 'sent', statusCount: 1 });
    await waitForOutput(connection, shell, 'got:[hello]');
    await waitForOutput(connection, session, 'got:[hello]');
  });

  test('AC5 — a program that enabled bracketed paste receives the text between ESC[200~ and ESC[201~, then CR', async () => {
    const { run, spawn, connection } = await start();
    const id = await spawn({}, rawReader(18, true));
    await waitForOutput(connection, id, 'ready');

    const result = await run(['terminal', 'send', String(id), '--text', 'hello', '--keys', 'enter']);

    expect(result.exits).toEqual([0]);
    await waitForOutput(connection, id, ':end');
    expect(bytesOf(connection.output(id))).toBe(hex('\u001b[200~hello\u001b[201~\r'));
  });

  test('AC6 — the keys reach the program as their bytes, in order', async () => {
    const { run, spawn, connection } = await start();
    const id = await spawn({}, rawReader(18, false));
    await waitForOutput(connection, id, 'ready');

    const result = await run(['terminal', 'send', String(id), '--keys', 'enter,esc,tab,backspace,up,down,right,left,ctrl-c,ctrl-d']);

    expect(result.exits).toEqual([0]);
    await waitForOutput(connection, id, ':end');
    expect(bytesOf(connection.output(id))).toBe(hex('\r\u001b\t\u007f\u001b[A\u001b[B\u001b[C\u001b[D\u0003\u0004'));
  });
});

describe('cockpit agent wait', () => {
  test.each([
    ['finished', 'settled', 'finished'],
    ['finished', 'finished', 'finished'],
    ['waiting', 'waiting', 'waiting'],
    ['waiting', 'settled', 'waiting'],
    ['working', 'working', 'working'],
  ] as const)('AC7 — a session whose last status is %s and --until %s: prints %s and its count at once', async (reported, until, printed) => {
    const { run, spawn, report } = await start();
    await spawn({ kind: 'session', sessionId: 's1' });
    await report('s1', reported);

    const result = await run(['agent', 'wait', 's1', '--until', until]);

    expect(result.exits).toEqual([0]);
    expect(jsonLine(result.out)).toEqual({ status: printed, statusCount: 1 });
  });

  test('AC7 — a working session and --until settled: returns on the next finished report', async () => {
    const { run, spawn, report } = await start();
    await spawn({ kind: 'session', sessionId: 's1' });
    await report('s1', 'working');

    const waiting = run(['agent', 'wait', 's1', '--until', 'settled']);
    await report('s1', 'finished');
    const result = await waiting;

    expect(result.exits).toEqual([0]);
    expect(jsonLine(result.out)).toEqual({ status: 'finished', statusCount: 2 });
  });

  test('AC7 — a working session and --until settled: returns on the finished that the agent\'s title gives', async () => {
    const { run, spawn, report, client } = await start();
    const id = await spawn({ kind: 'session', sessionId: 's1', agentTitles: TURN_TITLES });
    await report('s1', 'working');

    const waiting = run(['agent', 'wait', 's1', '--until', 'settled']);
    client.write(id, title('busy') + title('idle'));
    const result = await waiting;

    expect(result.exits).toEqual([0]);
    expect(jsonLine(result.out)).toEqual({ status: 'finished', statusCount: 2 });
  });

  test('AC8 — --after n does not return on the finished that has count n: it returns on the first later report that settles, with its count', async () => {
    const { run, spawn, report } = await start();
    await spawn({ kind: 'session', sessionId: 's1' });
    await report('s1', 'finished');

    const waiting = run(['agent', 'wait', 's1', '--until', 'settled', '--after', '1']);
    await report('s1', 'working');
    await report('s1', 'finished');
    const result = await waiting;

    expect(result.exits).toEqual([0]);
    expect(jsonLine(result.out)).toEqual({ status: 'finished', statusCount: 3 });
  });

  test('AC8 — a session that has reported no status yet: --until settled waits for a report', async () => {
    const { run, spawn, report } = await start();
    await spawn({ kind: 'session', sessionId: 's1' });

    const waiting = run(['agent', 'wait', 's1', '--until', 'settled']);
    await report('s1', 'waiting');
    const result = await waiting;

    expect(result.exits).toEqual([0]);
    expect(jsonLine(result.out)).toEqual({ status: 'waiting', statusCount: 1 });
  });

  test('AC9 — a session that reports nothing that matches: after --timeout, prints timeout and exits 1', async () => {
    const { run, spawn, report } = await start();
    await spawn({ kind: 'session', sessionId: 's1' });
    await report('s1', 'working');

    const result = await run(['agent', 'wait', 's1', '--until', 'finished', '--timeout', '0.2']);

    expect(result.exits).toEqual([1]);
    expect(jsonLine(result.out)).toEqual({ status: 'timeout' });
  });

  test('AC10 — the exited report during a wait: prints exited with the code and exits 1; a wait after the exit does the same at once', async () => {
    const { run, spawn, post } = await start();
    await spawn({ kind: 'session', sessionId: 's1' });

    const waiting = run(['agent', 'wait', 's1', '--until', 'finished']);
    await post({ sessionId: 's1', event: 'exited', exitCode: 3 });
    const during = await waiting;
    const after = await run(['agent', 'wait', 's1', '--until', 'finished']);

    for (const result of [during, after]) {
      expect(result.exits).toEqual([1]);
      expect(jsonLine(result.out)).toEqual({ status: 'exited', exitCode: 3 });
    }
  });

  test('AC10 — the end of the session\'s terminal during a wait: prints exited with a null code and exits 1', async () => {
    const { fixture, home, stateDir, socket, spawn, client } = await start();
    const id = await spawn({ kind: 'session', sessionId: 's1' });
    const proxied = await proxy({ fixture, home, stateDir, socket });

    const waiting = cockpit(['agent', 'wait', 's1', '--until', 'finished'], { home: proxied.home });
    // Or the command ended without listing (it does not know the command yet).
    await Promise.race([proxied.listed, waiting]);
    client.kill(id);
    const result = await waiting;

    expect(result.exits).toEqual([1]);
    expect(jsonLine(result.out)).toEqual({ status: 'exited', exitCode: null });
  });

  test('AC11 — a session with no running terminal: prints refused with the message and exits 1', async () => {
    const { run } = await start();

    const result = await run(['agent', 'wait', 'nope', '--until', 'settled']);

    expect(result.exits).toEqual([1]);
    expect(jsonLine(result.out)).toEqual({ status: 'refused', message: 'No running terminal for session nope.' });
  });

  test.each([
    ['--until missing', ['agent', 'wait', 's1']],
    ['--until that is no status', ['agent', 'wait', 's1', '--until', 'idle']],
    ['no session', ['agent', 'wait', '--until', 'settled']],
    ['--timeout 0', ['agent', 'wait', 's1', '--until', 'settled', '--timeout', '0']],
    ['--timeout negative', ['agent', 'wait', 's1', '--until', 'settled', '--timeout', '-1']],
    ['--timeout that is not a number', ['agent', 'wait', 's1', '--until', 'settled', '--timeout', 'soon']],
    ['--after negative', ['agent', 'wait', 's1', '--until', 'settled', '--after', '-1']],
    ['--after that is not an integer', ['agent', 'wait', 's1', '--until', 'settled', '--after', '1.5']],
    ['--after that is not a number', ['agent', 'wait', 's1', '--until', 'settled', '--after', 'n']],
  ])('AC11 — %s: the usage on stderr, exit 2, nothing started', async (_label, argv) => {
    const home = makeHome();

    const result = await cockpit(argv, { home });

    expect(result.exits).toEqual([2]);
    expect(result.err.startsWith('usage:')).toBe(true);
    expect(result.err).toContain(USAGE_LINES.wait);
    expect(result.out).toBe('');
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('driving an agent end to end', () => {
  test('AC12 — list, wait, read, send, wait --after, read: each reply is read after its turn settled, and the second wait does not return on the first turn', async () => {
    const { repo, run, create } = await startProjectDaemon(BUILD, { conversation: true });
    const workspace = await create('talk');

    const started = await run(['session', 'start', '--project', repo.root, '--workspace', workspace.path, '--harness', 'claude-code', '--prompt', 'first']);
    expect(started.exits).toEqual([0]);
    const sessionId = jsonLine(started.out).session.id as string;
    const listed = await run(['terminal', 'list']);
    const terminal = jsonLine(listed.out).find((each: { sessionId?: string }) => each.sessionId === sessionId);
    expect(terminal, 'the session\'s terminal is listed').toBeDefined();
    const id = String(terminal.id);

    const firstWait = await run(['agent', 'wait', sessionId, '--until', 'settled']);
    const firstRead = await run(['terminal', 'read', id]);
    const sent = await run(['terminal', 'send', id, '--text', 'second', '--keys', 'enter']);
    expect(sent.exits).toEqual([0]);
    const n = jsonLine(sent.out).statusCount as number;
    const secondWait = await run(['agent', 'wait', sessionId, '--until', 'settled', '--after', String(n)]);
    const secondRead = await run(['terminal', 'read', id]);

    expect(firstWait.exits).toEqual([0]);
    expect(jsonLine(firstWait.out)).toMatchObject({ status: 'finished' });
    expect(firstRead.out).toContain('reply:first');
    expect(firstRead.out).not.toContain('reply:second');
    expect(secondWait.exits).toEqual([0]);
    expect(jsonLine(secondWait.out)).toMatchObject({ status: 'finished' });
    expect(jsonLine(secondWait.out).statusCount).toBeGreaterThan(n);
    expect(secondRead.out).toContain('reply:second');
  });
});

/**
 * A Cockpit home whose daemon socket forwards to `socket` and says, through `listed`, when the first answer holding
 * an array (the `list` of a CLI command) went to the client: any event of the daemon after `await listed` reaches that
 * connection after its list answer.
 */
async function proxy({ fixture, home, stateDir, socket }: { fixture: AgentFixture; home: string; stateDir: string; socket: string }) {
  const proxied = realpathSync(makeHome());
  const files = daemonFiles(proxied, 1, BUILD);
  copyFileSync(daemonFiles(home, 1, BUILD).token, files.token);
  writeLaunchFile(proxied, launchOf(fixture, stateDir, BUILD));
  let forwarded!: () => void;
  const listed = new Promise<void>((resolve) => (forwarded = resolve));
  const server = createServer((client) => {
    const upstream = connect(socket);
    let seen = '';
    client.on('error', () => {});
    upstream.on('error', () => {});
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream);
    upstream.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      client.write(chunk, () => {
        if (seen.includes('"result":[')) forwarded();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(files.socket, resolve));
  onCleanup(() => server.close());
  return { home: proxied, listed };
}
