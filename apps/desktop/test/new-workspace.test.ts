import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type Locator, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MAIN_PROCESS_ERROR, launchSpawned, startClock, untilRead, versionLabel, type Session } from './launch';
import { makeTestDir } from './run-root';
import {
  agentSelect,
  basePopup,
  baseSelect,
  chooseBase,
  closePopups,
  createButton,
  detectAgain,
  isDisabledItem,
  itemTexts,
  itemsOf,
  messageOf,
  waitForMessage,
  norm,
  openComposer,
  openComposerFromSidebar,
  openPopup as openMenu,
  pickAgent,
  projectSelect,
  promptBox,
  searchBranches,
  textOf,
  useAgent,
  waitForAgent,
  waitForBase,
  storedSessions,
  tabsOf,
  waitForNewSession,
  waitForSelectedTab,
  waitForWorkspacePage,
} from './composer';
import { projectColour } from '../src/renderer/components/project-colour';
import { openPopup } from './composer';
import { afterIpcAnswers, countIpcCalls, ipcAnswered, ipcCalls, stateSnapshot, waitForSetupLabel } from './support/projects';
import { expectNoErrors, launchBuiltWith, locationsSeen, makeSessionsFixture, recordLocations, sessionEntries, sessionIdOf, type SessionsFixture, watchStarts } from './support/sessions';
import { daemonPidIn } from './support/panes';
import { activePane, goHome } from './support/terminal';

// COCKPIT-66: the New workspace page (the composer at `/`). One built-app launch with a fake login
// shell whose `PATH` holds stub agent CLIs (a stub is a `#!/bin/sh` file that logs its launch, so no
// real CLI ever runs), a seeded `state.json` (the projects) and a `git` that is the real one. The
// tests run in order on that launch: the first ones see the detection still running (the stubs'
// `--version` waits for a gate file), the later ones change what is on the `PATH` and detect again.

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

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const gitOrNull = (cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

interface Repo {
  parent: string;
  root: string;
  name: string;
}

function makeLight(name: string): Repo {
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
function makeClone(name: string): Repo {
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

const sha8 = (root: string) => createHash('sha256').update(root).digest('hex').slice(0, 8);
const localBranches = (repo: Repo) => git(repo.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

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

interface Fixture {
  root: string;
  bin: string;
  shellLog: string;
  runLog: string;
  env(): NodeJS.ProcessEnv;
}

function makeFixture(): Fixture {
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
  // (COCKPIT-89 AC11).
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const wrapper = join(bin, 'git');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then\n  echo add >> '${root}/git-adds.log'\n  if [ -p '${root}/git-block' ]; then { echo >&3; } 3<>'${root}/git-waiting' 2>/dev/null; { read -r _ <&3; } 3<>'${root}/git-block' 2>/dev/null; fi\nfi\nif [ "$1" = for-each-ref ] && [ "$2" = '--format=%(refname:short)' ] && [ -p '${root}/read-block' ]; then\n  { echo >&3; } 3<>'${root}/read-waiting' 2>/dev/null; { read -r _ <&3; } 3<>'${root}/read-block' 2>/dev/null\nfi\nexec '${realGit}' "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  // macOS scans a new executable the first time it runs.
  execFileSync(wrapper, ['--version']);
  const fx: Fixture = { root, bin, shellLog, runLog, env: () => ({ ...process.env, SHELL: shell }) };
  writeFileSync(runLog, '');
  writeFileSync(shellLog, '');
  return fx;
}

function installStub(fx: Fixture, name: string, { noVersion = false }: { noVersion?: boolean } = {}) {
  const stub = join(fx.bin, name);
  writeFileSync(stub, stubScript(fx.runLog));
  chmodSync(stub, 0o755);
  if (noVersion) writeFileSync(`${stub}.noversion`, '');
  // macOS scans a new executable the first time it runs; that run is not one the app made.
  const logged = readFileSync(fx.runLog, 'utf8');
  execFileSync(stub, ['--version'], { encoding: 'utf8' });
  writeFileSync(fx.runLog, logged);
}

const removeStub = (fx: Fixture, name: string) => rmSync(join(fx.bin, name), { force: true });

// A FIFO between the test and a stub. Both sides open it read-write, so neither open blocks, and the test holds
// it open, so a line written before the other side reads it stays in the pipe. A stub waits on one with `read`
// until the test writes a line, or writes a line the test waits for: no side polls a file.
async function openFifo(path: string): Promise<FileHandle> {
  rmSync(path, { force: true });
  execFileSync('mkfifo', [path]);
  return open(path, 'r+');
}

// Lets every stub waiting on the FIFO go on, then removes it so a stub that comes later does not wait.
async function releaseFifo(fifo: FileHandle, path: string) {
  await fifo.write('\n'.repeat(16));
  rmSync(path, { force: true });
  await fifo.close();
}

// Waits for a stub to write a line to the FIFO.
const signalled = async (fifo: FileHandle) => {
  await fifo.read(Buffer.alloc(1), 0, 1, null);
};

const gates = new Map<string, FileHandle>();
async function setGate(fx: Fixture, names: string[], closed: boolean) {
  for (const name of names) {
    const path = join(fx.bin, `${name}.gate`);
    const held = gates.get(path);
    gates.delete(path);
    if (held) await releaseFifo(held, path);
    if (closed) gates.set(path, await openFifo(path));
  }
}

const versionRuns = (fx: Fixture) => {
  const counts: Record<string, number> = {};
  for (const line of readFileSync(fx.runLog, 'utf8').split('\n').filter(Boolean)) {
    const name = line.replace(' --version', '');
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
};

interface Start {
  cwd: string;
  args: string[];
}

// What the stub `name` was started with, one entry per start.
function startsOf(fx: Fixture, name: string): Start[] {
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

const shellRuns = (fx: Fixture) => readFileSync(fx.shellLog, 'utf8').split('\n').filter((line) => line === '-l').length;

interface StoredSession {
  id: string;
  name: string;
  harness: string;
  directory: string;
  project?: string;
}

const sessionsInState = (dataDir: string): StoredSession[] =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { sessions?: StoredSession[] }).sessions ?? [];

// --- Page helpers ------------------------------------------------------------

const tokenColour = (page: Page, token: string, property: 'color' | 'backgroundColor' = 'color') =>
  page.evaluate(
    ([token, property]) => {
      const probe = document.createElement('span');
      probe.style[property as 'color'] = `var(${token})`;
      document.body.append(probe);
      const value = getComputedStyle(probe)[property as 'color'];
      probe.remove();
      return value;
    },
    [token, property] as const,
  );

const waitForSessionPage = waitForNewSession;

// The labels of the tabs of the workspace page and which are selected (a tab bears the session's name until
// its program sets a title, then that title).
const tabs = tabsOf;

// The rows of the terminal on the page.
const terminalRows = (page: Page) =>
  page
    .locator('.xterm-rows:visible')
    .first()
    .evaluate((element) => [...element.children].map((row) => (row.textContent ?? '').replace(/ /g, ' ').trimEnd()));
// The same rows read in the page, at once and after each DOM mutation, until one is the text. Self-contained: it runs in `untilRead`.
const readVisibleRows = () => {
  const terminal = [...document.querySelectorAll('.xterm-rows')].find((element) => {
    const { width, height } = element.getBoundingClientRect();
    return width > 0 && height > 0 && getComputedStyle(element).visibility !== 'hidden';
  });
  return terminal ? [...terminal.children].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()) : [];
};
const waitForRow = async (page: Page, text: string) => {
  const rows = await untilRead(page, readVisibleRows, (found, wanted: string) => found.includes(wanted), text);
  expect(rows, `the terminal shows "${text}"`).toContain(text);
};

const mainBox = async (locator: Locator) => (await locator.boundingBox())!;

// --- COCKPIT-89: a new workspace exists at once, with a setting-up status ------------------------------------

// Holds one git call of the app on the fixture's `git` until `release()`: `'git'` the `worktree add` (the
// worktree does not exist meanwhile), `'read'` the branch listing the reservation of the name reads. `reached()`
// resolves once a call is held.
interface Hold {
  reached(): Promise<void>;
  release(): Promise<void>;
}
async function holdGit(fx: Fixture, call: 'git' | 'read'): Promise<Hold> {
  const blockPath = join(fx.root, `${call}-block`);
  const waitingPath = join(fx.root, `${call}-waiting`);
  const waiting = await openFifo(waitingPath);
  const block = await openFifo(blockPath);
  let released = false;
  return {
    reached: () => signalled(waiting),
    release: async () => {
      if (released) return;
      released = true;
      await releaseFifo(block, blockPath);
      await waiting.close();
      rmSync(waitingPath, { force: true });
    },
  };
}

const loadingText = (page: Page) => page.locator('main').getByText('Setting up workspace…', { exact: true });
const backToComposer = (page: Page, where: 'main' | 'aside') => page.locator(where).getByRole('button', { name: 'Back to composer', exact: true });
const mainText = async (page: Page) => norm(await page.locator('main').innerText());
// The `li` of the workspace row titled `path` (the innermost one: a project's `li` holds it too).
const rowItem = (page: Page, path: string) => page.locator('aside li').filter({ has: page.locator(`[title="${path}"]`) }).last();
const rightBar = (page: Page) => page.getByRole('complementary', { name: 'Right bar' });
// The sidebar's message under Projects.
const projectsMessage = (page: Page) => page.locator('aside [role="status"]').filter({ hasText: /\S/ });
// Waits for the next `workspaces:settled` event of the main process (a setup ended, whatever its outcome) from the
// moment this is called; `await` the result after the action that settles. The api name is the IPC's: `api.workspaces.onSettled`.
const watchSettled = async (page: Page) => {
  await page.evaluate(() => {
    const win = window as unknown as { __settled?: Promise<void>; api: { workspaces: { onSettled(listener: () => void): () => void } } };
    win.__settled = new Promise<void>((resolve) => {
      const stop = win.api.workspaces.onSettled(() => {
        stop();
        resolve();
      });
    });
  });
  return () => page.evaluate(() => (window as unknown as { __settled: Promise<void> }).__settled);
};

// --- The launch --------------------------------------------------------------

describe('new workspace page: built app', () => {
  let fx: Fixture;
  let session: Session;
  let dataDir: string;
  let clone: Repo;
  let nodef: Repo;
  let gone: Repo;
  let refuse: Repo;
  let home: string;

  const worktreeOf = (repo: Repo, branch: string) => join(home, 'worktrees', `${repo.name}-${sha8(repo.root)}`, branch);
  const worktreesDirOf = (repo: Repo) => join(home, 'worktrees', `${repo.name}-${sha8(repo.root)}`);
  const listing = (repo: Repo) => (existsSync(worktreesDirOf(repo)) ? readdirSync(worktreesDirOf(repo)).sort() : []);
  const entryOf = (page: Page, path: string) => page.locator(`aside [title="${path}"]`).first();
  const linkInSessions = (page: Page, id: string) =>
    page
      .locator('aside section')
      .filter({ has: page.locator('h2, button[aria-expanded]').filter({ hasText: /^\s*Sessions\s*$/ }) })
      .locator(`a[href$="/sessions/${id}"]`);

  beforeAll(async () => {
    fx = makeFixture();
    installStub(fx, 'claude');
    installStub(fx, 'codex');
    // The detection waits on these until a test opens the gate.
    await setGate(fx, ['claude', 'codex'], true);
    clone = makeClone('cmp-clone');
    mkdirSync(join(clone.root, '.cockpit'));
    writeFileSync(join(clone.root, '.cockpit', 'config.json'), JSON.stringify({ setup: ['echo setup-ran >> "$COCKPIT_ROOT_PATH/setup.log"'] }));
    nodef = makeLight('cmp-nodef');
    git(nodef.root, 'checkout', '--detach');
    gone = makeLight('cmp-gone');
    refuse = makeLight('cmp-refuse');
    dataDir = makeTestDir('d-');
    writeFileSync(
      join(dataDir, 'state.json'),
      JSON.stringify({ version: 1, projects: [clone, nodef, gone, refuse].map((repo) => ({ path: repo.root })) }),
    );
    rmSync(gone.parent, { recursive: true, force: true });
    session = await launchSpawned(createRequire(import.meta.url)('electron') as string, ['.'], true, dataDir, fx.env());
    home = join(realpathSync(dataDir), 'h');
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    for (const folder of [dataDir, fx?.root, clone?.parent, nodef?.parent, refuse?.parent]) {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  // --- Detection, first: the stubs' `--version` is still waiting on its gate --------------------------

  test('AC11, AC15 — while the harnesses are detected the agent select shows a spinner and "Detecting…", its menu holds one disabled "Detecting agent CLIs…" item and the button is disabled; once the gate opens each stub ran `--version` once, and a reload, another page and a second visit reuse the result', async () => {
    const { page } = session;
    await promptBox(page).fill('Some task');
    const trigger = agentSelect(page);
    expect(await textOf(trigger)).toBe('Detecting…');
    expect(await trigger.locator('svg.animate-spin, svg.lucide-loader-circle, svg.lucide-loader-2, svg.lucide-loader').count()).toBeGreaterThan(0);
    expect(await createButton(page).isDisabled()).toBe(true);

    const menu = await openMenu(page, trigger);
    expect(await itemTexts(menu)).toEqual(['Detecting agent CLIs…']);
    expect(await isDisabledItem(itemsOf(menu).first())).toBe(true);
    await closePopups(page);

    await setGate(fx, ['claude', 'codex'], false);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    expect(await createButton(page).isEnabled()).toBe(true);
    expect(versionRuns(fx)).toEqual({ claude: 1, codex: 1 });

    // A reload, a visit to another page and a second visit to this one run no `--version` again.
    await page.reload();
    await promptBox(page).waitFor();
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await page.getByRole('link', { name: 'New workspace', exact: true }).click();
    await promptBox(page).waitFor();
    await waitForAgent(page, 'Claude Code');
    await closePopups(page);
    await openMenu(page, agentSelect(page));
    await closePopups(page);
    expect(versionRuns(fx)).toEqual({ claude: 1, codex: 1 });
  }, 60_000);

  // --- Navigation -----------------------------------------------------------------------------------

  test('AC1, AC2 — the home page is the "New workspace" heading (h1, 12 px, muted) above a centred composer, and the sidebar nav holds "New workspace" (square-pen, link to /, current) and nothing else: no "Home", no "Terminal"', async () => {
    const { page } = session;
    await openComposer(page);
    expect(new URL(page.url()).pathname).toBe('/');

    const heading = page.getByRole('heading', { level: 1, name: 'New workspace', exact: true });
    expect(await heading.count()).toBe(1);
    expect(await page.getByRole('heading', { name: 'Home' }).count()).toBe(0);
    expect(await heading.evaluate((element) => getComputedStyle(element).fontSize)).toBe('12px');
    expect(await heading.evaluate((element) => getComputedStyle(element).color)).toBe(await tokenColour(page, '--muted-foreground'));
    const main = await mainBox(page.locator('main'));
    const headingBox = await mainBox(heading);
    const promptBoxRect = await mainBox(promptBox(page));
    expect(Math.abs(headingBox.x + headingBox.width / 2 - (main.x + main.width / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(promptBoxRect.x + promptBoxRect.width / 2 - (main.x + main.width / 2))).toBeLessThanOrEqual(2);
    expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(promptBoxRect.y);

    const links = page.locator('aside nav a');
    expect((await links.allInnerTexts()).map(norm)).toEqual(['New workspace']);
    expect(await links.evaluateAll((all) => all.map((link) => new URL((link as HTMLAnchorElement).href).pathname))).toEqual(['/']);
    expect(await links.nth(0).getAttribute('aria-current')).toBe('page');
    expect(await links.nth(0).locator('svg.lucide-square-pen').count()).toBe(1);
    expect(await page.locator('aside').getByRole('link', { name: 'Home' }).count()).toBe(0);
    expect(await page.locator('aside').getByRole('link', { name: 'Terminal' }).count()).toBe(0);
    // That `/terminal` is no route any more is COCKPIT-70's AC4 (the route tree).
  });

  test('AC5 — without a project param, or with a path that is not in the state, the project select shows the first project of the sidebar', async () => {
    const { page } = session;
    await openComposer(page);
    expect(await textOf(projectSelect(page))).toContain(clone.name);
    await openComposer(page, '/not/a/project');
    expect(await textOf(projectSelect(page))).toContain(clone.name);
    await openComposer(page, nodef.root);
    expect(await textOf(projectSelect(page))).toContain(nodef.name);
  });

  test('AC3 — "New workspace" (the label is checked by the menus tests) in a project\'s menu goes to /?project=<path>, the project select shows that project and no dialog opens', async () => {
    const { page } = session;
    await openComposer(page);
    await page.getByTitle(refuse.root, { exact: true }).first().hover();
    await page.getByRole('button', { name: `Actions for ${refuse.name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: /^New workspace…?$/ }).click();

    await page.waitForURL((url) => url.searchParams.get('project') === refuse.root);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await textOf(projectSelect(page))).toContain(refuse.name);
    expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBe(0);
  });

  test('AC4 — the Sessions "+" goes to /?project=none, the project select shows "No project" and no menu opens', async () => {
    const { page } = session;
    await openComposer(page);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();

    await page.waitForURL((url) => url.searchParams.get('project') === 'none');
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await textOf(projectSelect(page))).toBe('No project');
    expect(await page.locator('[role="menu"]').count()).toBe(0);
  });

  // --- The composer ---------------------------------------------------------------------------------

  test('AC6 — the composer is 600 px wide with a rounded-xl bg-hover body, a 1 px border, padding 12/10/10/12, a 13 px "Prompt" with its placeholder, a toolbar of 24 px rounded-md controls 6 px apart and a 26 px round bg-brand button with a white arrow-up at its right, in both color schemes', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForBase(page, 'origin/main');
    const field = promptBox(page);
    expect(await field.getAttribute('placeholder')).toBe('Describe the task');

    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const expected = {
        hover: await tokenColour(page, '--hover', 'backgroundColor'),
        border: await tokenColour(page, '--border'),
        brand: await tokenColour(page, '--brand', 'backgroundColor'),
      };
      expect(expected.brand, 'the brand colour').toBe('rgb(94, 106, 210)');

      const composer = await field.evaluate((element) => {
        let node: HTMLElement | null = element.parentElement;
        while (node && parseFloat(getComputedStyle(node).borderTopWidth) === 0) node = node.parentElement;
        if (!node) return null;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          width: rect.width,
          right: rect.right,
          bottom: rect.bottom,
          radius: style.borderTopLeftRadius,
          background: style.backgroundColor,
          borderWidth: style.borderTopWidth,
          borderColor: style.borderTopColor,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
          fontSize: getComputedStyle(element).fontSize,
        };
      });
      expect(composer, 'the composer has a border').not.toBeNull();
      expect(composer!.width, scheme).toBeCloseTo(600, 0);
      expect(composer!.radius, scheme).toBe('12px');
      expect(composer!.background, scheme).toBe(expected.hover);
      expect(composer!.borderWidth, scheme).toBe('1px');
      expect(composer!.borderColor, scheme).toBe(expected.border);
      expect(composer!.padding, scheme).toEqual(['12px', '10px', '10px', '12px']);
      expect(composer!.fontSize, scheme).toBe('13px');

      const [project, agent, base, create, prompt] = await Promise.all(
        [projectSelect(page), agentSelect(page), baseSelect(page), createButton(page), field].map((locator) => mainBox(locator)),
      );
      for (const [name, box] of [['project', project], ['agent', agent], ['base', base]] as const) {
        expect(box!.height, `${name} control, ${scheme}`).toBeCloseTo(24, 0);
      }
      for (const select of [projectSelect(page), agentSelect(page), baseSelect(page)]) {
        expect(await select.evaluate((element) => getComputedStyle(element).borderTopLeftRadius), scheme).toBe('8px');
      }
      expect(agent!.x - (project!.x + project!.width), `project to agent, ${scheme}`).toBeCloseTo(6, 0);
      expect(base!.x - (agent!.x + agent!.width), `agent to base, ${scheme}`).toBeCloseTo(6, 0);
      expect(create!.width, scheme).toBeCloseTo(26, 0);
      expect(create!.height, scheme).toBeCloseTo(26, 0);
      expect(create!.x, 'at the right of the toolbar').toBeGreaterThan(base!.x + base!.width);
      expect(composer!.right - 1 - 10 - (create!.x + create!.width), 'right padding after the button').toBeCloseTo(0, 0);
      expect(
        await createButton(page).evaluate((element) => {
          const style = getComputedStyle(element);
          const radius = style.borderTopLeftRadius;
          const round = radius.endsWith('%') ? parseFloat(radius) >= 50 : parseFloat(radius) >= 13;
          const icon = element.querySelector('svg.lucide-arrow-up');
          return { round, background: style.backgroundColor, icon: icon ? getComputedStyle(icon).color : null };
        }),
        scheme,
      ).toEqual({ round: true, background: expected.brand, icon: 'rgb(255, 255, 255)' });

      // The toolbar sits 12 px under the field.
      const toolbarTop = await projectSelect(page).evaluate((element, other) => {
        const otherElement = other as Element;
        let node: Element | null = element.parentElement;
        while (node && !node.contains(otherElement)) node = node.parentElement;
        return node ? node.getBoundingClientRect().top : null;
      }, await agentSelect(page).elementHandle());
      expect(toolbarTop! - (prompt!.y + prompt!.height), `field to toolbar, ${scheme}`).toBeCloseTo(12, 0);
    }
    await page.emulateMedia({ colorScheme: null });
  });

  test('AC7 — the project select lists every project with its badge and name and a check on the selected one, then a separator and "No project" with the muted hint "Runs in its own folder"', async () => {
    const { page } = session;
    await openComposer(page, refuse.root);
    const menu = await openMenu(page, projectSelect(page));
    const items = itemsOf(menu);
    expect(await items.count()).toBe(5);
    const projects = [clone, nodef, gone, refuse];
    for (const [index, project] of projects.entries()) {
      const item = items.nth(index);
      expect(await textOf(item)).toContain(project.name);
      const badge = item.locator(`.${projectColour(project.root)}`);
      expect(await badge.count(), `${project.name} has its ${projectColour(project.root)} badge`).toBe(1);
      expect(norm(await badge.innerText())).toBe(project.name[0]!.toUpperCase());
      const checks = await item.locator('svg.lucide-check').count();
      expect(checks, `${project.name} check`).toBe(project === refuse ? 1 : 0);
    }
    const none = items.nth(4);
    expect(await textOf(none)).toBe('No project Runs in its own folder');
    expect(await none.locator('svg.lucide-check').count()).toBe(0);
    const hintColour = await none.getByText('Runs in its own folder', { exact: true }).evaluate((element) => getComputedStyle(element).color);
    expect(hintColour).toBe(await tokenColour(page, '--muted-foreground'));
    const separator = await mainBox(menu.locator('[role="separator"]').first());
    expect(separator.y).toBeGreaterThanOrEqual((await mainBox(items.nth(3))).y);
    expect(separator.y).toBeLessThanOrEqual((await mainBox(none)).y);
    await closePopups(page);
  });

  test('AC7 — picking a project in the select shows it, switches the base select to that project\'s default base and sets ?project=; picking "No project" removes the base select and sets ?project=none', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForBase(page, 'origin/main');

    let menu = await openMenu(page, projectSelect(page));
    await itemsOf(menu).filter({ hasText: refuse.name }).click();
    await page.waitForURL((url) => url.searchParams.get('project') === refuse.root);
    expect(await textOf(projectSelect(page))).toContain(refuse.name);
    expect(await textOf(projectSelect(page))).not.toContain(clone.name);
    await waitForBase(page, 'main');

    menu = await openMenu(page, projectSelect(page));
    await itemsOf(menu).filter({ hasText: /^\s*No project/ }).click();
    await page.waitForURL((url) => url.searchParams.get('project') === 'none');
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await textOf(projectSelect(page))).toBe('No project');
    await baseSelect(page).waitFor({ state: 'detached' });
  });

  test('AC8, AC9 — the base select shows the default base; opened, it has a focused "Search branches" field, the local branches under "Local" and the origin branches under "Remote" with the selected one checked; typing filters both groups case-insensitively (an empty group is hidden, no match says "No branch found") and picking a branch selects it and closes the popup; with "No project" there is no base select', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForBase(page, 'origin/main');
    expect(await baseSelect(page).locator('svg.lucide-git-branch').count()).toBe(1);

    await baseSelect(page).click();
    await searchBranches(page).waitFor();
    const opened = (await basePopup(page))!;
    expect(opened.focused).toBe(true);
    expect(opened.lines.slice(0, 1)).toEqual(['Local']);
    expect(opened.lines.indexOf('Remote')).toBeGreaterThan(0);
    const remoteAt = opened.lines.indexOf('Remote');
    expect(opened.lines.slice(1, remoteAt).sort()).toEqual(['local-topic', 'main', 'topic/nested']);
    expect(opened.lines.slice(remoteAt + 1).sort()).toEqual(['origin/develop', 'origin/feature/x', 'origin/main', 'origin/release/1.0']);
    expect(opened.selected).toEqual(['origin/main']);

    await searchBranches(page).fill('FEATURE');
    expect((await basePopup(page))!.lines).toEqual(['Remote', 'origin/feature/x']);
    await searchBranches(page).fill('MAIN');
    expect((await basePopup(page))!.lines.sort()).toEqual(['Local', 'Remote', 'main', 'origin/main']);
    await searchBranches(page).fill('nested');
    expect((await basePopup(page))!.lines).toEqual(['Local', 'topic/nested']);
    await searchBranches(page).fill('zzz-no-branch');
    expect((await basePopup(page))!.lines).toEqual(['No branch found']);

    await searchBranches(page).fill('nested');
    await page.locator('[role="option"]').filter({ hasText: 'topic/nested' }).click();
    await searchBranches(page).first().waitFor({ state: 'detached' });
    expect(await textOf(baseSelect(page))).toBe('topic/nested');

    await openComposer(page, 'none');
    expect(await textOf(projectSelect(page))).toBe('No project');
    expect(await baseSelect(page).count()).toBe(0);
  });

  test('AC10 — without a default base the base select says "Select a base" and the button stays disabled until one is picked; a project whose branches cannot be listed shows a message in the composer and the button stays disabled', async () => {
    const { page } = session;
    await openComposer(page, nodef.root);
    await promptBox(page).fill('Some task');
    await waitForBase(page, 'Select a base');
    expect(await createButton(page).isDisabled()).toBe(true);
    await baseSelect(page).click();
    await searchBranches(page).waitFor();
    await page.locator('[role="option"]').filter({ hasText: /^\s*main\s*$/ }).click();
    await waitForBase(page, 'main');
    expect(await createButton(page).isEnabled()).toBe(true);

    await openComposer(page, gone.root);
    await promptBox(page).fill('Some task');
    const message = await waitForMessage(page);
    expect(message).not.toBe('');
    expect(await createButton(page).isDisabled()).toBe(true);
  });

  // --- The agent select -----------------------------------------------------------------------------

  test('AC12 — the agent select shows the first detected harness; its menu lists each detected harness with its version muted at the right and a check on the selected one, then "Terminal", a separator and "Detect again" (refresh-cw)', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');

    const menu = await openMenu(page, agentSelect(page));
    expect(await itemTexts(menu)).toEqual(['Claude Code 9.9.9', 'Codex 9.9.9', 'Terminal', 'Detect again']);
    const items = itemsOf(menu);
    for (const index of [0, 1]) {
      const version = items.nth(index).getByText('9.9.9', { exact: true });
      expect(await version.count()).toBe(1);
      expect(await version.evaluate((element) => getComputedStyle(element).color)).toBe(await tokenColour(page, '--muted-foreground'));
      const [versionBox, itemBox] = [await mainBox(version), await mainBox(items.nth(index))];
      expect(versionBox.x + versionBox.width, 'the version is at the right').toBeGreaterThan(itemBox.x + itemBox.width - 24);
    }
    expect(await items.nth(0).locator('svg.lucide-check').count()).toBe(1);
    expect(await items.nth(1).locator('svg.lucide-check').count()).toBe(0);
    expect(await items.nth(3).locator('svg.lucide-refresh-cw').count()).toBe(1);
    const separator = await mainBox(menu.locator('[role="separator"]').first());
    expect(separator.y).toBeGreaterThanOrEqual((await mainBox(items.nth(2))).y);
    expect(separator.y).toBeLessThanOrEqual((await mainBox(items.nth(3))).y);
    await closePopups(page);
  });

  test('AC14 — "Detect again" shows "Detecting…" meanwhile, runs `--version` once more for each detected CLI and replaces the list: a CLI installed since launch appears (no version when it prints none), a removed one disappears, and a selected harness that disappeared falls back to the first detected', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await pickAgent(page, 'Codex');

    installStub(fx, 'opencode', { noVersion: true });
    removeStub(fx, 'codex');
    await setGate(fx, ['claude', 'opencode'], true);
    await detectAgain(page);
    await waitForAgent(page, 'Detecting…');
    expect(await createButton(page).isDisabled()).toBe(true);
    await setGate(fx, ['claude', 'opencode'], false);
    await waitForAgent(page, 'Claude Code');

    expect(versionRuns(fx)).toEqual({ claude: 2, codex: 1, opencode: 1 });
    const menu = await openMenu(page, agentSelect(page));
    expect(await itemTexts(menu)).toEqual(['Claude Code 9.9.9', 'OpenCode', 'Terminal', 'Detect again']);
    await closePopups(page);
  }, 60_000);

  // AC13 (no agent CLI at all) runs on the launch without any, below.

  test('AC15 — the button is disabled for a blank prompt (spaces only) and enabled for a filled one, and Shift+Enter inserts a new line without sending', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    expect(await createButton(page).isDisabled()).toBe(true);
    await promptBox(page).fill('    ');
    expect(await createButton(page).isDisabled()).toBe(true);
    await promptBox(page).press('Enter');
    expect(new URL(page.url()).pathname, 'Enter on a blank prompt sends nothing').toBe('/');

    await promptBox(page).fill('first line');
    expect(await createButton(page).isEnabled()).toBe(true);
    await promptBox(page).press('Shift+Enter');
    await promptBox(page).pressSequentially('second line');
    expect(await promptBox(page).inputValue()).toBe('first line\nsecond line');
    expect(new URL(page.url()).pathname, 'Shift+Enter sends nothing').toBe('/');
    expect(localBranches(clone)).not.toContain('first-line-second-line');
  });

  test('COCKPIT-89 AC11 — while a send is running (the reservation of its name still reading the branches) the button is disabled and Enter sends nothing more; the send ends with one workspace and one session', async () => {
    const { page } = session;
    const addsLog = join(fx.root, 'git-adds.log');
    const adds = () => (existsSync(addsLog) ? readFileSync(addsLog, 'utf8').split('\n').filter(Boolean).length : 0);
    const before = { adds: adds(), sessions: sessionsInState(dataDir).length, starts: startsOf(fx, 'claude').length };
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill('Blocked send');
    const held = await holdGit(fx, 'read');
    try {
      await createButton(page).click();
      await held.reached();
      expect(await createButton(page).isDisabled(), 'the button is disabled while the send is under way').toBe(true);
      await promptBox(page).press('Enter');
      await createButton(page).click({ force: true }).catch(() => {});
      expect(new URL(page.url()).pathname, 'the page has not opened and nothing was sent meanwhile').toBe('/');
    } finally {
      await held.release();
    }
    await waitForWorkspacePage(page, worktreeOf(clone, 'blocked-send'));
    await waitForSelectedTab(page);
    // The workspace's setup runs in this session's terminal: let it end so it does not write setup.log later.
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect(adds(), 'a single worktree was made').toBe(before.adds + 1);
    expect(localBranches(clone)).toContain('blocked-send');
    expect(localBranches(clone)).not.toContain('blocked-send-2');
    expect(sessionsInState(dataDir)).toHaveLength(before.sessions + 1);
    expect(startsOf(fx, 'claude')).toHaveLength(before.starts + 1);
  }, 60_000);

  // --- Send -----------------------------------------------------------------------------------------

  test('AC16, AC18 — Enter sends: the worktree is created from the base under COCKPIT_HOME on the prompt\'s slug, `cockpit setup` runs and the agent starts in it with the trimmed prompt as one argument, the session is stored with its project, the workspace page opens with the session as its one, selected tab and the composer is cleared', async () => {
    const { page } = session;
    const prompt = '  Fix the "login" $HOME redirect loop!  ';
    const branch = 'fix-the-login-home-redirect-loop';
    const path = worktreeOf(clone, branch);
    const startsBefore = startsOf(fx, 'claude').length;
    const setupLog = join(clone.root, 'setup.log');
    const setupRunsBefore = existsSync(setupLog) ? readFileSync(setupLog, 'utf8').split('\n').filter(Boolean).length : 0;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill(prompt);
    await promptBox(page).press('Enter');

    await waitForWorkspacePage(page, path);
    // The page opens while the worktree is made; the session's tab joins it once the session is stored.
    await waitForSelectedTab(page);
    const stored = sessionsInState(dataDir).find((each) => each.directory === path);
    expect(stored, 'the session is stored when its tab shows').toBeDefined();
    const id = stored!.id;
    // The page is the workspace's, with the session as its one tab, selected.
    const shown = await tabs(page);
    expect(shown.labels).toHaveLength(1);
    expect(shown.selected[0]).toMatch(/Claude Code/);
    expect(existsSync(path)).toBe(true);
    expect(git(clone.root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${path}\n`);
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${branch}.cockpitBase`)).toBe('origin/main');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(clone.root, 'rev-parse', 'origin/main'));

    await waitForRow(page, `cockpit setup · ${branch} · .cockpit/config.json`);
    await waitForRow(page, '$ echo setup-ran >> "$COCKPIT_ROOT_PATH/setup.log"');
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect(readFileSync(setupLog, 'utf8').split('\n').filter(Boolean).length).toBe(setupRunsBefore + 1);
    const starts = startsOf(fx, 'claude').slice(startsBefore);
    expect(starts).toEqual([{ cwd: path, args: [prompt.trim()] }]);

    expect(sessionsInState(dataDir).find((stored) => stored.id === id)).toMatchObject({
      harness: 'claude-code',
      name: 'Claude Code 1',
      directory: path,
      project: clone.root,
    });
    expect(await entryOf(page, path).count()).toBe(1);
    expect(await entryOf(page, path).innerText()).toContain(branch);

    await page.getByRole('link', { name: 'New workspace', exact: true }).click();
    await promptBox(page).waitFor();
    expect(await promptBox(page).inputValue()).toBe('');
  }, 60_000);

  test('AC17, COCKPIT-89 AC2 — "Terminal" with a project, its worktree held: the workspace page opens at once on the loading page; once the hold is released it shows one shell tab with the output of `cockpit setup --shell` (the setup, then the login shell, no agent) and no session is stored', async () => {
    const { page } = session;
    const branch = 'run-the-tests';
    const path = worktreeOf(clone, branch);
    const before = { claude: startsOf(fx, 'claude').length, shells: shellRuns(fx), sessions: sessionsInState(dataDir).length };
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await pickAgent(page, 'Terminal');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill('Run the tests');
    const held = await holdGit(fx, 'git');
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();
      expect(existsSync(path), 'the worktree does not exist yet').toBe(false);
    } finally {
      await held.release();
    }

    await waitForSelectedTab(page);
    expect(existsSync(path)).toBe(true);
    expect(await tabs(page)).toEqual({ labels: ['Terminal'], selected: ['Terminal'] });
    await waitForRow(page, `cockpit setup · ${branch} · .cockpit/config.json`);
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'login-shell>');
    expect(shellRuns(fx)).toBe(before.shells + 1);
    expect(startsOf(fx, 'claude')).toHaveLength(before.claude);
    expect(await storedSessions(page)).toHaveLength(before.sessions);
  }, 60_000);

  test('AC17, AC19 — "No project" with "Terminal" runs the login shell in a new folder under COCKPIT_HOME/sessions, and with an agent starts it there with the prompt as its argument, no worktree and no setup; both are listed in the Sessions section', async () => {
    const { page } = session;
    const before = { shells: shellRuns(fx), claude: startsOf(fx, 'claude').length, worktrees: listing(clone) };

    await openComposer(page, 'none');
    await waitForAgent(page, 'Claude Code');
    await pickAgent(page, 'Terminal');
    await promptBox(page).fill('Scratch pad');
    await createButton(page).click();
    const terminalId = await waitForSessionPage(page);
    await page.getByRole('heading', { name: 'Terminal 1', exact: true }).waitFor();
    await waitForRow(page, 'login-shell>');
    expect((await terminalRows(page)).some((row) => row.startsWith('cockpit setup'))).toBe(false);
    expect(shellRuns(fx)).toBe(before.shells + 1);
    const terminal = sessionsInState(dataDir).find((stored) => stored.id === terminalId)!;
    expect(terminal).toMatchObject({ harness: 'terminal', name: 'Terminal 1', directory: join(home, 'sessions', terminalId) });
    expect(terminal.project).toBeUndefined();
    expect(existsSync(terminal.directory)).toBe(true);
    expect(await linkInSessions(page, terminalId).count()).toBe(1);

    await openComposer(page, 'none');
    await waitForAgent(page, 'Claude Code');
    await promptBox(page).fill('Explore the codebase');
    await promptBox(page).press('Enter');
    const agentId = await waitForSessionPage(page, terminalId);
    await waitForRow(page, 'ready');
    const agent = sessionsInState(dataDir).find((stored) => stored.id === agentId)!;
    expect(agent).toMatchObject({ harness: 'claude-code', name: 'Claude Code 1', directory: join(home, 'sessions', agentId) });
    expect(agent.project).toBeUndefined();
    expect(startsOf(fx, 'claude').slice(before.claude)).toEqual([{ cwd: agent.directory, args: ['Explore the codebase'] }]);
    expect(await linkInSessions(page, agentId).count()).toBe(1);
    expect(listing(clone)).toEqual(before.worktrees);
    expect(shellRuns(fx), 'only the Terminal session ran the login shell').toBe(before.shells + 1);
  }, 60_000);

  test('AC18 — the same task again gets a "-2" branch', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill('Run the tests!');
    await createButton(page).click();
    await waitForWorkspacePage(page, worktreeOf(clone, 'run-the-tests-2'));
    await waitForSelectedTab(page);
    expect(localBranches(clone)).toContain('run-the-tests-2');
    expect(localBranches(clone)).toContain('run-the-tests');
  }, 60_000);

  // --- A new workspace exists at once, with a setting-up status (COCKPIT-89) -------------------------

  const worktreeCount = (path: string) => git(clone.root, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line === `worktree ${path}`).length;
  // Fills the composer for `repo` with the default agent and base and sends `prompt` with the button.
  const sendFrom = async (repo: Repo, prompt: string, base: string) => {
    const { page } = session;
    await openComposerFromSidebar(page, repo.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, base);
    await promptBox(page).fill(prompt);
    await createButton(page).click();
  };

  test('COCKPIT-89 AC1, AC2 — with `git worktree add` held the workspace page opens on "Setting up workspace…" under the workspace\'s name, its row says "Setting up" with no menu and no start button and no right bar shows; once released the page shows the session as its one selected tab holding the keyboard, with no navigation and no reload, and the row has its actions back', async () => {
    const { page } = session;
    const prompt = 'Hold the send';
    const branch = 'hold-the-send';
    const path = worktreeOf(clone, branch);
    const startsBefore = startsOf(fx, 'claude').length;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill(prompt);
    const held = await holdGit(fx, 'git');
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();
      expect(existsSync(path), 'the worktree does not exist yet').toBe(false);
      expect(await mainText(page)).toMatch(new RegExp(`${branch}.*Setting up workspace…`));
      await entryOf(page, path).waitFor();
      await waitForSetupLabel(page, path, 'Setting up');
      expect(await rowItem(page, path).getByRole('button').count(), 'no "…" menu and no start button on the row').toBe(0);
      expect(await rightBar(page).count(), 'no right bar and no rail').toBe(0);
      await recordLocations(page);
      await page.evaluate(() => void ((window as unknown as { __kept?: boolean }).__kept = true));
    } finally {
      await held.release();
    }

    await waitForSelectedTab(page);
    expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept), 'the page was not reloaded').toBe(true);
    expect(await locationsSeen(page), 'nothing navigated').toEqual([]);
    expect(await loadingText(page).count()).toBe(0);
    await page.locator('.xterm-helper-textarea:focus').waitFor({ state: 'attached' });
    expect(await activePane(page), 'the selected tab\'s terminal holds the keyboard').not.toBeNull();
    const shown = await tabs(page);
    expect(shown.labels).toHaveLength(1);
    expect(shown.selected[0]).toMatch(/Claude Code/);
    await page.getByRole('button', { name: `Actions for ${branch}`, exact: true }).waitFor();
    expect(await page.getByRole('button', { name: `Start session in ${branch}`, exact: true }).count()).toBe(1);
    expect(existsSync(path)).toBe(true);
    expect(sessionsInState(dataDir).find((each) => each.directory === path)).toMatchObject({ harness: 'claude-code', project: clone.root });
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect(startsOf(fx, 'claude').slice(startsBefore)).toEqual([{ cwd: path, args: [prompt] }]);
  }, 60_000);

  test('COCKPIT-89 AC9 — a workspace setting up, the same task sent again: the second workspace gets the "-2" branch and both end set up', async () => {
    const { page } = session;
    const first = worktreeOf(clone, 'twice-the-same');
    const second = worktreeOf(clone, 'twice-the-same-2');
    const startsBefore = startsOf(fx, 'claude').length;
    const held = await holdGit(fx, 'git');
    try {
      await sendFrom(clone, 'Twice the same', 'origin/main');
      await held.reached();
      await waitForWorkspacePage(page, first);
      await loadingText(page).waitFor();

      await sendFrom(clone, 'Twice the same!', 'origin/main');
      await waitForWorkspacePage(page, second);
      await loadingText(page).waitFor();
      await waitForSetupLabel(page, first, 'Setting up');
      await waitForSetupLabel(page, second, 'Setting up');
    } finally {
      await held.release();
    }

    await waitForSelectedTab(page);
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    await entryOf(page, first).click();
    await waitForWorkspacePage(page, first);
    await waitForSelectedTab(page);
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect(localBranches(clone)).toEqual(expect.arrayContaining(['twice-the-same', 'twice-the-same-2']));
    expect(worktreeCount(first)).toBe(1);
    expect(worktreeCount(second)).toBe(1);
    expect(sessionsInState(dataDir).filter((each) => each.directory === first || each.directory === second)).toHaveLength(2);
    expect(startsOf(fx, 'claude').slice(startsBefore).map((start) => start.cwd).sort()).toEqual([first, second]);
  }, 60_000);

  test('COCKPIT-89 AC3, AC4 — going to another page and back during the hold shows the loading page again; the user clicking elsewhere when the hold is released stays on the page they went to, with no entry added to the history, and the session runs and is stored; back on the workspace after the release its tab shows', async () => {
    const { page } = session;
    const prompt = 'Go elsewhere';
    const path = worktreeOf(clone, 'go-elsewhere');
    const startsBefore = startsOf(fx, 'claude').length;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill(prompt);
    const held = await holdGit(fx, 'git');
    let settled!: () => Promise<void>;
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();

      await goHome(page);
      await entryOf(page, path).click();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();

      await goHome(page);
      await recordLocations(page);
      settled = await watchSettled(page);
    } finally {
      await held.release();
    }
    await settled();
    await afterIpcAnswers(page);

    expect(await page.evaluate(() => location.pathname + location.search), 'the page the user went to stays').toBe('/');
    expect(await locationsSeen(page), 'no entry was added to the history').toEqual([]);
    expect(sessionsInState(dataDir).find((each) => each.directory === path), 'the session is stored').toMatchObject({ harness: 'claude-code', project: clone.root });

    await entryOf(page, path).click();
    await waitForWorkspacePage(page, path);
    await waitForSelectedTab(page);
    expect((await tabs(page)).selected[0]).toMatch(/Claude Code/);
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect(startsOf(fx, 'claude').slice(startsBefore)).toEqual([{ cwd: path, args: [prompt] }]);
  }, 60_000);

  test('COCKPIT-89 AC5 — a reload during the hold shows the loading page again; once released the workspace shows with one tab, and there is one worktree and one stored session, whose agent got the prompt', async () => {
    const { page } = session;
    const prompt = 'Reload during setup';
    const path = worktreeOf(clone, 'reload-during-setup');
    const startsBefore = startsOf(fx, 'claude').length;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill(prompt);
    const held = await holdGit(fx, 'git');
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();

      await page.reload();
      await loadingText(page).waitFor();
      expect(existsSync(path), 'the worktree does not exist yet').toBe(false);
    } finally {
      await held.release();
    }

    await waitForSelectedTab(page);
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect((await tabs(page)).labels).toHaveLength(1);
    expect(worktreeCount(path)).toBe(1);
    expect(sessionsInState(dataDir).filter((each) => each.directory === path)).toHaveLength(1);
    expect(startsOf(fx, 'claude').slice(startsBefore)).toEqual([{ cwd: path, args: [prompt] }]);
  }, 60_000);

  test('COCKPIT-89 AC6 — a refused creation while the user is on the loading page removes the row and shows the refusal in the page only with "Back to composer" (kept by a reload); the button opens the composer with the send\'s text, project, agent and base and no refusal, and a new send works', async () => {
    const { page } = session;
    git(refuse.root, 'branch', 'side');
    const branch = 'cannot-be-created';
    const path = worktreeOf(refuse, branch);
    // A file where the project's worktrees folder must be: git cannot create the worktree.
    const blocker = worktreesDirOf(refuse);
    mkdirSync(join(home, 'worktrees'), { recursive: true });
    const before = { branches: localBranches(refuse), sessions: sessionsInState(dataDir).length };

    try {
      await openComposer(page, refuse.root);
      await waitForAgent(page, 'Claude Code');
      await waitForBase(page, 'main');
      await pickAgent(page, 'Terminal');
      await chooseBase(page, 'side');
      await promptBox(page).fill('Cannot be created');
      const held = await holdGit(fx, 'git');
      try {
        await createButton(page).click();
        await held.reached();
        await waitForWorkspacePage(page, path);
        await loadingText(page).waitFor();
        writeFileSync(blocker, 'in the way');
      } finally {
        await held.release();
      }

      await backToComposer(page, 'main').waitFor();
      await entryOf(page, path).waitFor({ state: 'detached' });
      expect(await loadingText(page).count()).toBe(0);
      expect((await mainText(page)).replace('Back to composer', '').trim(), 'the page says why').not.toBe('');
      expect(await backToComposer(page, 'aside').count(), 'not under Projects').toBe(0);
      expect(await projectsMessage(page).count(), 'nothing under Projects').toBe(0);
      expect(localBranches(refuse)).toEqual(before.branches);
      expect(sessionsInState(dataDir)).toHaveLength(before.sessions);
      expect(existsSync(path)).toBe(false);

      await page.reload();
      await backToComposer(page, 'main').waitFor();
      expect(new URL(page.url()).pathname).toBe('/workspace');
      expect(await backToComposer(page, 'aside').count()).toBe(0);

      await backToComposer(page, 'main').click();
      await promptBox(page).waitFor();
      expect(await promptBox(page).inputValue()).toBe('Cannot be created');
      expect(await textOf(projectSelect(page))).toContain(refuse.name);
      expect(await textOf(agentSelect(page))).toBe('Terminal');
      await waitForBase(page, 'side');
      expect(await messageOf(page)).toBe('');
      expect(await backToComposer(page, 'main').count() + (await backToComposer(page, 'aside').count()), 'no refusal is left').toBe(0);

      rmSync(blocker);
      await createButton(page).click();
      await waitForWorkspacePage(page, path);
      await waitForSelectedTab(page);
      expect(localBranches(refuse)).toContain(branch);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(blocker, { force: true });
    }
  }, 60_000);

  test('COCKPIT-89 AC7 — a refused creation after the user left the page removes the row and shows the refusal under Projects with "Back to composer", kept by a reload until clicked; the button opens the composer as in AC6 and removes the refusal', async () => {
    const { page } = session;
    const branch = 'refused-later';
    const path = worktreeOf(refuse, branch);
    const other = worktreeOf(refuse, 'cannot-be-created');
    const folder = worktreesDirOf(refuse);
    const before = { branches: localBranches(refuse), sessions: sessionsInState(dataDir).length };

    await openComposer(page, refuse.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'main');
    await chooseBase(page, 'side');
    await promptBox(page).fill('Refused later');
    const held = await holdGit(fx, 'git');
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();

      await entryOf(page, other).click();
      await waitForWorkspacePage(page, other);
      await waitForSelectedTab(page);
      // The project's folder cannot be written to: git cannot create the worktree.
      chmodSync(folder, 0o555);
    } finally {
      await held.release();
    }
    try {
      await backToComposer(page, 'aside').waitFor();
    } finally {
      chmodSync(folder, 0o755);
    }

    await entryOf(page, path).waitFor({ state: 'detached' });
    expect(new URL(page.url()).searchParams.get('path'), 'the user stays where they went').toBe(other);
    expect(await backToComposer(page, 'main').count()).toBe(0);
    // The refusal says why next to its button.
    expect(norm(await backToComposer(page, 'aside').locator('xpath=..').innerText()).replace('Back to composer', '').trim()).not.toBe('');
    expect(localBranches(refuse)).toEqual(before.branches);
    expect(sessionsInState(dataDir)).toHaveLength(before.sessions);

    await page.reload();
    await backToComposer(page, 'aside').waitFor();

    await backToComposer(page, 'aside').click();
    await promptBox(page).waitFor();
    expect(await promptBox(page).inputValue()).toBe('Refused later');
    expect(await textOf(projectSelect(page))).toContain(refuse.name);
    expect(await textOf(agentSelect(page))).toBe('Claude Code');
    await waitForBase(page, 'side');
    expect(await messageOf(page)).toBe('');
    await backToComposer(page, 'aside').waitFor({ state: 'detached' });
  }, 60_000);

  test('COCKPIT-89 AC8 — a worktree created while its agent cannot start keeps the workspace in the sidebar without "Setting up", its page shows its panes, "Could not start Claude Code: …" shows under Projects, and an agent started from the New tab menu works in that workspace', async () => {
    const { page } = session;
    const path = worktreeOf(refuse, 'start-fails');
    await openComposer(page, refuse.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'main');
    // Removed after it was detected: the start finds it gone.
    removeStub(fx, 'claude');
    try {
      await promptBox(page).fill('Start fails');
      await createButton(page).click();

      await waitForWorkspacePage(page, path);
      await projectsMessage(page).filter({ hasText: /^\s*Could not start Claude Code: / }).first().waitFor();
    } finally {
      installStub(fx, 'claude');
    }
    expect(existsSync(path)).toBe(true);
    expect(localBranches(refuse)).toContain('start-fails');
    await entryOf(page, path).waitFor();
    await waitForSetupLabel(page, path, null);
    expect(await loadingText(page).count()).toBe(0);
    await page.getByRole('button', { name: 'New tab', exact: true }).first().waitFor();
    expect(new URL(page.url()).searchParams.get('path')).toBe(path);

    const startsBefore = startsOf(fx, 'claude').length;
    await page.getByRole('button', { name: 'New tab', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'Claude Code', exact: true }).click();
    await waitForSelectedTab(page);
    expect((await tabs(page)).selected[0]).toMatch(/Claude Code/);
    await waitForRow(page, 'ready');
    expect(startsOf(fx, 'claude').slice(startsBefore).map((start) => start.cwd)).toEqual([path]);
  }, 60_000);

  test('COCKPIT-89 AC10 — a worktrees folder that cannot be created refuses the send before any workspace is reserved: the composer stays with its message, text and selections and no row ever appears', async () => {
    const { page } = session;
    const root = join(home, 'worktrees');
    const aside = `${root}.aside`;
    const path = worktreeOf(clone, 'no-root');
    expect(existsSync(root), 'earlier tests created workspaces under the root').toBe(true);
    renameSync(root, aside);
    writeFileSync(root, 'not a folder');
    try {
      await openComposer(page, clone.root);
      await waitForAgent(page, 'Claude Code');
      await pickAgent(page, 'Terminal');
      await waitForBase(page, 'origin/main');
      await chooseBase(page, 'origin/develop');
      await promptBox(page).fill('no root');
      // Any row titled with the new path, however briefly, is recorded.
      await page.evaluate((title) => {
        const win = window as unknown as { __rowSeen?: boolean };
        win.__rowSeen = false;
        new MutationObserver(() => {
          if (document.querySelector(`aside [title="${title}"]`)) win.__rowSeen = true;
        }).observe(document, { subtree: true, childList: true, attributes: true });
      }, path);
      await createButton(page).click();

      expect(await waitForMessage(page)).toMatch(/^Cockpit could not create its worktrees folder .*: EEXIST\.$/);
      await createButton(page).and(page.locator('button:enabled')).waitFor();
      expect(new URL(page.url()).pathname).toBe('/');
      expect(await promptBox(page).inputValue()).toBe('no root');
      expect(await textOf(projectSelect(page))).toContain(clone.name);
      expect(await textOf(agentSelect(page))).toBe('Terminal');
      expect(await textOf(baseSelect(page))).toBe('origin/develop');
      expect(await page.evaluate(() => (window as unknown as { __rowSeen: boolean }).__rowSeen), 'no row appeared').toBe(false);
      expect(await entryOf(page, path).count()).toBe(0);
      expect(localBranches(clone)).not.toContain('no-root');
    } finally {
      rmSync(root, { force: true });
      renameSync(aside, root);
    }
  }, 60_000);

  // --- A send with no project whose start has not answered (COCKPIT-89 AC12) -------------------------

  // The daemon is stopped, so the start the send asked for has not answered (COCKPIT-86's technique); `during` runs
  // with it pending, then the daemon resumes and the start answers. With `refused` the save of the session fails
  // once the agent is spawned (a folder where the state's temporary file goes, as the sessions tests do): the start
  // is refused only when it answers.
  async function stalledStart(prompt: string, during: () => Promise<void>, { refused = false } = {}) {
    const { page } = session;
    const blocker = join(dataDir, 'state.json.tmp');
    const starts = await watchStarts(session);
    await openComposerFromSidebar(page, 'none');
    await useAgent(page, 'Claude Code');
    await promptBox(page).fill(prompt);
    const daemon = daemonPidIn(session.cockpitHome);
    if (refused) mkdirSync(blocker);
    process.kill(daemon, 'SIGSTOP');
    try {
      try {
        await createButton(page).click();
        await during();
      } finally {
        process.kill(daemon, 'SIGCONT');
      }
      await ipcAnswered(session, 'sessions:start', starts + 1);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  }
  const hereNow = (page: Page) => page.evaluate(() => location.pathname + location.search);

  test('COCKPIT-89 AC12 — a send with no project refused after the daemon resumes, the user still on the composer: today\'s behaviour, the message shows in the composer', async () => {
    const { page } = session;
    await stalledStart('Stay here', async () => {}, { refused: true });
    expect(await waitForMessage(page)).toMatch(/^Could not start Claude Code: /);
    expect(await hereNow(page)).toBe('/?project=none');
    expect(await promptBox(page).inputValue()).toBe('Stay here');
  }, 60_000);

  test('COCKPIT-89 AC12 — a send with no project refused after the user left shows the refusal under Projects and leaves the page they went to alone', async () => {
    const { page } = session;
    const known = new Set((await storedSessions(page)).map((each) => each.id));
    await stalledStart(
      'Refused after leaving',
      async () => {
        await recordLocations(page);
        await goHome(page);
      },
      { refused: true },
    );
    await projectsMessage(page).filter({ hasText: /^\s*Could not start Claude Code: / }).first().waitFor();
    await afterIpcAnswers(page);
    expect(await hereNow(page)).toBe('/');
    expect((await locationsSeen(page)).filter((href) => href.startsWith('/sessions'))).toEqual([]);
    expect(await messageOf(page)).toBe('');
    expect((await storedSessions(page)).map((each) => each.id).sort()).toEqual([...known].sort());
  }, 60_000);

  test('COCKPIT-89 AC12 — a send with no project whose start answers after the user left keeps the page they went to, and the session is stored', async () => {
    const { page } = session;
    const known = new Set((await storedSessions(page)).map((each) => each.id));
    await stalledStart('Answered after leaving', async () => {
      await recordLocations(page);
      await goHome(page);
    });
    const stored = (await storedSessions(page)).find((each) => !known.has(each.id));
    expect(stored, 'the session is stored').toBeTruthy();
    expect(stored!.project).toBeUndefined();
    await page.locator(`aside a[href$="/sessions/${stored!.id}"]`).first().waitFor();
    await afterIpcAnswers(page);
    expect(await hereNow(page), 'the page the user went to stays').toBe('/');
    expect((await locationsSeen(page)).filter((href) => href.startsWith('/sessions')), 'the page never went to the session').toEqual([]);
  }, 60_000);

  // --- The workspace name from the agent's title ----------------------------------------------------

  // The titles the stub prints in the worktree folder `folder` (the prompt's slug: a rename never moves it).
  const titlesFor = (folder: string) => join(fx.bin, `claude.titles.${folder}`);

  // The main process has read every title the daemon sent so far: its `projects:list` runs on the per-repository
  // chain a rename would be queued on. Used after the stubs' last title, before asserting that nothing was renamed.
  const settleMain = (page: Page) =>
    page.evaluate(() => (globalThis as unknown as { api: { projects: { list(): Promise<unknown> } } }).api.projects.list());

  test('AC21, AC22, AC23 — the first prompt-derived title renames the branch to its slug, sets cockpitName, keeps cockpitBase, leaves the folder and shows the name on the sidebar row within 5 s; the idle title and a second title change nothing; a session started from the workspace row renames nothing', async () => {
    const { page } = session;
    const first = 'please-fix-the-login-redirect-loop';
    const titles = titlesFor(first);
    writeFileSync(titles, '✳ Fix the login redirect loop\n✳ Something else entirely\n');
    let done = await openFifo(`${titles}.done`);
    const renamed = 'fix-the-login-redirect-loop';
    const path = worktreeOf(clone, first);

    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill('Please fix the login redirect loop');
    await promptBox(page).press('Enter');
    await waitForWorkspacePage(page, path);

    // The stub has printed its titles once it writes to the FIFO; the idle title `✳ Claude Code` came first and renames nothing.
    // `nameWorkspace` writes `cockpitName` last, then the windows list again: the row showing the name is the event that
    // the branch is renamed and named. AC21's bound: the name shows within 5 s of the stub's last title.
    await signalled(done);
    const within = startClock();
    await entryOf(page, path).filter({ hasText: 'Fix the login redirect loop' }).waitFor();
    within('the sidebar row shows the name', 5_000);
    expect(localBranches(clone)).toContain(renamed);
    expect(localBranches(clone)).not.toContain(first);
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${renamed}.cockpitName`)).toBe('Fix the login redirect loop');
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${renamed}.cockpitBase`)).toBe('origin/main');
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${first}.cockpitBase`)).toBeNull();
    expect(existsSync(path), 'the folder does not move').toBe(true);
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(renamed);
    // The sidebar row shows the name without a window focus; its title attribute stays the path.
    expect(await entryOf(page, path).innerText()).toContain('Fix the login redirect loop');
    expect(await entryOf(page, path).getAttribute('title')).toBe(path);

    // A second prompt-derived title changes nothing: the main process has read every title the stub printed.
    await settleMain(page);
    expect(localBranches(clone)).toContain(renamed);
    expect(localBranches(clone)).not.toContain('something-else-entirely');
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${renamed}.cockpitName`)).toBe('Fix the login redirect loop');
    expect(await entryOf(page, path).innerText()).toContain('Fix the login redirect loop');

    // A session started from the workspace row (no `nameFromTitle`) renames nothing, whatever its title.
    writeFileSync(titles, '✳ Started from the row\n');
    await done.close();
    done = await openFifo(`${titles}.done`);
    const started = await page.evaluate(
      ([project, workspace]) =>
        (globalThis as unknown as { api: { sessions: { start(harness: string, size: object, options: object): Promise<{ status: string }> } } }).api.sessions.start(
          'claude-code',
          { cols: 80, rows: 24 },
          { workspace: { project, path: workspace } },
        ),
      [clone.root, path] as const,
    );
    expect(started.status).toBe('started');
    await signalled(done);
    await settleMain(page);
    expect(localBranches(clone)).toContain(renamed);
    await done.close();
    rmSync(`${titles}.done`, { force: true });
    expect(localBranches(clone)).not.toContain('started-from-the-row');
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${renamed}.cockpitName`)).toBe('Fix the login redirect loop');

    // No error was logged by the main process or the page across the whole block.
    expect(session.isRunning()).toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(await page.pageErrors({ filter: 'all' })).toEqual([]);
    expect((await page.consoleMessages({ filter: 'all' })).filter((message) => message.type() === 'error').map((message) => message.text())).toEqual([]);
  }, 90_000);

  // Types a line on the keyboard of the visible terminal, as a user does.
  const typeLine = async (page: Page, text: string) => {
    await page.locator('.xterm:visible').first().click();
    await page.locator('.xterm:visible .xterm-helper-textarea').first().focus();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };

  test('AC23 — a title printed by a setup command, before the agent started, never names the workspace: the stub\'s title does', async () => {
    const { page } = session;
    const placeholder = 'title-during-the-setup';
    writeFileSync(titlesFor(placeholder), '✳ Fix the login redirect loop\n');
    const renamed = 'fix-the-login-redirect-loop';
    const config = join(refuse.root, '.cockpit');
    mkdirSync(config, { recursive: true });
    // A title that matches the harness's prompt pattern, printed by the setup command itself, before the agent starts.
    writeFileSync(join(config, 'config.json'), JSON.stringify({ setup: [`printf '\\033]0;\\342\\234\\263 Setup title\\007'; echo title-printed`] }));
    try {
      await openComposer(page, refuse.root);
      await waitForAgent(page, 'Claude Code');
      await waitForBase(page, 'main');
      await promptBox(page).fill('Title during the setup');
      await promptBox(page).press('Enter');
      await waitForWorkspacePage(page, worktreeOf(refuse, placeholder));
      await waitForRow(page, 'title-printed');
      // The row shows the name once `nameWorkspace` has renamed the branch and stored the name.
      await entryOf(page, worktreeOf(refuse, placeholder)).filter({ hasText: 'Fix the login redirect loop' }).waitFor();
    } finally {
      rmSync(config, { recursive: true, force: true });
    }

    expect(localBranches(refuse)).not.toContain('setup-title');
    expect(localBranches(refuse)).not.toContain(placeholder);
    expect(gitOrNull(refuse.root, 'config', '--get', `branch.${renamed}.cockpitName`)).toBe('Fix the login redirect loop');
    expect(git(worktreeOf(refuse, placeholder), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(renamed);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  }, 60_000);

  test('AC23 — a title the login shell sets after the agent exited, which printed no prompt-derived title, renames nothing: the branch keeps the prompt\'s slug and no cockpitName is set', async () => {
    const { page } = session;
    const branch = 'title-after-the-agent';
    await openComposer(page, refuse.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'main');
    await promptBox(page).fill('Title after the agent');
    await promptBox(page).press('Enter');
    await waitForWorkspacePage(page, worktreeOf(refuse, branch));
    await waitForRow(page, 'ready');

    // The agent exits before it printed a prompt-derived title; the login shell then prints one.
    await typeLine(page, 'exit');
    await waitForRow(page, '[Claude Code exited with code 3]');
    await waitForRow(page, 'login-shell>');
    await typeLine(page, "printf '\\033]0;\\342\\234\\263 Shell title\\007'; git branch --show-current; echo shell-title-done");
    await waitForRow(page, 'shell-title-done');
    await settleMain(page);

    // The shell's own `git` ran after the title, in the worktree: it still sees the prompt's slug.
    await waitForRow(page, branch);
    expect(localBranches(refuse)).toContain(branch);
    expect(localBranches(refuse)).not.toContain('shell-title');
    expect(gitOrNull(refuse.root, 'config', '--get', `branch.${branch}.cockpitName`)).toBeNull();
    expect(git(worktreeOf(refuse, branch), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);

    expect(session.isRunning()).toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(await page.pageErrors({ filter: 'all' })).toEqual([]);
  }, 90_000);

  test('AC5 — with no project in Cockpit the project select shows "No project"', async () => {
    const { page } = session;
    for (const repo of [clone, nodef, gone, refuse]) {
      await page.evaluate((path) => (globalThis as unknown as { api: { projects: { remove(path: string): Promise<unknown> } } }).api.projects.remove(path), repo.root);
    }
    await openComposer(page);
    expect(await textOf(projectSelect(page))).toBe('No project');
    expect(await baseSelect(page).count()).toBe(0);
  });
});

describe('built app without any agent CLI on the login shell PATH', () => {
  let fx: SessionsFixture;
  let session: Session;
  let dataDir: string;

  beforeAll(async () => {
    fx = makeSessionsFixture([]);
    dataDir = makeTestDir('d-');
    session = await launchBuiltWith(fx.env(), dataDir);
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC2, COCKPIT-66 AC13 — with no agent CLI the New workspace page\'s agent select shows "Terminal", its menu a disabled "No agent CLI found" item with the install hint above "Terminal", and no session starts', async () => {
    const { page } = session;
    const before = stateSnapshot(session.dataDir);

    await waitForAgent(page, 'Terminal');
    const menu = await openPopup(page, agentSelect(page));

    expect(await itemTexts(menu)).toEqual([
      'No agent CLI found Install Claude Code, Codex or OpenCode, then detect again. Until then, the workspace opens with a terminal.',
      'Terminal',
      'Detect again',
    ]);
    const missing = menu.locator('[role^="menuitem"]').first();
    expect(await missing.evaluate((item) => item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('data-disabled'))).toBe(true);

    // A disabled item: the click starts nothing, so no `sessions:start` reached the main process by the time its
    // later answers came.
    await countIpcCalls(session, ['sessions:start']);
    await missing.click({ force: true }).catch(() => {});
    await afterIpcAnswers(page);
    expect(await ipcCalls(session, 'sessions:start')).toBe(0);
    await page.keyboard.press('Escape');
    expect(await sessionEntries(page)).toEqual([]);
    expect(sessionIdOf(page)).toBeUndefined();
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    await expectNoErrors(session);
  });

  test('COCKPIT-68 AC26 — the agent menu\'s multi-line hint item is taller than 28 px, holds its text, and no two items overlap', async () => {
    const { page } = session;
    await waitForAgent(page, 'Terminal');
    const menu = await openPopup(page, agentSelect(page));

    const boxes = await itemsOf(menu).evaluateAll((items) =>
      items.map((item) => {
        // Layout boxes: the popup's opening animation scales its rects.
        const element = item as HTMLElement;
        const top = element.offsetTop;
        return { top, bottom: top + element.offsetHeight, height: element.offsetHeight, text: (item.textContent ?? '').trim(), overflow: item.scrollHeight - item.clientHeight };
      }),
    );
    await page.keyboard.press('Escape');

    expect(boxes).toHaveLength(3);
    const hint = boxes.find((box) => box.text.startsWith('No agent CLI found'))!;
    expect(hint.height, 'the hint item').toBeGreaterThan(28);
    for (const box of boxes) expect(box.overflow, `${box.text} fits its box`).toBeLessThanOrEqual(1);
    const ordered = [...boxes].sort((a, b) => a.top - b.top);
    for (let at = 1; at < ordered.length; at++) {
      expect(ordered[at]!.top, `${ordered[at]!.text} starts below ${ordered[at - 1]!.text}`).toBeGreaterThanOrEqual(ordered[at - 1]!.bottom - 0.5);
    }
  });
});
