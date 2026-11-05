import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { type DaemonClient } from '@cockpit/daemon';
import { type ElementHandle, type Locator, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sendFromComposer } from '../composer';
import { daemonSocketIn, isAlive, launchDev, launchPackaged, launchSpawned, quitApp, type Session, untilIn, untilRead, versionLabel, watchTerminalEnd } from '../launch';
import { makeTestDir } from '../run-root';


// COCKPIT-70: the workspace page, panes with tabs of agents and shells. The built app runs the full
// block (a launch of its own, the tests below share it and run in order); the dev server and the
// packaged app each run one smoke path, and the launchd-environment mode its shell test.
//
// What the tests rely on in the page (the mockups carry no test hooks):
//  - the workspace row is a link (`aside a`) to `/workspace?path=<worktree path>` whose text starts with the branch;
//  - a pane's tab bar is a `role="tablist"`, a tab a `role="tab"` (`aria-selected`) whose label is its `title`
//    (or its text), its close button a button named `Close <label>`; the "New tab" button is named `New tab`;
//  - a terminal is an `.xterm`; the ones of tabs that are not selected are not visible.

export const electron = () => createRequire(import.meta.url)('electron') as string;
export const launchBuiltWith = (env: NodeJS.ProcessEnv, dataDir?: string | null, home?: string | null) =>
  launchSpawned(electron(), ['.'], true, dataDir, env, home);

// --- Fixture: stub agents and a fake login shell ------------------------------

// A harness that is not a harness: prints what the tests check, echoes every line it reads and exits with
// code 3 on `exit` (0 on `quit`). `title-*` sets the terminal title (OSC 0) the way an agent does.
// `hook <Event>` is not needed: the tests report statuses to the daemon the way a hook does.
export const STUB = `#!/bin/sh
if [ "$1" = "--version" ]; then
  #VERSION_LOG#
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

export interface Fixture {
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

export function makeFixture(binaries: string[]): Fixture {
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
  return { root, bin, shell, shellLog, runLog, env: () => ({ ...process.env, SHELL: shell }), install };
}

export const versionRuns = (fx: Fixture) => readFileSync(fx.runLog, 'utf8').split('\n').filter(Boolean);

// --- Repositories ------------------------------------------------------------

export const gitTestEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
export const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitTestEnv, encoding: 'utf8' }).trim();

export interface TempRepo {
  parent: string;
  root: string;
  name: string;
}

export function makeRepo(name: string): TempRepo {
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), 'hello\n');
  gitIn(root, 'init', '-b', 'main');
  gitIn(root, 'add', '.');
  gitIn(root, 'commit', '-m', 'initial');
  return { parent, root, name };
}

export function writeConfig(repo: TempRepo, config: unknown) {
  mkdirSync(join(repo.root, '.cockpit'), { recursive: true });
  writeFileSync(join(repo.root, '.cockpit', 'config.json'), JSON.stringify(config));
}

export const sha8 = (root: string) => createHash('sha256').update(root).digest('hex').slice(0, 8);
export const worktreePath = (session: Session, repo: TempRepo, branch: string) =>
  join(realpathSync(session.dataDir), 'h', 'worktrees', `${repo.name}-${sha8(repo.root)}`, branch);

export interface StoredSession {
  id: string;
  name: string;
  harness: string;
  directory: string;
  project?: string;
}
export const sessionsInState = (dataDir: string): StoredSession[] =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { sessions?: StoredSession[] }).sessions ?? [];
export const sessionNamed = (dataDir: string, name: string, directory: string) =>
  sessionsInState(dataDir).find((session) => session.name === name && session.directory === directory);

// --- The page ----------------------------------------------------------------

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
export const LOADING_ITEM = 'Detecting agent CLIs…';

export type Terminal = ElementHandle<HTMLElement>;

export const dispatchFocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

export const tokenColor = (page: Page, token: string) =>
  page.evaluate((token) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

export async function stubPicker(session: Session, pick: string) {
  await session.evaluateInMain(`(() => {
    const { dialog } = require('electron');
    const picker = (globalThis.__pickerCalls ??= { count: 0 });
    dialog.showOpenDialog = async () => { picker.count++; return { canceled: false, filePaths: [${JSON.stringify(pick)}] }; };
  })()`);
}

export async function addRepository(session: Session, repo: TempRepo) {
  const { page } = session;
  await stubPicker(session, repo.root);
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('button', { name: `Actions for ${repo.name}`, exact: true }).waitFor({ state: 'attached' });
}

/** The sidebar row of a workspace: a link whose text starts with its branch. */
export const workspaceRow = (page: Page, name: string) =>
  page.locator('aside a[href*="/workspace"]').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}(\\s|$)`) });

export async function createWorkspace(session: Session, repo: TempRepo, name: string): Promise<string> {
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
  await page.locator('aside').getByText(name, { exact: true }).first().waitFor();
  return worktreePath(session, repo, name);
}

// The workspace page a test is on, by name: its area is a region named after the workspace (the workspace's name
// is its branch, the basename of its path). The router pushes the URL before it loads and renders the page, so
// the URL says nothing about what the page shows: a test waits for the page's own region, never for the URL.
export const currentWorkspace = new WeakMap<Page, string>();

export const regionName = (page: Page) => {
  const name = currentWorkspace.get(page);
  if (name === undefined) throw new Error('no workspace page was opened on this page');
  return name;
};

export const workspaceRegion = (page: Page) => page.getByRole('region', { name: regionName(page), exact: true });

/** Waits for the page of the workspace at `path` to be rendered, then checks the URL is its own. */
export async function onWorkspacePage(page: Page, path: string, name = basename(path)) {
  currentWorkspace.set(page, name);
  await workspaceRegion(page).waitFor();
  const url = new URL(page.url());
  expect([url.pathname, url.searchParams.get('path')]).toEqual(['/workspace', path]);
}

export async function openWorkspace(page: Page, name: string, path: string) {
  await workspaceRow(page, name).click();
  await onWorkspacePage(page, path, name);
}

export async function goHome(page: Page) {
  await page.getByRole('link', { name: 'New workspace', exact: true }).click();
  await page.getByRole('heading', { name: 'New workspace', exact: true }).waitFor();
}

// A pane is the tab bar (`tablist`) of the workspace region, found by role and auto-waited. The panes are rendered
// flat and placed by boxes, so the DOM order is not always the order a reader sees them in (left to right, then top
// to bottom): the index is read from the tab bars' positions once the pane exists.
export const tabLists = (page: Page) => workspaceRegion(page).getByRole('tablist');

/** Waits until the workspace page holds exactly `count` panes. */
export async function expectPaneCount(page: Page, count: number) {
  const lists = tabLists(page);
  if (count > 0) await lists.nth(count - 1).waitFor();
  await lists.nth(count).waitFor({ state: 'detached' });
}

export async function pane(page: Page, index: number): Promise<Locator> {
  const lists = tabLists(page);
  await lists.nth(index).waitFor();
  const corners = await lists.evaluateAll((bars) =>
    bars.map((bar, domIndex) => {
      const { left, top } = bar.getBoundingClientRect();
      return { domIndex, left: Math.round(left), top: Math.round(top) };
    }),
  );
  corners.sort((a, b) => a.left - b.left || a.top - b.top);
  return lists.nth(corners[index]!.domIndex);
}

export const newTabButton = async (page: Page, index = 0) => (await pane(page, index)).getByRole('button', { name: 'New tab', exact: true });

export const labelsOf = (list: Locator) =>
  list.getByRole('tab').evaluateAll((tabs) =>
    tabs.map((tab) => (tab.getAttribute('title') ?? tab.querySelector('[title]')?.getAttribute('title') ?? tab.textContent ?? '').trim()),
  );

export const selectedLabelOf = async (list: Locator) =>
  (await list
    .locator('[role="tab"][aria-selected="true"]')
    .evaluateAll((tabs) =>
      tabs.map((tab) => (tab.getAttribute('title') ?? tab.querySelector('[title]')?.getAttribute('title') ?? tab.textContent ?? '').trim()),
    ))[0] ?? null;

export const tabLabeled = (list: Locator, label: string, nth = 0) =>
  list.locator('[role="tab"]').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`) }).nth(nth);

export const closeButton = (list: Locator, label: string, nth = 0) => list.getByRole('button', { name: `Close ${label}`, exact: true }).nth(nth);

// Hovers the tab (a close button may show on hover only) and clicks its close button.
export async function clickClose(page: Page, index: number, label: string, nth = 0) {
  const list = await pane(page, index);
  await tabLabeled(list, label, nth).hover();
  await closeButton(list, label, nth).click();
}

// The labels of the tabs of the pane at `index` of a workspace page's region (the panes ordered as `pane` does: left to
// right, then top to bottom), null while there is no such pane. Self-contained: it runs in `untilRead`.
export const readPaneLabels = ({ region, index }: { region: string; index: number; expected?: string[] }) => {
  const root = [...document.querySelectorAll('[role="region"]')].find((element) => element.getAttribute('aria-label') === region);
  const bars = [...(root?.querySelectorAll('[role="tablist"]') ?? [])]
    .map((bar) => ({ bar, left: Math.round(bar.getBoundingClientRect().left), top: Math.round(bar.getBoundingClientRect().top) }))
    .sort((a, b) => a.left - b.left || a.top - b.top);
  const found = bars[index]?.bar;
  if (!found) return null;
  return [...found.querySelectorAll('[role="tab"]')].map((tab) => (tab.getAttribute('title') ?? tab.querySelector('[title]')?.getAttribute('title') ?? tab.textContent ?? '').trim());
};

export async function expectLabels(page: Page, index: number, expected: string[], selected?: string) {
  const labels = await untilRead(
    page,
    readPaneLabels,
    (found, arg: { region: string; index: number; expected: string[] }) => JSON.stringify(found) === JSON.stringify(arg.expected),
    { region: regionName(page), index, expected },
  );
  expect(labels).toEqual(expected);
  if (selected !== undefined) expect(await selectedLabelOf(await pane(page, index))).toBe(selected);
}

export async function selectTab(page: Page, index: number, label: string, nth = 0) {
  await tabLabeled(await pane(page, index), label, nth).click();
}

// The visible terminals (the selected tab of each pane).
export async function visibleTerminals(page: Page): Promise<Terminal[]> {
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
export async function terminalOf(page: Page, index: number): Promise<Terminal> {
  const bar = (await (await pane(page, index)).elementHandle())!;
  // Resolves with the visible terminal under the bar once there is one, looked for at once and after each DOM mutation,
  // transition or resize (the terminal's box is placed by the layout).
  const found = await page.evaluateHandle(
    (area) =>
      new Promise<Element>((resolve) => {
        const under = () => {
          const bounds = area.getBoundingClientRect();
          return [...document.querySelectorAll('.xterm')].find((element) => {
            const box = element.getBoundingClientRect();
            const centre = box.left + box.width / 2;
            return (
              box.width > 0 &&
              box.height > 0 &&
              getComputedStyle(element).visibility === 'visible' &&
              centre >= bounds.left &&
              centre <= bounds.right &&
              box.top >= bounds.bottom - 1
            );
          });
        };
        const events = ['transitionend', 'transitioncancel', 'animationend'];
        const check = () => {
          const element = under();
          if (!element) return;
          observer.disconnect();
          for (const name of events) document.removeEventListener(name, check, true);
          window.removeEventListener('resize', check);
          resolve(element);
        };
        const observer = new MutationObserver(check);
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        for (const name of events) document.addEventListener(name, check, true);
        window.addEventListener('resize', check);
        check();
      }),
    bar as ElementHandle<HTMLElement>,
  );
  return found.asElement() as Terminal;
}

// The terminal that holds the keyboard focus, if it is a visible one.
export async function keyboardTerminal(page: Page): Promise<Terminal | null> {
  const handle = await page.evaluateHandle(() => {
    const focused = document.activeElement?.closest('.xterm');
    if (!focused) return null;
    const { width, height } = focused.getBoundingClientRect();
    return width > 0 && height > 0 && getComputedStyle(focused).visibility === 'visible' ? focused : null;
  });
  return (handle.asElement() as Terminal | null) ?? null;
}

export const isSame = (a: Terminal, b: Terminal) => a.evaluate((one, other) => one === other, b);

// Resolves once the keyboard is in the terminal: at once if it is, else on the `focusin` that puts it there. The wait
// is the check (a keyboard that never arrives ends on the test's guard), so it asserts nothing after it.
export async function expectKeyboardIn(_page: Page, terminal: Terminal, _what: string) {
  await terminal.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        const held = () => document.activeElement !== null && element.contains(document.activeElement);
        if (held()) return resolve();
        const onFocus = () => {
          if (!held()) return;
          document.removeEventListener('focusin', onFocus, true);
          resolve();
        };
        document.addEventListener('focusin', onFocus, true);
      }),
  );
}

// The index of the pane whose terminal holds the keyboard.
export async function paneWithKeyboard(page: Page): Promise<number> {
  const count = await tabLists(page).count();
  for (let index = 0; index < count; index++) {
    const active = await keyboardTerminal(page);
    if (active && (await isSame(active, await terminalOf(page, index)))) return index;
  }
  return -1;
}

export async function typeLine(page: Page, text: string) {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

export const rowsOf = (terminal: Terminal) =>
  terminal.evaluate((element) => [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()));

// The rows of a terminal, read at once and after each DOM mutation until `done(rows, arg)` accepts them. `read` and
// `done` run in the page: both are self-contained.
export const readRows = (element: HTMLElement) => [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd());
export const untilRows = <A>(terminal: Terminal, done: (rows: string[], arg: A) => boolean, arg?: A) => untilIn(terminal, readRows, done, arg);

export async function waitForRow(_page: Page, text: string | RegExp, terminal: Terminal) {
  await untilRows(terminal, (rows, source: string) => rows.some((row) => new RegExp(source).test(row)), typeof text === 'string' ? `^${escapeRegExp(text)}$` : text.source);
}

export async function captureRow(page: Page, pattern: RegExp, terminal: Terminal): Promise<string[]> {
  await waitForRow(page, pattern, terminal);
  for (const row of await rowsOf(terminal)) {
    const match = pattern.exec(row);
    if (match) return match.slice(1);
  }
  throw new Error(`no terminal row matches ${pattern}`);
}

// The `cwd:<path>` line the stub prints, read across the rows it wraps over in a narrow pane.
export async function expectCwd(terminal: Terminal, path: string) {
  const want = `cwd:${path}`;
  // Self-contained: it runs in the page.
  const read = (element: HTMLElement, wanted: string) => {
    const rows = [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd());
    const first = rows.findIndex((row) => row.startsWith('cwd:'));
    if (first < 0) return '';
    if (rows[first]!.length >= wanted.length) return rows[first]!;
    let text = rows[first]!;
    for (let next = first + 1; next < rows.length && text.length < wanted.length; next++) text += rows[next]!;
    return text.length === wanted.length ? text : text.slice(0, wanted.length + 1);
  };
  expect(await untilIn(terminal, read, (found, wanted: string) => found === wanted, want)).toBe(want);
}

export const waitForPrompt = (_page: Page, terminal: Terminal) => untilRows(terminal, (rows) => rows.some((row) => row.trim() !== ''));

// The test's own connection to the daemon (the built app's block opens it): the `exit` the daemon sends tells that a
// terminal's process is gone. A pid is watched from the moment its terminal prints it.
export let daemonLine: DaemonClient | undefined;
export function setDaemonLine(line: DaemonClient | undefined) {
  daemonLine = line;
}
export const endOf = new Map<number, Promise<void>>();

export async function watchEnd(pid: number) {
  if (daemonLine) endOf.set(pid, (await watchTerminalEnd(daemonLine, pid)).ended);
}

// Types where the keyboard is and returns the pid a shell prints.
export async function shellPid(page: Page, terminal: Terminal): Promise<number> {
  await waitForPrompt(page, terminal);
  await typeLine(page, 'echo pid-$$');
  const pid = Number((await captureRow(page, /^pid-(\d+)$/, terminal))[0]);
  await watchEnd(pid);
  return pid;
}

export async function agentPid(page: Page, terminal: Terminal): Promise<number> {
  const pid = Number((await captureRow(page, /^pid:(\d+)$/, terminal))[0]);
  await watchEnd(pid);
  return pid;
}

// Resolves with true once the daemon has told that the process of a terminal whose pid was read ended.
export async function hasEnded(pid: number): Promise<boolean> {
  const ended = endOf.get(pid);
  if (!ended) throw new Error(`the end of process ${pid} was not watched`);
  await ended;
  return true;
}

// --- Separators (COCKPIT-45) -------------------------------------------------
//
// The line between two panes is an element with `role="separator"` and `aria-orientation` (`vertical` between
// panes side by side, `horizontal` between panes stacked). A pane is the element carrying the percent box
// (`left`, `top`, `width`, `height`) around a tab bar; the area is its offset parent.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export const paneRect = async (page: Page, index: number): Promise<Rect> =>
  (await pane(page, index)).evaluate((list) => {
    const { left, top, right, bottom, width, height } = list.closest('[style*="left"]')!.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  });

export const areaRect = async (page: Page): Promise<Rect> =>
  (await pane(page, 0)).evaluate((list) => {
    const { left, top, right, bottom, width, height } = (list.closest('[style*="left"]') as HTMLElement).offsetParent!.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  });

export async function separatorOf(page: Page, orientation: 'vertical' | 'horizontal'): Promise<Locator> {
  const separator = page.locator(`[role="separator"][aria-orientation="${orientation}"]:visible`);
  await separator.first().waitFor();
  expect(await separator.count(), `one ${orientation} separator between the panes`).toBe(1);
  return separator;
}

// A real pointer drag from the middle of the separator to `to` (the other coordinate stays).
export async function dragSeparator(page: Page, separator: Locator, to: { x?: number; y?: number }, release = true) {
  const box = (await separator.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x ?? from.x, to.y ?? from.y, { steps: 8 });
  if (release) await page.mouse.up();
}

export let sttyMarks = 0;

// What `stty size` answers in the terminal: [rows, columns].
export async function sttySize(page: Page, terminal: Terminal): Promise<[number, number]> {
  await terminal.click();
  await waitForPrompt(page, terminal);
  const mark = `ss${Date.now()}x${sttyMarks++}`;
  await typeLine(page, `printf '${mark} %s\\n' "$(stty size)"`);
  const [rows, columns] = (await captureRow(page, new RegExp(`^${mark} (\\d+) (\\d+)$`), terminal)).map(Number);
  return [rows!, columns!];
}

// The colour of the thin line of a separator: its own thin element (a background), else the 1 px border of the
// pane after it, which is what shows when the separator draws nothing.
export const separatorLine = (separator: Locator, orientation: 'vertical' | 'horizontal') =>
  separator.evaluate((element, orientation) => {
    const vertical = orientation === 'vertical';
    for (const each of [element, ...element.querySelectorAll('*')]) {
      const { width, height } = each.getBoundingClientRect();
      const color = getComputedStyle(each).backgroundColor;
      const thin = vertical ? width > 0 && width <= 1.01 && height > 50 : height > 0 && height <= 1.01 && width > 50;
      if (thin && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
    }
    const centre = element.getBoundingClientRect();
    const x = vertical ? centre.left + centre.width / 2 + 0.5 : centre.left + centre.width / 2;
    const y = vertical ? centre.top + centre.height / 2 : centre.top + centre.height / 2 + 0.5;
    for (const each of document.elementsFromPoint(x, y)) {
      const style = getComputedStyle(each);
      if (vertical && style.borderLeftWidth === '1px') return style.borderLeftColor;
      if (!vertical && style.borderTopWidth === '1px') return style.borderTopColor;
    }
    return null;
  }, orientation);

// Two frames: a layout change has been through its `ResizeObserver` callbacks, so the terminal has fitted and sent
// its resize to the main process.
export const afterRender = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

// What `stty size` answers against what the terminal displays. The renderer sends the terminal's resize when it fits
// (at a layout change, before the next frame ends) and the main process hands the messages on in order, so the keys
// typed after those frames reach the shell after the resize: the answer is the size the terminal displays, no later.
export async function expectSizeMatchesDisplay(page: Page, terminal: Terminal) {
  await terminal.click();
  await waitForPrompt(page, terminal);
  await afterRender(page);
  const digit = String(1 + (Date.now() % 9));
  await typeLine(page, `printf '%0600d\\n' 0 | tr 0 ${digit}`);
  const rows = await untilRows(
    terminal,
    (found, wanted: string) => found.filter((row) => new RegExp(`^${wanted}+$`).test(row)).reduce((sum, row) => sum + row.length, 0) >= 600,
    digit,
  );
  const line = new RegExp(`^${digit}+$`);
  const shown = [rows.length, Math.max(...rows.filter((row) => line.test(row)).map((row) => row.length))];
  const mark = `sz${Date.now()}x${sttyMarks++}`;
  await typeLine(page, `printf '${mark} %s\\n' "$(stty size)"`);
  const answer = (await captureRow(page, new RegExp(`^${mark} (\\d+) (\\d+)$`), terminal)).map(Number);
  expect(answer, `stty size against the displayed rows and columns ${shown}`).toEqual(shown);
}

// --- Menus -------------------------------------------------------------------

// Menus are found by their accessible name (the name of the trigger that opened them): a menu that was just closed
// stays in the DOM until its exit animation ends, and an unnamed lookup would see it, or pick it.
export const newTabMenu = (page: Page) => page.getByRole('menu', { name: 'New tab', exact: true });
export const rowMenu = (page: Page, workspace: string) => page.getByRole('menu', { name: `Start session in ${workspace}`, exact: true });
export const harnessSubmenu = (page: Page) => page.getByRole('menu', { name: /^Open harness/ });
// A tab's context menu has no accessible name (its trigger is the tab's wrapper, which has no role): it is the one
// menu that holds "Split right".
export const tabMenu = (page: Page) => page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Split right', exact: true }) });

export const menuItems = (menu: Locator) => menu.getByRole('menuitem');

export async function openNewTabMenu(page: Page, index = 0): Promise<Locator> {
  // The menu of a previous pick may still be leaving.
  await newTabMenu(page).waitFor({ state: 'detached' });
  await (await newTabButton(page, index)).click();
  const menu = newTabMenu(page);
  await menu.waitFor();
  return menu;
}

export const detectionDone = (page: Page) => page.getByRole('menuitem').filter({ hasText: LOADING_ITEM }).first().waitFor({ state: 'detached' });

export const topLevelItems = async (menu: Locator) => (await menuItems(menu).allInnerTexts()).map(normalized);

export const menuItemNamed = (menu: Locator, text: string) =>
  menu.getByRole('menuitem').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`) });

export async function openHarnessSubmenu(page: Page): Promise<Locator> {
  await menuItemNamed(newTabMenu(page), 'Open harness').click();
  const submenu = harnessSubmenu(page);
  await submenu.getByRole('menuitem').first().waitFor();
  return submenu;
}

/** Picks an entry of the pane's "New tab" menu and waits for the tab it adds. */
export async function newTab(page: Page, choice: string, { pane: index = 0, submenu = false }: { pane?: number; submenu?: boolean } = {}) {
  const before = (await labelsOf(await pane(page, index))).length;
  const menu = await openNewTabMenu(page, index);
  await detectionDone(page);
  if (submenu) {
    const list = await openHarnessSubmenu(page);
    await list.getByRole('menuitem').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(choice)}(\\s|$)`) }).first().click();
  } else {
    await menuItemNamed(menu, choice).click();
  }
  await menu.waitFor({ state: 'detached' });
  const tabs = (await pane(page, index)).getByRole('tab');
  await tabs.nth(before).waitFor();
  await tabs.nth(before + 1).waitFor({ state: 'detached' });
}

export async function contextMenu(page: Page, index: number, label: string, nth = 0): Promise<Locator> {
  await tabLabeled(await pane(page, index), label, nth).click({ button: 'right' });
  const menu = tabMenu(page);
  await menu.waitFor();
  return menu;
}

export async function pickContextItem(menu: Locator, item: string) {
  await menuItemNamed(menu, item).click();
  await menu.waitFor({ state: 'detached' });
}

export const projectsMessage = (page: Page) => page.locator('aside [role="status"]');

// --- Control endpoint --------------------------------------------------------

export const controlTokenIn = (home: string) => readFileSync(daemonSocketIn(home).replace(/\.sock$/, '.token'), 'utf8');

export function postSessionEvent(socketPath: string, token: string, body: unknown) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ socketPath, method: 'POST', path: '/session-events', headers: { authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

export async function reportStatus(session: Session, id: string, event: 'working' | 'waiting' | 'finished') {
  const status = await postSessionEvent(daemonSocketIn(session.cockpitHome), controlTokenIn(session.cockpitHome), { sessionId: id, event });
  expect(status, `${event} for ${id}`).toBe(204);
}

// The status icon of a workspace row: its accessible name and `title`, its size, and what a row with
// no status shows (the dashed circle, `aria-hidden`, and the color of the name). Null while the row is not there.
// Self-contained: it runs in `untilRead`.
export const readRowStatus = ({ name }: { name: string; label?: string | null }) => {
  const pattern = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  const row = [...document.querySelectorAll('aside a[href*="/workspace"]')].find((each) => pattern.test(each.textContent ?? ''));
  if (!row) return null;
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
};

export const rowStatus = async (page: Page, name: string) => {
  await workspaceRow(page, name).waitFor();
  return (await page.evaluate(readRowStatus, { name }))!;
};

// Waits until the row shows the status `label` (null: none), read at once and after each DOM mutation.
export const waitForRowStatus = async (page: Page, name: string, label: string | null) =>
  (await untilRead(page, readRowStatus, (found, arg: { name: string; label: string | null }) => found?.label === arg.label, { name, label }))!;

// --- Daemon ------------------------------------------------------------------

export function daemonPidIn(home: string): number {
  const file = readdirSync(home).find((entry) => /^daemon-1-.+\.pid$/.test(entry));
  if (!file) throw new Error(`no daemon pid file in ${home}`);
  return Number(readFileSync(join(home, file), 'utf8').trim());
}

export const childPidsOf = (pid: number): number[] =>
  execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === pid)
    .map(([child]) => child!);

export const holdPtySpawn = (session: Session) =>
  session.evaluateInMain(`(() => {
    const handlers = require('electron').ipcMain._invokeHandlers;
    const original = handlers.get('pty:spawn');
    if (!original) throw new Error('the main process has no pty:spawn handler');
    const gate = new Promise((resolve) => { globalThis.__releasePtySpawn = resolve; });
    globalThis.__originalPtySpawn = original;
    handlers.set('pty:spawn', async (...args) => { await gate; return original(...args); });
  })()`);

export const releasePtySpawn = (session: Session) =>
  session.evaluateInMain(`(() => {
    const original = globalThis.__originalPtySpawn;
    if (original) require('electron').ipcMain._invokeHandlers.set('pty:spawn', original);
    globalThis.__releasePtySpawn?.();
    delete globalThis.__originalPtySpawn;
    delete globalThis.__releasePtySpawn;
  })()`);

export const replacePtySpawn = (session: Session, body: string) =>
  session.evaluateInMain(`(() => {
    const handlers = require('electron').ipcMain._invokeHandlers;
    const original = globalThis.__replacedPtySpawn ?? handlers.get('pty:spawn');
    globalThis.__replacedPtySpawn = original;
    handlers.set('pty:spawn', (${body}));
  })()`);

export const restorePtySpawn = (session: Session) =>
  session.evaluateInMain(`(() => {
    const original = globalThis.__replacedPtySpawn;
    if (original) require('electron').ipcMain._invokeHandlers.set('pty:spawn', original);
    delete globalThis.__replacedPtySpawn;
  })()`);

export const stubNotifications = (session: Session) =>
  session.evaluateInMain(`(() => {
    const { Notification, BrowserWindow } = require('electron');
    globalThis.__notified = [];
    globalThis.__onShown = [];
    Notification.prototype.show = function () {
      globalThis.__notified.push({ title: this.title, body: this.body, notification: this });
      for (const listener of globalThis.__onShown.splice(0)) listener();
    };
    BrowserWindow.getFocusedWindow = () => null;
  })()`);

// Resolves once the stubbed `Notification.prototype.show` has been called (it tells `globalThis.__onShown`), at once if it has.
export const notificationShown = (session: Session) =>
  session.evaluateInMain<void>(`new Promise((resolve) => { if (globalThis.__notified.length > 0) resolve(); else globalThis.__onShown.push(resolve); })`);

// --- New workspace composer ----------------------------------------------------

// COCKPIT-66: the prompt is `name`, so the workspace's branch is `name` (a lower-case word); the workspace page opens.
export async function createThroughComposer(page: Page, repo: TempRepo, name: string, agent?: string) {
  await sendFromComposer(page, repo, { prompt: name, agent });
}

// =============================================================================
// Built app: the full block
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

    await pickContextItem(await contextMenu(page, 0, 'Terminal'), 'Split right');
    await expectPaneCount(page, 2);
    const right = await terminalOf(page, 1);
    await expectKeyboardIn(page, right, 'the new pane');
    await waitForPrompt(page, right);
    await typeLine(page, 'echo split-$((7*6))');
    await waitForRow(page, 'split-42', right);

    await newTab(page, 'Claude Code', { pane: 0 });
    await expectLabels(page, 0, ['Terminal', 'Claude Code 1'], 'Claude Code 1');
    const agent = await terminalOf(page, 0);
    await waitForRow(page, 'ready', agent);
    await expectCwd(agent, path);
    expect(sessionNamed(session.dataDir, 'Claude Code 1', path)).toMatchObject({ project: repo.root });
  } finally {
    rmSync(repo.parent, { recursive: true, force: true });
    void fx;
  }
}

export const describePanesDevServerSmoke = () => describe('workspace panes: dev server smoke path', () => {
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

  test('COCKPIT-80 AC3 — with the /workspace route module held, the URL is the workspace\'s while openWorkspace has not returned and no workspace region exists; once released, openWorkspace returns and a Terminal tab appears in that workspace\'s page', async () => {
    const { page } = session;
    const repo = makeRepo('held-route');
    // The route module's request: the router pushes the URL, then fetches it (first visit) and renders.
    const routeModule = /\/routes\/workspace\.tsx\?tsr-split=component/;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const requested = new Promise<void>((resolve) => (held = resolve));
    try {
      await addRepository(session, repo);
      const path = await createWorkspace(session, repo, 'held');
      // A reload on the New workspace page (`/`): the route module has not been fetched by this page.
      await goHome(page);
      await page.reload();
      await page.getByRole('heading', { name: 'New workspace', exact: true }).waitFor();
      await page.route(routeModule, async (route) => {
        held();
        await released;
        await route.continue();
      });

      let returned = false;
      const opening = openWorkspace(page, 'held', path).then(() => {
        returned = true;
      });
      await requested;
      await page.waitForURL((url) => url.pathname === '/workspace' && url.searchParams.get('path') === path);
      expect(returned, 'openWorkspace has not returned').toBe(false);
      expect(await page.getByRole('region', { name: 'held', exact: true }).count(), 'no workspace region').toBe(0);

      release();
      await opening;
      expect(await page.getByRole('region', { name: 'held', exact: true }).count()).toBe(1);
      await newTab(page, 'Terminal');
      expect(await labelsOf(await pane(page, 0))).toEqual(['Terminal']);
    } finally {
      release();
      await page.unroute(routeModule).catch(() => undefined);
      rmSync(repo.parent, { recursive: true, force: true });
    }
  });
});

export const describePanesPackagedSmoke = () => describe('workspace panes: packaged app smoke path and restart', () => {
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
export const describePanesLaunchdSmoke = () => describe('workspace panes: packaged app with the launchd environment', () => {
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
    // What the command printed, read in the terminal at once and after each DOM mutation until it holds every directory.
    // Self-contained: it runs in the page.
    const printed = (element: HTMLElement) => {
      const rows = [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/ /g, ' '));
      const command = rows.findLastIndex((row) => /printf %s "\$PATH"\s*$/.test(row));
      return command < 0 ? '' : rows.slice(command + 1).join('');
    };
    const missingFrom = (text: string) => directories.filter((directory) => !normalizeFnm(text).includes(directory));
    const output = await untilIn(
      terminal,
      printed,
      (text, wanted: string[]) => {
        const normalizedText = text.replace(/fnm_multishells\/[^/:]+/g, 'fnm_multishells/<id>');
        return wanted.every((directory) => normalizedText.includes(directory));
      },
      directories,
    );
    expect(missingFrom(output)).toEqual([]);
    expect(output.startsWith(LAUNCHD_PATH)).toBe(false);
  }, 120_000);
});
