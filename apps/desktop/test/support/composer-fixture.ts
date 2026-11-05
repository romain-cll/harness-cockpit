import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { type Page } from 'playwright-core';
import { expect } from 'vitest';
import { tabsOf } from '../composer';
import { untilRead } from '../launch';
import { makeTestDir } from '../run-root';

// The fixture the composer's test files share (`new-workspace.test.ts`, `workspace-setup.test.ts`): temporary
// repositories, a fake login shell whose `PATH` holds stub agent CLIs and a `git` wrapper that holds calls, FIFOs,
// and the reads of the app's stored sessions and of the terminal on the page.

// --- Fixture -----------------------------------------------------------------

const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
export const gitOrNull = (cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

export interface Repo {
  parent: string;
  root: string;
  name: string;
}

export function makeLight(name: string): Repo {
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  mkdirSync(root);
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
  return { parent, root, name };
}

// A clone with `origin` (branches `develop`, `feature/x` and `release/1.0` besides `main`), a local commit
// on `main` that `origin/main` lacks, and the local branches `local-topic` and `topic/nested`: the default
// base is `origin/main`.
export function makeClone(name: string): Repo {
  const upstream = makeLight(`${name}-upstream`);
  for (const branch of ['develop', 'feature/x', 'release/1.0']) git(upstream.root, 'branch', branch);
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  git(parent, 'clone', '--quiet', upstream.root, root);
  git(root, 'commit', '--allow-empty', '-m', 'local only');
  git(root, 'branch', 'local-topic');
  git(root, 'branch', 'topic/nested');
  return { parent, root, name };
}

export const sha8 = (root: string) => createHash('sha256').update(root).digest('hex').slice(0, 8);
export const localBranches = (repo: Repo) => git(repo.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

// The stub agent: logs every `--version` run, waits on the FIFO `<stub>.gate` while there is one, prints `9.9.9`
// (nothing with `<stub>.noversion`), and as a session logs its working directory and arguments (what the status
// feature adds before them is set aside), prints the idle title, then one title per line of
// `<stub>.titles.<folder>` and writes a line to the FIFO `<stub>.titles.<folder>.done`, `<folder>` being the name of its working
// directory, and echoes what it reads until `exit`. It never pauses: `cockpit setup`'s markers order its titles
// against anything printed before it started. The titles are per folder because a session's agent may start
// after its test ended: it must not print the titles the next test meant for its own session.
function stubScript(runLog: string) {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "$(basename "$0") --version" >> '${runLog}'
  if [ -p "$0.gate" ]; then { read -r _ <&3; } 3<>"$0.gate" 2>/dev/null; fi
  [ -e "$0.noversion" ] || echo 9.9.9
  exit 0
fi
case "$1" in
  --settings) shift 2 ;;
  --no-daemon) shift; if [ "$1" = -c ]; then shift 2; fi ;;
  --standalone) shift ;;
esac
{ echo "---"; echo "cwd=$(pwd -P)"; for a in "$@"; do echo "arg=$a"; done; } >> "$0.starts"
printf '\\033]0;✳ Claude Code\\007'
echo ready
titles="$0.titles.$(basename "$(pwd -P)")"
if [ -e "$titles" ]; then
  while IFS= read -r title; do printf '\\033]0;%s\\007' "$title"; done < "$titles"
  if [ -p "$titles.done" ]; then { echo >&3; } 3<>"$titles.done" 2>/dev/null; fi
fi
while IFS= read -r line; do
  [ "$line" = exit ] && exit 3
  echo "got:$line"
done
`;
}

export interface Fixture {
  root: string;
  bin: string;
  shellLog: string;
  runLog: string;
  env(): NodeJS.ProcessEnv;
}

export function makeFixture(): Fixture {
  const root = realpathSync(makeTestDir('s-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const runLog = join(root, 'runs.log');
  const shell = join(root, 'login-shell');
  const shellLog = join(root, 'shell-args.log');
  // Started as a login shell with no command (`-l`) it is an interactive /bin/sh with a prompt of its own;
  // run with `-ilc <script>` (the app resolving its environment) it runs the script with the stubs' `PATH`.
  writeFileSync(
    shell,
    `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\necho "$*" >> '${shellLog}'\n[ "$*" = -l ] && { PS1='login-shell> '; export PS1; exec /bin/sh -i; }\nPATH='${bin}:/usr/bin:/bin' /bin/sh -c "$2"\n`,
  );
  chmodSync(shell, 0o755);
  execFileSync(shell, ['--warmup']);
  // A `git` first on the PATH that, while the FIFO `<root>/git-block` exists, writes a line to the FIFO
  // `<root>/git-waiting` and holds `worktree add` until a line comes through `git-block`; it logs each
  // `worktree add` in `git-adds.log` and runs the real git. The same goes for the branch listing the
  // reservation of a name reads (`for-each-ref --format=%(refname:short)`) with `read-block` and `read-waiting`
  // (COCKPIT-89 AC11). A `worktree add` that ends writes a line to the FIFO `add-done` when there is one.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const wrapper = join(bin, 'git');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then\n  echo add >> '${root}/git-adds.log'\n  if [ -p '${root}/git-block' ]; then { echo >&3; } 3<>'${root}/git-waiting' 2>/dev/null; { read -r _ <&3; } 3<>'${root}/git-block' 2>/dev/null; fi\nfi\nif [ "$1" = for-each-ref ] && [ "$2" = '--format=%(refname:short)' ] && [ -p '${root}/read-block' ]; then\n  { echo >&3; } 3<>'${root}/read-waiting' 2>/dev/null; { read -r _ <&3; } 3<>'${root}/read-block' 2>/dev/null\nfi\nif [ "$1" = worktree ] && [ "$2" = add ]; then\n  '${realGit}' "$@"; code=$?\n  if [ -p '${root}/add-done' ]; then { echo >&3; } 3<>'${root}/add-done' 2>/dev/null; fi\n  exit $code\nfi\nexec '${realGit}' "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  // macOS scans a new executable the first time it runs.
  execFileSync(wrapper, ['--version']);
  const fx: Fixture = { root, bin, shellLog, runLog, env: () => ({ ...process.env, SHELL: shell }) };
  writeFileSync(runLog, '');
  writeFileSync(shellLog, '');
  return fx;
}

export function installStub(fx: Fixture, name: string, { noVersion = false }: { noVersion?: boolean } = {}) {
  const stub = join(fx.bin, name);
  writeFileSync(stub, stubScript(fx.runLog));
  chmodSync(stub, 0o755);
  if (noVersion) writeFileSync(`${stub}.noversion`, '');
  // macOS scans a new executable the first time it runs; that run is not one the app made.
  const logged = readFileSync(fx.runLog, 'utf8');
  execFileSync(stub, ['--version'], { encoding: 'utf8' });
  writeFileSync(fx.runLog, logged);
}

export const removeStub = (fx: Fixture, name: string) => rmSync(join(fx.bin, name), { force: true });

// A FIFO between the test and a stub. Both sides open it read-write, so neither open blocks, and the test holds
// it open, so a line written before the other side reads it stays in the pipe. A stub waits on one with `read`
// until the test writes a line, or writes a line the test waits for: no side polls a file.
export async function openFifo(path: string): Promise<FileHandle> {
  rmSync(path, { force: true });
  execFileSync('mkfifo', [path]);
  return open(path, 'r+');
}

// Lets every stub waiting on the FIFO go on, then removes it so a stub that comes later does not wait.
export async function releaseFifo(fifo: FileHandle, path: string) {
  await fifo.write('\n'.repeat(16));
  rmSync(path, { force: true });
  await fifo.close();
}

// Waits for a stub to write a line to the FIFO.
export const signalled = async (fifo: FileHandle) => {
  await fifo.read(Buffer.alloc(1), 0, 1, null);
};

export interface Start {
  cwd: string;
  args: string[];
}

// What the stub `name` was started with, one entry per start.
export function startsOf(fx: Fixture, name: string): Start[] {
  const file = join(fx.bin, `${name}.starts`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('---\n')
    .filter(Boolean)
    .map((record) => {
      const lines = record.split('\n').filter(Boolean);
      return {
        cwd: lines.find((line) => line.startsWith('cwd='))!.slice('cwd='.length),
        args: lines.filter((line) => line.startsWith('arg=')).map((line) => line.slice('arg='.length)),
      };
    });
}

export const shellRuns = (fx: Fixture) => readFileSync(fx.shellLog, 'utf8').split('\n').filter((line) => line === '-l').length;

export interface StoredSession {
  id: string;
  name: string;
  harness: string;
  directory: string;
  project?: string;
}

export const sessionsInState = (dataDir: string): StoredSession[] =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { sessions?: StoredSession[] }).sessions ?? [];

// The worktree of `branch` and the folder of a project's worktrees under the launch's COCKPIT_HOME `home`.
export const worktreesDirIn = (home: string, repo: Repo) => join(home, 'worktrees', `${repo.name}-${sha8(repo.root)}`);
export const worktreeIn = (home: string, repo: Repo, branch: string) => join(worktreesDirIn(home, repo), branch);

// --- Page helpers ------------------------------------------------------------

// The sidebar row titled `path`.
export const entryOf = (page: Page, path: string) => page.locator(`aside [title="${path}"]`).first();

// The labels of the tabs of the workspace page and which are selected (a tab bears the session's name until
// its program sets a title, then that title).
export const tabs = tabsOf;

// The same rows read in the page, at once and after each DOM mutation, until one is the text. Self-contained: it runs in `untilRead`.
const readVisibleRows = () => {
  const terminal = [...document.querySelectorAll('.xterm-rows')].find((element) => {
    const { width, height } = element.getBoundingClientRect();
    return width > 0 && height > 0 && getComputedStyle(element).visibility !== 'hidden';
  });
  return terminal ? [...terminal.children].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()) : [];
};
export const waitForRow = async (page: Page, text: string) => {
  const rows = await untilRead(page, readVisibleRows, (found, wanted: string) => found.includes(wanted), text);
  expect(rows, `the terminal shows "${text}"`).toContain(text);
};


// --- COCKPIT-89: a new workspace exists at once, with a setting-up status ------------------------------------

// Holds one git call of the app on the fixture's `git` until `release()`: `'git'` the `worktree add` (the
// worktree does not exist meanwhile), `'read'` the branch listing the reservation of the name reads. `reached()`
// resolves once a call is held.
export interface Hold {
  reached(): Promise<void>;
  /** Starts listening for the end of the held `worktree add` (before `release()`, `'git'` only); `await` the result once released. */
  watchEnd(): Promise<() => Promise<void>>;
  release(): Promise<void>;
}
export async function holdGit(fx: Fixture, call: 'git' | 'read'): Promise<Hold> {
  const blockPath = join(fx.root, `${call}-block`);
  const waitingPath = join(fx.root, `${call}-waiting`);
  const donePath = join(fx.root, 'add-done');
  const waiting = await openFifo(waitingPath);
  const block = await openFifo(blockPath);
  let released = false;
  return {
    reached: () => signalled(waiting),
    watchEnd: async () => {
      const done = await openFifo(donePath);
      return async () => {
        await signalled(done);
        rmSync(donePath, { force: true });
        await done.close();
      };
    },
    release: async () => {
      if (released) return;
      released = true;
      await releaseFifo(block, blockPath);
      await waiting.close();
      rmSync(waitingPath, { force: true });
    },
  };
}

export const loadingText = (page: Page) => page.locator('main').getByText('Setting up workspace…', { exact: true });
