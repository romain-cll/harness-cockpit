import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ElementHandle, type Locator, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  MAIN_PROCESS_ERROR,
  UI_TIMEOUT,
  daemonSocketIn,
  isAlive,
  launchDev,
  launchPackaged,
  launchSpawned,
  poll,
  versionLabel,
  waitForGroupGone,
  type Session,
} from './launch';
import { makeTestDir } from './run-root';

// COCKPIT-70: the workspace page, panes with tabs of agents and shells. The built app runs the full
// block (a launch of its own, the tests below share it and run in order); the dev server and the
// packaged app each run one smoke path, and the launchd-environment mode its shell test.
//
// What the tests rely on in the page (the mockups carry no test hooks):
//  - the workspace row is a link (`aside a`) to `/workspace?path=<worktree path>` whose text starts with the branch;
//  - a pane's tab bar is a `role="tablist"`, a tab a `role="tab"` (`aria-selected`) whose label is its `title`
//    (or its text), its close button a button named `Close <label>`; the "New tab" button is named `New tab`;
//  - a terminal is an `.xterm`; the ones of tabs that are not selected are not visible.

const electron = () => createRequire(import.meta.url)('electron') as string;
const launchBuiltWith = (env: NodeJS.ProcessEnv, dataDir?: string | null, home?: string | null) =>
  launchSpawned(electron(), ['.'], true, dataDir, env, home);

// --- Fixture: stub agents and a fake login shell ------------------------------

// A harness that is not a harness: prints what the tests check, echoes every line it reads and exits with
// code 3 on `exit` (0 on `quit`). `title-*` sets the terminal title (OSC 0) the way an agent does.
// `hook <Event>` is not needed: the tests report statuses to the daemon the way a hook does.
const STUB = `#!/bin/sh
if [ "$1" = "--version" ]; then
  #VERSION_LOG#
  [ -e "$0.slow" ] && sleep 1
  if [ -e "$0.noversion" ]; then echo "no version here"; else echo 9.9.9; fi
  exit 0
fi
case "$1" in
  --settings) shift 2 ;;
  --no-daemon) shift; if [ "$1" = -c ]; then shift 2; fi ;;
  --standalone) shift ;;
esac
echo "cwd:$(pwd -P)"
echo "args:$#:$*"
echo "pid:$$"
echo "ready"
while IFS= read -r line; do
  case "$line" in
    exit) exit 3 ;;
    quit) exit 0 ;;
    title-spinner) printf '\\033]0;✳ Fix the tests\\007'; echo "titled" ;;
    title-empty) printf '\\033]0;✳ \\007'; echo "titled-empty" ;;
    title-long) printf '\\033]0;Fix the tests of the workspace panes in the very long running feature branch right now\\007'; echo "titled-long" ;;
    *) echo "got:$line" ;;
  esac
done
`;

interface Fixture {
  root: string;
  bin: string;
  shell: string;
  /** Appended to by the login shell on every run as a login shell (`-l`). */
  shellLog: string;
  /** `<binary> --version` for each run of a stub's `--version`. */
  runLog: string;
  env(): NodeJS.ProcessEnv;
  install(name: string): void;
}

function makeFixture(binaries: string[], { slowVersion = false } = {}): Fixture {
  const root = realpathSync(makeTestDir('w-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const runLog = join(root, 'runs.log');
  const script = STUB.replace('#VERSION_LOG#', `echo "$(basename "$0") $*" >> '${runLog}'`);
  const install = (name: string) => {
    const stub = join(bin, name);
    writeFileSync(stub, script);
    chmodSync(stub, 0o755);
    // macOS scans a new executable the first time it runs.
    expect(execFileSync(stub, ['--version'], { encoding: 'utf8' }).trim()).toBe('9.9.9');
  };
  for (const name of binaries) install(name);

  const shellLog = join(root, 'shell-args.log');
  const shell = join(root, 'login-shell');
  // Asked for the environment (`-ilc <command>`) it runs the command with the stubs on the PATH; started as a
  // login shell with no command (`-l`) it is an interactive /bin/sh with a prompt of its own.
  writeFileSync(
    shell,
    `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\nif [ "$*" = -l ]; then echo "$*" >> '${shellLog}'; PS1='login-shell> '; export PS1; exec /bin/sh -i; fi\nPATH='${bin}:/usr/bin:/bin' /bin/sh -c "$2"\n`,
  );
  chmodSync(shell, 0o755);
  execFileSync(shell, ['--warmup']);
  expect(execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })).toBe(`${bin}:/usr/bin:/bin`);
  writeFileSync(runLog, '');
  writeFileSync(shellLog, '');
  if (slowVersion) for (const name of binaries) writeFileSync(join(bin, `${name}.slow`), '');
  return { root, bin, shell, shellLog, runLog, env: () => ({ ...process.env, SHELL: shell }), install };
}

const versionRuns = (fx: Fixture) => readFileSync(fx.runLog, 'utf8').split('\n').filter(Boolean);

// --- Repositories ------------------------------------------------------------

const gitTestEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitTestEnv, encoding: 'utf8' }).trim();

interface TempRepo {
  parent: string;
  root: string;
  name: string;
}

function makeRepo(name: string): TempRepo {
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), 'hello\n');
  gitIn(root, 'init', '-b', 'main');
  gitIn(root, 'add', '.');
  gitIn(root, 'commit', '-m', 'initial');
  return { parent, root, name };
}

function writeConfig(repo: TempRepo, config: unknown) {
  mkdirSync(join(repo.root, '.cockpit'), { recursive: true });
  writeFileSync(join(repo.root, '.cockpit', 'config.json'), JSON.stringify(config));
}

const sha8 = (root: string) => createHash('sha256').update(root).digest('hex').slice(0, 8);
const worktreePath = (session: Session, repo: TempRepo, branch: string) =>
  join(realpathSync(session.dataDir), 'h', 'worktrees', `${repo.name}-${sha8(repo.root)}`, branch);

interface StoredSession {
  id: string;
  name: string;
  harness: string;
  directory: string;
  project?: string;
}
const sessionsInState = (dataDir: string): StoredSession[] =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { sessions?: StoredSession[] }).sessions ?? [];
const sessionNamed = (dataDir: string, name: string, directory: string) =>
  sessionsInState(dataDir).find((session) => session.name === name && session.directory === directory);

// --- The page ----------------------------------------------------------------

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
const LOADING_ITEM = 'Detecting agent CLIs…';

type Terminal = ElementHandle<HTMLElement>;

const dispatchFocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

const tokenColor = (page: Page, token: string) =>
  page.evaluate((token) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

async function stubPicker(session: Session, pick: string) {
  await session.evaluateInMain(`(() => {
    const { dialog } = require('electron');
    const picker = (globalThis.__pickerCalls ??= { count: 0 });
    dialog.showOpenDialog = async () => { picker.count++; return { canceled: false, filePaths: [${JSON.stringify(pick)}] }; };
  })()`);
}

async function addRepository(session: Session, repo: TempRepo) {
  const { page } = session;
  await stubPicker(session, repo.root);
  await page.getByRole('button', { name: 'Add project', exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('button', { name: `Actions for ${repo.name}`, exact: true }).waitFor({ state: 'attached', timeout: UI_TIMEOUT });
}

/** The sidebar row of a workspace: a link whose text starts with its branch. */
const workspaceRow = (page: Page, name: string) =>
  page.locator('aside a[href*="/workspace"]').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}(\\s|$)`) });

async function createWorkspace(session: Session, repo: TempRepo, name: string): Promise<string> {
  const { page } = session;
  const result = await page.evaluate(
    ([project, name]) =>
      (window as unknown as { api: { workspaces: { create(project: string, name: string, base: string): Promise<{ status: string }> } } }).api.workspaces.create(
        project!,
        name!,
        'main',
      ),
    [repo.root, name] as const,
  );
  expect(result.status).toBe('created');
  await dispatchFocus(page);
  // Listed in the sidebar, whatever the row is made of.
  await page.locator('aside').getByText(name, { exact: true }).first().waitFor({ timeout: UI_TIMEOUT });
  return worktreePath(session, repo, name);
}

const onWorkspacePage = (page: Page, path: string) =>
  page.waitForURL((url) => url.pathname === '/workspace' && url.searchParams.get('path') === path, { timeout: UI_TIMEOUT });

async function openWorkspace(page: Page, name: string, path: string) {
  await workspaceRow(page, name).click({ timeout: UI_TIMEOUT });
  await onWorkspacePage(page, path);
}

async function goHome(page: Page) {
  await page.getByRole('link', { name: 'Home', exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('heading', { name: 'Home' }).waitFor({ timeout: UI_TIMEOUT });
}

// Panes, in the order a reader sees them (left to right, then top to bottom): marks each tab bar and each
// "New tab" button with its index, so locators can be scoped to one pane. Only visible ones count.
async function markPanes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const { width, height } = element.getBoundingClientRect();
      return width > 0 && height > 0 && getComputedStyle(element).visibility === 'visible';
    };
    const order = (a: Element, b: Element) => {
      const [x, y] = [a.getBoundingClientRect(), b.getBoundingClientRect()];
      return Math.round(x.left) - Math.round(y.left) || Math.round(x.top) - Math.round(y.top);
    };
    const lists = [...document.querySelectorAll('[role="tablist"]')].filter(visible).sort(order);
    for (const stale of document.querySelectorAll('[data-test-pane], [data-test-new]')) {
      stale.removeAttribute('data-test-pane');
      stale.removeAttribute('data-test-new');
    }
    lists.forEach((list, index) => list.setAttribute('data-test-pane', String(index)));
    const buttons = [...document.querySelectorAll('button')]
      .filter((button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim() === 'New tab' && visible(button))
      .sort(order);
    buttons.forEach((button, index) => button.setAttribute('data-test-new', String(index)));
    return lists.length;
  });
}

async function pane(page: Page, index: number): Promise<Locator> {
  await markPanes(page);
  return page.locator(`[data-test-pane="${index}"]`);
}

const paneCount = (page: Page) => markPanes(page);

const labelsOf = (list: Locator) =>
  list.getByRole('tab').evaluateAll((tabs) =>
    tabs.map((tab) => (tab.getAttribute('title') ?? tab.querySelector('[title]')?.getAttribute('title') ?? tab.textContent ?? '').trim()),
  );

const selectedLabelOf = async (list: Locator) =>
  (await list
    .locator('[role="tab"][aria-selected="true"]')
    .evaluateAll((tabs) =>
      tabs.map((tab) => (tab.getAttribute('title') ?? tab.querySelector('[title]')?.getAttribute('title') ?? tab.textContent ?? '').trim()),
    ))[0] ?? null;

const tabLabeled = (list: Locator, label: string, nth = 0) =>
  list.locator('[role="tab"]').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`) }).nth(nth);

const closeButton = (list: Locator, label: string, nth = 0) => list.getByRole('button', { name: `Close ${label}`, exact: true }).nth(nth);

// Hovers the tab (a close button may show on hover only) and clicks its close button.
async function clickClose(page: Page, index: number, label: string, nth = 0) {
  const list = await pane(page, index);
  await tabLabeled(list, label, nth).hover({ timeout: UI_TIMEOUT });
  await closeButton(list, label, nth).click({ timeout: UI_TIMEOUT });
}

async function expectLabels(page: Page, index: number, expected: string[], selected?: string) {
  const labels = await poll(async () => labelsOf(await pane(page, index)), (found) => JSON.stringify(found) === JSON.stringify(expected), UI_TIMEOUT);
  expect(labels).toEqual(expected);
  if (selected !== undefined) expect(await selectedLabelOf(await pane(page, index))).toBe(selected);
}

async function selectTab(page: Page, index: number, label: string, nth = 0) {
  await tabLabeled(await pane(page, index), label, nth).click({ timeout: UI_TIMEOUT });
}

// The visible terminals (the selected tab of each pane).
async function visibleTerminals(page: Page): Promise<Terminal[]> {
  const list = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.xterm')].filter((element) => {
      const { width, height } = element.getBoundingClientRect();
      return width > 0 && height > 0 && getComputedStyle(element).visibility === 'visible';
    }),
  );
  const found = [...(await list.getProperties()).values()].map((handle) => handle.asElement() as Terminal);
  await list.dispose();
  return found;
}

// The visible terminal of pane `index`: the one under its tab bar.
async function terminalOf(page: Page, index: number): Promise<Terminal> {
  await markPanes(page);
  const handle = await poll(
    async () => {
      const found = await page.evaluateHandle((index) => {
        const list = document.querySelector(`[data-test-pane="${index}"]`);
        if (!list) return null;
        const bar = list.getBoundingClientRect();
        return (
          [...document.querySelectorAll('.xterm')].find((element) => {
            const box = element.getBoundingClientRect();
            const centre = box.left + box.width / 2;
            return (
              box.width > 0 &&
              box.height > 0 &&
              getComputedStyle(element).visibility === 'visible' &&
              centre >= bar.left &&
              centre <= bar.right &&
              box.top >= bar.bottom - 1
            );
          }) ?? null
        );
      }, index);
      return found.asElement() as Terminal | null;
    },
    Boolean,
    UI_TIMEOUT,
  );
  if (!handle) throw new Error(`pane ${index} shows no terminal`);
  return handle;
}

// The terminal that holds the keyboard focus, if it is a visible one.
async function keyboardTerminal(page: Page): Promise<Terminal | null> {
  const handle = await page.evaluateHandle(() => {
    const focused = document.activeElement?.closest('.xterm');
    if (!focused) return null;
    const { width, height } = focused.getBoundingClientRect();
    return width > 0 && height > 0 && getComputedStyle(focused).visibility === 'visible' ? focused : null;
  });
  return (handle.asElement() as Terminal | null) ?? null;
}

const isSame = (a: Terminal, b: Terminal) => a.evaluate((one, other) => one === other, b);

async function expectKeyboardIn(page: Page, terminal: Terminal, what: string) {
  const deadline = Date.now() + UI_TIMEOUT;
  for (;;) {
    const active = await keyboardTerminal(page);
    if (active && (await isSame(active, terminal))) return;
    if (Date.now() > deadline) throw new Error(`the keyboard is not in ${what}`);
    await sleep(100);
  }
}

// The index of the pane whose terminal holds the keyboard.
async function paneWithKeyboard(page: Page): Promise<number> {
  const count = await markPanes(page);
  for (let index = 0; index < count; index++) {
    const active = await keyboardTerminal(page);
    if (active && (await isSame(active, await terminalOf(page, index)))) return index;
  }
  return -1;
}

async function typeLine(page: Page, text: string) {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

const rowsOf = (terminal: Terminal) =>
  terminal.evaluate((element) => [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/ /g, ' ').trimEnd()));

async function waitForRow(page: Page, text: string | RegExp, terminal: Terminal) {
  await page.waitForFunction(
    ([element, source]) => {
      const pattern = new RegExp(source);
      return [...element.querySelectorAll('.xterm-rows > div')].some((row) => pattern.test((row.textContent ?? '').replace(/ /g, ' ').trimEnd()));
    },
    [terminal, typeof text === 'string' ? `^${escapeRegExp(text)}$` : text.source] as const,
    { timeout: 15_000 },
  );
}

async function captureRow(page: Page, pattern: RegExp, terminal: Terminal): Promise<string[]> {
  await waitForRow(page, pattern, terminal);
  for (const row of await rowsOf(terminal)) {
    const match = pattern.exec(row);
    if (match) return match.slice(1);
  }
  throw new Error(`no terminal row matches ${pattern}`);
}

const waitForPrompt = (page: Page, terminal: Terminal) =>
  page.waitForFunction(
    (element) => [...element.querySelectorAll('.xterm-rows > div')].some((row) => (row.textContent ?? '').trim() !== ''),
    terminal,
    { timeout: 20_000 },
  );

// Types where the keyboard is and returns the pid a shell prints.
async function shellPid(page: Page, terminal: Terminal): Promise<number> {
  await waitForPrompt(page, terminal);
  await typeLine(page, 'echo pid-$$');
  return Number((await captureRow(page, /^pid-(\d+)$/, terminal))[0]);
}

async function agentPid(page: Page, terminal: Terminal): Promise<number> {
  return Number((await captureRow(page, /^pid:(\d+)$/, terminal))[0]);
}

const endsWithin = async (pid: number, timeout = 5_000) => !(await poll(() => isAlive(pid), (alive) => !alive, timeout));

// What `stty size` answers against what the terminal displays; a late resize is read again for up to 5 s.
async function expectSizeMatchesDisplay(page: Page, terminal: Terminal) {
  await terminal.click({ timeout: UI_TIMEOUT });
  await waitForPrompt(page, terminal);
  const digit = String(1 + (Date.now() % 9));
  await typeLine(page, `printf '%0600d\\n' 0 | tr 0 ${digit}`);
  const line = new RegExp(`^${digit}+$`);
  const total = (rows: string[]) => rows.filter((row) => line.test(row)).reduce((sum, row) => sum + row.length, 0);
  const rows = await poll(() => rowsOf(terminal), (found) => total(found) >= 600, 15_000);
  const shown = [rows.length, Math.max(...rows.filter((row) => line.test(row)).map((row) => row.length))];
  let tag = 0;
  const read = async () => {
    const mark = `sz${Date.now()}x${tag++}`;
    await typeLine(page, `printf '${mark} %s\\n' "$(stty size)"`);
    const [rowsAnswer, colsAnswer] = (await captureRow(page, new RegExp(`^${mark} (\\d+) (\\d+)$`), terminal)).map(Number);
    return [rowsAnswer!, colsAnswer!];
  };
  const matches = (size: number[]) => size[0] === shown[0] && size[1] === shown[1];
  const answer = await poll(read, matches, 5_000);
  expect(answer, `stty size against the displayed rows and columns ${shown}`).toEqual(shown);
}

// --- Menus -------------------------------------------------------------------

const menuItems = (page: Page) => page.getByRole('menu').first().getByRole('menuitem');

async function openNewTabMenu(page: Page, index = 0) {
  await markPanes(page);
  await page.locator(`[data-test-new="${index}"]`).click({ timeout: UI_TIMEOUT });
  await page.getByRole('menu').first().waitFor({ timeout: UI_TIMEOUT });
}

const detectionDone = (page: Page) => poll(() => page.getByRole('menuitem').filter({ hasText: LOADING_ITEM }).count(), (count) => count === 0, 15_000);

const topLevelItems = async (page: Page) => (await menuItems(page).allInnerTexts()).map(normalized);

const menuItemNamed = (page: Page, text: string) =>
  page.getByRole('menu').first().getByRole('menuitem').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`) });

async function openHarnessSubmenu(page: Page): Promise<Locator> {
  await menuItemNamed(page, 'Open harness').click({ timeout: UI_TIMEOUT });
  const submenu = page.getByRole('menu').last();
  await submenu.getByRole('menuitem').first().waitFor({ timeout: UI_TIMEOUT });
  return submenu;
}

/** Picks an entry of the pane's "New tab" menu and waits for the tab it adds. */
async function newTab(page: Page, choice: string, { pane: index = 0, submenu = false }: { pane?: number; submenu?: boolean } = {}) {
  const before = (await labelsOf(await pane(page, index))).length;
  await openNewTabMenu(page, index);
  await detectionDone(page);
  if (submenu) {
    const list = await openHarnessSubmenu(page);
    await list.getByRole('menuitem').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(choice)}(\\s|$)`) }).first().click({ timeout: UI_TIMEOUT });
  } else {
    await menuItemNamed(page, choice).click({ timeout: UI_TIMEOUT });
  }
  await poll(async () => (await labelsOf(await pane(page, index))).length, (count) => count === before + 1, UI_TIMEOUT);
}

async function contextMenu(page: Page, index: number, label: string, nth = 0) {
  await tabLabeled(await pane(page, index), label, nth).click({ button: 'right', timeout: UI_TIMEOUT });
  await page.getByRole('menu').first().waitFor({ timeout: UI_TIMEOUT });
}

async function pickContextItem(page: Page, item: string) {
  await menuItemNamed(page, item).click({ timeout: UI_TIMEOUT });
  await page.getByRole('menu').first().waitFor({ state: 'hidden', timeout: UI_TIMEOUT });
}

const projectsMessage = (page: Page) => page.locator('aside [role="status"]');

// --- Control endpoint --------------------------------------------------------

const controlTokenIn = (home: string) => readFileSync(daemonSocketIn(home).replace(/\.sock$/, '.token'), 'utf8');

function postSessionEvent(socketPath: string, token: string, body: unknown) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ socketPath, method: 'POST', path: '/session-events', headers: { authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function reportStatus(session: Session, id: string, event: 'working' | 'waiting' | 'finished') {
  const status = await postSessionEvent(daemonSocketIn(session.cockpitHome), controlTokenIn(session.cockpitHome), { sessionId: id, event });
  expect(status, `${event} for ${id}`).toBe(204);
}

// The status icon of a workspace row: its accessible name and `title`, its size, and what a row with
// no status shows (the dashed circle, `aria-hidden`, and the color of the name).
const rowStatus = async (page: Page, name: string) => {
  await workspaceRow(page, name).waitFor({ timeout: UI_TIMEOUT });
  return workspaceRow(page, name).evaluate((row, name) => {
    const img = row.querySelector('[role="img"][aria-label]');
    const hidden = row.querySelector('svg[aria-hidden="true"]');
    const nameLeaf = [...row.querySelectorAll('*')].find((element) => element.children.length === 0 && (element.textContent ?? '').trim() === name);
    return {
      label: img?.getAttribute('aria-label') ?? null,
      title: img?.getAttribute('title') ?? null,
      iconSize: (img?.querySelector('svg') ?? hidden)?.getBoundingClientRect().width ?? null,
      hiddenIcon: !!hidden,
      nameColor: nameLeaf ? getComputedStyle(nameLeaf).color : null,
    };
  }, name);
};

const waitForRowStatus = (page: Page, name: string, label: string | null) =>
  poll(() => rowStatus(page, name), (found) => found.label === label, 3_000);

// --- Daemon ------------------------------------------------------------------

function daemonPidIn(home: string): number {
  const file = readdirSync(home).find((entry) => /^daemon-1-.+\.pid$/.test(entry));
  if (!file) throw new Error(`no daemon pid file in ${home}`);
  return Number(readFileSync(join(home, file), 'utf8').trim());
}

const childPidsOf = (pid: number): number[] =>
  execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === pid)
    .map(([child]) => child!);

async function quitApp(session: Session): Promise<void> {
  await session.evaluateInMain(`(() => { const { app } = require('electron'); setTimeout(() => app.quit(), 300); })()`);
  await session.disconnectInspector();
  expect(await poll(() => session.isRunning(), (running) => !running, 10_000), 'the app exits').toBe(false);
  await waitForGroupGone(session.pid);
}

const holdPtySpawn = (session: Session) =>
  session.evaluateInMain(`(() => {
    const handlers = require('electron').ipcMain._invokeHandlers;
    const original = handlers.get('pty:spawn');
    if (!original) throw new Error('the main process has no pty:spawn handler');
    const gate = new Promise((resolve) => { globalThis.__releasePtySpawn = resolve; });
    globalThis.__originalPtySpawn = original;
    handlers.set('pty:spawn', async (...args) => { await gate; return original(...args); });
  })()`);

const releasePtySpawn = (session: Session) =>
  session.evaluateInMain(`(() => {
    const original = globalThis.__originalPtySpawn;
    if (original) require('electron').ipcMain._invokeHandlers.set('pty:spawn', original);
    globalThis.__releasePtySpawn?.();
    delete globalThis.__originalPtySpawn;
    delete globalThis.__releasePtySpawn;
  })()`);

const replacePtySpawn = (session: Session, body: string) =>
  session.evaluateInMain(`(() => {
    const handlers = require('electron').ipcMain._invokeHandlers;
    const original = globalThis.__replacedPtySpawn ?? handlers.get('pty:spawn');
    globalThis.__replacedPtySpawn = original;
    handlers.set('pty:spawn', (${body}));
  })()`);

const restorePtySpawn = (session: Session) =>
  session.evaluateInMain(`(() => {
    const original = globalThis.__replacedPtySpawn;
    if (original) require('electron').ipcMain._invokeHandlers.set('pty:spawn', original);
    delete globalThis.__replacedPtySpawn;
  })()`);

const stubNotifications = (session: Session) =>
  session.evaluateInMain(`(() => {
    const { Notification, BrowserWindow } = require('electron');
    globalThis.__notified = [];
    Notification.prototype.show = function () { globalThis.__notified.push({ title: this.title, body: this.body, notification: this }); };
    BrowserWindow.getFocusedWindow = () => null;
  })()`);

// --- New workspace dialog ----------------------------------------------------

async function createThroughDialog(page: Page, repo: TempRepo, name: string, agent?: string) {
  await page.getByRole('button', { name: `Actions for ${repo.name}`, exact: true }).hover({ timeout: UI_TIMEOUT }).catch(() => undefined);
  await page.getByRole('button', { name: `Actions for ${repo.name}`, exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('menuitem', { name: 'New workspace…' }).click({ timeout: UI_TIMEOUT });
  const dialog = page.getByRole('dialog', { name: `New workspace in ${repo.name}` });
  await dialog.waitFor({ timeout: UI_TIMEOUT });
  await poll(async () => (await dialog.getByRole('combobox', { name: 'Base', exact: true }).innerText()).trim(), (value) => value === 'main', UI_TIMEOUT);
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  if (agent) {
    await dialog.getByRole('combobox', { name: 'Agent', exact: true }).click({ timeout: UI_TIMEOUT });
    await page.getByRole('option', { name: agent, exact: true }).click({ timeout: UI_TIMEOUT });
  }
  await dialog.getByRole('button', { name: 'Create', exact: true }).click({ timeout: UI_TIMEOUT });
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
}

// =============================================================================
// Built app: the full block
// =============================================================================

describe('workspace panes: built app', () => {
  let fx: Fixture;
  let session: Session;
  let repo: TempRepo;
  let repoTwo: TempRepo;
  // The workspaces the tests work in, by branch.
  const ws = { alpha: '', beta: '', gamma: '' };
  const pids = { shell: 0, second: 0, third: 0, claude: 0, codex: 0, claudeTwo: 0, codexTwo: 0 };

  beforeAll(async () => {
    // The stubs' `--version` sleeps 1 s while their `.slow` file exists (the first detection).
    fx = makeFixture(['claude', 'codex'], { slowVersion: true });
    repo = makeRepo('panes-repo');
    repoTwo = makeRepo('panes-other');
    writeConfig(repo, { setup: ['echo setup-one', 'while [ ! -f "$COCKPIT_ROOT_PATH/go" ]; do sleep 0.1; done'] });
    session = await launchBuiltWith(fx.env());
    await session.page.getByText(versionLabel).waitFor();
    await addRepository(session, repo);
    ws.alpha = await createWorkspace(session, repo, 'alpha');
    ws.beta = await createWorkspace(session, repo, 'beta');
    ws.gamma = await createWorkspace(session, repo, 'gamma');
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    for (const each of [repo, repoTwo]) if (each) rmSync(each.parent, { recursive: true, force: true });
  });

  // A failing test must not leave a menu or a dialog that blocks the next ones. Never while the keyboard is in a
  // terminal: the Escape would reach its program.
  afterEach(async () => {
    const { page } = session;
    const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
    for (let attempt = 0; attempt < 4; attempt++) {
      const open = await overlays.count();
      if (open === 0 || (await page.evaluate(() => !!document.activeElement?.closest('.xterm')))) break;
      await page.keyboard.press('Escape');
      await poll(() => overlays.count(), (count) => count < open, 1_000);
    }
  });

  // --- Sidebar ---

  test('AC4 — the sidebar has no Terminal link, Home stays, and the route tree has no /terminal', async () => {
    const { page } = session;
    expect(await page.getByRole('link', { name: 'Terminal', exact: true }).count()).toBe(0);
    expect(await page.locator('aside a[href="/terminal"]').count()).toBe(0);
    expect(await page.getByRole('link', { name: 'Home', exact: true }).count()).toBe(1);
    expect(readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'routeTree.gen.ts'), 'utf8')).not.toContain("'/terminal'");
  });

  test('AC2 — a workspace is one 28 px row with 30 px of left padding, named after its branch, with no git-branch icon and no session rows; its + and … buttons stay', async () => {
    const { page } = session;
    const row = workspaceRow(page, 'alpha');
    await row.waitFor({ timeout: UI_TIMEOUT });
    const facts = await row.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const item = element.closest('li')!;
      return {
        height: box.height,
        paddingLeft: getComputedStyle(element).paddingLeft,
        branchIcons: item.querySelectorAll('svg.lucide-git-branch').length,
        sessionLinks: item.querySelectorAll('a[href*="/sessions/"]').length,
        text: (element.textContent ?? '').trim(),
      };
    });
    expect(facts).toEqual({ height: 28, paddingLeft: '30px', branchIcons: 0, sessionLinks: 0, text: 'alpha' });

    await row.hover({ timeout: UI_TIMEOUT });
    expect(await page.getByRole('button', { name: 'Start session in alpha', exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Actions for alpha', exact: true }).count()).toBe(1);
  });

  test('AC1 — clicking the workspace row shows /workspace?path=<worktree path>, the row is the current page with the sidebar-accent fill, and an empty workspace shows "No tab open" and a "New tab" button', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    await page.mouse.move(700, 400);
    const row = workspaceRow(page, 'alpha');
    expect(await row.getAttribute('aria-current')).toBe('page');
    expect(await row.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(await tokenColor(page, '--sidebar-accent'));
    expect(await workspaceRow(page, 'beta').getAttribute('aria-current')).toBeNull();

    await page.getByText('No tab open', { exact: true }).waitFor({ timeout: UI_TIMEOUT });
    expect(await page.getByRole('button', { name: 'New tab', exact: true }).count()).toBeGreaterThan(0);
  });

  // --- The New tab menu ---

  test('AC9 — the menu shows one disabled "Detecting agent CLIs…" item while detection runs, then the harnesses with logos, the "Open harness" submenu (versions on the right, a separator, "Detect again") and "Terminal"', async () => {
    const { page } = session;
    await openNewTabMenu(page);
    const loading = page.getByRole('menuitem').filter({ hasText: LOADING_ITEM });
    expect(await loading.count()).toBe(1);
    expect(await loading.first().isDisabled()).toBe(true);
    await detectionDone(page);
    // From now on a detection takes no time.
    for (const name of ['claude', 'codex']) unlinkSync(join(fx.bin, `${name}.slow`));

    expect(await topLevelItems(page)).toEqual(['Claude Code', 'Codex', 'Open harness', 'Terminal']);
    const text = normalized(await page.getByRole('menu').first().innerText());
    expect(text).not.toMatch(/Browser|File|[⌘⇧⌥⌃]/);
    for (const name of ['Claude Code', 'Codex']) {
      expect(await menuItemNamed(page, name).locator('svg').count(), `the logo of ${name}`).toBeGreaterThan(0);
    }

    const submenu = await openHarnessSubmenu(page);
    const items = (await submenu.getByRole('menuitem').allInnerTexts()).map(normalized);
    expect(items).toEqual(['Claude Code 9.9.9', 'Codex 9.9.9', 'Detect again']);
    // The version is on the right of the name.
    const versionIsRight = await submenu.getByRole('menuitem').first().evaluate((item) => {
      const leaves = [...item.querySelectorAll('*')].filter((element) => element.children.length === 0);
      const version = leaves.find((element) => (element.textContent ?? '').trim() === '9.9.9');
      const name = leaves.find((element) => (element.textContent ?? '').trim() === 'Claude Code');
      return !!version && !!name && version.getBoundingClientRect().left >= name.getBoundingClientRect().right - 1;
    });
    expect(versionIsRight).toBe(true);
    // A separator sits between the harnesses and "Detect again".
    const order = await submenu.evaluate((menu) => {
      const y = (element: Element | undefined) => element?.getBoundingClientRect().top ?? NaN;
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const separator = menu.querySelector('[role="separator"]');
      return { codex: y(items[1]), separator: y(separator ?? undefined), detect: y(items[2]) };
    });
    expect(order.separator).toBeGreaterThan(order.codex);
    expect(order.detect).toBeGreaterThan(order.separator);
  });

  test('AC10, AC8 — a harness picked from the list starts a session in the worktree in a new selected tab with the keyboard, and one picked from the submenu a second one; clicking a tab selects it and gives it the keyboard', async () => {
    const { page } = session;
    await newTab(page, 'Claude Code');
    await expectLabels(page, 0, ['Claude Code 1'], 'Claude Code 1');
    const claude = await terminalOf(page, 0);
    await expectKeyboardIn(page, claude, 'the new Claude Code tab');
    await waitForRow(page, 'ready', claude);
    expect((await captureRow(page, /^cwd:(.+)$/, claude))[0]).toBe(ws.alpha);
    expect((await captureRow(page, /^args:(\d+):/, claude))[0]).toBe('0');
    pids.claude = await agentPid(page, claude);
    await typeLine(page, 'hello');
    await waitForRow(page, 'got:hello', claude);

    // Stored with the project, numbered per workspace, no prompt.
    const stored = sessionNamed(session.dataDir, 'Claude Code 1', ws.alpha);
    expect(stored).toMatchObject({ harness: 'claude-code', project: repo.root, directory: ws.alpha });

    await newTab(page, 'Codex', { submenu: true });
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1'], 'Codex 1');
    const codex = await terminalOf(page, 0);
    await expectKeyboardIn(page, codex, 'the new Codex tab');
    pids.codex = await agentPid(page, codex);
    expect(sessionNamed(session.dataDir, 'Codex 1', ws.alpha)).toMatchObject({ harness: 'codex', project: repo.root });
    // Only the selected tab's terminal is visible.
    expect(await visibleTerminals(page)).toHaveLength(1);

    await selectTab(page, 0, 'Claude Code 1');
    expect(await selectedLabelOf(await pane(page, 0))).toBe('Claude Code 1');
    const shown = await terminalOf(page, 0);
    expect(await isSame(shown, claude)).toBe(true);
    await expectKeyboardIn(page, shown, 'the clicked tab');
    await typeLine(page, 'again');
    await waitForRow(page, 'got:again', shown);
  });

  test('AC10 — a refused start adds no tab and shows its message in the Projects message slot', async () => {
    const { page } = session;
    const binary = join(fx.bin, 'claude');
    const before = sessionsInState(session.dataDir).length;
    renameSync(binary, `${binary}.off`);
    try {
      await openNewTabMenu(page);
      await menuItemNamed(page, 'Claude Code').click({ timeout: UI_TIMEOUT });
      await poll(() => projectsMessage(page).first().innerText().catch(() => ''), (text) => text.startsWith('Could not start Claude Code:'), UI_TIMEOUT);
      expect(await projectsMessage(page).first().innerText()).toContain('not found');
      expect(await labelsOf(await pane(page, 0))).toEqual(['Claude Code 1', 'Codex 1']);
      expect(sessionsInState(session.dataDir)).toHaveLength(before);
    } finally {
      renameSync(`${binary}.off`, binary);
    }
  });

  test('AC11 — "Terminal" starts a login shell in the worktree with the terminal environment in a new selected tab with the keyboard; a spawn that rejects writes [Could not start the shell: …] in that tab', async () => {
    const { page } = session;
    await newTab(page, 'Terminal');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal'], 'Terminal');
    const shell = await terminalOf(page, 0);
    await expectKeyboardIn(page, shell, 'the new shell tab');
    await waitForPrompt(page, shell);
    await typeLine(page, 'echo "env:$TERM:$COLORTERM:${COCKPIT_SOCKET:+socket}:$(pwd -P)"');
    expect((await captureRow(page, /^env:(.*)$/, shell))[0]).toBe(`xterm-256color:truecolor:socket:${ws.alpha}`);
    expect(readFileSync(fx.shellLog, 'utf8').split('\n').filter(Boolean)).toContain('-l');
    pids.shell = await shellPid(page, shell);

    await replacePtySpawn(session, `async () => { throw new Error('refused by the test'); }`);
    try {
      await newTab(page, 'Terminal');
      const broken = await terminalOf(page, 0);
      await waitForRow(page, /^\[Could not start the shell: .*refused by the test.*\]$/, broken);
    } finally {
      await restorePtySpawn(session);
    }
    // The failed tab goes with its close button.
    await clickClose(page, 0, 'Terminal', 1);
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal'], 'Terminal');
  });

  test('AC7 — a tab shows its program\'s title without the leading glyphs, falls back to the session name or "Terminal" when there is none or it is empty once stripped', async () => {
    const { page } = session;
    await selectTab(page, 0, 'Claude Code 1');
    const claude = await terminalOf(page, 0);
    await claude.click();
    await typeLine(page, 'title-spinner');
    await expectLabels(page, 0, ['Fix the tests', 'Codex 1', 'Terminal']);
    expect(await tabLabeled(await pane(page, 0), 'Fix the tests').getAttribute('title')).toBe('Fix the tests');

    await typeLine(page, 'title-empty');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal']);

    await selectTab(page, 0, 'Terminal');
    const shell = await terminalOf(page, 0);
    await shell.click();
    await typeLine(page, `printf '\\033]0;~ shell-title\\007'`);
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'shell-title']);
    await typeLine(page, `printf '\\033]0;\\007'`);
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal']);
  });

  test('AC6 — the tab bar, tabs, close buttons and terminal are measured as in the mockup', async () => {
    const { page } = session;
    await selectTab(page, 0, 'Codex 1');
    const list = await pane(page, 0);
    const accent = await tokenColor(page, '--sidebar-accent');

    // A long title is truncated, the full label is the title.
    await selectTab(page, 0, 'Claude Code 1');
    const claude = await terminalOf(page, 0);
    await claude.click();
    await typeLine(page, 'title-long');
    const long = 'Fix the tests of the workspace panes in the very long running feature branch right now';
    await expectLabels(page, 0, [long, 'Codex 1', 'Terminal']);
    await selectTab(page, 0, 'Codex 1');

    const facts = await list.evaluate((bar) => {
      const label = (tab: Element) => (tab.getAttribute('title') ?? tab.querySelector('[title]')?.getAttribute('title') ?? tab.textContent ?? '').trim();
      const tabs = [...bar.querySelectorAll('[role="tab"]')].map((tab) => {
        const name = label(tab);
        const close = [...bar.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === `Close ${name}`) as HTMLElement | undefined;
        let box: Element = tab;
        while (close && box !== bar && !box.contains(close)) box = box.parentElement!;
        const style = getComputedStyle(box);
        const icon = box.querySelector('svg');
        const leaf = [...box.querySelectorAll('*')].find((element) => element.children.length === 0 && (element.textContent ?? '').trim() === name.trim());
        const closeBox = close?.getBoundingClientRect();
        const closeStyle = close ? getComputedStyle(close) : undefined;
        return {
          label: name,
          selected: tab.getAttribute('aria-selected') === 'true',
          height: box.getBoundingClientRect().height,
          width: box.getBoundingClientRect().width,
          radius: style.borderTopLeftRadius,
          paddingLeft: style.paddingLeft,
          background: style.backgroundColor,
          border: `${style.borderTopWidth} ${style.borderTopColor}`,
          inset: style.boxShadow,
          iconWidth: icon?.getBoundingClientRect().width,
          fontSize: leaf ? getComputedStyle(leaf).fontSize : null,
          ellipsis: leaf ? getComputedStyle(leaf).textOverflow : null,
          truncated: leaf ? leaf.scrollWidth > leaf.clientWidth : null,
          closeSize: closeBox ? [closeBox.width, closeBox.height] : null,
          closeShown: closeStyle ? closeStyle.display !== 'none' && closeStyle.visibility !== 'hidden' && Number(closeStyle.opacity) > 0 : null,
          iconClass: icon?.getAttribute('class') ?? '',
        };
      });
      const barBox = bar.getBoundingClientRect();
      return { barHeight: barBox.height, barBorder: getComputedStyle(bar).borderBottomWidth, tabs };
    });

    expect(facts.barHeight).toBe(28);
    expect(facts.barBorder).toBe('0px');
    expect(facts.tabs.map((tab) => tab.label)).toEqual([long, 'Codex 1', 'Terminal']);
    for (const tab of facts.tabs) {
      expect(tab.height, tab.label).toBe(28);
      expect(tab.radius, tab.label).toBe('8px');
      expect(tab.width, tab.label).toBeLessThanOrEqual(200);
      expect(tab.paddingLeft, tab.label).toBe('8px');
      expect(tab.iconWidth, tab.label).toBe(14);
      expect(tab.fontSize, tab.label).toBe('12px');
      expect(tab.closeSize, tab.label).toEqual([16, 16]);
    }
    const [longTab, selected, shellTab] = facts.tabs;
    expect(longTab!.ellipsis).toBe('ellipsis');
    expect(longTab!.truncated).toBe(true);
    expect(shellTab!.iconClass).toContain('lucide-square-terminal');
    // Selected: the sidebar-accent fill and a visible close button; the others: no fill, a 1 px inside border of that colour.
    expect(selected!.selected).toBe(true);
    expect(selected!.background).toBe(accent);
    expect(selected!.closeShown).toBe(true);
    for (const other of [longTab!, shellTab!]) {
      expect(other.selected).toBe(false);
      expect(other.background).toMatch(/^rgba\(0, 0, 0, 0\)$|^transparent$/);
      const hasBorder = other.border === `1px ${accent}`;
      const hasInset = other.inset.includes(accent) && other.inset.includes('inset');
      expect(hasBorder || hasInset, `${other.label} has a 1 px inside border in ${accent}: ${other.border} / ${other.inset}`).toBe(true);
      expect(other.closeShown, `${other.label} hides its close button`).toBe(false);
    }
    // The close button of another tab shows on hover.
    await tabLabeled(list, 'Terminal').hover({ timeout: UI_TIMEOUT });
    const shown = () =>
      closeButton(list, 'Terminal').evaluate((button) => {
        const style = getComputedStyle(button);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      });
    expect(await poll(shown, Boolean, 2_000), 'the close button of another tab shows on hover').toBe(true);

    // The terminal sits 8 px below the tab bar; only the selected tab's terminal is visible.
    const terminal = await terminalOf(page, 0);
    const gap = (await terminal.evaluate((element) => element.getBoundingClientRect().top)) - (await list.evaluate((bar) => bar.getBoundingClientRect().bottom));
    expect(gap).toBeGreaterThanOrEqual(8);
    expect(gap).toBeLessThanOrEqual(12);
    expect(await visibleTerminals(page)).toHaveLength(1);

    await selectTab(page, 0, long);
    await (await terminalOf(page, 0)).click();
    await typeLine(page, 'title-empty');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal']);
  });

  test('AC13, AC15 — right-clicking a tab opens a menu with "Split right", "Split down", "Copy path" and, after a separator, "Close tab", no shortcut; "Copy path" puts the worktree path on the clipboard', async () => {
    const { page } = session;
    await contextMenu(page, 0, 'Codex 1');
    expect(await topLevelItems(page)).toEqual(['Split right', 'Split down', 'Copy path', 'Close tab']);
    expect(normalized(await page.getByRole('menu').first().innerText())).not.toMatch(/[⌘⇧⌥⌃]/);
    const order = await page.getByRole('menu').first().evaluate((menu) => {
      const y = (element: Element | null | undefined) => element?.getBoundingClientRect().top ?? NaN;
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      return { copy: y(items[2]), separator: y(menu.querySelector('[role="separator"]')), close: y(items[3]) };
    });
    expect(order.separator).toBeGreaterThan(order.copy);
    expect(order.close).toBeGreaterThan(order.separator);

    await session.evaluateInMain(`require('electron').clipboard.writeText('before')`);
    await pickContextItem(page, 'Copy path');
    expect(await poll(() => session.evaluateInMain<string>(`require('electron').clipboard.readText()`), (text) => text === ws.alpha, UI_TIMEOUT)).toBe(ws.alpha);
  });

  test('AC14 — "Split right" and "Split down" divide a pane into equal halves with a new selected shell tab holding the keyboard; splits nest, panes are 8 px padded and 1 px apart in --border, and every terminal\'s stty size matches its display', async () => {
    const { page } = session;
    await selectTab(page, 0, 'Terminal');
    await contextMenu(page, 0, 'Terminal');
    await pickContextItem(page, 'Split right');
    await poll(() => paneCount(page), (count) => count === 2, UI_TIMEOUT);

    // The pane keeps its tabs on the left; the new pane on the right holds one shell tab, selected, with the keyboard.
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal'], 'Terminal');
    await expectLabels(page, 1, ['Terminal'], 'Terminal');
    const right = await terminalOf(page, 1);
    await expectKeyboardIn(page, right, 'the new pane');
    pids.second = await shellPid(page, right);
    expect(await paneWithKeyboard(page)).toBe(1);

    // Equal halves, 8 px of padding on each side of a 1 px divider in --border.
    const bars = await Promise.all([0, 1].map(async (index) => (await pane(page, index)).evaluate((bar) => {
      const { left, right, top, width } = bar.getBoundingClientRect();
      return { left, right, top, width };
    })));
    expect(Math.abs(bars[0]!.width - bars[1]!.width)).toBeLessThanOrEqual(1);
    expect(bars[0]!.top).toBe(bars[1]!.top);
    expect(bars[1]!.left - bars[0]!.right).toBeGreaterThanOrEqual(16.5);
    expect(bars[1]!.left - bars[0]!.right).toBeLessThanOrEqual(17.5);
    const border = await tokenColor(page, '--border');
    const divider = await page.evaluate(
      ([x, y]) =>
        document.elementsFromPoint(x!, y!).some((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const oneWide = box.width > 0 && box.width <= 1.01 && box.height > 100;
          return oneWide || style.borderLeftWidth === '1px' || style.borderRightWidth === '1px';
        }),
      [bars[0]!.right + 8.5, bars[0]!.top + 100] as const,
    );
    expect(divider, 'a 1 px divider between the panes').toBe(true);
    const dividerColor = await page.evaluate(
      ([x, y]) => {
        for (const element of document.elementsFromPoint(x!, y!)) {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (box.width > 0 && box.width <= 1.01 && box.height > 100) return style.backgroundColor;
          if (style.borderLeftWidth === '1px') return style.borderLeftColor;
          if (style.borderRightWidth === '1px') return style.borderRightColor;
        }
        return null;
      },
      [bars[0]!.right + 8.5, bars[0]!.top + 100] as const,
    );
    expect(dividerColor).toBe(border);

    // Split down on the right pane: three panes, the two on the right of equal height.
    await contextMenu(page, 1, 'Terminal');
    await pickContextItem(page, 'Split down');
    await poll(() => paneCount(page), (count) => count === 3, UI_TIMEOUT);
    await expectLabels(page, 2, ['Terminal'], 'Terminal');
    const bottom = await terminalOf(page, 2);
    await expectKeyboardIn(page, bottom, 'the pane split down');
    pids.third = await shellPid(page, bottom);
    const heights = await Promise.all([1, 2].map(async (index) => (await terminalOf(page, index)).evaluate((element) => element.getBoundingClientRect().height)));
    expect(Math.abs(heights[0]! - heights[1]!)).toBeLessThanOrEqual(24);
    expect(await visibleTerminals(page)).toHaveLength(3);

    for (const index of [0, 1, 2]) await expectSizeMatchesDisplay(page, await terminalOf(page, index));
  });

  test('AC27 — with the sidebar hidden, "Show sidebar" sits at least 72 px from the left and the first tab starts right of it; the empty part of the top tab bar drags the window, its tabs and buttons do not', async () => {
    const { page } = session;
    await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click({ timeout: UI_TIMEOUT });
    try {
      const show = page.getByRole('button', { name: 'Show sidebar', exact: true });
      await show.waitFor({ timeout: UI_TIMEOUT });
      const showBox = (await show.boundingBox())!;
      expect(showBox.x).toBeGreaterThanOrEqual(72);
      const first = (await tabLabeled(await pane(page, 0), 'Claude Code 1').boundingBox({ timeout: UI_TIMEOUT }))!;
      expect(first.x).toBeGreaterThanOrEqual(showBox.x + showBox.width - 1);

      const regions = await page.evaluate(() => {
        const effective = (point: [number, number]) => {
          for (let element = document.elementFromPoint(...point); element; element = element.parentElement) {
            const region = getComputedStyle(element).getPropertyValue('-webkit-app-region');
            if (region === 'drag' || region === 'no-drag') return region;
          }
          return 'none';
        };
        const bar = document.querySelector('[data-test-pane="0"]') as HTMLElement;
        const box = bar.getBoundingClientRect();
        const centre = (element: Element): [number, number] => {
          const rect = element.getBoundingClientRect();
          return [rect.left + rect.width / 2, rect.top + rect.height / 2];
        };
        const tab = bar.querySelector('[role="tab"]')!;
        const buttons = [...bar.querySelectorAll('button')].concat(
          [...document.querySelectorAll('button')].filter((button) => (button.getAttribute('aria-label') ?? '').trim() === 'New tab'),
        );
        // The empty part: the right end of the first pane's bar, past its tabs and buttons.
        const last = [...bar.querySelectorAll('[role="tab"], button')].reduce((edge, element) => Math.max(edge, element.getBoundingClientRect().right), 0);
        return {
          empty: effective([Math.min(box.right - 4, last + 24), box.top + box.height / 2]),
          tab: effective(centre(tab)),
          buttons: buttons.filter((button) => button.getBoundingClientRect().width > 0).map((button) => effective(centre(button))),
        };
      });
      expect(regions.empty).toBe('drag');
      expect(regions.tab).toBe('no-drag');
      expect(regions.buttons.length).toBeGreaterThan(0);
      expect(regions.buttons.every((region) => region === 'no-drag')).toBe(true);
    } finally {
      await page.getByRole('button', { name: 'Show sidebar', exact: true }).click({ timeout: UI_TIMEOUT });
      await page.getByRole('button', { name: 'Hide sidebar', exact: true }).waitFor({ timeout: UI_TIMEOUT });
    }
  });

  test('AC23, AC8 — a workspace row\'s + menu starts the session in a new tab of the workspace\'s focused pane (the pane last clicked or typed in)', async () => {
    const { page } = session;
    // The pane last clicked: the first one.
    await selectTab(page, 0, 'Claude Code 1');
    await (await terminalOf(page, 0)).click();
    await workspaceRow(page, 'alpha').hover({ timeout: UI_TIMEOUT });
    await page.getByRole('button', { name: 'Start session in alpha', exact: true }).click({ timeout: UI_TIMEOUT });
    await detectionDone(page);
    await menuItemNamed(page, 'Claude Code').click({ timeout: UI_TIMEOUT });
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Claude Code 2'], 'Claude Code 2');
    const claudeTwo = await terminalOf(page, 0);
    await expectKeyboardIn(page, claudeTwo, 'the new tab');
    pids.claudeTwo = await agentPid(page, claudeTwo);

    // Then the second pane.
    await (await terminalOf(page, 1)).click();
    await workspaceRow(page, 'alpha').hover({ timeout: UI_TIMEOUT });
    await page.getByRole('button', { name: 'Start session in alpha', exact: true }).click({ timeout: UI_TIMEOUT });
    await detectionDone(page);
    await menuItemNamed(page, 'Codex').click({ timeout: UI_TIMEOUT });
    await expectLabels(page, 1, ['Terminal', 'Codex 2'], 'Codex 2');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Claude Code 2']);
    pids.codexTwo = await agentPid(page, await terminalOf(page, 1));
  });

  // --- Status of the row ---

  test('AC3, AC2 — a workspace row shows the icon of its most urgent session (Needs input, Working, Ready, Exited N); with none, the muted dashed circle with aria-hidden; the sessions are not rows', async () => {
    const { page } = session;
    // `beta` never had a session: the muted dashed circle, hidden from assistive technology.
    const none = await rowStatus(page, 'beta');
    expect(none).toMatchObject({ label: null, hiddenIcon: true, iconSize: 14 });
    expect(none.nameColor).toBe(await tokenColor(page, '--muted-foreground'));

    await workspaceRow(page, 'beta').hover({ timeout: UI_TIMEOUT });
    for (let n = 1; n <= 3; n++) {
      await page.getByRole('button', { name: 'Start session in beta', exact: true }).click({ timeout: UI_TIMEOUT });
      await detectionDone(page);
      await menuItemNamed(page, 'Claude Code').click({ timeout: UI_TIMEOUT });
      await onWorkspacePage(page, ws.beta);
      await expectLabels(page, 0, Array.from({ length: n }, (_, index) => `Claude Code ${index + 1}`), `Claude Code ${n}`);
      await workspaceRow(page, 'beta').hover({ timeout: UI_TIMEOUT });
    }
    const id = (name: string) => sessionNamed(session.dataDir, name, ws.beta)!.id;
    const [one, two, three] = [id('Claude Code 1'), id('Claude Code 2'), id('Claude Code 3')] as [string, string, string];
    // Numbered per workspace: alpha has its own "Claude Code 1" and "Claude Code 2".
    expect(sessionNamed(session.dataDir, 'Claude Code 1', ws.alpha)).toBeDefined();
    // Running sessions that have not reported yet have no status.
    expect((await rowStatus(page, 'beta')).label).toBeNull();

    await reportStatus(session, one, 'working');
    await reportStatus(session, two, 'waiting');
    const waiting = await waitForRowStatus(page, 'beta', 'Needs input');
    expect(waiting).toMatchObject({ label: 'Needs input', title: 'Needs input', iconSize: 14, hiddenIcon: false });

    await reportStatus(session, two, 'finished');
    expect((await waitForRowStatus(page, 'beta', 'Working')).label).toBe('Working');
    await reportStatus(session, one, 'finished');
    expect((await waitForRowStatus(page, 'beta', 'Ready')).label).toBe('Ready');

    // Both end with code 3 while the third runs without a status: "Exited 3".
    for (const label of ['Claude Code 1', 'Claude Code 2']) {
      await selectTab(page, 0, label);
      await (await terminalOf(page, 0)).click();
      await typeLine(page, 'exit');
      await waitForRow(page, '[Process exited with code 3]', await terminalOf(page, 0));
    }
    expect((await waitForRowStatus(page, 'beta', 'Exited 3')).label).toBe('Exited 3');
    // An exit with code 0 does not outrank it.
    await reportStatus(session, three, 'finished');
    await selectTab(page, 0, 'Claude Code 3');
    await (await terminalOf(page, 0)).click();
    await typeLine(page, 'quit');
    await waitForRow(page, '[Process exited with code 0]', await terminalOf(page, 0));
    expect((await rowStatus(page, 'beta')).label).toBe('Exited 3');
    // No session row under the workspace.
    expect(await workspaceRow(page, 'beta').evaluate((row) => row.closest('li')!.querySelectorAll('a[href*="/sessions/"]').length)).toBe(0);
  });

  // --- Leaving and coming back ---

  test('AC18, AC20 — Home, another workspace and back keep the panes, tabs, selections, outputs, processes and the keyboard; a window resized meanwhile is fitted on return, in the shown and in a hidden tab', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const done = join(session.dataDir, 'later.flag');
    rmSync(done, { force: true });
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Claude Code 2'], 'Claude Code 2');
    await expectLabels(page, 1, ['Terminal', 'Codex 2'], 'Codex 2');
    // Markers in the shells, a command that prints later in the bottom pane, the keyboard there.
    await selectTab(page, 1, 'Terminal');
    const second = await terminalOf(page, 1);
    await second.click();
    await typeLine(page, 'echo m2-$((20+2))');
    await waitForRow(page, 'm2-22', second);
    const bottom = await terminalOf(page, 2);
    await bottom.click();
    await typeLine(page, 'echo m3-$((30+3))');
    await waitForRow(page, 'm3-33', bottom);
    await typeLine(page, `sleep 2; echo later-$((6*7)); : > '${done}'`);

    try {
      await goHome(page);
      expect(existsSync(done), 'the command has not printed yet when the user leaves').toBe(false);
      for (const pid of Object.values(pids)) if (pid) expect(isAlive(pid), `process ${pid} while Home`).toBe(true);
      await page.setViewportSize({ width: viewport.width - 300, height: viewport.height - 150 });
      expect(await poll(() => existsSync(done), Boolean, 15_000), 'the command ended while Home').toBe(true);

      // Another workspace meanwhile: the processes of the workspace not shown keep running.
      await openWorkspace(page, 'beta', ws.beta);
      for (const pid of Object.values(pids)) if (pid) expect(isAlive(pid), `process ${pid} on another workspace`).toBe(true);
      await openWorkspace(page, 'alpha', ws.alpha);

      expect(await paneCount(page)).toBe(3);
      await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Claude Code 2'], 'Claude Code 2');
      await expectLabels(page, 1, ['Terminal', 'Codex 2'], 'Terminal');
      await expectLabels(page, 2, ['Terminal'], 'Terminal');
      const back = await terminalOf(page, 2);
      await waitForRow(page, 'm3-33', back);
      await waitForRow(page, 'later-42', back);
      await waitForRow(page, 'm2-22', await terminalOf(page, 1));
      // The keyboard is where it was: no click before typing.
      await expectKeyboardIn(page, back, 'the bottom pane');
      await typeLine(page, 'echo kb-$((3*3))');
      await waitForRow(page, 'kb-9', back);

      // stty size is what the terminals display, in a shown shell and in the one of a tab that was hidden meanwhile.
      await expectSizeMatchesDisplay(page, back);
      await selectTab(page, 0, 'Terminal');
      await expectSizeMatchesDisplay(page, await terminalOf(page, 0));
      for (const pid of Object.values(pids)) if (pid) expect(isAlive(pid)).toBe(true);
    } finally {
      await page.setViewportSize(viewport);
    }
  });

  // --- Closing ---

  test('AC16, AC17 — closing a shell tab ends its process and selects the tab on its left; the last tab of a pane removes the pane and its sibling takes the keyboard; a running agent asks first (Cancel and Escape change nothing); an agent that ended closes at once', async () => {
    const { page } = session;
    // The bottom pane's only tab: the pane goes, the pane above fills the area and takes the keyboard.
    await contextMenu(page, 2, 'Terminal');
    await pickContextItem(page, 'Close tab');
    await poll(() => paneCount(page), (count) => count === 2, UI_TIMEOUT);
    expect(await endsWithin(pids.third), 'the closed shell is gone within 5 s').toBe(true);
    await expectLabels(page, 1, ['Terminal', 'Codex 2']);
    await expectKeyboardIn(page, await terminalOf(page, 1), 'the sibling pane');

    // A running agent: a dialog first.
    await clickClose(page, 1, 'Codex 2');
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'Close Codex 2?' });
    await dialog.waitFor({ timeout: UI_TIMEOUT });
    expect(normalized(await dialog.innerText())).toContain('Codex is still running in this tab. Closing it ends the agent; the workspace stays in the sidebar.');
    expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: UI_TIMEOUT });
    await dialog.waitFor({ state: 'hidden', timeout: UI_TIMEOUT });
    await clickClose(page, 1, 'Codex 2');
    await dialog.waitFor({ timeout: UI_TIMEOUT });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: UI_TIMEOUT });
    await expectLabels(page, 1, ['Terminal', 'Codex 2']);
    expect(isAlive(pids.codexTwo)).toBe(true);

    await clickClose(page, 1, 'Codex 2');
    await dialog.waitFor({ timeout: UI_TIMEOUT });
    await dialog.getByRole('button', { name: 'Close tab', exact: true }).click({ timeout: UI_TIMEOUT });
    await expectLabels(page, 1, ['Terminal'], 'Terminal');
    expect(await endsWithin(pids.codexTwo), 'the agent is gone within 5 s').toBe(true);
    // The session stays stored and the workspace row stays.
    expect(sessionNamed(session.dataDir, 'Codex 2', ws.alpha)).toBeDefined();
    expect(await workspaceRow(page, 'alpha').count()).toBe(1);

    // The last tab of the pane: it goes, the first pane fills the window and takes the keyboard.
    await clickClose(page, 1, 'Terminal');
    await poll(() => paneCount(page), (count) => count === 1, UI_TIMEOUT);
    expect(await endsWithin(pids.second)).toBe(true);
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Claude Code 2']);
    await expectKeyboardIn(page, await terminalOf(page, 0), 'the remaining pane');

    // A shell tab closed from the tab bar: the tab on its left gets the selection.
    await selectTab(page, 0, 'Terminal');
    await clickClose(page, 0, 'Terminal');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Claude Code 2'], 'Codex 1');
    expect(await endsWithin(pids.shell)).toBe(true);

    // An agent that ended closes with no dialog.
    await selectTab(page, 0, 'Claude Code 2');
    await (await terminalOf(page, 0)).click();
    await typeLine(page, 'exit');
    await waitForRow(page, '[Process exited with code 3]', await terminalOf(page, 0));
    await clickClose(page, 0, 'Claude Code 2');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1'], 'Codex 1');
    expect(await page.getByRole('alertdialog').or(page.getByRole('dialog')).count()).toBe(0);
    expect(await endsWithin(pids.claudeTwo)).toBe(true);
    expect(isAlive(pids.claude) && isAlive(pids.codex)).toBe(true);
  });

  test('AC16 — closing the workspace\'s last tab shows "No tab open"', async () => {
    const { page } = session;
    await openWorkspace(page, 'gamma', ws.gamma);
    await newTab(page, 'Terminal');
    await expectLabels(page, 0, ['Terminal'], 'Terminal');
    const shell = await terminalOf(page, 0);
    const pid = await shellPid(page, shell);
    await clickClose(page, 0, 'Terminal');
    await page.getByText('No tab open', { exact: true }).waitFor({ timeout: UI_TIMEOUT });
    expect(await endsWithin(pid)).toBe(true);
    expect(await page.getByRole('button', { name: 'New tab', exact: true }).count()).toBeGreaterThan(0);
  });

  // --- Detecting again ---

  test('AC12 — "Detect again" runs every found harness\'s --version once more: a stub added to a PATH folder appears (without a version when it prints none), one removed disappears, and the other Start session menus show the same; with none left the menu says "No agent CLI found" and "Terminal" still works', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    const readMenu = async () => {
      await openNewTabMenu(page);
      await detectionDone(page);
      const items = await topLevelItems(page);
      await page.keyboard.press('Escape');
      await page.getByRole('menu').first().waitFor({ state: 'hidden', timeout: UI_TIMEOUT });
      return items;
    };
    const detectAgain = async () => {
      const before = versionRuns(fx).length;
      await openNewTabMenu(page);
      await detectionDone(page);
      const submenu = await openHarnessSubmenu(page);
      await submenu.getByRole('menuitem').filter({ hasText: 'Detect again' }).click({ timeout: UI_TIMEOUT });
      return before;
    };

    expect(await readMenu()).toEqual(['Claude Code', 'Codex', 'Open harness', 'Terminal']);
    fx.install('opencode');
    writeFileSync(join(fx.bin, 'opencode.noversion'), '');
    const before = await detectAgain();
    await poll(async () => versionRuns(fx).length, (count) => count >= before + 3, UI_TIMEOUT);
    // Each found harness once more.
    expect(versionRuns(fx).slice(before).sort()).toEqual(['claude --version', 'codex --version', 'opencode --version']);
    expect(await readMenu()).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Open harness', 'Terminal']);
    await openNewTabMenu(page);
    await detectionDone(page);
    const submenu = await openHarnessSubmenu(page);
    expect((await submenu.getByRole('menuitem').allInnerTexts()).map(normalized)).toEqual(['Claude Code 9.9.9', 'Codex 9.9.9', 'OpenCode', 'Detect again']);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // The Sessions header's menu and the workspace row's menu show the same result.
    await page.getByRole('button', { name: 'Start session', exact: true }).click({ timeout: UI_TIMEOUT });
    await detectionDone(page);
    expect((await menuItems(page).allInnerTexts()).map(normalized)).toEqual(['Claude Code', 'Codex', 'OpenCode']);
    await page.keyboard.press('Escape');
    await workspaceRow(page, 'alpha').hover({ timeout: UI_TIMEOUT });
    await page.getByRole('button', { name: 'Start session in alpha', exact: true }).click({ timeout: UI_TIMEOUT });
    await detectionDone(page);
    expect((await menuItems(page).allInnerTexts()).map(normalized)).toEqual(['Claude Code', 'Codex', 'OpenCode']);
    await page.keyboard.press('Escape');

    // Removing the stubs: they disappear, and with none left, nothing but "Terminal" starts.
    for (const name of ['claude', 'codex', 'opencode']) renameSync(join(fx.bin, name), join(fx.bin, `${name}.off`));
    await detectAgain();
    await poll(async () => (await readMenu()).includes('No agent CLI found'), Boolean, UI_TIMEOUT);
    await openNewTabMenu(page);
    await detectionDone(page);
    const none = page.getByRole('menuitem').filter({ hasText: 'No agent CLI found' });
    expect(await none.count()).toBe(1);
    expect(await none.first().isDisabled()).toBe(true);
    expect(await menuItemNamed(page, 'Terminal').isDisabled()).toBe(false);
    await page.keyboard.press('Escape');

    for (const name of ['claude', 'codex', 'opencode']) renameSync(join(fx.bin, `${name}.off`), join(fx.bin, name));
    unlinkSync(join(fx.bin, 'opencode'));
    const restored = await detectAgain();
    await poll(async () => versionRuns(fx).length, (count) => count > restored, UI_TIMEOUT);
    await poll(readMenu, (items) => items.join() === 'Claude Code,Codex,Open harness,Terminal', UI_TIMEOUT);
  });

  // --- Restoring ---

  test('AC19, AC7 — after a reload each workspace\'s running sessions and shells are the tabs of one pane in creation order, the first selected, with their screens and the fallback labels; the layout is not saved', async () => {
    const { page } = session;
    await newTab(page, 'Terminal');
    const shell = await terminalOf(page, 0);
    const shellId = await shellPid(page, shell);
    await typeLine(page, 'echo marker-before-reload');
    await waitForRow(page, 'marker-before-reload', shell);
    // A title set by the program is not kept across a reload.
    await selectTab(page, 0, 'Claude Code 1');
    await (await terminalOf(page, 0)).click();
    await typeLine(page, 'title-spinner');
    await expectLabels(page, 0, ['Fix the tests', 'Codex 1', 'Terminal']);
    await contextMenu(page, 0, 'Terminal');
    await pickContextItem(page, 'Split right');
    await poll(() => paneCount(page), (count) => count === 2, UI_TIMEOUT);

    await page.reload();
    await page.getByText(versionLabel).waitFor({ timeout: UI_TIMEOUT });
    await page.waitForURL((url) => url.pathname === '/workspace', { timeout: UI_TIMEOUT });
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Terminal'], 'Claude Code 1');
    expect(await paneCount(page), 'the split is not saved').toBe(1);
    expect(await visibleTerminals(page)).toHaveLength(1);
    for (const pid of [pids.claude, pids.codex, shellId]) expect(isAlive(pid), `process ${pid}`).toBe(true);
    // The screens come back.
    const first = await terminalOf(page, 0);
    await waitForRow(page, 'got:again', first);
    await selectTab(page, 0, 'Terminal');
    await waitForRow(page, 'marker-before-reload', await terminalOf(page, 0));
    // Another workspace whose processes ended: nothing to restore.
    await openWorkspace(page, 'beta', ws.beta);
    await page.getByText('No tab open', { exact: true }).waitFor({ timeout: UI_TIMEOUT });
  });

  // --- Entry points ---

  test('AC21 — the New workspace dialog with an agent opens the workspace page with one selected agent tab that runs the setup through the CLI, then the agent; the row says Setting up meanwhile', async () => {
    const { page } = session;
    rmSync(join(repo.root, 'go'), { force: true });
    await createThroughDialog(page, repo, 'dagent', 'Claude Code');
    const path = worktreePath(session, repo, 'dagent');
    await onWorkspacePage(page, path);
    await expectLabels(page, 0, ['Claude Code 1'], 'Claude Code 1');
    const terminal = await terminalOf(page, 0);
    await waitForRow(page, /^cockpit setup · dagent · \.cockpit\/config\.json$/, terminal);
    await waitForRow(page, '$ echo setup-one', terminal);
    await waitForRow(page, 'setup-one', terminal);
    const label = () => workspaceRow(page, 'dagent').locator('xpath=ancestor::li[1]').innerText();
    await poll(label, (text) => text.includes('Setting up'), UI_TIMEOUT);
    expect(await label()).toContain('Setting up');
    writeFileSync(join(repo.root, 'go'), '');
    await waitForRow(page, '✓ Setup done', terminal);
    await waitForRow(page, 'ready', terminal);
    expect((await captureRow(page, /^cwd:(.+)$/, terminal))[0]).toBe(path);
    await poll(label, (text) => !text.includes('Setting up'), UI_TIMEOUT);
    expect(sessionNamed(session.dataDir, 'Claude Code 1', path)).toMatchObject({ project: repo.root });
  });

  test('AC22 — the dialog with Agent "None" opens the workspace page with one shell tab running `cockpit setup --shell`: header, $ lines, output, ✓ Setup done, then the login shell prompt; no session, no label; with no setup command, the login shell at once', async () => {
    const { page } = session;
    await createThroughDialog(page, repo, 'dnone');
    const path = worktreePath(session, repo, 'dnone');
    await onWorkspacePage(page, path);
    await expectLabels(page, 0, ['Terminal'], 'Terminal');
    const terminal = await terminalOf(page, 0);
    await waitForRow(page, /^cockpit setup · dnone · \.cockpit\/config\.json$/, terminal);
    await waitForRow(page, '$ echo setup-one', terminal);
    await waitForRow(page, 'setup-one', terminal);
    await waitForRow(page, '✓ Setup done', terminal);
    await waitForRow(page, /^login-shell>/, terminal);
    expect(sessionsInState(session.dataDir).filter((stored) => stored.directory === path)).toEqual([]);
    expect(await workspaceRow(page, 'dnone').locator('xpath=ancestor::li[1]').innerText()).not.toMatch(/Setting up|Setup failed/);

    writeConfig(repo, { setup: [] });
    await createThroughDialog(page, repo, 'dplain');
    await onWorkspacePage(page, worktreePath(session, repo, 'dplain'));
    await expectLabels(page, 0, ['Terminal'], 'Terminal');
    const plain = await terminalOf(page, 0);
    await waitForRow(page, /^login-shell>/, plain);
    expect((await rowsOf(plain)).some((row) => row.includes('cockpit setup'))).toBe(false);
  });

  test('AC24 — clicking the notification of a workspace session shows that workspace\'s page with the session\'s tab selected; a session outside any project opens its session page', async () => {
    const { page } = session;
    await stubNotifications(session);
    await openWorkspace(page, 'alpha', ws.alpha);
    await selectTab(page, 0, 'Codex 1');
    const claudeId = sessionNamed(session.dataDir, 'Claude Code 1', ws.alpha)!.id;
    await goHome(page);

    await reportStatus(session, claudeId, 'waiting');
    await poll(() => session.evaluateInMain<number>('globalThis.__notified.length'), (count) => count > 0, UI_TIMEOUT);
    expect(await session.evaluateInMain('globalThis.__notified.at(-1).title')).toBe('Claude Code 1');
    await session.evaluateInMain(`(() => {
      const window = require('electron').BrowserWindow.getAllWindows()[0];
      window.show = () => {};
      window.focus = () => {};
      globalThis.__notified.at(-1).notification.emit('click');
    })()`);
    await onWorkspacePage(page, ws.alpha);
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Terminal'], 'Claude Code 1');

    // A session outside any project: its page, as before.
    await page.getByRole('button', { name: 'Start session', exact: true }).click({ timeout: UI_TIMEOUT });
    await detectionDone(page);
    await menuItemNamed(page, 'Claude Code').click({ timeout: UI_TIMEOUT });
    await page.waitForURL((url) => /^\/sessions\/[^/]+$/.test(url.pathname), { timeout: UI_TIMEOUT });
    const outside = /^\/sessions\/([^/]+)$/.exec(new URL(page.url()).pathname)![1]!;
    await goHome(page);
    await session.evaluateInMain('globalThis.__notified.length = 0');
    await reportStatus(session, outside, 'waiting');
    await poll(() => session.evaluateInMain<number>('globalThis.__notified.length'), (count) => count > 0, UI_TIMEOUT);
    await session.evaluateInMain('globalThis.__notified.at(-1).notification.emit("click")');
    await page.waitForURL((url) => url.pathname === `/sessions/${outside}`, { timeout: UI_TIMEOUT });
  });

  test('AC5 — a session outside any project keeps its page: one terminal, no tabs', async () => {
    const { page } = session;
    await goHome(page);
    await page.getByRole('button', { name: 'Start session', exact: true }).click({ timeout: UI_TIMEOUT });
    await detectionDone(page);
    await menuItemNamed(page, 'Codex').click({ timeout: UI_TIMEOUT });
    await page.getByRole('heading', { name: 'Codex 1', exact: true }).waitFor({ timeout: UI_TIMEOUT });
    expect(new URL(page.url()).pathname).toMatch(/^\/sessions\/[^/]+$/);
    expect(await page.locator('[role="tablist"]').count()).toBe(0);
    const terminals = await poll(() => visibleTerminals(page), (found) => found.length === 1, UI_TIMEOUT);
    expect(terminals).toHaveLength(1);
    await waitForRow(page, 'ready', terminals[0]!);
  });

  test('AC26 — the Changes toggle sits at the right of the top row of the workspace page and opens the Changes sidebar for that workspace; Home shows neither', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    const toggle = page.getByRole('button', { name: 'Changes', exact: true });
    await toggle.waitFor({ timeout: UI_TIMEOUT });
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    const box = (await toggle.boundingBox())!;
    const width = await page.evaluate(() => innerWidth);
    expect(box.y).toBeLessThan(48);
    expect(box.x + box.width).toBeGreaterThan(width - 60);

    await toggle.click({ timeout: UI_TIMEOUT });
    expect(await toggle.getAttribute('aria-pressed')).toBe('true');
    await page.getByText('against main', { exact: false }).waitFor({ timeout: UI_TIMEOUT });
    const panel = await page.evaluate(() => {
      const found = [...document.querySelectorAll<HTMLElement>('body *')].find((element) => {
        const box = element.getBoundingClientRect();
        return Math.abs(box.width - 360) <= 1 && Math.abs(box.right - innerWidth) <= 1 && box.height > 100 && (element.textContent ?? '').includes('Changes');
      });
      return !!found;
    });
    expect(panel, 'a 360 px sidebar docked to the right').toBe(true);
    await toggle.click({ timeout: UI_TIMEOUT });
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');

    await goHome(page);
    expect(await page.getByRole('button', { name: 'Changes', exact: true }).count()).toBe(0);
  });

  // --- Deleting and removing ---

  test('AC25 — deleting a workspace (not at the uncommitted-changes step) ends every one of its processes and drops its tabs; removing its project does the same for the others', async () => {
    const { page } = session;
    await openWorkspace(page, 'gamma', ws.gamma);
    await newTab(page, 'Terminal');
    const shell = await terminalOf(page, 0);
    const shellId = await shellPid(page, shell);
    await newTab(page, 'Claude Code');
    const agent = await agentPid(page, await terminalOf(page, 0));
    writeFileSync(join(ws.gamma, 'README.md'), 'uncommitted\n');

    await workspaceRow(page, 'gamma').hover({ timeout: UI_TIMEOUT });
    await page.getByRole('button', { name: 'Actions for gamma', exact: true }).click({ timeout: UI_TIMEOUT });
    await page.getByRole('menuitem', { name: 'Delete workspace…' }).click({ timeout: UI_TIMEOUT });
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'Delete gamma?' });
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
    await confirm.filter({ hasText: 'has uncommitted changes' }).waitFor({ timeout: 15_000 });
    // The uncommitted-changes step ends nothing.
    expect(isAlive(shellId) && isAlive(agent)).toBe(true);
    await confirm.getByRole('button', { name: 'Delete anyway', exact: true }).click({ timeout: UI_TIMEOUT });
    await workspaceRow(page, 'gamma').waitFor({ state: 'detached', timeout: 15_000 });
    expect(await endsWithin(shellId), 'the shell is gone within 5 s').toBe(true);
    expect(await endsWithin(agent), 'the agent is gone within 5 s').toBe(true);

    // Removing a project ends the processes of its workspaces, which come back with no tab.
    await addRepository(session, repoTwo);
    const omega = await createWorkspace(session, repoTwo, 'omega');
    await openWorkspace(page, 'omega', omega);
    await newTab(page, 'Terminal');
    const omegaShell = await shellPid(page, await terminalOf(page, 0));
    await newTab(page, 'Codex');
    const omegaAgent = await agentPid(page, await terminalOf(page, 0));
    await page.getByRole('button', { name: `Actions for ${repoTwo.name}`, exact: true }).hover({ timeout: UI_TIMEOUT });
    await page.getByRole('button', { name: `Actions for ${repoTwo.name}`, exact: true }).click({ timeout: UI_TIMEOUT });
    await page.getByRole('menuitem', { name: /Remove from Cockpit/ }).click({ timeout: UI_TIMEOUT });
    expect(await endsWithin(omegaShell)).toBe(true);
    expect(await endsWithin(omegaAgent)).toBe(true);
    await addRepository(session, repoTwo);
    await openWorkspace(page, 'omega', omega);
    await page.getByText('No tab open', { exact: true }).waitFor({ timeout: UI_TIMEOUT });
    expect(isAlive(pids.claude), 'the other project\'s processes are untouched').toBe(true);
  });

  // --- The Terminal page's guarantees, in workspace tabs ---

  test('AC20 — keys typed before the spawn resolves reach the shell in order, and a shell that starts during a resize ends at its displayed size', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await holdPtySpawn(session);
    let released = false;
    try {
      await newTab(page, 'Terminal');
      const terminal = await terminalOf(page, 0);
      await expectKeyboardIn(page, terminal, 'the new tab, whose shell has not started');
      await page.keyboard.type('echo early-$((6*7))');
      await page.keyboard.press('Enter');
      await page.setViewportSize({ width: viewport.width - 300, height: viewport.height - 150 });
      await releasePtySpawn(session);
      released = true;
      await waitForRow(page, 'early-42', terminal);
      await expectSizeMatchesDisplay(page, terminal);
    } finally {
      if (!released) await releasePtySpawn(session);
      await page.setViewportSize(viewport);
    }
  });

  test('AC20 — with the daemon stopped, keys typed reach the shell after SIGCONT, and a spawn pending across a reload is killed when the daemon resumes with no handler error', async () => {
    const { page } = session;
    const daemon = daemonPidIn(session.cockpitHome);
    const last = (await labelsOf(await pane(page, 0))).filter((label) => label === 'Terminal').length - 1;
    await selectTab(page, 0, 'Terminal', last);
    const terminal = await terminalOf(page, 0);
    await terminal.click();
    await waitForPrompt(page, terminal);
    process.kill(daemon, 'SIGSTOP');
    try {
      await typeLine(page, 'echo resumed-$((6*7))');
    } finally {
      process.kill(daemon, 'SIGCONT');
    }
    await waitForRow(page, 'resumed-42', terminal);

    // A spawn left pending across a reload: killed once the daemon answers.
    const children = childPidsOf(daemon).sort((a, b) => a - b);
    const mark = session.output().length;
    process.kill(daemon, 'SIGSTOP');
    try {
      await newTab(page, 'Terminal');
      await page.reload();
      await page.getByText(versionLabel).waitFor({ timeout: UI_TIMEOUT });
    } finally {
      process.kill(daemon, 'SIGCONT');
    }
    expect(await poll(() => childPidsOf(daemon).sort((a, b) => a - b), (found) => found.join() === children.join(), 10_000)).toEqual(children);
    expect(session.output().slice(mark)).not.toContain('Error occurred in handler');
    expect(session.output().slice(mark)).not.toMatch(MAIN_PROCESS_ERROR);
  });

  test('AC20 — with the daemon killed every tab shows [Process ended], and a new tab runs a command in a new daemon', async () => {
    const { page } = session;
    await page.waitForURL((url) => url.pathname === '/workspace', { timeout: UI_TIMEOUT });
    const labels = await labelsOf(await pane(page, 0));
    expect(labels.length).toBeGreaterThan(2);
    const old = daemonPidIn(session.cockpitHome);
    process.kill(old, 'SIGKILL');
    await poll(() => isAlive(old), (alive) => !alive, 5_000);

    for (let index = 0; index < labels.length; index++) {
      await (await pane(page, 0)).getByRole('tab').nth(index).click({ timeout: UI_TIMEOUT });
      await waitForRow(page, /^\[Process ended\]$/, await terminalOf(page, 0));
    }
    expect(session.isRunning()).toBe(true);

    await newTab(page, 'Terminal');
    const fresh = await terminalOf(page, 0);
    await waitForPrompt(page, fresh);
    await typeLine(page, 'echo fresh-$((1+2))');
    await waitForRow(page, 'fresh-3', fresh);
    expect(daemonPidIn(session.cockpitHome)).not.toBe(old);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});

// =============================================================================
// AC28: the background service cannot start
// =============================================================================

describe('workspace panes: the background service cannot start', () => {
  let fx: Fixture;
  let session: Session;
  let repo: TempRepo;

  beforeAll(async () => {
    fx = makeFixture(['claude']);
    repo = makeRepo('panes-down');
    const dataDir = makeTestDir('d-');
    // COCKPIT_HOME is a regular file: the daemon cannot start.
    const home = join(dataDir, 'h');
    writeFileSync(home, 'a file, not a folder');
    session = await launchBuiltWith(fx.env(), dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    const dataDir = session?.dataDir;
    await session?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  test('AC28 — the workspace page shows the failure view in place of the panes', async () => {
    const { page } = session;
    await addRepository(session, repo);
    // Workspaces do not need the daemon; a worktree made with git is listed like one made by the app.
    const path = join(session.dataDir, 'wt-down');
    gitIn(repo.root, 'worktree', 'add', '-b', 'down', path);
    await dispatchFocus(page);
    await page.locator('aside').getByText('down', { exact: true }).first().waitFor({ timeout: UI_TIMEOUT });
    await workspaceRow(page, 'down').click({ timeout: UI_TIMEOUT });
    await page.waitForURL((url) => url.pathname === '/workspace', { timeout: UI_TIMEOUT });
    await page.getByText("Cockpit's background service could not start", { exact: true }).waitFor({ timeout: UI_TIMEOUT });
    expect(await page.getByRole('button', { name: 'Try again', exact: true }).count()).toBe(1);
    expect(await page.locator('[role="tablist"]').count()).toBe(0);
    expect(await page.locator('.xterm').count()).toBe(0);
  });
});

// =============================================================================
// Smoke paths: the dev server and the packaged app; the launchd environment's shell test
// =============================================================================

// One path through the feature: a workspace page, a Terminal tab that runs a command, "Split right" giving a
// second shell tab that runs one, an agent tab from the New tab menu.
async function smokePath(session: Session, fx: Fixture) {
  const { page } = session;
  const repo = makeRepo('smoke-panes');
  try {
    await page.getByText(versionLabel).waitFor();
    await addRepository(session, repo);
    const path = await createWorkspace(session, repo, 'smoke');
    await openWorkspace(page, 'smoke', path);

    await newTab(page, 'Terminal');
    const shell = await terminalOf(page, 0);
    await waitForPrompt(page, shell);
    await typeLine(page, 'echo smoke-$((6*7))');
    await waitForRow(page, 'smoke-42', shell);

    await contextMenu(page, 0, 'Terminal');
    await pickContextItem(page, 'Split right');
    await poll(() => paneCount(page), (count) => count === 2, UI_TIMEOUT);
    const right = await terminalOf(page, 1);
    await expectKeyboardIn(page, right, 'the new pane');
    await waitForPrompt(page, right);
    await typeLine(page, 'echo split-$((7*6))');
    await waitForRow(page, 'split-42', right);

    await newTab(page, 'Claude Code', { pane: 0 });
    await expectLabels(page, 0, ['Terminal', 'Claude Code 1'], 'Claude Code 1');
    const agent = await terminalOf(page, 0);
    await waitForRow(page, 'ready', agent);
    expect((await captureRow(page, /^cwd:(.+)$/, agent))[0]).toBe(path);
    expect(sessionNamed(session.dataDir, 'Claude Code 1', path)).toMatchObject({ project: repo.root });
  } finally {
    rmSync(repo.parent, { recursive: true, force: true });
    void fx;
  }
}

describe('workspace panes: dev server smoke path', () => {
  let fx: Fixture;
  let session: Session;
  beforeAll(async () => {
    fx = makeFixture(['claude']);
    session = await launchDev(fx.env());
  });
  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  test('smoke — a workspace page, a Terminal tab, Split right and an agent tab', async () => {
    await smokePath(session, fx);
  }, 120_000);
});

describe('workspace panes: packaged app smoke path and restart', () => {
  let fx: Fixture;
  let dataDir: string;
  let session: Session | undefined;
  beforeAll(() => {
    fx = makeFixture(['claude']);
    dataDir = makeTestDir('d-');
  });
  afterAll(async () => {
    await session?.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  test('smoke — a workspace page, a Terminal tab, Split right and an agent tab', async () => {
    session = await launchPackaged({ env: fx.env() });
    await smokePath(session, fx);
    await session.close();
    session = undefined;
  }, 120_000);

  test('AC19 — a shell tab and a session tab survive app.quit() and come back as the tabs of one pane, in creation order, with their screens', async () => {
    const repo = makeRepo('restart-panes');
    try {
      session = await launchPackaged({ env: fx.env(), dataDir });
      const first = session;
      await first.page.getByText(versionLabel).waitFor();
      await addRepository(first, repo);
      const path = await createWorkspace(first, repo, 'again');
      await openWorkspace(first.page, 'again', path);
      await newTab(first.page, 'Terminal');
      const shell = await terminalOf(first.page, 0);
      const shellId = await shellPid(first.page, shell);
      await typeLine(first.page, 'echo marker-before-quit');
      await waitForRow(first.page, 'marker-before-quit', shell);
      await newTab(first.page, 'Claude Code');
      const agentId = await agentPid(first.page, await terminalOf(first.page, 0));
      await quitApp(first);
      session = undefined;
      for (const pid of [shellId, agentId]) expect(isAlive(pid), `process ${pid} after the quit`).toBe(true);

      session = await launchPackaged({ env: fx.env(), dataDir });
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      await openWorkspace(page, 'again', path);
      await expectLabels(page, 0, ['Terminal', 'Claude Code 1'], 'Terminal');
      await waitForRow(page, 'marker-before-quit', await terminalOf(page, 0));
      await selectTab(page, 0, 'Claude Code 1');
      await waitForRow(page, 'ready', await terminalOf(page, 0));
      for (const pid of [shellId, agentId]) expect(isAlive(pid)).toBe(true);
    } finally {
      rmSync(repo.parent, { recursive: true, force: true });
    }
  }, 180_000);
});

// The packaged app is given launchd's environment: a shell tab gets the login shell's PATH, not launchd's.
describe('workspace panes: packaged app with the launchd environment', () => {
  const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const normalizeFnm = (path: string) => path.replace(/fnm_multishells\/[^/:]+/g, 'fnm_multishells/<id>');
  let session: Session;
  let repo: TempRepo;

  beforeAll(async () => {
    const { shell, username } = userInfo();
    if (!shell) throw new Error('The current user has no login shell');
    repo = makeRepo('launchd-panes');
    session = await launchPackaged({ env: { HOME: homedir(), USER: username, LOGNAME: username, SHELL: shell, TMPDIR: process.env.TMPDIR ?? '/tmp', PATH: LAUNCHD_PATH } });
    await session.page.getByText(versionLabel).waitFor();
  });
  afterAll(async () => {
    await session?.close();
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  test('terminal AC12 — the shell tab gets the login shell PATH, not the launchd PATH', async () => {
    const { page } = session;
    await addRepository(session, repo);
    const path = await createWorkspace(session, repo, 'launchd');
    await openWorkspace(page, 'launchd', path);
    await newTab(page, 'Terminal');
    const terminal = await terminalOf(page, 0);

    const expected = normalizeFnm(await page.evaluate(() => (globalThis as unknown as { api: { getShellPath(): Promise<string> } }).api.getShellPath()));
    expect(expected).not.toBe(LAUNCHD_PATH);
    const directories = expected.split(':').filter(Boolean);
    // The developer's login shell starts slowly and drops what is typed before its prompt.
    await waitForPrompt(page, terminal);
    await typeLine(page, 'printf %s "$PATH"');
    const printed = () =>
      terminal.evaluate((element) => {
        const rows = [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/ /g, ' '));
        const command = rows.findLastIndex((row) => /printf %s "\$PATH"\s*$/.test(row));
        return command < 0 ? '' : rows.slice(command + 1).join('');
      });
    const missingFrom = (text: string) => directories.filter((directory) => !normalizeFnm(text).includes(directory));
    const output = await poll(printed, (text) => missingFrom(text).length === 0, 20_000);
    expect(missingFrom(output)).toEqual([]);
    expect(output.startsWith(LAUNCHD_PATH)).toBe(false);
  }, 120_000);
});
