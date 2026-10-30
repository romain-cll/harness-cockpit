import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

// COCKPIT-57: `cockpit setup` and `cockpit teardown`, the compiled binary itself: only Bun's runtime
// shows the stdio inheritance, the signal handling and the exit codes of the children as a pty gives
// them. Turbo builds `dist/cockpit` before `test`. A temporary repository with one linked worktree,
// stub agent and shell scripts, and a fake daemon on a Unix socket that records the reports.
//
// Assumed here (the spec names the lines, not every detail):
// - the output is read as lines, ANSI sequences and blank lines removed;
// - `cockpit setup` reports `setup-running`, then `setup-done` or `setup-failed`, then `exited` (with
//   the agent's exit code, `null` for a signal), through `POST /session-events`, only with
//   `COCKPIT_SESSION_ID` and `COCKPIT_SOCKET` set;
// - `cockpit teardown` exits with the exit code of the command that failed.

const BINARY = resolve(import.meta.dirname, '../dist/cockpit');
const TOKEN = 'b'.repeat(64);
const USAGE_LINES = ['cockpit status <working|waiting|finished>', 'cockpit setup [--then <command> [args…]]', 'cockpit teardown'];
const BRANCH = 'feat-setup';
const HEADER = (what: 'setup' | 'teardown') => `cockpit ${what} · ${BRANCH} · .cockpit/config.json`;

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv }, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let worktree: string;
let bin: string;
let shell: string;
let agent: string;
let server: Server;
let socket: string;
let reports: Array<Record<string, unknown>> = [];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  reports = [];
});

beforeAll(async () => {
  if (!existsSync(BINARY)) throw new Error(`${BINARY} is missing: run bun run build in apps/cli first`);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ck-')));
  repo = join(root, 'repo');
  worktree = join(root, 'wt');
  bin = join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  git(repo, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'first');
  git(repo, 'worktree', 'add', '--quiet', '-b', BRANCH, worktree, 'main');

  // A stub agent named after a catalogue binary: it records its working directory and its arguments
  // (NUL-separated, so a newline in one stays visible) and exits as STUB_AGENT says.
  agent = join(bin, 'claude');
  writeFileSync(
    agent,
    `#!/bin/sh
pwd -P > "$STUB_DIR/agent.cwd"
printf '%s\\0' "$@" > "$STUB_DIR/agent.argv"
echo agent-started
case "\${STUB_AGENT-}" in
  exit3) exit 3 ;;
  term) kill -TERM $$ ;;
esac
exit 0
`,
  );
  // A stub login shell: it records that it ran, with which arguments and where, and returns.
  shell = join(bin, 'login-shell');
  writeFileSync(
    shell,
    `#!/bin/sh
pwd -P > "$STUB_DIR/shell.cwd"
printf '%s\\0' "$@" > "$STUB_DIR/shell.argv"
echo shell-prompt
`,
  );
  for (const stub of [agent, shell]) chmodSync(stub, 0o755);
  // macOS scans a new executable the first time it runs.
  const warm = mkdtempSync(join(tmpdir(), 'ck-'));
  for (const stub of [agent, shell]) execFileSync(stub, [], { env: { STUB_DIR: warm } });
  rmSync(warm, { recursive: true, force: true });

  // The fake daemon: records every report it is sent with the right token and answers 204.
  socket = join(root, 'daemon-1-aaaa1111.sock');
  writeFileSync(socket.replace(/\.sock$/, '.token'), TOKEN);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.headers.authorization === `Bearer ${TOKEN}` && req.method === 'POST' && req.url === '/session-events') {
        reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        res.statusCode = 204;
      } else {
        res.statusCode = 401;
      }
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(socket, done));
});

afterAll(() => {
  server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

function writeConfig(config: unknown | undefined) {
  const folder = join(repo, '.cockpit');
  rmSync(folder, { recursive: true, force: true });
  if (config === undefined) return;
  mkdirSync(folder);
  writeFileSync(join(folder, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');

interface Run {
  code: number | null;
  /** stdout and stderr in the order they were written, without ANSI sequences and blank lines. */
  lines: string[];
  /** What the stubs recorded. */
  stub: { dir: string; file(name: string): string | undefined };
}

/** Runs the compiled binary with stdout and stderr on one file, so the order of the lines is the pty's. */
async function cockpit(args: string[], { cwd = worktree, env = {} }: { cwd?: string; env?: Record<string, string> } = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'ck-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'output.txt');
  const fd = openSync(output, 'w');
  try {
    const code = await new Promise<number | null>((done, fail) => {
      const child = spawn(BINARY, args, {
        cwd,
        stdio: ['ignore', fd, fd],
        env: { PATH: `${bin}:/usr/bin:/bin`, SHELL: shell, STUB_DIR: dir, ...gitEnv, ...env },
      });
      const failsafe = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('error', fail);
      child.on('close', (exit) => {
        clearTimeout(failsafe);
        done(exit);
      });
    });
    const lines = stripAnsi(readFileSync(output, 'utf8'))
      .replaceAll('\r', '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean);
    const file = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined);
    return { code, lines, stub: { dir, file } };
  } finally {
    closeSync(fd);
  }
}

const SESSION = () => ({ COCKPIT_SOCKET: socket, COCKPIT_SESSION_ID: 'session-1' });
const nulSplit = (text: string | undefined) => (text === undefined ? undefined : text.split('\0').slice(0, -1));
const events = () => reports.map((report) => report.event);

/** Waits for the reports the CLI sent before it exited (it may send them as it goes). */
async function reportsSettled(expected: number) {
  const deadline = Date.now() + 3_000;
  while (reports.length < expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('cockpit setup', () => {
  test('AC1 — prints the header, a "$ <command>" line and the output of each command in order, "✓ Setup done", then runs the agent in the worktree with its arguments intact; the commands get the three environment variables; the reports are setup-running, setup-done, exited', async () => {
    const env = 'echo "env:$COCKPIT_ROOT_PATH|$COCKPIT_WORKSPACE_PATH|$COCKPIT_WORKSPACE_NAME"';
    writeConfig({ setup: [env, 'pwd -P', 'echo one; echo two'] });
    const prompt = `say "hi" $HOME 100% 'q'\nsecond line`;
    const settings = '{"hooks":{"Stop":[]}}';

    const run = await cockpit(['setup', '--then', agent, '--settings', settings, prompt], { env: SESSION() });
    await reportsSettled(3);

    expect(run.lines.slice(0, 10)).toEqual([
      HEADER('setup'),
      `$ ${env}`,
      `env:${repo}|${worktree}|${BRANCH}`,
      '$ pwd -P',
      worktree,
      '$ echo one; echo two',
      'one',
      'two',
      '✓ Setup done',
      'agent-started',
    ]);
    expect(run.stub.file('agent.cwd')?.trim()).toBe(worktree);
    expect(nulSplit(run.stub.file('agent.argv'))).toEqual(['--settings', settings, prompt]);
    expect(run.stub.file('shell.cwd'), 'no --shell: no shell').toBeUndefined();
    expect(reports).toEqual([
      { sessionId: 'session-1', event: 'setup-running' },
      { sessionId: 'session-1', event: 'setup-done' },
      { sessionId: 'session-1', event: 'exited', exitCode: 0 },
    ]);
  });

  test.each([
    ['code 3', 'exit3', 3, '[Claude Code exited with code 3]'],
    ['code 0', '', 0, '[Claude Code exited with code 0]'],
    ['a signal', 'term', null, '[Claude Code was killed by SIGTERM]'],
  ])('AC5 — the agent exits with %s: exited is reported with it, "%s" is printed, and the login shell (-l) then starts in the worktree', async (_label, how, exitCode, line) => {
    writeConfig({ setup: ['echo only'] });

    const run = await cockpit(['setup', '--shell', '--then', agent], { env: { ...SESSION(), STUB_AGENT: how } });
    await reportsSettled(3);

    expect(run.lines.slice(0, 5)).toEqual([HEADER('setup'), '$ echo only', 'only', '✓ Setup done', 'agent-started']);
    expect(run.lines).toContain(line);
    expect(run.lines.at(-1)).toBe('shell-prompt');
    expect(run.lines.indexOf(line)).toBeLessThan(run.lines.indexOf('shell-prompt'));
    expect(run.stub.file('shell.cwd')?.trim()).toBe(worktree);
    expect(nulSplit(run.stub.file('shell.argv'))).toEqual(['-l']);
    expect(reports.at(-1)).toEqual({ sessionId: 'session-1', event: 'exited', exitCode });
    expect(events()).toEqual(['setup-running', 'setup-done', 'exited']);
  });

  test('AC3 — a command that exits with code N stops the setup: the later commands do not run, the failure and the hint lines are printed, then the login shell starts in the worktree and the agent never does', async () => {
    writeConfig({ setup: ['echo before', 'echo bad; exit 4', 'touch "$COCKPIT_ROOT_PATH/should-not-exist"'] });

    const run = await cockpit(['setup', '--shell', '--then', agent, '--some', 'arg'], { env: SESSION() });
    await reportsSettled(2);

    expect(run.lines).toEqual([
      HEADER('setup'),
      '$ echo before',
      'before',
      '$ echo bad; exit 4',
      'bad',
      '✗ Setup failed: echo bad; exit 4 exited with code 4',
      'Claude Code was not started. Run `cockpit setup --then claude` to try again.',
      'shell-prompt',
    ]);
    expect(existsSync(join(repo, 'should-not-exist'))).toBe(false);
    expect(run.stub.file('agent.cwd'), 'the agent never starts').toBeUndefined();
    expect(run.stub.file('shell.cwd')?.trim()).toBe(worktree);
    expect(nulSplit(run.stub.file('shell.argv'))).toEqual(['-l']);
    expect(events()).toEqual(['setup-running', 'setup-failed']);
  });

  test('AC3 — a command killed by a signal (Ctrl+C included) is a failure too: "was killed by <SIGNAL>", the later commands do not run, and the CLI itself survives it', async () => {
    writeConfig({ setup: ['echo start', 'kill -INT $$', 'echo after'] });

    const run = await cockpit(['setup'], { env: SESSION() });
    await reportsSettled(2);

    expect(run.lines).toEqual([HEADER('setup'), '$ echo start', 'start', '$ kill -INT $$', '✗ Setup failed: kill -INT $$ was killed by SIGINT']);
    expect(events()).toEqual(['setup-running', 'setup-failed']);
  });

  test('AC4 — typed in the shell a failure left: a plain "cockpit setup" runs again with the output of AC1 and returns (no shell, no agent, exit 0); "--then claude" found on the PATH starts the agent after "✓ Setup done", still without a shell', async () => {
    writeConfig({ setup: ['echo again'] });

    const plain = await cockpit(['setup'], { env: SESSION() });
    await reportsSettled(2);
    expect(plain.code).toBe(0);
    expect(plain.lines).toEqual([HEADER('setup'), '$ echo again', 'again', '✓ Setup done']);
    expect(plain.stub.file('agent.cwd')).toBeUndefined();
    expect(plain.stub.file('shell.cwd'), 'no nested shell').toBeUndefined();
    expect(events()).toEqual(['setup-running', 'setup-done']);

    reports = [];
    const then = await cockpit(['setup', '--then', 'claude'], { env: SESSION() });
    await reportsSettled(3);
    expect(then.lines.slice(0, 5)).toEqual([HEADER('setup'), '$ echo again', 'again', '✓ Setup done', 'agent-started']);
    expect(then.stub.file('agent.cwd')?.trim()).toBe(worktree);
    expect(then.stub.file('shell.cwd'), 'no nested shell').toBeUndefined();
    expect(events()).toEqual(['setup-running', 'setup-done', 'exited']);
  });

  test.each([
    ['no config file', undefined],
    ['a config without setup commands', { teardown: ['echo only-teardown'] }],
  ])('AC7 — with %s the setup prints nothing of its own, reports no setup state and starts the agent at once', async (_label, config) => {
    writeConfig(config);

    const run = await cockpit(['setup', '--shell', '--then', agent], { env: SESSION() });
    await reportsSettled(1);

    expect(run.lines[0]).toBe('agent-started');
    expect(run.lines.join('\n')).not.toMatch(/cockpit setup|Setup done|Setup failed/);
    expect(run.stub.file('agent.cwd')?.trim()).toBe(worktree);
    expect(events()).not.toContain('setup-running');
    expect(events()).not.toContain('setup-failed');
  });

  test('AC8 — a config the package refuses prints "✗ Setup failed: <reason>" naming the file, runs no command, and continues as a failure: hint, login shell, setup-failed reported', async () => {
    writeConfig({ setup: ['touch "$COCKPIT_ROOT_PATH/should-not-exist"'], run: ['bun dev'] });

    const run = await cockpit(['setup', '--shell', '--then', agent], { env: SESSION() });
    await reportsSettled(1);

    const failure = run.lines.find((line) => line.startsWith('✗ Setup failed: '));
    expect(failure).toContain('config.json');
    expect(run.lines.some((line) => line.startsWith('$ '))).toBe(false);
    expect(run.lines.slice(-2)).toEqual(['Claude Code was not started. Run `cockpit setup --then claude` to try again.', 'shell-prompt']);
    expect(existsSync(join(repo, 'should-not-exist'))).toBe(false);
    expect(run.stub.file('agent.cwd')).toBeUndefined();
    expect(events().at(-1)).toBe('setup-failed');
    expect(events()).not.toContain('exited');
  });

  test('AC8 — run in the main working tree (not a linked worktree), it prints "✗ Setup failed: <reason>", runs no command and continues as a failure', async () => {
    writeConfig({ setup: ['touch "$COCKPIT_ROOT_PATH/should-not-exist"'] });

    const run = await cockpit(['setup', '--shell', '--then', agent], { cwd: repo, env: SESSION() });
    await reportsSettled(1);

    expect(run.lines.find((line) => line.startsWith('✗ Setup failed: '))).toBeDefined();
    expect(run.lines.some((line) => line.startsWith('$ '))).toBe(false);
    expect(run.lines.slice(-2)).toEqual(['Claude Code was not started. Run `cockpit setup --then claude` to try again.', 'shell-prompt']);
    expect(existsSync(join(repo, 'should-not-exist'))).toBe(false);
    expect(run.stub.file('agent.cwd')).toBeUndefined();
    expect(events().at(-1)).toBe('setup-failed');
  });

  test('AC10 — without COCKPIT_SESSION_ID (a terminal that is not a session) it runs as usual and reports nothing', async () => {
    writeConfig({ setup: ['echo quiet'] });

    const run = await cockpit(['setup', '--then', agent], { env: { COCKPIT_SOCKET: socket } });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(run.lines.slice(0, 5)).toEqual([HEADER('setup'), '$ echo quiet', 'quiet', '✓ Setup done', 'agent-started']);
    expect(reports).toEqual([]);
  });
});

describe('cockpit teardown', () => {
  test('AC11 — prints the header, each "$ <command>" line with its output and "✓ Teardown done", exits 0, starts no shell and reports nothing', async () => {
    const env = 'echo "td:$COCKPIT_ROOT_PATH|$COCKPIT_WORKSPACE_PATH|$COCKPIT_WORKSPACE_NAME"';
    writeConfig({ setup: ['echo not-this'], teardown: [env, 'echo second'] });

    const run = await cockpit(['teardown'], { env: SESSION() });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(run.code).toBe(0);
    expect(run.lines).toEqual([HEADER('teardown'), `$ ${env}`, `td:${repo}|${worktree}|${BRANCH}`, '$ echo second', 'second', '✓ Teardown done']);
    expect(run.stub.file('shell.cwd'), 'no login shell follows a teardown').toBeUndefined();
    expect(reports).toEqual([]);
  });

  test('AC11 — a failing command stops it: "✗ Teardown failed: <command> exited with code N", the later commands do not run, and the exit code is N', async () => {
    writeConfig({ teardown: ['echo a', 'exit 5', 'touch "$COCKPIT_ROOT_PATH/should-not-exist"'] });

    const run = await cockpit(['teardown']);

    expect(run.code).toBe(5);
    expect(run.lines).toEqual([HEADER('teardown'), '$ echo a', 'a', '$ exit 5', '✗ Teardown failed: exit 5 exited with code 5']);
    expect(existsSync(join(repo, 'should-not-exist'))).toBe(false);
    expect(run.stub.file('shell.cwd')).toBeUndefined();
  });
});

describe('cockpit usage', () => {
  test.each([
    ['no argument', []],
    ['an unknown command', ['frobnicate']],
    ['setup with an unknown option', ['setup', '--bogus']],
    ['setup --then without a command', ['setup', '--then']],
    ['teardown with an argument', ['teardown', 'extra']],
  ])('AC12 — %s: the three usage lines, exit 2, and nothing run or reported', async (_label, args) => {
    writeConfig({ setup: ['touch "$COCKPIT_ROOT_PATH/usage-ran"'], teardown: ['touch "$COCKPIT_ROOT_PATH/usage-ran"'] });

    const run = await cockpit(args, { env: SESSION() });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(run.code).toBe(2);
    const text = run.lines.join('\n');
    expect(text.startsWith('usage:')).toBe(true);
    for (const line of USAGE_LINES) expect(text).toContain(line);
    expect(text).not.toContain('--shell');
    expect(existsSync(join(repo, 'usage-ran'))).toBe(false);
    expect(run.stub.file('agent.cwd')).toBeUndefined();
    expect(run.stub.file('shell.cwd')).toBeUndefined();
    expect(reports).toEqual([]);
  });
});
