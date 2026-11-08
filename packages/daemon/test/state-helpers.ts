import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { expect } from 'vitest';
import { runCli } from '../src/cli';
import { daemonFiles, runDaemon } from '../src/index';
import { BUILD, connectTo, makeHome, onCleanup, waitForOutput } from './helpers';

// What the tests of the state moved into the daemon (COCKPIT-37) assume of the API; the spec names the
// pieces, not every signature.
//
// - `runDaemon({ home, build, stateDir, cli })` loads `<stateDir>/state.json` and runs the state-writing
//   actions; `cli` is the `cockpit` binary the sessions' hooks and `cockpit setup` run.
// - `client.call(method, params)` sends a `call` line request (the methods of the spec's `Calls` map);
//   `project-add` takes `{ folder }`.
// - `daemon-launch.json` in the home: `{ executable, bundle, build, stateDir, cli }`. The CLI finds the
//   daemon of `build` in the home, or starts `<executable> <bundle> --cockpit-daemon <build>` with
//   `COCKPIT_HOME`, `COCKPIT_STATE_DIR` and `COCKPIT_CLI`.
// - The commands print one JSON line on stdout (exit 0), or exit 1 when the result is a refusal, 2 for a usage error.

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
// The Bun that compiles the CLI (a pinned devDependency of `apps/cli`) runs TypeScript as it is: it stands for the
// Electron binary that runs the daemon's bundle in the app.
export const BUN = join(REPO_ROOT, 'apps/cli/node_modules/.bin/bun');

export const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

export interface Repo {
  parent: string;
  /** The root as git reports it (macOS `/var` is `/private/var`). */
  root: string;
  name: string;
}

/** `<tmp>/<name>` on `main`, with one commit. */
export function makeRepo(name = 'project'): Repo {
  const parent = realpathSync(makeHome());
  const root = join(parent, name);
  mkdirSync(root);
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'initial');
  return { parent, root, name };
}

/** A folder that is in no repository. */
export function makePlainFolder(name = 'plain'): string {
  const folder = join(realpathSync(makeHome()), name);
  mkdirSync(folder);
  return folder;
}

export const branchesOf = (repo: Repo) => git(repo.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

export const worktreesOf = (repo: Repo) =>
  git(repo.root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .slice(1);

export interface AgentFixture {
  root: string;
  /** The fake login shell: its environment holds the stub `claude` on `PATH`. */
  shell: string;
  /** The `cockpit` the daemon's sessions run: the CLI's source under Bun. */
  cli: string;
  /** The bundle of the daemon's entry (`<executable> <bundle> --cockpit-daemon <build>`). */
  entry: string;
  /** One line per run of the stub (`agent`) and of a repository's setup (`setup`), in order. */
  runs: string;
  /** What the last stub run printed: its working directory, then its arguments, one per line. */
  ran: () => string[];
  /** The file holding the pid of the last stub run (`kill -0` tells whether it still runs). */
  pidFile: string;
  /** The environment the last stub run had. */
  environment: () => Record<string, string>;
}

/**
 * A stub `claude` (it is not an agent: it logs `agent` in `runs`, records its working directory and arguments,
 * prints `agent-ready`, and exits with code 0 on the line `quit`), a login shell that puts it on the `PATH`, the
 * CLI as a script over Bun and the daemon's entry as a script over Bun. Every executable is run once, as
 * macOS scans a new one the first time.
 */
export function makeAgentFixture(): AgentFixture {
  const root = realpathSync(makeHome());
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const runs = join(root, 'runs.log');
  writeFileSync(runs, '');
  const stub = join(bin, 'claude');
  writeFileSync(
    stub,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi
echo agent >> '${runs}'
echo $$ > "$0.pid"
env > "$0.env"
{ pwd -P; printf '%s\\n' "$@"; } > "$0.ran"
echo agent-ready
while IFS= read -r line; do
  [ "$line" = quit ] && exit 0
done
`,
  );
  chmodSync(stub, 0o755);
  const shell = join(root, 'login-shell');
  writeFileSync(shell, `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\nif [ "$1" = -l ] && [ $# -eq 1 ]; then exec /bin/sh; fi\nLOGIN_SHELL_MARK=from-login-shell PATH='${bin}:/usr/bin:/bin' /bin/sh -c "$2"\n`);
  chmodSync(shell, 0o755);
  mkdirSync(join(root, 'cli'));
  const cli = join(root, 'cli', 'cockpit');
  writeFileSync(cli, `#!/bin/sh\nexec '${BUN}' '${join(REPO_ROOT, 'apps/cli/src/main.ts')}' "$@"\n`);
  chmodSync(cli, 0o755);
  const entry = join(root, 'daemon-entry.mjs');
  writeFileSync(
    entry,
    `import { reportReady, runDaemonEntry } from '${join(REPO_ROOT, 'packages/daemon/src/index.ts')}';\nvoid runDaemonEntry(process.argv, process.env, { stderr: process.stderr, exit: (code) => process.exit(code), ready: () => reportReady() });\n`,
  );

  expect(execFileSync(stub, ['--version'], { encoding: 'utf8' }).trim()).toBe('9.9.9');
  execFileSync(shell, ['--warmup']);
  execFileSync(cli, ['status', 'working'], { env: { PATH: '/usr/bin:/bin' } });
  const environment = () =>
    Object.fromEntries(
      readFileSync(`${stub}.env`, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  return { root, shell, cli, entry, runs, ran: () => readFileSync(`${stub}.ran`, 'utf8').split('\n').filter(Boolean), pidFile: `${stub}.pid`, environment };
}

export const runsOf = (fixture: AgentFixture) => readFileSync(fixture.runs, 'utf8').split('\n').filter(Boolean);

export interface Launch {
  executable: string;
  bundle: string;
  build: string;
  stateDir: string;
  cli: string;
}

/** The file the app writes at each launch (`<home>/daemon-launch.json`) and the CLI starts the daemon from. */
export function writeLaunchFile(home: string, launch: Launch): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'daemon-launch.json'), JSON.stringify(launch));
}

export const launchOf = (fixture: AgentFixture, stateDir: string, build = BUILD): Launch => ({ executable: BUN, bundle: fixture.entry, build, stateDir, cli: fixture.cli });

/**
 * A launch whose daemon can run terminals: node-pty does not run under Bun, so the entry is bundled for Node
 * (node-pty stays external, found through a `node_modules` link next to the bundle) and run by this process's Node,
 * as the app runs its bundle with Electron as Node.
 */
export function nodeLaunchOf(fixture: AgentFixture, stateDir: string, build = BUILD): Launch {
  const bundle = join(fixture.root, 'daemon-bundle.mjs');
  execFileSync(BUN, ['build', fixture.entry, '--target', 'node', '--external', 'node-pty', '--outfile', bundle], { stdio: 'pipe' });
  symlinkSync(join(REPO_ROOT, 'packages/daemon/node_modules'), join(fixture.root, 'node_modules'));
  return { executable: process.execPath, bundle, build, stateDir, cli: fixture.cli };
}

export const newStateDir = () => join(realpathSync(makeHome()), 'user-data');

export const stateFileIn = (stateDir: string) => join(stateDir, 'state.json');

export interface StoredSession {
  id: string;
  name: string;
  harness: string;
  directory: string;
  createdAt: string;
  project?: string;
  open?: boolean;
  harnessSessionId?: string;
}

export const stateIn = (stateDir: string) =>
  JSON.parse(readFileSync(stateFileIn(stateDir), 'utf8')) as { version: number; projects?: Array<{ path: string; mainWorkspace?: boolean }>; sessions?: StoredSession[] };

/**
 * Resolves once `holds` is true of `state.json`: read at once and after every change of its folder (the state is
 * written to a temporary file and renamed over it). `action` runs after the watcher is in place, so a write it causes
 * is never missed. No timer.
 */
export function untilState(stateDir: string, holds: (state: ReturnType<typeof stateIn>) => boolean, action?: () => Promise<unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      let state: ReturnType<typeof stateIn>;
      try {
        state = stateIn(stateDir);
      } catch {
        return;
      }
      if (!holds(state)) return;
      watcher.close();
      resolve();
    };
    const watcher = watch(stateDir, check);
    onCleanup(() => watcher.close());
    (action?.() ?? Promise.resolve()).then(check, (error: unknown) => {
      watcher.close();
      reject(error);
    });
  });
}

/**
 * A daemon of this process, running the stub's login shell, with its state in a folder of its own and its launch
 * file in the home, as the app leaves them. `state` seeds `state.json` before the daemon loads it.
 */
export async function startStateDaemon({ fixture, state, build = BUILD, home = realpathSync(makeHome()) }: { fixture: AgentFixture; state?: object; build?: string; home?: string }) {
  // A real path by default: git reports worktrees by theirs (macOS `/var` is `/private/var`).
  const stateDir = newStateDir();
  if (state) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFileIn(stateDir), JSON.stringify(state));
  }
  // The daemon resolves its login shell's environment from `SHELL`, once.
  const shell = process.env.SHELL;
  process.env.SHELL = fixture.shell;
  onCleanup(() => {
    if (shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = shell;
  });
  const daemon = await runDaemon({ home, build, stateDir, cli: fixture.cli });
  onCleanup(() => daemon.close());
  writeLaunchFile(home, launchOf(fixture, stateDir, build));
  return { home, stateDir, daemon, socket: daemon.socketPath, build };
}

/** The line a `cockpit` command printed: the only one, ended by a newline, a JSON object. */
export function jsonLine(out: string): any {
  expect(out.endsWith('\n'), 'the output ends with a newline').toBe(true);
  const lines = out.split('\n').filter(Boolean);
  expect(lines, 'one line').toHaveLength(1);
  return JSON.parse(lines[0]!);
}

/**
 * Runs the CLI in this process, from a plain shell: `COCKPIT_HOME` set (`home: undefined` leaves it unset), no
 * `COCKPIT_SOCKET`, in `cwd` when given (a relative path is resolved against it).
 */
export async function cockpit(argv: string[], { home, env = {}, stdin = '', cwd }: { home: string | undefined; env?: Record<string, string | undefined>; stdin?: string; cwd?: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const before = process.cwd();
  if (cwd !== undefined) process.chdir(cwd);
  try {
    await runCli(argv, { PATH: process.env.PATH, HOME: process.env.HOME, SHELL: process.env.SHELL, COCKPIT_HOME: home, ...env } as NodeJS.ProcessEnv, {
      stdin: Readable.from(stdin === '' ? [] : [Buffer.from(stdin)], { objectMode: false }),
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
      exit: (code: number) => void exits.push(code),
    });
  } finally {
    process.chdir(before);
  }
  return { out: out.join(''), err: err.join(''), exits };
}

/** Sets variables of this process (`undefined` removes one) until the end of the test: a daemon the CLI starts, or `homedir()`, reads them. */
export function setProcessEnv(variables: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(variables)) {
    const before = process.env[name];
    onCleanup(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Ends the daemon the CLI started in `home` (detached: nobody else would). */
export function endDaemonIn(home: string, build = BUILD): void {
  onCleanup(() => {
    try {
      process.kill(Number(readFileSync(daemonFiles(home, 1, build).pid, 'utf8')), 'SIGTERM');
    } catch {
      // It never started, or is gone.
    }
  });
}

/** Waits until the session's terminal has printed `text`, whether before or after the call. `build` is the daemon's own: another one would supersede it. */
export async function untilSessionPrints(socket: string, sessionId: string, text: string, build = BUILD): Promise<void> {
  const connection = await connectTo(socket, build);
  const terminal = (await connection.client.list()).find((entry) => entry.sessionId === sessionId);
  expect(terminal, `a terminal for session ${sessionId}`).toBeDefined();
  const attached = await connection.client.attach(terminal!.id);
  if (!attached.screen.includes(text)) await waitForOutput(connection, terminal!.id, text);
  connection.client.close();
}

/** A daemon whose state holds a repository as a project, with `run` for CLI commands and `create` for a workspace. */
export async function startProjectDaemon(build = BUILD) {
  const fixture = makeAgentFixture();
  const repo = makeRepo();
  const daemon = await startStateDaemon({ fixture, state: { version: 1, projects: [{ path: repo.root }] }, build });
  const run = (argv: string[]) => cockpit(argv, { home: daemon.home });
  const create = async (task: string) => {
    const result = await run(['ws', 'create', '--project', repo.root, '--task', task]);
    expect(result.exits).toEqual([0]);
    return jsonLine(result.out).workspace as { path: string; branch: string };
  };
  /** Starts the stub in the workspace and gives the session's id, once the stub is running. */
  const startAgent = async (workspace: { path: string }, ...more: string[]) => {
    const result = await run(['session', 'start', '--project', repo.root, '--workspace', workspace.path, '--harness', 'claude-code', '--prompt', 'hello', ...more]);
    expect(result.exits).toEqual([0]);
    const id = jsonLine(result.out).session.id as string;
    await untilSessionPrints(daemon.socket, id, 'agent-ready', build);
    return id;
  };
  return { fixture, repo, ...daemon, run, create, startAgent };
}
