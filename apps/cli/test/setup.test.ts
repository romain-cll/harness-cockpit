import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

// COCKPIT-57: `cockpit setup` and `cockpit teardown`, the compiled binary itself: only Bun's runtime
// shows the stdio inheritance, the signal handling and the exit codes of the children as a pty gives
// them. Turbo builds `dist/cockpit` before `test`. A temporary repository with one linked worktree,
// stub agent and shell scripts, and a fake daemon on a Unix socket that records the reports.
//
// Every run has a fake daemon of its own (its own socket, its own list of reports) and is read after the
// CLI's exit, so a run that outlives its test can never write into another test's reports. The `git` the
// CLI runs is a wrapper on the stubs' PATH that execs the test's own git, optionally held by a FIFO.
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
let testGit: string;

const cleanups: Array<() => void> = [];
const running = new Set<Running>();
afterEach(async () => {
  // A run still going (a failed test, a held git) is killed and awaited before its folder goes.
  for (const run of running) {
    run.kill();
    await run.done.catch(() => undefined);
  }
  running.clear();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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
  // The git of this test file: what its own `git` calls run. The CLI gets a wrapper that execs it, and that
  // blocks on the FIFO "$STUB_DIR/git-gate" (reads it once, removes it) when a run asks for one.
  testGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
if [ -p "$STUB_DIR/git-gate" ]; then
  read -r _ < "$STUB_DIR/git-gate"
  rm -f "$STUB_DIR/git-gate"
fi
exec '${testGit}' "$@"
`,
  );
  for (const stub of [agent, shell, join(bin, 'git')]) chmodSync(stub, 0o755);
  // macOS scans a new executable the first time it runs.
  const warm = mkdtempSync(join(tmpdir(), 'ck-'));
  for (const stub of [agent, shell, join(bin, 'git')]) execFileSync(stub, ['--version'], { env: { STUB_DIR: warm } });
  rmSync(warm, { recursive: true, force: true });
});

afterAll(() => {
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
  /** What this run's own fake daemon was sent with the right token. */
  reports: Array<Record<string, unknown>>;
}

interface Running {
  /** Resolves on the CLI's exit, with everything it printed and reported. */
  done: Promise<Run>;
  /** Lets a git call held by `gated` go on; resolves once the held git read it. */
  release(): Promise<void>;
  kill(): void;
}

interface Options {
  cwd?: string;
  env?: Record<string, string>;
  /** Sets COCKPIT_SESSION_ID and COCKPIT_SOCKET (this run's fake daemon). */
  session?: string;
  /** Sets COCKPIT_SOCKET alone. */
  socketOnly?: boolean;
  /** The first git call of the CLI blocks on a FIFO until `release()`. */
  gated?: boolean;
}

/** Starts the compiled binary with stdout and stderr on one file, so the order of the lines is the pty's. */
function start(args: string[], { cwd = worktree, env = {}, session, socketOnly = false, gated = false }: Options = {}): Running {
  const dir = mkdtempSync(join(tmpdir(), 'ck-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const gate = join(dir, 'git-gate');
  if (gated) execFileSync('mkfifo', [gate]);
  const socket = join(dir, 'daemon-1-run.sock');
  writeFileSync(socket.replace(/\.sock$/, '.token'), TOKEN);
  const reports: Array<Record<string, unknown>> = [];
  // This run's fake daemon: records every report it is sent with the right token and answers 204.
  const server = createServer((req, res) => {
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
  const output = join(dir, 'output.txt');
  const fd = openSync(output, 'w');
  let child: ChildProcess | undefined;
  let killed = false;
  // A group of its own, so killing it takes the git wrapper blocked on the FIFO along.
  const kill = () => {
    killed = true;
    if (child?.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  };
  const done = (async (): Promise<Run> => {
    try {
      await new Promise<void>((listening) => server.listen(socket, listening));
      const code = await new Promise<number | null>((exited, fail) => {
        child = spawn(BINARY, args, {
          cwd,
          detached: true,
          stdio: ['ignore', fd, fd],
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            SHELL: shell,
            STUB_DIR: dir,
            ...gitEnv,
            ...(session === undefined ? {} : { COCKPIT_SOCKET: socket, COCKPIT_SESSION_ID: session }),
            ...(socketOnly ? { COCKPIT_SOCKET: socket } : {}),
            ...env,
          },
        });
        if (killed) kill();
        child.on('error', fail);
        child.on('close', exited);
      });
      const lines = stripAnsi(readFileSync(output, 'utf8'))
        .replaceAll('\r', '')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean);
      const file = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined);
      return { code, lines, stub: { dir, file }, reports };
    } finally {
      closeSync(fd);
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    }
  })();
  const handle: Running = { done, release: () => writeFile(gate, 'go\n'), kill };
  running.add(handle);
  return handle;
}

const cockpit = (args: string[], options?: Options): Promise<Run> => start(args, options).done;

const SESSION = 'session-1';
const nulSplit = (text: string | undefined) => (text === undefined ? undefined : text.split('\0').slice(0, -1));
const events = (run: Run) => run.reports.map((report) => report.event);

describe('cockpit setup', () => {
  test('AC1 — prints the header, a "$ <command>" line and the output of each command in order, "✓ Setup done", then runs the agent in the worktree with its arguments intact; the commands get the three environment variables; the reports are setup-running, setup-done, exited', async () => {
    const env = 'echo "env:$COCKPIT_ROOT_PATH|$COCKPIT_WORKSPACE_PATH|$COCKPIT_WORKSPACE_NAME"';
    writeConfig({ setup: [env, 'pwd -P', 'echo one; echo two'] });
    const prompt = `say "hi" $HOME 100% 'q'\nsecond line`;
    const settings = '{"hooks":{"Stop":[]}}';

    const run = await cockpit(['setup', '--then', agent, '--settings', settings, prompt], { session: SESSION });

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
    expect(run.reports).toEqual([
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

    const run = await cockpit(['setup', '--shell', '--then', agent], { session: SESSION, env: { STUB_AGENT: how } });

    expect(run.lines.slice(0, 5)).toEqual([HEADER('setup'), '$ echo only', 'only', '✓ Setup done', 'agent-started']);
    expect(run.lines).toContain(line);
    expect(run.lines.at(-1)).toBe('shell-prompt');
    expect(run.lines.indexOf(line)).toBeLessThan(run.lines.indexOf('shell-prompt'));
    expect(run.stub.file('shell.cwd')?.trim()).toBe(worktree);
    expect(nulSplit(run.stub.file('shell.argv'))).toEqual(['-l']);
    expect(run.reports.at(-1)).toEqual({ sessionId: 'session-1', event: 'exited', exitCode });
    expect(events(run)).toEqual(['setup-running', 'setup-done', 'exited']);
  });

  test('AC15 — "--then <binary>" that cannot be spawned (no such file), once the setup passes: "[<binary> could not start: <reason>]" is printed, exited is reported with a null exit code, and with --shell the login shell (-l) starts in the worktree', async () => {
    writeConfig({ setup: ['echo only'] });
    const missing = join(bin, 'no-such-agent');

    const run = await cockpit(['setup', '--shell', '--then', missing, '--some', 'arg'], { session: SESSION });

    expect(run.lines.slice(0, 4)).toEqual([HEADER('setup'), '$ echo only', 'only', '✓ Setup done']);
    expect(run.lines[4]).toMatch(/^\[(.*\/)?no-such-agent could not start: .+\]$/);
    expect(run.lines.at(-1)).toBe('shell-prompt');
    expect(run.lines.indexOf('shell-prompt')).toBeGreaterThan(4);
    expect(run.stub.file('agent.cwd'), 'no stub agent ran').toBeUndefined();
    expect(run.stub.file('shell.cwd')?.trim()).toBe(worktree);
    expect(nulSplit(run.stub.file('shell.argv'))).toEqual(['-l']);
    expect(run.reports).toEqual([
      { sessionId: 'session-1', event: 'setup-running' },
      { sessionId: 'session-1', event: 'setup-done' },
      { sessionId: 'session-1', event: 'exited', exitCode: null },
    ]);
  });

  test('AC3 — a command that exits with code N stops the setup: the later commands do not run, the failure and the hint lines are printed, then the login shell starts in the worktree and the agent never does', async () => {
    writeConfig({ setup: ['echo before', 'echo bad; exit 4', 'touch "$COCKPIT_ROOT_PATH/should-not-exist"'] });

    const run = await cockpit(['setup', '--shell', '--then', agent, '--some', 'arg'], { session: SESSION });

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
    expect(events(run)).toEqual(['setup-running', 'setup-failed']);
  });

  test('AC3 — a command killed by a signal (Ctrl+C included) is a failure too: "was killed by <SIGNAL>", the later commands do not run, and the CLI itself survives it', async () => {
    writeConfig({ setup: ['echo start', 'kill -INT $$', 'echo after'] });

    const run = await cockpit(['setup'], { session: SESSION });

    expect(run.lines).toEqual([HEADER('setup'), '$ echo start', 'start', '$ kill -INT $$', '✗ Setup failed: kill -INT $$ was killed by SIGINT']);
    expect(events(run)).toEqual(['setup-running', 'setup-failed']);
  });

  test('AC4 — typed in the shell a failure left: a plain "cockpit setup" runs again with the output of AC1 and returns (no shell, no agent, exit 0); "--then claude" found on the PATH starts the agent after "✓ Setup done", still without a shell', async () => {
    writeConfig({ setup: ['echo again'] });

    const plain = await cockpit(['setup'], { session: SESSION });
    expect(plain.code).toBe(0);
    expect(plain.lines).toEqual([HEADER('setup'), '$ echo again', 'again', '✓ Setup done']);
    expect(plain.stub.file('agent.cwd')).toBeUndefined();
    expect(plain.stub.file('shell.cwd'), 'no nested shell').toBeUndefined();
    expect(events(plain)).toEqual(['setup-running', 'setup-done']);

    const then = await cockpit(['setup', '--then', 'claude'], { session: SESSION });
    expect(then.lines.slice(0, 5)).toEqual([HEADER('setup'), '$ echo again', 'again', '✓ Setup done', 'agent-started']);
    expect(then.stub.file('agent.cwd')?.trim()).toBe(worktree);
    expect(then.stub.file('shell.cwd'), 'no nested shell').toBeUndefined();
    expect(events(then)).toEqual(['setup-running', 'setup-done', 'exited']);
  });

  test.each([
    ['no config file', undefined],
    ['a config without setup commands', { teardown: ['echo only-teardown'] }],
  ])('AC7 — with %s the setup prints nothing of its own, reports no setup state and starts the agent at once', async (_label, config) => {
    writeConfig(config);

    const run = await cockpit(['setup', '--shell', '--then', agent], { session: SESSION });

    expect(run.lines[0]).toBe('agent-started');
    expect(run.lines.join('\n')).not.toMatch(/cockpit setup|Setup done|Setup failed/);
    expect(run.stub.file('agent.cwd')?.trim()).toBe(worktree);
    expect(events(run)).not.toContain('setup-running');
    expect(events(run)).not.toContain('setup-failed');
  });

  test('AC8 — a config the package refuses prints "✗ Setup failed: <reason>" naming the file, runs no command, and continues as a failure: hint, login shell, setup-failed reported', async () => {
    writeConfig({ setup: ['touch "$COCKPIT_ROOT_PATH/should-not-exist"'], run: ['bun dev'] });

    const run = await cockpit(['setup', '--shell', '--then', agent], { session: SESSION });

    const failure = run.lines.find((line) => line.startsWith('✗ Setup failed: '));
    expect(failure).toContain('config.json');
    expect(run.lines.some((line) => line.startsWith('$ '))).toBe(false);
    expect(run.lines.slice(-2)).toEqual(['Claude Code was not started. Run `cockpit setup --then claude` to try again.', 'shell-prompt']);
    expect(existsSync(join(repo, 'should-not-exist'))).toBe(false);
    expect(run.stub.file('agent.cwd')).toBeUndefined();
    expect(events(run).at(-1)).toBe('setup-failed');
    expect(events(run)).not.toContain('exited');
  });

  test('AC8 — run in the main working tree (not a linked worktree), it prints "✗ Setup failed: <reason>", runs no command and continues as a failure', async () => {
    writeConfig({ setup: ['touch "$COCKPIT_ROOT_PATH/should-not-exist"'] });

    const run = await cockpit(['setup', '--shell', '--then', agent], { cwd: repo, session: SESSION });

    expect(run.lines.find((line) => line.startsWith('✗ Setup failed: '))).toBeDefined();
    expect(run.lines.some((line) => line.startsWith('$ '))).toBe(false);
    expect(run.lines.slice(-2)).toEqual(['Claude Code was not started. Run `cockpit setup --then claude` to try again.', 'shell-prompt']);
    expect(existsSync(join(repo, 'should-not-exist'))).toBe(false);
    expect(run.stub.file('agent.cwd')).toBeUndefined();
    expect(events(run).at(-1)).toBe('setup-failed');
  });

  test('AC10 — without COCKPIT_SESSION_ID (a terminal that is not a session) it runs as usual and reports nothing', async () => {
    writeConfig({ setup: ['echo quiet'] });

    const run = await cockpit(['setup', '--then', agent], { socketOnly: true });

    expect(run.lines.slice(0, 5)).toEqual([HEADER('setup'), '$ echo quiet', 'quiet', '✓ Setup done', 'agent-started']);
    expect(run.reports).toEqual([]);
  });
});

describe('cockpit teardown', () => {
  test('AC11 — prints the header, each "$ <command>" line with its output and "✓ Teardown done", exits 0, starts no shell and reports nothing', async () => {
    const env = 'echo "td:$COCKPIT_ROOT_PATH|$COCKPIT_WORKSPACE_PATH|$COCKPIT_WORKSPACE_NAME"';
    writeConfig({ setup: ['echo not-this'], teardown: [env, 'echo second'] });

    const run = await cockpit(['teardown'], { session: SESSION });

    expect(run.code).toBe(0);
    expect(run.lines).toEqual([HEADER('teardown'), `$ ${env}`, `td:${repo}|${worktree}|${BRANCH}`, '$ echo second', 'second', '✓ Teardown done']);
    expect(run.stub.file('shell.cwd'), 'no login shell follows a teardown').toBeUndefined();
    expect(run.reports).toEqual([]);
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

    const run = await cockpit(args, { session: SESSION });

    expect(run.code).toBe(2);
    const text = run.lines.join('\n');
    expect(text.startsWith('usage:')).toBe(true);
    for (const line of USAGE_LINES) expect(text).toContain(line);
    expect(text).not.toContain('--shell');
    expect(existsSync(join(repo, 'usage-ran'))).toBe(false);
    expect(run.stub.file('agent.cwd')).toBeUndefined();
    expect(run.stub.file('shell.cwd')).toBeUndefined();
    expect(run.reports).toEqual([]);
  });
});

// COCKPIT-80: the CLI's runs are deterministic. Its git is the test's own git, and a run's reports are its own.
describe('deterministic runs (COCKPIT-80)', () => {
  test('AC1 — the git the CLI runs is the one the test runs: `command -v git` prints the wrapper on the stubs\' PATH, and it answers with the test\'s own git', async () => {
    writeConfig({ setup: ['command -v git', 'git --version'] });

    const run = await cockpit(['setup']);

    const ownVersion = execFileSync(testGit, ['--version'], { encoding: 'utf8' }).trim();
    expect(run.lines.slice(1, 5)).toEqual(['$ command -v git', join(bin, 'git'), '$ git --version', ownVersion]);
    expect(run.lines).not.toContain('/usr/bin/git');
    expect(readFileSync(join(bin, 'git'), 'utf8')).toContain(`exec '${testGit}'`);
  });

  test('AC2 — a run whose first git call is held does not take the reports of a run that starts and ends meanwhile: each run holds exactly its own three, and the held one has not ended', async () => {
    writeConfig({ setup: ['echo held'] });
    const held = start(['setup', '--then', agent], { session: 'session-held', gated: true });
    let heldEnded = false;
    void held.done.then(
      () => (heldEnded = true),
      () => (heldEnded = true),
    );

    const second = await cockpit(['setup', '--then', agent], { session: 'session-second' });

    expect(second.code).toBe(0);
    expect(second.reports).toEqual([
      { sessionId: 'session-second', event: 'setup-running' },
      { sessionId: 'session-second', event: 'setup-done' },
      { sessionId: 'session-second', event: 'exited', exitCode: 0 },
    ]);
    expect(heldEnded, 'the held run has not ended').toBe(false);

    await held.release();
    const first = await held.done;

    expect(first.code).toBe(0);
    expect(first.lines).toContain('✓ Setup done');
    expect(first.reports).toEqual([
      { sessionId: 'session-held', event: 'setup-running' },
      { sessionId: 'session-held', event: 'setup-done' },
      { sessionId: 'session-held', event: 'exited', exitCode: 0 },
    ]);
  });
});
