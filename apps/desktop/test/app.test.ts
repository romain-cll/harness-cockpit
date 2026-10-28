import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { statusCommand } from '@cockpit/daemon';
import { statusLaunch } from '@cockpit/harnesses';
import { type ElementHandle, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  MAIN_PROCESS_ERROR,
  UI_TIMEOUT,
  appDir,
  daemonSocketIn,
  freePort,
  isAlive,
  launchBuilt,
  launchDev,
  launchEnv,
  launchPackaged,
  launchSpawned,
  packagedAppDir,
  poll,
  stopGroup,
  versionLabel,
  waitForGroupGone,
  type Session,
} from './launch';
import { makeTestDir } from './run-root';

// Launches the app the four ways it runs: the dev server, the built app, the
// packaged app and the packaged app with the minimal environment launchd gives
// an app opened from the Finder or the Dock, and checks each one starts,
// renders, logs no error, stays in the background and writes its data in its
// own folder. In CI only, it also launches the packaged app without the
// background switch.

// What the page sees of the main process's `Api.getShellPath`.
const getShellPath = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { api: { getShellPath(): Promise<string> } }).api.getShellPath());

// The PATH launchd gives an app started from the Finder or the Dock.
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

// The environment launchd gives an app started from the Finder or the Dock,
// minus the few variables it adds that no startup file is expected to need.
const LAUNCHD_ENV: Record<string, string> = (() => {
  const { shell, username } = userInfo();
  if (!shell) throw new Error('The current user has no login shell');
  return {
    HOME: homedir(),
    USER: username,
    LOGNAME: username,
    SHELL: shell,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    PATH: LAUNCHD_PATH,
  };
})();

// Every shell gets its own `fnm_multishells/<id>` directory in its PATH.
const normalizeFnm = (path: string) => path.replace(/fnm_multishells\/[^/:]+/g, 'fnm_multishells/<id>');

const launchLaunchd = () => launchPackaged({ env: LAUNCHD_ENV });

const run = promisify(execFile);

// An empty answer means lsappinfo has nothing to report (no frontmost app, an
// app it does not know yet).
async function lsappinfo(...args: string[]): Promise<string> {
  return run('lsappinfo', args).then(({ stdout }) => stdout.trim(), () => '');
}

// Reports `ApplicationType` `UIElement` for an app without a Dock icon and
// `Foreground` for a regular one. Polls because a launched app is not
// registered right away.
async function applicationType(pid: number): Promise<string> {
  return poll(() => lsappinfo('info', '-only', 'ApplicationType', String(pid)), (answer) => /ApplicationType"="/.test(answer), 5_000);
}

// Samples the frontmost app every 100 ms and collects its pid. Started before
// the launch, so an activation at startup is seen too.
function watchFrontmost() {
  const pids = new Set<number>();
  let stopped = false;
  const sampling = (async () => {
    while (!stopped) {
      const front = await lsappinfo('front');
      const pid = /"pid"=(\d+)/.exec(front && (await lsappinfo('info', '-only', 'pid', front)))?.[1];
      if (pid) pids.add(Number(pid));
      await sleep(100);
    }
  })();
  return {
    pids,
    stop: async () => {
      stopped = true;
      await sampling;
    },
  };
}

// What `window.api.pty` must look like. Declared here, not imported, because
// the test project does not include the app sources.
interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}
interface PtyExit {
  exitCode: number | null;
  signal: number | null;
}
interface PtyApi {
  spawn(options: PtySpawnOptions): Promise<number>;
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  kill(id: number): void;
  onData(listener: (id: number, data: string) => void): () => void;
  onExit(listener: (id: number, exit: PtyExit) => void): () => void;
}
/** What the renderer collected from `onData` and `onExit`, per session id. */
interface PtyLog {
  data: Record<number, string>;
  exits: Record<number, PtyExit[]>;
}
type PtyWindow = Window & { api: { pty: PtyApi }; __ptyLog?: PtyLog };

const shellOptions: PtySpawnOptions = {
  command: '/bin/sh',
  args: [],
  cwd: homedir(),
  env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
};

// Spawns a shell through `window.api.pty` from the renderer. The listeners are
// registered before the spawn, once per page load, so no output is missed.
function spawnShell(page: Page, options: Partial<PtySpawnOptions> = shellOptions): Promise<number> {
  return page.evaluate((options) => {
    const w = window as unknown as PtyWindow;
    if (!w.api.pty) throw new Error('window.api.pty is not exposed');
    if (!w.__ptyLog) {
      const log: PtyLog = { data: {}, exits: {} };
      w.api.pty.onData((id, data) => {
        log.data[id] = (log.data[id] ?? '') + data;
      });
      w.api.pty.onExit((id, exit) => {
        (log.exits[id] ??= []).push(exit);
      });
      w.__ptyLog = log;
    }
    return w.api.pty.spawn(options as PtySpawnOptions);
  }, options);
}

const ptyWrite = (page: Page, id: number, data: string) =>
  page.evaluate(([id, data]) => (window as unknown as PtyWindow).api.pty.write(id, data), [id, data] as const);

const ptyResize = (page: Page, id: number, cols: number, rows: number) =>
  page.evaluate(([id, cols, rows]) => (window as unknown as PtyWindow).api.pty.resize(id, cols, rows), [id, cols, rows] as const);

const ptyKill = (page: Page, id: number) =>
  page.evaluate((id) => (window as unknown as PtyWindow).api.pty.kill(id), id);

// Waits until the output of the session contains `text`, or matches it when it
// is a regular expression.
const waitForOutput = (page: Page, id: number, text: string | RegExp) =>
  page.waitForFunction(
    ([id, source]) => new RegExp(source).test((window as unknown as PtyWindow).__ptyLog?.data[id] ?? ''),
    [id, typeof text === 'string' ? text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : text.source] as const,
    { timeout: 15_000 },
  );

const waitForExit = (page: Page, id: number) =>
  page.waitForFunction((id) => ((window as unknown as PtyWindow).__ptyLog?.exits[id]?.length ?? 0) > 0, id, {
    timeout: 15_000,
  });

const exitsOf = (page: Page, id: number) =>
  page.evaluate((id) => (window as unknown as PtyWindow).__ptyLog?.exits[id] ?? [], id);

const outputOf = (page: Page, id: number) =>
  page.evaluate((id) => (window as unknown as PtyWindow).__ptyLog?.data[id] ?? '', id);

const consoleErrorsOf = async (page: Page) =>
  (await page.consoleMessages()).filter((m) => m.type() === 'error').map((m) => m.text());

// By default Playwright returns only what came after the last new-document
// navigation (a reload included). These read everything since the page was
// attached (or since the last clear), so a message logged before a reload counts.
const allConsoleErrorsOf = async (page: Page) =>
  (await page.consoleMessages({ filter: 'all' })).filter((m) => m.type() === 'error').map((m) => m.text());

const allPageErrorsOf = (page: Page) => page.pageErrors({ filter: 'all' });

// --- Terminal page helpers ---------------------------------------------------

// A terminal on the page. The page keeps every terminal of every tab in the DOM
// (the ones of other tabs are hidden), so a helper never reads "the terminal":
// it reads one pane, the one the keyboard is in unless the test gives another.
type Pane = ElementHandle<HTMLElement>;

// The visible terminals (those of the selected tab), in DOM order.
// Read through `evaluateHandle`, not a locator: after a refused navigation a
// locator wait hangs (see the navigation tests).
async function visiblePanes(page: Page): Promise<Pane[]> {
  const list = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.xterm')].filter((element) => {
      const { width, height } = element.getBoundingClientRect();
      return width > 0 && height > 0 && getComputedStyle(element).visibility === 'visible';
    }),
  );
  const panes = [...(await list.getProperties()).values()].map((handle) => handle.asElement() as Pane);
  await list.dispose();
  return panes;
}

// The visible terminal that holds the keyboard focus, or null.
async function activePane(page: Page): Promise<Pane | null> {
  const handle = await page.evaluateHandle(() => {
    const focused = document.activeElement?.closest('.xterm');
    if (!focused) return null;
    const { width, height } = focused.getBoundingClientRect();
    return width > 0 && height > 0 && getComputedStyle(focused).visibility === 'visible' ? focused : null;
  });
  return (handle.asElement() as Pane | null) ?? null;
}

// The terminal that holds the keyboard focus; else the first visible one.
async function focusedPane(page: Page): Promise<Pane> {
  const pane = await poll(
    async () => (await activePane(page)) ?? (await visiblePanes(page))[0] ?? null,
    Boolean,
    UI_TIMEOUT,
  );
  if (!pane) throw new Error('No terminal is visible');
  return pane;
}

const isSamePane = (a: Pane, b: Pane) => a.evaluate((one, other) => one === other, b);

async function isOneOf(pane: Pane, panes: Pane[]): Promise<boolean> {
  for (const other of panes) if (await isSamePane(pane, other)) return true;
  return false;
}

// Waits until a visible terminal that is not one of `previous` holds the keyboard
// focus, and returns it.
async function newlyFocusedPane(page: Page, previous: Pane[]): Promise<Pane> {
  const deadline = Date.now() + UI_TIMEOUT;
  for (;;) {
    const active = await activePane(page);
    if (active && !(await isOneOf(active, previous))) return active;
    if (Date.now() > deadline) throw new Error('No new terminal has the keyboard focus');
    await sleep(100);
  }
}

const boxOf = (pane: Pane) =>
  pane.evaluate((element) => {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  });
type Box = Awaited<ReturnType<typeof boxOf>>;

// Waits until the terminals stop moving: a terminal is refitted to its area a
// moment after the area changes, and a terminal's box follows its rows.
async function settle(...panes: Pane[]) {
  const read = async () => JSON.stringify(await Promise.all(panes.map(boxOf)));
  let last = await read();
  const deadline = Date.now() + UI_TIMEOUT;
  for (;;) {
    await sleep(250);
    const now = await read();
    if (now === last || Date.now() > deadline) return;
    last = now;
  }
}

// Whether two boxes are the same area, give or take `tolerance` px per edge.
const sameArea = (a: Box, b: Box, tolerance = 2) =>
  (['left', 'top', 'right', 'bottom'] as const).every((edge) => Math.abs(a[edge] - b[edge]) <= tolerance);

async function goHome(page: Page) {
  await page.getByRole('link', { name: 'Home', exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('heading', { name: 'Home' }).waitFor({ timeout: UI_TIMEOUT });
}

// Goes to the terminal page through the sidebar's link, without touching the terminals.
async function goToTerminalPage(page: Page) {
  await page.getByRole('link', { name: 'Terminal', exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
}

// Ends every shell of the daemon (COCKPIT-55: the shells outlive the page, so a reload shows them
// again), through `window.api.pty`, and waits until the daemon lists none. Sessions are left running.
async function endShells(page: Page) {
  await page.evaluate(async () => {
    type Listed = { id: number; kind?: string };
    const pty = (window as unknown as { api: { pty: { list(): Promise<Listed[]>; kill(id: number): void } } }).api.pty;
    for (const terminal of await pty.list()) if ((terminal.kind ?? 'shell') === 'shell') pty.kill(terminal.id);
    const deadline = Date.now() + 5_000;
    while ((await pty.list()).some((terminal) => (terminal.kind ?? 'shell') === 'shell') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
}

// Reloads the page on Home (the tabs outlive a visit, and, once the shells are ended, a reload starts
// over), then opens the terminal page through the sidebar: each call opens a new page lifetime
// (one tab, one shell), and focuses the terminal.
async function openTerminal(page: Page) {
  await goHome(page);
  await endShells(page);
  await page.reload();
  await page.getByRole('heading', { name: 'Home' }).waitFor({ timeout: UI_TIMEOUT });
  await goToTerminalPage(page);
  await focusTerminal(page);
}

// For a page with a single visible terminal.
async function focusTerminal(page: Page) {
  const terminal = page.locator('.xterm:visible').first();
  await terminal.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  await terminal.click({ timeout: UI_TIMEOUT });
  await page.locator('.xterm:visible .xterm-helper-textarea').first().focus({ timeout: UI_TIMEOUT });
}

// Clicks a terminal and puts the keyboard in it.
async function focusPane(pane: Pane) {
  await pane.click({ timeout: UI_TIMEOUT });
  await pane.$eval('.xterm-helper-textarea', (textarea) => (textarea as HTMLElement).focus());
}

// Types on the keyboard, as a user does: it goes to the focused terminal.
async function typeLine(page: Page, text: string) {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

// The text of each row xterm.js renders (its DOM renderer) in one terminal, cell
// padding removed.
const rowsOf = (pane: Pane) =>
  pane.evaluate((element) =>
    [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/ /g, ' ').trimEnd()),
  );

const terminalRows = async (page: Page, pane?: Pane) => rowsOf(pane ?? (await focusedPane(page)));

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Waits until a row of the terminal is exactly `text`, or matches it when it is a
// regular expression. Output reaches the DOM on animation frames, so it is polled.
async function waitForRow(page: Page, text: string | RegExp, pane?: Pane) {
  await page.waitForFunction(
    ([element, source]) => {
      const pattern = new RegExp(source);
      return [...element.querySelectorAll('.xterm-rows > div')].some((row) =>
        pattern.test((row.textContent ?? '').replace(/ /g, ' ').trimEnd()),
      );
    },
    [pane ?? (await focusedPane(page)), typeof text === 'string' ? `^${escapeRegExp(text)}$` : text.source] as const,
    { timeout: 15_000 },
  );
}

// Waits for a row matching `pattern` and returns its capture groups.
async function captureRow(page: Page, pattern: RegExp, pane?: Pane): Promise<string[]> {
  const target = pane ?? (await focusedPane(page));
  await waitForRow(page, pattern, target);
  for (const row of await rowsOf(target)) {
    const match = pattern.exec(row);
    if (match) return match.slice(1);
  }
  throw new Error(`No terminal row matches ${pattern}`);
}

// Waits until the shell has printed something (its prompt), so typed keys are
// not lost before the terminal is connected to it.
const waitForPrompt = async (page: Page, pane?: Pane) =>
  page.waitForFunction(
    (element) => [...element.querySelectorAll('.xterm-rows > div')].some((row) => (row.textContent ?? '').trim() !== ''),
    pane ?? (await focusedPane(page)),
    { timeout: 20_000 },
  );

// Types `stty size` and returns the `[rows, cols]` of its answer.
async function terminalSize(page: Page, pane?: Pane): Promise<[number, number]> {
  const target = pane ?? (await focusedPane(page));
  const answers = (element: HTMLElement) =>
    [...element.querySelectorAll('.xterm-rows > div')].filter((row) => /^\d+\s\d+\s*$/.test(row.textContent ?? '')).length;
  const before = await target.evaluate(answers);
  await typeLine(page, 'stty size');
  await page.waitForFunction(
    ([element, before]) =>
      [...element.querySelectorAll('.xterm-rows > div')].filter((row) => /^\d+\s\d+\s*$/.test(row.textContent ?? '')).length > before,
    [target, before] as const,
    { timeout: 15_000 },
  );
  const rows = await rowsOf(target);
  const last = rows.filter((row) => /^\d+ \d+$/.test(row)).at(-1)!;
  const [r, c] = last.split(' ').map(Number);
  return [r!, c!];
}

// The `[rows, cols]` the terminal displays: its rendered rows, and the width of
// the wrapped rows of a long line of one digit the shell prints. Each call prints
// another digit, so the lines of an earlier call on the same screen are not mistaken
// for this one.
let lineCount = 0;
async function displayedSize(page: Page, pane: Pane): Promise<[number, number]> {
  const digit = String(1 + (lineCount++ % 9));
  await typeLine(page, `printf '%0600d\\n' 0 | tr 0 ${digit}`);
  // The line wraps over several rows: wait until they hold all 600 digits.
  const line = new RegExp(`^${digit}+$`);
  const total = (rows: string[]) => rows.filter((row) => line.test(row)).reduce((sum, row) => sum + row.length, 0);
  const rows = await poll(() => rowsOf(pane), (found) => total(found) >= 600, 15_000);
  expect(total(rows), 'the whole line is displayed').toBe(600);
  const cols = Math.max(...rows.filter((row) => line.test(row)).map((row) => row.length));
  return [rows.length, cols];
}

// What `stty size` answers in a terminal must be what the terminal displays.
async function expectSizeMatchesDisplay(page: Page, pane: Pane) {
  await focusPane(pane);
  await waitForPrompt(page, pane);
  const answered = await terminalSize(page, pane);
  const shown = await displayedSize(page, pane);
  expect(answered, 'the shell is told the rows and columns the terminal displays').toEqual(shown);
}

// Types `echo pid-$$` in a terminal and returns the shell's process id. With a
// pane, it clicks it first; without, it types where the keyboard already is.
async function pidOf(page: Page, pane?: Pane): Promise<number> {
  if (pane) await focusPane(pane);
  const target = pane ?? (await focusedPane(page));
  await waitForPrompt(page, target);
  await typeLine(page, 'echo pid-$$');
  const [pid] = await captureRow(page, /^pid-(\d+)$/, target);
  return Number(pid);
}

// Whether the process is gone within `timeout` ms.
const endsWithin = async (pid: number, timeout = 5_000) => !(await poll(() => isAlive(pid), (alive) => !alive, timeout));

// --- Tabs and splits ---------------------------------------------------------

const newTerminalButton = (page: Page) => page.getByRole('button', { name: 'New terminal', exact: true }).first();
const newTerminal = (page: Page) => newTerminalButton(page).click({ timeout: UI_TIMEOUT });
const tabNamed = (page: Page, number: number) => page.getByRole('tab', { name: `Terminal ${number}`, exact: true });
const selectTab = (page: Page, number: number) => tabNamed(page, number).click({ timeout: UI_TIMEOUT });
const closeTab = (page: Page, number: number) =>
  page.getByRole('button', { name: `Close Terminal ${number}`, exact: true }).click({ timeout: UI_TIMEOUT });

interface TabsShown {
  names: string[];
  selected: string | undefined;
}

// The tabs of the tab bar, in order, and the selected one.
const tabsShown = (page: Page): Promise<TabsShown> =>
  page.getByRole('tab').evaluateAll((tabs) => {
    const names = tabs.map((tab) => (tab.textContent ?? '').trim());
    return { names, selected: names[tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')] };
  });

// Waits for the tab bar to show exactly these tabs, with this one selected.
async function expectTabs(page: Page, names: string[], selected: string | undefined) {
  const expected = { names, selected };
  const shown = await poll(() => tabsShown(page), (tabs) => JSON.stringify(tabs) === JSON.stringify(expected), UI_TIMEOUT);
  expect(shown).toEqual(expected);
}

// The "Split right", "Split down" or "Close terminal" button of a terminal: the
// one in the pane's own toolbar, found by the DOM when the toolbar sits next to
// the terminal, else by the position nearest to the terminal.
async function paneButton(pane: Pane, label: 'Split right' | 'Split down' | 'Close terminal') {
  await pane.hover({ timeout: UI_TIMEOUT });
  const handle = await pane.evaluateHandle((element, label) => {
    const selector = `button[aria-label="${label}"]`;
    const shown = (button: Element) => {
      const { width, height } = button.getBoundingClientRect();
      return width > 0 && height > 0 && getComputedStyle(button).visibility === 'visible';
    };
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.querySelectorAll('.xterm').length > 1) break;
      const own = [...ancestor.querySelectorAll(selector)].filter(shown);
      if (own.length === 1) return own[0]!;
    }
    const terminal = element.getBoundingClientRect();
    const distance = (button: Element) => {
      const { left, top, width, height } = button.getBoundingClientRect();
      const x = left + width / 2;
      const y = top + height / 2;
      return Math.hypot(Math.max(terminal.left - x, 0, x - terminal.right), Math.max(terminal.top - y, 0, y - terminal.bottom));
    };
    return [...document.querySelectorAll(selector)].filter(shown).sort((a, b) => distance(a) - distance(b))[0] ?? null;
  }, label);
  const button = handle.asElement();
  if (!button) throw new Error(`No "${label}" button for this terminal`);
  return button;
}

async function clickPaneButton(pane: Pane, label: 'Split right' | 'Split down' | 'Close terminal') {
  await (await paneButton(pane, label)).click({ timeout: UI_TIMEOUT });
}

// Splits a terminal and returns the new one, which must hold the keyboard focus.
async function splitPane(page: Page, pane: Pane, direction: 'right' | 'down'): Promise<Pane> {
  const before = await visiblePanes(page);
  await clickPaneButton(pane, direction === 'right' ? 'Split right' : 'Split down');
  const created = await newlyFocusedPane(page, before);
  expect(await visiblePanes(page)).toHaveLength(before.length + 1);
  await settle(...before, created);
  return created;
}

// Opens a new tab and returns its terminal, which must hold the keyboard focus.
async function openTab(page: Page): Promise<Pane> {
  const before = await visiblePanes(page);
  await newTerminal(page);
  return newlyFocusedPane(page, before);
}

// Two tabs, the second one split in two: the shells' pids, in creation order.
async function openTwoTabsOneSplit(page: Page): Promise<number[]> {
  await openTerminal(page);
  const pids = [await pidOf(page)];
  await openTab(page);
  pids.push(await pidOf(page));
  const second = await focusedPane(page);
  await splitPane(page, second, 'right');
  pids.push(await pidOf(page));
  for (const pid of pids) expect(isAlive(pid)).toBe(true);
  return pids;
}

// The "New terminal" button of the empty state, not the one of the page header.
const emptyStateNewTerminal = (page: Page) =>
  page.getByText('No terminal open', { exact: true }).locator('..').getByRole('button', { name: 'New terminal', exact: true });

// The pid of the daemon (COCKPIT-55; it was the pty utility process), read from the parent of a probe shell (ended
// before the call returns, so it leaves nothing under the host).
async function ptyHostPid(page: Page): Promise<number> {
  const id = await spawnShell(page);
  await ptyWrite(page, id, 'echo ppid-$PPID\n');
  await waitForOutput(page, id, /ppid-\d+/);
  const hostPid = Number(/ppid-(\d+)/.exec(await outputOf(page, id))![1]);
  await ptyKill(page, id);
  await waitForExit(page, id);
  return hostPid;
}

// Kills the daemon, the way a crash does, and returns the id of the
// session that found it (its exit is reported). Works at the API level, so it
// also runs in the launchd-environment mode.
async function killPtyHost(page: Page): Promise<number> {
  const id = await spawnShell(page);
  await ptyWrite(page, id, 'echo ppid-$PPID\n');
  await waitForOutput(page, id, /ppid-\d+/);
  const hostPid = Number(/ppid-(\d+)/.exec(await outputOf(page, id))![1]);
  expect(hostPid, 'the host is a process of its own, not the main process').toBeGreaterThan(0);
  process.kill(hostPid, 'SIGKILL');
  await waitForExit(page, id);
  return id;
}

// Makes the main process hold every `pty:spawn` answer until `releasePtySpawn`, so
// a test can change a terminal's size while its shell is still starting. Uses the
// handler table of Electron's `ipcMain` (private), because the app has no hook for it.
const holdPtySpawn = (session: Session) =>
  session.evaluateInMain(`(() => {
    const handlers = require('electron').ipcMain._invokeHandlers;
    const original = handlers.get('pty:spawn');
    if (!original) throw new Error('the main process has no pty:spawn handler');
    const gate = new Promise((resolve) => { globalThis.__releasePtySpawn = resolve; });
    globalThis.__originalPtySpawn = original;
    handlers.set('pty:spawn', async (...args) => {
      await gate;
      return original(...args);
    });
  })()`);

// Lets the held spawns go on and puts the real handler back.
const releasePtySpawn = (session: Session) =>
  session.evaluateInMain(`(() => {
    const original = globalThis.__originalPtySpawn;
    if (original) require('electron').ipcMain._invokeHandlers.set('pty:spawn', original);
    globalThis.__releasePtySpawn?.();
    delete globalThis.__originalPtySpawn;
    delete globalThis.__releasePtySpawn;
  })()`);

// Replaces the main process's `pty:spawn` handler (the handler table of Electron's
// `ipcMain` is private, the app has no hook for it). `body` is the source of the
// new handler; the original is in scope as `original`, e.g.
// `async (...args) => original(...args)`.
const replacePtySpawn = (session: Session, body: string) =>
  session.evaluateInMain(`(() => {
    const handlers = require('electron').ipcMain._invokeHandlers;
    const original = globalThis.__replacedPtySpawn ?? handlers.get('pty:spawn');
    if (!original) throw new Error('the main process has no pty:spawn handler');
    globalThis.__replacedPtySpawn = original;
    handlers.set('pty:spawn', (${body}));
  })()`);

// Puts the original `pty:spawn` handler back.
const restorePtySpawn = (session: Session) =>
  session.evaluateInMain(`(() => {
    const original = globalThis.__replacedPtySpawn;
    if (original) require('electron').ipcMain._invokeHandlers.set('pty:spawn', original);
    delete globalThis.__replacedPtySpawn;
  })()`);

// The console errors of the navigation tests that are not the refusal of the
// file:// URL they tried: Chromium words it `Not allowed to load local resource:
// <url>`, and any other message of that kind is a failure.
const unexpectedConsoleErrors = (errors: string[], fileUrl: string) =>
  errors.filter((text) => text !== `Not allowed to load local resource: ${fileUrl}`);

// What the terminal paints against what the tokens say, in `rgb()` form: a
// token is normalised through a 1x1 canvas, whatever notation it is written in.
interface TerminalColors {
  actual: { text: string; background: string; red: string };
  expected: { text: string; background: string; red: string };
}
const readTerminalColors = (page: Page): Promise<TerminalColors> =>
  page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d')!;
    const rgba = (css: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000000';
      context.fillStyle = css;
      context.clearRect(0, 0, 1, 1);
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { css: `rgb(${r}, ${g}, ${b})`, a: a! };
    };
    const token = (name: string) => {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value ? rgba(value).css : `missing ${name}`;
    };
    const rows = document.querySelector('.xterm-rows') as HTMLElement | null;
    // The terminal background is the first painted one going up from the rows.
    let background = 'none';
    for (let element = rows; element; element = element.parentElement) {
      const painted = rgba(getComputedStyle(element).backgroundColor);
      if (painted.a > 0) {
        background = painted.css;
        break;
      }
    }
    const red = [...document.querySelectorAll<HTMLElement>('.xterm-rows span.xterm-fg-1')].find((span) => span.textContent === 'red');
    return {
      actual: {
        text: rows ? rgba(getComputedStyle(rows).color).css : 'no rows',
        background,
        red: red ? rgba(getComputedStyle(red).color).css : 'no red text',
      },
      expected: {
        text: token('--foreground'),
        background: token('--background'),
        red: token('--terminal-red'),
      },
    };
  });

// --- Projects helpers --------------------------------------------------------

// A git that ignores the user's configuration, for the repositories the tests
// create.
const gitTestEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitTestEnv, encoding: 'utf8' }).trim();

interface TempRepo {
  /** The temporary folder that holds the repository, to remove afterwards. */
  parent: string;
  /** The repository root, as git reports it (macOS `/var` is `/private/var`). */
  root: string;
  /** The name the sidebar shows: the root's basename. */
  name: string;
}

// `<tmp>/<name>` with one commit (`README.md`, `src/main.ts`).
function makeRepo(name: string): TempRepo {
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'hello\n');
  writeFileSync(join(root, 'src', 'main.ts'), 'export {};\n');
  gitIn(root, 'init', '-b', 'main');
  gitIn(root, 'add', '.');
  gitIn(root, 'commit', '-m', 'initial');
  expect(gitIn(root, 'rev-parse', '--show-toplevel')).toBe(root);
  return { parent, root, name };
}

// A folder that is not inside any git repository.
function makePlainFolder(name: string): TempRepo {
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  mkdirSync(root);
  return { parent, root, name };
}

// What a removal from Cockpit must leave alone.
const snapshotRepo = (repo: TempRepo) => ({
  head: gitIn(repo.root, 'rev-parse', 'HEAD'),
  status: gitIn(repo.root, 'status', '--porcelain'),
  readme: readFileSync(join(repo.root, 'README.md'), 'utf8'),
  source: readFileSync(join(repo.root, 'src', 'main.ts'), 'utf8'),
  hasGit: existsSync(join(repo.root, '.git')),
});

const projectsInState = (dataDir: string): unknown =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { projects?: unknown }).projects;

const stateSnapshot = (dataDir: string) => {
  const file = join(dataDir, 'state.json');
  return { content: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs };
};

// Replaces `dialog.showOpenDialog` in the main process with a function that
// answers the folder `pick` (or a cancellation for `null`) and counts its calls.
const stubPicker = (session: Session, pick: string | null) =>
  session.evaluateInMain(`(() => {
    const { dialog } = require('electron');
    const picker = (globalThis.__pickerCalls ??= { count: 0 });
    const answer = ${JSON.stringify(pick === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [pick] })};
    const stub = async () => {
      picker.count++;
      return answer;
    };
    dialog.showOpenDialog = stub;
    if (dialog.showOpenDialog !== stub) throw new Error('dialog.showOpenDialog cannot be replaced');
    return picker.count;
  })()`);

const pickerCalls = (session: Session) => session.evaluateInMain<number>('globalThis.__pickerCalls?.count ?? 0');

// Clicks "Add project" with the picker answering `pick`, and waits until the
// app has opened the picker. What the app does with the answer is the caller's
// to wait for.
async function addProject(session: Session, pick: string | null) {
  await stubPicker(session, pick);
  const before = await pickerCalls(session);
  await session.page.getByRole('button', { name: 'Add project', exact: true }).click({ timeout: UI_TIMEOUT });
  const after = await poll(() => pickerCalls(session), (calls) => calls > before, UI_TIMEOUT);
  expect(after, 'clicking "Add project" opens the folder picker').toBeGreaterThan(before);
}

interface SidebarEntry {
  title: string;
  text: string;
}

// The sidebar elements that carry a `title`: the project entries (the outermost
// one when the title is repeated on nested elements).
const sidebarEntries = (page: Page): Promise<SidebarEntry[]> =>
  page.evaluate(() => {
    const titled = [...document.querySelectorAll('aside [title]')] as HTMLElement[];
    return titled
      .filter((element) => !titled.some((other) => other !== element && other.contains(element) && other.title === element.title))
      .map((element) => ({ title: element.title, text: (element.textContent ?? '').trim() }));
  });

const entryTitles = async (page: Page) => (await sidebarEntries(page)).map((entry) => entry.title);

const waitForEntries = (page: Page, expected: string[]) =>
  poll(() => entryTitles(page), (titles) => JSON.stringify(titles) === JSON.stringify(expected), UI_TIMEOUT);

// The text lines of the sidebar.
const sidebarLines = async (page: Page) =>
  (await page.locator('aside').innerText()).split('\n').map((line) => line.trim()).filter(Boolean);

const REFUSAL = /is already in Cockpit\.$|is not in a git repository\.$/;
const refusalsShown = async (page: Page) => (await sidebarLines(page)).filter((line) => REFUSAL.test(line));

const waitForLine = (page: Page, line: string) =>
  poll(() => sidebarLines(page), (lines) => lines.includes(line), UI_TIMEOUT);

// Whether the deepest element that shows `text` (or carries `title`) sits
// below the "Projects" header in the sidebar.
const isBelowProjectsHeader = (page: Page, target: { text: string } | { title: string }) =>
  page.evaluate((target) => {
    const all = [...document.querySelectorAll('aside *')] as HTMLElement[];
    const deepest = (matches: (element: HTMLElement) => boolean) =>
      all.filter(matches).filter((element) => !all.some((other) => other !== element && element.contains(other) && matches(other)))[0];
    const header = deepest((element) => (element.textContent ?? '').trim() === 'Projects');
    const found =
      'title' in target
        ? deepest((element) => element.getAttribute('title') === target.title)
        : deepest((element) => (element.textContent ?? '').trim() === target.text);
    if (!header || !found) return false;
    return found.getBoundingClientRect().top >= header.getBoundingClientRect().bottom - 1;
  }, target);

// The "…" menu trigger of the sidebar entry titled `title` (a project root or a
// workspace path): the nearest ancestor of the entry that holds a menu trigger
// of its own, not counting the triggers of entries nested in it (a project
// holds its workspaces).
async function menuTriggerOf(page: Page, title: string) {
  const handle = await page.evaluateHandle((title) => {
    const entry = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === title);
    for (let node: Element | null = entry ?? null; node && node.tagName !== 'ASIDE'; node = node.parentElement) {
      const here: Element = node;
      const triggers = [...here.querySelectorAll('button[aria-haspopup="menu"][aria-label^="Actions for"]')].filter((button) => {
        const titled = button.closest('[title]');
        return !titled || titled === here || !here.contains(titled) || titled.getAttribute('title') === title;
      });
      if (triggers.length === 1) return triggers[0]!;
      if (triggers.length > 1) return null;
    }
    return null;
  }, title);
  const trigger = handle.asElement();
  if (!trigger) throw new Error(`no single "…" menu trigger for the sidebar entry titled ${title}`);
  return trigger;
}

// Opens the "…" menu of the sidebar entry titled `title` and waits for its items.
async function openMenu(page: Page, title: string) {
  await page.getByTitle(title, { exact: true }).first().hover({ timeout: UI_TIMEOUT });
  const trigger = await menuTriggerOf(page, title);
  await trigger.click({ timeout: UI_TIMEOUT });
  await page.getByRole('menuitem').first().waitFor({ timeout: UI_TIMEOUT });
}

// Opens the "…" menu of the project entry titled `root`, checks the removal
// item, and picks "Remove from Cockpit".
async function removeThroughMenu(page: Page, root: string) {
  await openMenu(page, root);

  const items = page.getByRole('menuitem');
  const remove = items.filter({ hasText: 'Remove from Cockpit' });
  expect(await remove.count()).toBe(1);
  const lines = (await remove.first().innerText()).split('\n').map((line) => line.trim()).filter(Boolean);
  expect(lines).toEqual(['Remove from Cockpit', 'Files stay on disk']);
  // The second line is muted: not painted like the item itself.
  const colors = await remove.first().evaluate((item) => {
    const note = [...item.querySelectorAll('*')].find((element) => element.textContent?.trim() === 'Files stay on disk');
    return { item: getComputedStyle(item).color, note: note ? getComputedStyle(note).color : 'no element of its own' };
  });
  expect(colors.note).not.toBe('no element of its own');
  expect(colors.note).not.toBe(colors.item);

  await remove.first().click({ timeout: UI_TIMEOUT });
}

// --- Workspaces helpers ------------------------------------------------------

const sha8 = (root: string) => createHash('sha256').update(root).digest('hex').slice(0, 8);

// Where the app must create the worktree of `branch` for `repo`:
// `$COCKPIT_HOME/worktrees/<repo basename>-<8 hex>/<branch>`, compared by real
// path (macOS `/var` is `/private/var`; the data folder exists, the rest does not yet).
const worktreePath = (session: Session, repo: TempRepo, branch: string) =>
  join(realpathSync(session.dataDir), 'h', 'worktrees', `${repo.name}-${sha8(repo.root)}`, branch);

// A repository with `origin` (a clone of `upstream`, which has `develop`,
// `feature/x` and `release/1.0` besides `main`), a local commit on `main` that
// `origin/main` lacks, and the local branches `local-topic` and `topic/nested`.
interface TempClone extends TempRepo {
  upstream: TempRepo;
}
function makeClone(name: string): TempClone {
  const upstream = makeRepo(`${name}-upstream`);
  for (const branch of ['develop', 'feature/x', 'release/1.0']) gitIn(upstream.root, 'branch', branch);
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  gitIn(parent, 'clone', '--quiet', upstream.root, root);
  gitIn(root, 'commit', '--allow-empty', '-m', 'local only');
  gitIn(root, 'branch', 'local-topic');
  gitIn(root, 'branch', 'topic/nested');
  expect(gitIn(root, 'rev-parse', '--show-toplevel')).toBe(root);
  return { parent, root, name, upstream };
}

// A repository whose only content is an empty commit.
function makeLightRepo(name: string): TempRepo {
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  mkdirSync(root);
  gitIn(root, 'init', '--quiet', '-b', 'main');
  gitIn(root, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
  return { parent, root, name };
}

// The linked worktrees of `repo`, in `git worktree list` order.
function linkedWorktrees(repo: TempRepo): { path: string; branch: string | null }[] {
  const records = gitIn(repo.root, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean);
  return records.slice(1).map((record) => {
    const lines = record.split('\n');
    return {
      path: lines.find((line) => line.startsWith('worktree '))!.slice('worktree '.length),
      branch: lines.find((line) => line.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? null,
    };
  });
}

const localBranches = (repo: TempRepo) =>
  gitIn(repo.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

// What a cancelled or refused action must leave alone.
const gitState = (repo: TempRepo) => ({
  worktrees: gitIn(repo.root, 'worktree', 'list', '--porcelain'),
  branches: localBranches(repo),
  refs: gitIn(repo.root, 'for-each-ref', '--format=%(refname) %(objectname)'),
});

// Adds a repository through the stubbed picker and waits until it is listed.
async function addRepository(session: Session, repo: TempRepo) {
  await addProject(session, repo.root);
  await poll(() => entryTitles(session.page), (titles) => titles.includes(repo.root), UI_TIMEOUT);
  expect(await entryTitles(session.page)).toContain(repo.root);
}

// Asks the main process to look again, as it does when the window gains focus.
const dispatchFocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

const openDialogs = (page: Page) => page.locator('[role="dialog"], [role="alertdialog"]');

// Escape until no dialog is left (a Select popup takes one Escape of its own).
async function dismissDialogs(page: Page) {
  for (let attempt = 0; attempt < 4 && (await openDialogs(page).count()) > 0; attempt++) {
    await page.keyboard.press('Escape');
    await sleep(250);
  }
  expect(await openDialogs(page).count()).toBe(0);
}

const linesOf = async (locator: ReturnType<Page['locator']>) =>
  (await locator.innerText()).split('\n').map((line) => line.trim()).filter(Boolean);

const waitForDialogLine = (dialog: ReturnType<Page['locator']>, matches: (line: string) => boolean) =>
  poll(
    async () => (await linesOf(dialog)).filter(matches),
    (found) => found.length > 0,
    UI_TIMEOUT,
  );

// Marks where the console and the main process output stood, so a test can check that
// what it did logged no error (the shared session may hold earlier ones).
const errorMark = async (session: Session) => ({
  errors: (await allConsoleErrorsOf(session.page)).length,
  output: session.output().length,
});
const expectNoNewErrors = async (session: Session, mark: { errors: number; output: number }) => {
  expect(await allConsoleErrorsOf(session.page)).toHaveLength(mark.errors);
  expect(await allPageErrorsOf(session.page)).toEqual([]);
  const written = session.output().slice(mark.output);
  expect(written).not.toMatch(MAIN_PROCESS_ERROR);
  expect(written).not.toContain('Error occurred in handler');
};

// --- New workspace dialog

const newWorkspaceDialog = (page: Page, project: TempRepo) =>
  page.getByRole('dialog', { name: `New workspace in ${project.name}` });
const nameField = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('textbox', { name: 'Name', exact: true });
const baseSelect = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('combobox', { name: 'Base', exact: true });
const createButton = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('button', { name: 'Create', exact: true });

async function openNewWorkspaceDialog(page: Page, project: TempRepo) {
  await openMenu(page, project.root);
  await page.getByRole('menuitem', { name: 'New workspace…' }).click({ timeout: UI_TIMEOUT });
  const dialog = newWorkspaceDialog(page, project);
  await dialog.waitFor({ timeout: UI_TIMEOUT });
  return dialog;
}

// What the Base select shows as its value.
const selectedBase = async (dialog: ReturnType<Page['locator']>) => (await baseSelect(dialog).innerText()).trim();

// Opens the Base select, reads its options per group ("Local", "Remote"), closes it.
async function readBaseOptions(page: Page, dialog: ReturnType<Page['locator']>) {
  await baseSelect(dialog).click({ timeout: UI_TIMEOUT });
  const listbox = page.getByRole('listbox');
  await listbox.waitFor({ timeout: UI_TIMEOUT });
  const groups: Record<string, string[]> = {};
  let current: string | undefined;
  for (const line of await linesOf(listbox)) {
    if (line === 'Local' || line === 'Remote') groups[(current = line)] = [];
    else if (current) groups[current]!.push(line);
  }
  await page.keyboard.press('Escape');
  await listbox.waitFor({ state: 'hidden', timeout: UI_TIMEOUT });
  expect(await dialog.isVisible(), 'closing the Base select keeps the dialog open').toBe(true);
  return groups;
}

async function chooseBase(page: Page, dialog: ReturnType<Page['locator']>, base: string) {
  await baseSelect(dialog).click({ timeout: UI_TIMEOUT });
  await page.getByRole('option', { name: base, exact: true }).click({ timeout: UI_TIMEOUT });
  await poll(() => selectedBase(dialog), (value) => value === base, UI_TIMEOUT);
}

// --- Delete workspace dialog

const deleteDialog = (page: Page, text: string) => openDialogs(page).filter({ hasText: text });

async function startDeletion(page: Page, path: string) {
  await openMenu(page, path);
  await page.getByRole('menuitem', { name: 'Delete workspace…' }).click({ timeout: UI_TIMEOUT });
}

// The color the `muted-foreground` token resolves to, for "muted" lines.
const mutedColor = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--muted-foreground)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });

// The computed color of the deepest sidebar element that shows `text`.
const colorOfLine = (page: Page, text: string) =>
  page.evaluate((text) => {
    const all = [...document.querySelectorAll('aside *')] as HTMLElement[];
    const matches = all.filter((element) => (element.textContent ?? '').trim() === text);
    const deepest = matches.find((element) => !matches.some((other) => other !== element && element.contains(other)));
    return deepest ? getComputedStyle(deepest).color : null;
  }, text);

// --- Workspace scripts helpers (COCKPIT-32) -----------------------------------

// The repository's `.cockpit/config.json` (a string is written as is, to test an invalid one).
function writeConfig(repo: TempRepo, config: unknown) {
  mkdirSync(join(repo.root, '.cockpit'), { recursive: true });
  writeFileSync(join(repo.root, '.cockpit', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

// Scripts the configured commands call, kept in the main working tree so a command stays short (the
// terminal echoes it as one row). `$COCKPIT_ROOT_PATH` is set by the app. `waitfor.sh <marker>` waits
// until the test creates `<root>/<marker>`; `record.sh <file>` appends the environment of its run.
function writeScripts(repo: TempRepo, extra: Record<string, string> = {}) {
  const scripts: Record<string, string> = {
    'waitfor.sh': 'while [ ! -f "$COCKPIT_ROOT_PATH/$1" ]; do sleep 0.1; done\n',
    'record.sh':
      'echo "root=$COCKPIT_ROOT_PATH ws=$COCKPIT_WORKSPACE_PATH name=$COCKPIT_WORKSPACE_NAME term=$TERM pwd=$(pwd -P) path=$PATH" >> "$COCKPIT_ROOT_PATH/$1"\n',
    ...extra,
  };
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(repo.root, name), body);
}

// What `record.sh` wrote, one record per run.
function readRecords(repo: TempRepo, file: string) {
  const path = join(repo.root, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const found = /^root=(.*) ws=(.*) name=(.*) term=(.*) pwd=(.*) path=(.*)$/.exec(line);
      if (!found) throw new Error(`unexpected record: ${line}`);
      const [, root, ws, name, term, pwd, path] = found;
      return { root, ws, name, term, pwd, path };
    });
}

// The pids whose command line matches `pattern` (an extended regular expression).
function pidsMatching(pattern: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).sort();
  } catch {
    // `pgrep` exits with 1 when nothing matches.
    return [];
  }
}

// The `waitfor.sh <marker>` processes of `repo`: only the script itself has the expanded path in its
// command line (the shells that run the command hold `$COCKPIT_ROOT_PATH` unexpanded).
const waiters = (repo: TempRepo, marker: string) => pidsMatching(`${escapeRegExp(repo.root)}/waitfor\\.sh ${escapeRegExp(marker)}$`);

// Waits for the one `waitfor.sh <marker>` process of `repo` and returns its pid.
async function startedWaiter(repo: TempRepo, marker: string): Promise<number> {
  const found = await poll(() => waiters(repo, marker), (pids) => pids.length === 1, UI_TIMEOUT);
  expect(found, `one waitfor.sh ${marker} process runs`).toHaveLength(1);
  return found[0]!;
}

// Lets a `waitfor.sh <marker>` go on.
const release = (repo: TempRepo, marker: string) => writeFileSync(join(repo.root, marker), '');

const setupHeading = (page: Page, workspaceName: string) =>
  page.getByRole('heading', { name: `Setup of ${workspaceName}`, exact: true });
const retryButton = (page: Page) => page.getByRole('button', { name: 'Retry setup', exact: true });
const startAnywayButton = (page: Page) => page.getByRole('button', { name: 'Start anyway', exact: true });

// The status label of the `Setup` link under a workspace row (`Running`, `Done`, `Failed`), null when
// the row has no such link.
const setupLinkStatus = (page: Page, workspacePath: string) =>
  page.evaluate((workspacePath) => {
    const row = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === workspacePath);
    const link = row?.closest('li')?.querySelector('a[href*="/setup"]');
    if (!link) return null;
    const found = /^Setup\s*(Running|Done|Failed)$/.exec((link.textContent ?? '').trim());
    return found ? found[1]! : `unexpected label: ${link.textContent}`;
  }, workspacePath);

const waitForSetupStatus = (page: Page, workspacePath: string, status: string | null) =>
  poll(() => setupLinkStatus(page, workspacePath), (found) => found === status, UI_TIMEOUT);

// Every `Setup` link of the sidebar.
const setupLinkCount = (page: Page) => page.locator('aside a[href*="/setup"]').count();

async function openSetupLink(page: Page, workspacePath: string) {
  const handle = await page.evaluateHandle((workspacePath) => {
    const row = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === workspacePath);
    return row?.closest('li')?.querySelector('a[href*="/setup"]') ?? null;
  }, workspacePath);
  const link = handle.asElement();
  if (!link) throw new Error(`no Setup link under the workspace ${workspacePath}`);
  await link.click({ timeout: UI_TIMEOUT });
}

// Whether the workspace's `Setup` link is drawn above its first session link.
const setupAboveSessions = (page: Page, workspacePath: string) =>
  page.evaluate((workspacePath) => {
    const row = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === workspacePath);
    const item = row?.closest('li');
    const setup = item?.querySelector('a[href*="/setup"]');
    const session = item?.querySelector('a[href*="/sessions/"]');
    return !!setup && !!session && setup.getBoundingClientRect().top < session.getBoundingClientRect().top;
  }, workspacePath);

// What `window.api.workspaces.runCommands` answers.
const runCommandsApi = (page: Page, project: string, path: string, which: 'setup' | 'teardown') =>
  page.evaluate(
    ([project, path, which]) =>
      (
        window as unknown as {
          api: {
            workspaces: {
              runCommands(
                project: string,
                path: string,
                which: 'setup' | 'teardown',
                size: { cols: number; rows: number },
              ): Promise<{ status: string; message?: string }>;
            };
          };
        }
      ).api.workspaces.runCommands(project, path, which as 'setup', { cols: 80, rows: 24 }),
    [project, path, which] as const,
  );

// The terminal a dialog shows (the teardown's).
async function dialogTerminal(page: Page): Promise<Pane> {
  return (await openDialogs(page).locator('.xterm').first().elementHandle({ timeout: UI_TIMEOUT })) as Pane;
}

describe.each([
  ['dev server', launchDev],
  ['built app', launchBuilt],
  ['packaged app', launchPackaged],
  ['packaged app with the launchd environment', launchLaunchd],
])('%s', (mode, launch) => {
  let session: Session;
  let front: ReturnType<typeof watchFrontmost>;
  // The terminal tests run the shell the tests chose (`SHELL=/bin/sh`). The
  // launchd-environment mode runs the developer's real shell and its
  // configuration, so it only gets the PATH check (terminal AC12).
  const inIsolatedShell = launch !== launchLaunchd;
  // COCKPIT-48: a feature's full block runs once, in the built app. The other
  // modes run one smoke path per feature that goes through its IPC end to end
  // (`smoke paths` below), plus the checks that differ between modes.
  const full = mode === 'built app';

  beforeAll(async () => {
    front = watchFrontmost();
    session = await launch();
  });

  afterAll(async () => {
    await front?.stop();
    await session?.close();
    // The folder is removed once the app has closed.
    if (session) expect(existsSync(session.dataDir)).toBe(false);
  });

  test('shows the home page and the version from the main process', async () => {
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    await page.getByRole('heading', { name: 'Home' }).waitFor();
    expect(await page.title()).toBe('Cockpit');
    expect(await page.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
  });

  test('keeps Node out of the renderer', async () => {
    // Checks Node's `process` rather than any `process`: TanStack Router defines
    // a `process.env` stub in development.
    const nodeGlobals = await session.page.evaluate(() => {
      const scope = globalThis as { require?: unknown; process?: { versions?: unknown } };
      return { require: typeof scope.require, versions: typeof scope.process?.versions };
    });
    expect(nodeGlobals).toEqual({ require: 'undefined', versions: 'undefined' });
  });

  test('follows the system color scheme', async () => {
    const { page } = session;
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await background()).toBe('oklch(0.145 0 0)');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await background()).toBe('oklch(1 0 0)');
  });

  test('reloads to the same page', async () => {
    const { page } = session;
    await page.reload();
    await page.getByText(versionLabel).waitFor();
  });

  test('stays in the background', async () => {
    // No Dock icon (`UIElement`) and never the frontmost app, whichever app the
    // user brings to the front meanwhile.
    expect(await applicationType(session.pid)).toContain('"UIElement"');
    expect(front.pids.has(session.pid)).toBe(false);
  });

  test('runs while hidden', async () => {
    const hidden = await session.page.evaluate(async () => ({
      visibility: document.visibilityState,
      frame: await Promise.race([
        new Promise<boolean>((resolve) => requestAnimationFrame(() => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]),
    }));
    expect(hidden).toEqual({ visibility: 'visible', frame: true });
  });

  test('keeps its data in its own folder', async () => {
    const files = await poll(() => readdirSync(session.dataDir), (names) => names.length > 0, 5_000);
    expect(files).not.toEqual([]);
  });

  test('AC7 — the output holds what the app wrote from its first line', async () => {
    // Chromium prints this line during startup, before the test attaches to the window.
    expect(session.output()).toContain('DevTools listening on');
  });

  test('AC1 (state) — the data folder holds state.json with version 1', async () => {
    const file = join(session.dataDir, 'state.json');
    await poll(() => existsSync(file), Boolean, 5_000);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    expect(existsSync(join(session.dataDir, 'state.json.tmp'))).toBe(false);
  });

  test('AC1 — spawns a shell through window.api.pty and receives its output', async () => {
    const { page } = session;
    const id = await spawnShell(page);
    expect(typeof id).toBe('number');

    await ptyWrite(page, id, 'echo cockpit-$((6*7))\n');
    await waitForOutput(page, id, 'cockpit-42');

    await ptyKill(page, id);
  });

  test.runIf(full)('AC2 — resizes the pty', async () => {
    const { page } = session;
    const id = await spawnShell(page);

    await ptyResize(page, id, 100, 30);
    await ptyWrite(page, id, 'stty size\n');
    await waitForOutput(page, id, '30 100');

    await ptyKill(page, id);
  });

  test.runIf(full)('AC3 — kill ends the session with a single exit, and later calls on it do nothing', async () => {
    const { page } = session;
    const id = await spawnShell(page);

    await ptyKill(page, id);
    await waitForExit(page, id);

    const thrown = await page.evaluate((id) => {
      try {
        const { pty } = (window as unknown as PtyWindow).api;
        pty.write(id, 'echo late\n');
        pty.resize(id, 120, 40);
        pty.kill(id);
        return null;
      } catch (error) {
        return String(error);
      }
    }, id);
    expect(thrown).toBeNull();

    await sleep(500);
    expect(await exitsOf(page, id)).toHaveLength(1);
    expect(await consoleErrorsOf(page)).toEqual([]);
  });

  // node-pty is N-API: electron-builder must ship its prebuilds as they are
  // (`npmRebuild: false`), not compile it in place.
  test.runIf(mode === 'packaged app')('ships the node-pty prebuilds, not a rebuilt copy', () => {
    const nodePty = join(packagedAppDir(), 'Contents/Resources/app.asar.unpacked/node_modules/node-pty');
    expect(existsSync(join(nodePty, 'prebuilds'))).toBe(true);
    expect(existsSync(join(nodePty, 'build'))).toBe(false);
  });

  test('login shell: AC3 — gets the PATH of the login shell from the main process', async () => {
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    const path = await getShellPath(page);
    expect(typeof path).toBe('string');
    expect(path).not.toBe('');
  });

  // The app is given the environment launchd gives an app opened from the
  // Finder, so the same environment can be given to the login shell.
  test.runIf(launch === launchLaunchd)(
    'login shell: AC1 — gets exactly the PATH printed by the login shell, not the launchd PATH',
    async () => {
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      const expected = execFileSync(LAUNCHD_ENV.SHELL!, ['-ilc', 'printf %s "$PATH"'], {
        cwd: homedir(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        // The same environment as the app's shell: launchd's plus the two test variables.
        env: {
          ...LAUNCHD_ENV,
          COCKPIT_TEST_BACKGROUND: '1',
          COCKPIT_USER_DATA_DIR: session.dataDir,
        },
      });
      const path = await getShellPath(page);
      expect(normalizeFnm(path)).toBe(normalizeFnm(expected));
      expect(path).not.toBe(LAUNCHD_PATH);
    },
  );

  test.runIf(full)('terminal AC1 — the Terminal link opens a page with a heading, a tab bar and an xterm.js terminal under the header', async () => {
    const { page } = session;
    await page.getByRole('link', { name: 'Home', exact: true }).click({ timeout: UI_TIMEOUT });
    await page.getByRole('heading', { name: 'Home' }).waitFor({ timeout: UI_TIMEOUT });
    await page.getByRole('link', { name: 'Terminal', exact: true }).click({ timeout: UI_TIMEOUT });

    await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
    expect(await page.getByRole('link', { name: 'Terminal', exact: true }).getAttribute('aria-current')).toBe('page');
    await page.locator('.xterm').waitFor({ state: 'visible', timeout: UI_TIMEOUT });

    // The header holds the tab bar: the selected tab "Terminal 1" and a "New terminal" button.
    const header = page.locator('main header');
    await header.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
    await header.getByRole('tab', { name: 'Terminal 1', exact: true }).waitFor({ timeout: UI_TIMEOUT });
    await header.getByRole('button', { name: 'New terminal', exact: true }).waitFor({ timeout: UI_TIMEOUT });
    await expectTabs(page, ['Terminal 1'], 'Terminal 1');
    expect(await visiblePanes(page)).toHaveLength(1);

    // It fills the page: right under the header, down to the window bottom and
    // across the main area, give or take one cell and the scrollbar.
    const boxes = await page.evaluate(() => {
      const box = (selector: string) => {
        const { top, bottom, width } = document.querySelector(selector)!.getBoundingClientRect();
        return { top, bottom, width };
      };
      return { header: box('main header'), main: box('main'), terminal: box('.xterm') };
    });
    expect(boxes.terminal.width).toBeGreaterThan(0);
    expect(boxes.terminal.top).toBeGreaterThanOrEqual(boxes.header.bottom - 1);
    expect(boxes.terminal.top).toBeLessThan(boxes.header.bottom + 20);
    expect(boxes.terminal.bottom).toBeGreaterThan(boxes.main.bottom - 40);
    expect(boxes.terminal.width).toBeGreaterThan(boxes.main.width - 40);
  });

  test.runIf(inIsolatedShell)('terminal AC2 — typing a command shows its output', async () => {
    const { page } = session;
    await openTerminal(page);

    await typeLine(page, 'echo cockpit-$((6*7))');

    // The echoed command line shows `$((6*7))`: only the shell prints `cockpit-42`.
    await waitForRow(page, 'cockpit-42');
  });

  test.runIf(full)('terminal AC3 — resizing the viewport resizes the pty to the terminal columns and rows', async () => {
    const { page } = session;
    await openTerminal(page);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const screenWidth = () => page.evaluate(() => document.querySelector('.xterm-screen')!.getBoundingClientRect().width);
    const renderedRows = async () => (await terminalRows(page)).length;

    const [rowsBefore, colsBefore] = await terminalSize(page);
    expect(rowsBefore).toBe(await renderedRows());
    const widthBefore = await screenWidth();

    try {
      await page.setViewportSize({ width: viewport.width - 300, height: viewport.height - 150 });
      await page.waitForFunction(
        (before) => document.querySelector('.xterm-screen')!.getBoundingClientRect().width !== before,
        widthBefore,
        { timeout: UI_TIMEOUT },
      );

      const [rowsAfter, colsAfter] = await terminalSize(page);
      expect(colsAfter).not.toBe(colsBefore);
      expect(rowsAfter).toBe(await renderedRows());
    } finally {
      await page.setViewportSize(viewport);
    }
  });

  test.runIf(full)('terminal AC4 — exit shows the exit code, and later keys do nothing', async () => {
    const { page } = session;
    await openTerminal(page);

    await typeLine(page, 'exit 3');
    await waitForRow(page, '[Process exited with code 3]');

    const before = await terminalRows(page);
    await page.keyboard.type('still-typing');
    await page.keyboard.press('Enter');
    await sleep(500);
    expect(await terminalRows(page)).toEqual(before);
    expect(await page.pageErrors()).toEqual([]);
    expect(await consoleErrorsOf(page)).toEqual([]);
  });

  test.runIf(full)('terminal AC5 — copy puts the selected word in the clipboard data as text/plain', async () => {
    const { page } = session;
    await openTerminal(page);
    await typeLine(page, 'echo copy-me-123');
    await waitForRow(page, 'copy-me-123');

    // The echoed command line holds the word too: double-click the output line.
    // xterm.js sets `pointer-events: none` on `.xterm-rows`, so Playwright refuses
    // a locator `dblclick` on a row: the mouse goes to the word's position, where
    // the event lands on `.xterm-screen`, which handles the selection.
    const index = (await terminalRows(page)).indexOf('copy-me-123');
    expect(index).toBeGreaterThanOrEqual(0);
    const box = (await page.locator('.xterm-rows > div').nth(index).boundingBox())!;
    await page.mouse.dblclick(box.x + 5, box.y + box.height / 2);

    const copied = () =>
      page.evaluate(() => {
        const clipboardData = new DataTransfer();
        document.querySelector('.xterm')!.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
        return clipboardData.getData('text/plain');
      });
    expect(await poll(copied, (text) => text !== '', 5_000)).toBe('copy-me-123');
  });

  test.runIf(full)('terminal AC6 — pasting text then pressing Enter runs it', async () => {
    const { page } = session;
    await openTerminal(page);

    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'echo pasted-$((2*21))');
      document.querySelector('.xterm')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await page.keyboard.press('Enter');

    await waitForRow(page, 'pasted-42');
  });

  test.runIf(full)('terminal AC7 — text, background and ANSI red follow the tokens as the color scheme changes', async () => {
    const { page } = session;
    await openTerminal(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await typeLine(page, "printf '\\033[31mred\\033[0m\\n'");
    await page.locator('.xterm-rows span.xterm-fg-1', { hasText: 'red' }).first().waitFor({ timeout: 15_000 });

    const settled = (colors: TerminalColors) => JSON.stringify(colors.actual) === JSON.stringify(colors.expected);

    const dark = await poll(() => readTerminalColors(page), settled, 5_000);
    expect(dark.actual).toEqual(dark.expected);

    // Without reloading.
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await poll(() => readTerminalColors(page), settled, 5_000);
    expect(light.actual).toEqual(light.expected);

    // The two schemes really differ, so the checks above are not vacuous.
    expect(light.expected.text).not.toBe(dark.expected.text);
    expect(light.expected.background).not.toBe(dark.expected.background);
    expect(light.expected.red).not.toBe(light.expected.text);
  });

  // --- Several terminals: tabs, splits and lifecycle (COCKPIT-24) -------------

  test.runIf(full)('tabs AC2 — "New terminal" adds the next tab, selected, with a new shell that has the focus; the previous shell keeps running and can be typed in again', async () => {
    const { page } = session;
    await openTerminal(page);
    const first = await focusedPane(page);
    const firstPid = await pidOf(page, first);
    await typeLine(page, 'echo first-marker-$((20+1))');
    await waitForRow(page, 'first-marker-21', first);

    await newTerminal(page);
    await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 2');
    // The keyboard is in the new terminal already: no click before typing.
    const second = await newlyFocusedPane(page, [first]);
    expect(await visiblePanes(page)).toHaveLength(1);
    const secondPid = await pidOf(page);
    expect(secondPid).not.toBe(firstPid);
    expect(isAlive(firstPid)).toBe(true);
    expect(await rowsOf(second)).not.toContain('first-marker-21');

    await selectTab(page, 1);
    await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 1');
    expect(await first.isVisible()).toBe(true);
    expect(await rowsOf(first)).toContain('first-marker-21');
    await focusPane(first);
    await typeLine(page, 'echo back-$((3*5))');
    await waitForRow(page, 'back-15', first);
    expect(isAlive(firstPid)).toBe(true);
    expect(isAlive(secondPid)).toBe(true);
  });

  test.runIf(full)('tabs AC3 — "Split right" and "Split down" divide the terminal into two halves of equal width or height, the original keeps its shell and output, the new half has the focus; splits nest', async () => {
    const { page } = session;
    await openTerminal(page);
    const a = await focusedPane(page);
    const aPid = await pidOf(page, a);
    await typeLine(page, 'echo a-marker-$((10+1))');
    await waitForRow(page, 'a-marker-11', a);
    await settle(a);
    const whole = await boxOf(a);

    const b = await splitPane(page, a, 'right');
    const aBox = await boxOf(a);
    const bBox = await boxOf(b);
    expect(Math.abs(aBox.width - bBox.width), 'equal widths').toBeLessThanOrEqual(2);
    expect(Math.abs(aBox.top - bBox.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(aBox.height - bBox.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(aBox.height - whole.height), 'full height').toBeLessThanOrEqual(2);
    expect(aBox.left, 'the original is the first half').toBeLessThan(bBox.left);
    expect(aBox.right, 'side by side').toBeLessThanOrEqual(bBox.left + 2);
    expect(aBox.width + bBox.width, 'the two halves share the area').toBeGreaterThan(whole.width - 24);
    expect(aBox.width + bBox.width).toBeLessThanOrEqual(whole.width + 2);

    // The original terminal was not rebuilt: same element, same shell, same output.
    expect(await a.evaluate((element) => element.isConnected)).toBe(true);
    expect(await rowsOf(a)).toContain('a-marker-11');
    expect(isAlive(aPid)).toBe(true);
    // The new half runs a new shell and the keyboard is in it.
    const bPid = await pidOf(page);
    expect(bPid).not.toBe(aPid);
    expect(await rowsOf(b)).not.toContain('a-marker-11');

    // A half can be split again.
    const c = await splitPane(page, b, 'down');
    const bBox2 = await boxOf(b);
    const cBox = await boxOf(c);
    expect(Math.abs(bBox2.height - cBox.height), 'equal heights').toBeLessThanOrEqual(2);
    expect(Math.abs(bBox2.width - cBox.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(bBox2.left - cBox.left)).toBeLessThanOrEqual(2);
    expect(bBox2.top).toBeLessThan(cBox.top);
    expect(bBox2.bottom, 'stacked').toBeLessThanOrEqual(cBox.top + 2);
    expect(Math.abs(bBox2.width - bBox.width), 'inside the half it split').toBeLessThanOrEqual(2);
    expect(bBox2.height + cBox.height).toBeGreaterThan(bBox.height - 24);
    expect(sameArea(await boxOf(a), aBox), 'the first half is untouched').toBe(true);
    expect(await b.evaluate((element) => element.isConnected)).toBe(true);
    expect(isAlive(bPid)).toBe(true);
    expect(await rowsOf(b), 'the split terminal keeps its shell and output').toContain(`pid-${bPid}`);
    const cPid = await pidOf(page);
    expect(new Set([aPid, bPid, cPid]).size).toBe(3);
  });

  // In A | (B / C), closing C: B takes C's area, A is untouched, the keyboard is in B. The other
  // modes check the focus after "Close terminal" in the terminal smoke path.
  test.runIf(full)('tabs AC4 — in a nested split A | (B / C), closing C gives its area to B, leaves A untouched and puts the keyboard in B', async () => {
    const { page } = session;
    await openTerminal(page);
    const a = await focusedPane(page);
    const aPid = await pidOf(page, a);
    const b = await splitPane(page, a, 'right');
    const bPid = await pidOf(page);
    await typeLine(page, 'echo b-marker-$((10+5))');
    await waitForRow(page, 'b-marker-15', b);
    const c = await splitPane(page, b, 'down');
    const cPid = await pidOf(page);
    const aBox = await boxOf(a);
    const bBox = await boxOf(b);
    const cBox = await boxOf(c);
    const slot: Box = { left: bBox.left, top: bBox.top, right: cBox.right, bottom: cBox.bottom, width: bBox.width, height: cBox.bottom - bBox.top };

    await clickPaneButton(c, 'Close terminal');

    expect(await endsWithin(cPid)).toBe(true);
    await poll(async () => (await visiblePanes(page)).length, (count) => count === 2, UI_TIMEOUT);
    const grown = await poll(() => boxOf(b), (box) => sameArea(box, slot), UI_TIMEOUT);
    expect(sameArea(grown, slot), 'the sibling takes the closed terminal\'s whole area').toBe(true);
    expect(sameArea(await boxOf(a), aBox), 'the other half is untouched').toBe(true);
    expect(await rowsOf(b), 'the sibling keeps its output').toContain('b-marker-15');
    expect(isAlive(aPid)).toBe(true);
    expect(isAlive(bPid)).toBe(true);

    // No click: the text goes where the keyboard is.
    const active = await poll(() => activePane(page), Boolean, UI_TIMEOUT);
    expect(active, 'a visible terminal holds the keyboard focus').not.toBeNull();
    expect(await isSamePane(active!, b), 'the sibling B holds the focus').toBe(true);
    await typeLine(page, 'echo sibling-$((6*7))');
    await waitForRow(page, 'sibling-42', b);
    expect(await rowsOf(a), 'A did not receive the typed text').not.toContain('sibling-42');
    expect((await rowsOf(a)).join('\n')).not.toContain('echo sibling-');

    // The layout is now A | B. Closing A, the first child, gives the keyboard to B too.
    const whole: Box = { left: aBox.left, top: slot.top, right: slot.right, bottom: slot.bottom, width: slot.right - aBox.left, height: slot.height };
    await clickPaneButton(a, 'Close terminal');

    expect(await endsWithin(aPid), 'the first child\'s shell ends within 5 s').toBe(true);
    await poll(async () => (await visiblePanes(page)).length, (count) => count === 1, UI_TIMEOUT);
    const whole2 = await poll(() => boxOf(b), (box) => sameArea(box, whole), UI_TIMEOUT);
    expect(sameArea(whole2, whole), 'B takes the whole area').toBe(true);
    expect(isAlive(bPid)).toBe(true);
    const active2 = await poll(() => activePane(page), Boolean, UI_TIMEOUT);
    expect(await isSamePane(active2!, b), 'B holds the focus after the first child closed').toBe(true);
    await typeLine(page, 'echo first-closed-$((8*8))');
    await waitForRow(page, 'first-closed-64', b);
  });

  test.runIf(full)('tabs AC5 — closing a tab ends all its shells, selects the tab on its left (the new first one for the first), numbers are not reused, and an empty page offers "New terminal"; survive AC4 — the empty page is kept across Home and back, and its own "New terminal" button opens the next number', async () => {
    const { page } = session;
    await openTerminal(page);
    const pid1 = await pidOf(page);
    await openTab(page);
    const pid2 = await pidOf(page);
    await splitPane(page, await focusedPane(page), 'right');
    const pid2b = await pidOf(page);
    await openTab(page);
    const pid3 = await pidOf(page);
    await expectTabs(page, ['Terminal 1', 'Terminal 2', 'Terminal 3'], 'Terminal 3');

    // A middle tab with two shells: both end, the selection moves to its left.
    await selectTab(page, 2);
    await closeTab(page, 2);
    await expectTabs(page, ['Terminal 1', 'Terminal 3'], 'Terminal 1');
    expect(await endsWithin(pid2), 'the first shell of the closed tab ends within 5 s').toBe(true);
    expect(await endsWithin(pid2b), 'the second shell of the closed tab ends within 5 s').toBe(true);
    expect(isAlive(pid1)).toBe(true);
    expect(isAlive(pid3)).toBe(true);

    // Numbers are never reused: the next tab is 4, not 2.
    await openTab(page);
    const pid4 = await pidOf(page);
    await expectTabs(page, ['Terminal 1', 'Terminal 3', 'Terminal 4'], 'Terminal 4');

    await closeTab(page, 4);
    await expectTabs(page, ['Terminal 1', 'Terminal 3'], 'Terminal 3');
    expect(await endsWithin(pid4)).toBe(true);

    // The first tab: the selection goes to the new first tab.
    await selectTab(page, 1);
    await closeTab(page, 1);
    await expectTabs(page, ['Terminal 3'], 'Terminal 3');
    expect(await endsWithin(pid1)).toBe(true);
    expect(isAlive(pid3)).toBe(true);

    // The last tab: an empty state.
    await closeTab(page, 3);
    await expectTabs(page, [], undefined);
    expect(await endsWithin(pid3)).toBe(true);
    await page.getByText('No terminal open', { exact: true }).waitFor({ timeout: UI_TIMEOUT });
    expect(await visiblePanes(page)).toHaveLength(0);
    await newTerminalButton(page).waitFor({ state: 'visible', timeout: UI_TIMEOUT });

    // The page shows the state it was left in: no tab, no terminal, and no tab opened for the user.
    await goHome(page);
    await goToTerminalPage(page);
    await page.getByText('No terminal open', { exact: true }).waitFor({ timeout: UI_TIMEOUT });
    await expectTabs(page, [], undefined);
    expect(await visiblePanes(page)).toHaveLength(0);

    // The empty state's own "New terminal" button (not the header's) opens Terminal N+1: the
    // highest number used was 4.
    await emptyStateNewTerminal(page).click({ timeout: UI_TIMEOUT });
    await expectTabs(page, ['Terminal 5'], 'Terminal 5');
    await page.getByText('No terminal open', { exact: true }).waitFor({ state: 'detached', timeout: UI_TIMEOUT });
    const fresh = await newlyFocusedPane(page, []);
    await waitForPrompt(page, fresh);
    await typeLine(page, 'echo cockpit-$((6*7))');
    await waitForRow(page, 'cockpit-42', fresh);
  });

  test.runIf(full)('tabs AC5 — closing the last terminal of a tab closes the tab, and the last tab leaves the empty state; survive AC4 — after Home and back the next tab continues the count of the page\'s lifetime', async () => {
    const { page } = session;
    await openTerminal(page);
    const first = await focusedPane(page);
    const pid1 = await pidOf(page, first);
    const second = await openTab(page);
    const pid2 = await pidOf(page);
    await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 2');

    await clickPaneButton(second, 'Close terminal');
    await expectTabs(page, ['Terminal 1'], 'Terminal 1');
    expect(await endsWithin(pid2)).toBe(true);
    expect(isAlive(pid1)).toBe(true);

    // Terminal 1 and 2 opened, 2 closed, Home and back: the next one is Terminal 3, not 2.
    await goHome(page);
    expect(isAlive(pid1)).toBe(true);
    await goToTerminalPage(page);
    await expectTabs(page, ['Terminal 1'], 'Terminal 1');
    const third = await openTab(page);
    await expectTabs(page, ['Terminal 1', 'Terminal 3'], 'Terminal 3');
    const pid3 = await pidOf(page);

    await clickPaneButton(third, 'Close terminal');
    await expectTabs(page, ['Terminal 1'], 'Terminal 1');
    expect(await endsWithin(pid3)).toBe(true);

    await clickPaneButton(first, 'Close terminal');
    await expectTabs(page, [], undefined);
    expect(await endsWithin(pid1)).toBe(true);
    await page.getByText('No terminal open', { exact: true }).waitFor({ timeout: UI_TIMEOUT });
  });

  test.runIf(full)('tabs AC6 — stty size equals the rows and columns displayed in a new tab, in both halves of a split and in a sibling that grew', async () => {
    const { page } = session;
    await openTerminal(page);
    const tab = await openTab(page);
    await expectSizeMatchesDisplay(page, tab);

    const half = await splitPane(page, tab, 'right');
    await expectSizeMatchesDisplay(page, half);
    await expectSizeMatchesDisplay(page, tab);

    const quarter = await splitPane(page, half, 'down');
    await expectSizeMatchesDisplay(page, quarter);
    await expectSizeMatchesDisplay(page, half);

    await clickPaneButton(quarter, 'Close terminal');
    await poll(async () => (await visiblePanes(page)).length, (count) => count === 2, UI_TIMEOUT);
    await expectSizeMatchesDisplay(page, half);
  });

  test.runIf(full)('tabs AC6 — a terminal resized while its tab was hidden still gets its real size', async () => {
    const { page } = session;
    await openTerminal(page);
    const first = await focusedPane(page);
    await waitForPrompt(page, first);
    await openTab(page);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const rowsBefore = (await rowsOf(first)).length;

    try {
      await page.setViewportSize({ width: viewport.width - 300, height: viewport.height - 150 });
      // The hidden terminal is refitted while its tab is not shown.
      const rowsAfter = await poll(async () => (await rowsOf(first)).length, (count) => count !== rowsBefore, UI_TIMEOUT);
      expect(rowsAfter, 'the hidden terminal was resized').not.toBe(rowsBefore);
      await selectTab(page, 1);
      await poll(() => first.isVisible(), Boolean, UI_TIMEOUT);
      await expectSizeMatchesDisplay(page, first);
    } finally {
      await page.setViewportSize(viewport);
    }
  });

  test.runIf(full)('tabs AC6 — a terminal resized while its shell is starting gets the size it ends up with', async () => {
    const { page } = session;
    await openTerminal(page);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const hostPid = await ptyHostPid(page);
    const onePid = await pidOf(page);
    let tab: Pane | undefined;

    await holdPtySpawn(session);
    try {
      tab = await openTab(page);
      const rowsBefore = (await rowsOf(tab)).length;
      await page.setViewportSize({ width: viewport.width - 300, height: viewport.height - 150 });
      const rowsAfter = await poll(async () => (await rowsOf(tab!)).length, (count) => count !== rowsBefore, UI_TIMEOUT);
      // The premise: the shell has not started yet, and the terminal is already resized.
      expect(rowsAfter, 'the terminal was resized').not.toBe(rowsBefore);
      expect((await rowsOf(tab)).some((row) => row.trim() !== ''), 'the shell is still starting').toBe(false);

      // survive AC5: a tab opened while the spawn is held, then closed before it is released.
      await openTab(page);
      await expectTabs(page, ['Terminal 1', 'Terminal 2', 'Terminal 3'], 'Terminal 3');
      await closeTab(page, 3);
      await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 2');
    } finally {
      await releasePtySpawn(session);
    }

    try {
      await waitForPrompt(page, tab);
      await expectSizeMatchesDisplay(page, tab);
      const twoPid = await pidOf(page, tab);
      // survive AC5: the closed tab's shell, spawned late, does not stay under the pty host.
      expect(
        await poll(
          () => childPidsOf(hostPid).sort((a, b) => a - b),
          (children) => children.length === 2 && children.includes(onePid) && children.includes(twoPid),
          5_000,
        ),
        'no shell of the closed tab is left under the pty host',
      ).toEqual([onePid, twoPid].sort((a, b) => a - b));
    } finally {
      await page.setViewportSize(viewport);
    }
  });

  // COCKPIT-46: the tabs and splits outlive a visit of the page. One test, since only the
  // whole page shows elements moved across a route change.
  test.runIf(full)('survive AC1, AC2, AC3 — tabs and splits keep their shells, output, selection and keyboard across Home and back, a command that ended meanwhile shows its output, and the terminals fit a window resized meanwhile', async () => {
    const { page } = session;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    // The shell creates it after printing, so the test knows the command ended without a fixed wait.
    const done = join(session.dataDir, 'later.flag');
    rmSync(done, { force: true });

    await openTerminal(page);
    const one = await focusedPane(page);
    const onePid = await pidOf(page, one);
    await typeLine(page, 'echo m1-$((10+1))');
    await waitForRow(page, 'm1-11', one);
    const two = await openTab(page);
    const twoPid = await pidOf(page);
    await typeLine(page, 'echo m2-$((20+2))');
    await waitForRow(page, 'm2-22', two);
    const three = await splitPane(page, two, 'right');
    const threePid = await pidOf(page);
    await typeLine(page, 'echo m3-$((30+3))');
    await waitForRow(page, 'm3-33', three);
    const pids = [onePid, twoPid, threePid];
    expect(new Set(pids).size).toBe(3);
    await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 2');
    // The keyboard is in the second half of Terminal 2, which runs a command that prints later.
    await typeLine(page, `sleep 2; echo later-$((6*7)); : > '${done}'`);

    try {
      await goHome(page);
      expect(existsSync(done), 'the command has not printed yet when the user leaves').toBe(false);
      for (const pid of pids) expect(isAlive(pid), `shell ${pid} is alive while Home`).toBe(true);

      // The window is resized while the terminals are not on the page.
      await page.setViewportSize({ width: viewport.width - 300, height: viewport.height - 150 });
      expect(await poll(() => existsSync(done), Boolean, 15_000), 'the command ended while Home').toBe(true);
      for (const pid of pids) expect(isAlive(pid), `shell ${pid} is alive after the command ended`).toBe(true);

      await goToTerminalPage(page);
      for (const pid of pids) expect(isAlive(pid), `shell ${pid} is alive after coming back`).toBe(true);
      await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 2');
      expect(await visiblePanes(page)).toHaveLength(2);
      expect(await rowsOf(two)).toContain('m2-22');
      expect(await rowsOf(three)).toContain('m3-33');
      // AC2: the output of the command that ended while the user was away.
      await waitForRow(page, 'later-42', three);

      // The keyboard is where it was: no click before typing.
      const active = await poll(() => activePane(page), Boolean, UI_TIMEOUT);
      expect(active, 'a visible terminal holds the keyboard focus').not.toBeNull();
      expect(await isSamePane(active!, three), 'the terminal that had the keyboard has it again').toBe(true);
      await typeLine(page, 'echo kb-$((3*3))');
      await waitForRow(page, 'kb-9', three);
      expect(await rowsOf(two)).not.toContain('kb-9');

      // A command in each of the other two terminals.
      await focusPane(two);
      await typeLine(page, 'echo cmd-two-$((2*2))');
      await waitForRow(page, 'cmd-two-4', two);

      // AC3: stty size is what the terminal displays, in the shown terminals...
      await expectSizeMatchesDisplay(page, three);
      await expectSizeMatchesDisplay(page, two);

      // ...and in the other tab's terminal, once that tab is selected.
      await selectTab(page, 1);
      await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 1');
      await poll(() => one.isVisible(), Boolean, UI_TIMEOUT);
      expect(await rowsOf(one)).toContain('m1-11');
      await focusPane(one);
      await typeLine(page, 'echo cmd-one-$((1+1))');
      await waitForRow(page, 'cmd-one-2', one);
      await expectSizeMatchesDisplay(page, one);
      for (const pid of pids) expect(isAlive(pid)).toBe(true);
    } finally {
      await page.setViewportSize(viewport);
    }
  });

  test.runIf(full)('daemon AC4 — after Home and back, reloading the page keeps every shell of every tab running: the page shows one tab per shell, in creation order, each with its output and taking a new command', async () => {
    const { page } = session;
    const pids = await openTwoTabsOneSplit(page);

    await goHome(page);
    await goToTerminalPage(page);
    await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 2');
    for (const pid of pids) expect(isAlive(pid)).toBe(true);

    await page.reload();
    await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });

    for (const pid of pids) expect(isAlive(pid), `shell ${pid} is still running`).toBe(true);
    // One tab per running shell, without the split.
    await poll(async () => (await tabsShown(page)).names.length, (count) => count >= pids.length, UI_TIMEOUT);
    const shown: number[] = [];
    for (const name of (await tabsShown(page)).names) {
      await page.getByRole('tab', { name, exact: true }).click({ timeout: UI_TIMEOUT });
      shown.push(await pidOf(page));
    }
    for (const pid of pids) expect(shown).toContain(pid);
  });

  // The spawn itself fails: the terminal says so, the other tabs go on, and the next spawn works.
  test.runIf(full)('survive AC9 — a failing spawn shows [Could not start the shell: …] in the new tab, the other tabs keep working, and a new tab runs commands once spawn works again', async () => {
    const { page } = session;
    await openTerminal(page);
    const first = await focusedPane(page);
    await pidOf(page, first);

    await replacePtySpawn(session, `async () => { throw new Error('refused by the test'); }`);
    let broken: Pane;
    try {
      broken = await openTab(page);
      // Typed into the terminal whose shell never started: nothing runs it, nowhere.
      await typeLine(page, 'echo lost-$((1+1))');
      await waitForRow(page, /^\[Could not start the shell: .*refused by the test.*\]$/, broken);
      await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 2');

      await selectTab(page, 1);
      await poll(() => first.isVisible(), Boolean, UI_TIMEOUT);
      await focusPane(first);
      await typeLine(page, 'echo still-$((3*5))');
      await waitForRow(page, 'still-15', first);
      expect((await rowsOf(first)).some((row) => row.includes('lost-2'))).toBe(false);
      expect((await rowsOf(broken)).some((row) => row.includes('lost-2'))).toBe(false);
    } finally {
      await restorePtySpawn(session);
    }

    const fresh = await openTab(page);
    await waitForPrompt(page, fresh);
    await typeLine(page, 'echo cockpit-$((6*7))');
    await waitForRow(page, 'cockpit-42', fresh);
    await expectTabs(page, ['Terminal 1', 'Terminal 2', 'Terminal 3'], 'Terminal 3');
  });

  // The app is given launchd's environment: the terminal's shell must get the
  // login shell's PATH (`await shellEnv`), not launchd's. The shell is a login
  // shell and re-reads the user's startup files, so its PATH may be reordered or
  // extended: every directory of the login-shell PATH must appear in it.
  test.runIf(launch === launchLaunchd)('terminal AC12 — the terminal shell gets the login shell PATH, not the launchd PATH', async () => {
    const { page } = session;
    await openTerminal(page);
    const expected = normalizeFnm(await getShellPath(page));
    expect(expected).not.toBe(LAUNCHD_PATH);
    const directories = expected.split(':').filter(Boolean);

    // The developer's login shell starts slowly and drops what is typed before
    // its prompt: wait for the prompt.
    await page.waitForFunction(
      () => [...document.querySelectorAll('.xterm-rows > div')].some((row) => (row.textContent ?? '').trim() !== ''),
      undefined,
      { timeout: 20_000 },
    );
    await typeLine(page, 'printf %s "$PATH"');

    // A long PATH wraps over several rows: the rows after the typed command are
    // joined (a wrapped row is full, so no padding comes between its parts), and
    // the shell's prompt, if any, follows the PATH.
    const printed = () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' '));
        const command = rows.findLastIndex((row) => /printf %s "\$PATH"\s*$/.test(row));
        return command < 0 ? '' : rows.slice(command + 1).join('');
      });
    const missingFrom = (text: string) => directories.filter((directory) => !normalizeFnm(text).includes(directory));
    const output = await poll(printed, (text) => missingFrom(text).length === 0, 20_000);
    expect(missingFrom(output)).toEqual([]);
    expect(output.startsWith(LAUNCHD_PATH)).toBe(false);
  });

  // The picker is stubbed in the main process (`session.evaluateInMain`). The
  // tests share the session and run in order: the repository added by AC1 is
  // the one AC2 adds again, and AC6 removes what AC1 and AC4 added.
  describe.runIf(full)('projects', () => {
    let alpha: TempRepo;
    let bravo: TempRepo;
    let plain: TempRepo;
    const folders: TempRepo[] = [];

    beforeAll(() => {
      alpha = makeRepo('alpha-project');
      bravo = makeRepo('bravo-project');
      plain = makePlainFolder('not-a-repository');
      folders.push(alpha, bravo, plain);
    });

    afterAll(() => {
      for (const folder of folders) rmSync(folder.parent, { recursive: true, force: true });
    });

    test('AC1 — adding a subfolder of a repository lists the repository by name, titled with its root, and stores its root', async () => {
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      expect(await sidebarLines(page)).toContain('Projects');
      expect(await entryTitles(page)).toEqual([]);

      await addProject(session, join(alpha.root, 'src'));
      await waitForEntries(page, [alpha.root]);

      const entries = await sidebarEntries(page);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.title).toBe(alpha.root);
      expect(entries[0]!.text).toContain(alpha.name);
      expect(await isBelowProjectsHeader(page, { title: alpha.root })).toBe(true);

      await poll(() => projectsInState(session.dataDir), (projects) => Array.isArray(projects) && projects.length > 0, UI_TIMEOUT);
      expect(projectsInState(session.dataDir)).toEqual([{ path: alpha.root }]);
      expect(existsSync(join(session.dataDir, 'state.json.tmp'))).toBe(false);
    });

    test('AC2 — adding the same repository again, by its root or a subfolder, keeps one entry, shows a message and leaves state.json alone', async () => {
      const { page } = session;
      const message = `${alpha.name} is already in Cockpit.`;
      const before = stateSnapshot(session.dataDir);

      for (const pick of [alpha.root, join(alpha.root, 'src')]) {
        await addProject(session, pick);
        await waitForLine(page, message);
        await sleep(300);

        expect(await entryTitles(page)).toEqual([alpha.root]);
        expect(await refusalsShown(page)).toEqual([message]);
        expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
        expect(stateSnapshot(session.dataDir)).toEqual(before);
      }
    });

    test('AC3 — a folder outside any git repository is refused with a message, no entry and state.json untouched', async () => {
      const { page } = session;
      const message = `${plain.root} is not in a git repository.`;
      const before = stateSnapshot(session.dataDir);

      await addProject(session, plain.root);
      await waitForLine(page, message);
      await sleep(300);

      expect(await entryTitles(page)).toEqual([alpha.root]);
      expect(await refusalsShown(page)).toEqual([message]);
      expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
      expect(stateSnapshot(session.dataDir)).toEqual(before);
    });

    test('AC4 — a message goes away when a valid repository is added, and the project appears', async () => {
      const { page } = session;
      expect(await refusalsShown(page), 'a message is shown before the add').not.toEqual([]);

      await addProject(session, bravo.root);
      await waitForEntries(page, [alpha.root, bravo.root]);

      expect(await refusalsShown(page)).toEqual([]);
      await poll(() => projectsInState(session.dataDir), (projects) => Array.isArray(projects) && projects.length > 1, UI_TIMEOUT);
      expect(projectsInState(session.dataDir)).toEqual([{ path: alpha.root }, { path: bravo.root }]);
    });

    test('AC5 — cancelling the picker changes neither the list, nor state.json, and shows no message', async () => {
      const { page } = session;
      expect(await refusalsShown(page)).toEqual([]);
      const before = stateSnapshot(session.dataDir);

      await addProject(session, null);
      await sleep(500);

      expect(await entryTitles(page)).toEqual([alpha.root, bravo.root]);
      expect(await refusalsShown(page)).toEqual([]);
      expect(stateSnapshot(session.dataDir)).toEqual(before);
    });

    test('AC6 — the "…" menu offers "Remove from Cockpit" (Files stay on disk); picking it removes the entry at once and leaves the repository on disk', async () => {
      const { page } = session;
      const alphaOnDisk = snapshotRepo(alpha);
      const bravoOnDisk = snapshotRepo(bravo);

      await removeThroughMenu(page, bravo.root);
      await waitForEntries(page, [alpha.root]);
      // No confirmation to answer.
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(await page.getByRole('alertdialog').count()).toBe(0);
      await poll(() => projectsInState(session.dataDir), (projects) => Array.isArray(projects) && projects.length === 1, UI_TIMEOUT);
      expect(projectsInState(session.dataDir)).toEqual([{ path: alpha.root }]);
      expect(snapshotRepo(bravo)).toEqual(bravoOnDisk);

      await removeThroughMenu(page, alpha.root);
      await waitForEntries(page, []);
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(await page.getByRole('alertdialog').count()).toBe(0);
      await poll(() => projectsInState(session.dataDir), (projects) => Array.isArray(projects) && projects.length === 0, UI_TIMEOUT);
      expect(projectsInState(session.dataDir)).toEqual([]);
      expect(snapshotRepo(alpha)).toEqual(alphaOnDisk);
      expect(alphaOnDisk.hasGit).toBe(true);
      expect(basename(alpha.root)).toBe(alpha.name);
    });
  });

  // Workspaces: the picker is stubbed as in `projects`, and the tests share the
  // session and run in order. `ws-clone` stays in the list from the first test
  // to the "delete" tests, and the workspaces `feature/login` and
  // `second-by-enter`, created by the AC5 test, are the ones the delete tests
  // delete. Worktrees the app creates land under the launch's COCKPIT_HOME.
  describe.runIf(full)('workspaces', () => {
    let clone: TempClone;
    let noDefault: TempRepo;
    const folders: TempRepo[] = [];
    const loginBranch = 'feature/login';
    const enterBranch = 'second-by-enter';

    beforeAll(() => {
      clone = makeClone('ws-clone');
      noDefault = makeRepo('ws-no-default');
      gitIn(noDefault.root, 'checkout', '--detach');
      folders.push(clone, clone.upstream, noDefault);
    });

    // A failing test must not leave a menu or a dialog that blocks the tests after it.
    // Escape only while something is open (at most 4 times), and wait for it to close.
    afterEach(async () => {
      const { page } = session;
      const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
      for (let attempt = 0; attempt < 4; attempt++) {
        const open = await overlays.count();
        if (open === 0) break;
        await page.keyboard.press('Escape');
        await poll(() => overlays.count(), (count) => count < open, 1_000);
      }
    });

    afterAll(async () => {
      try {
        await clearProjects();
      } finally {
        for (const folder of folders) rmSync(folder.parent, { recursive: true, force: true });
      }
    });

    const projectWorktrees = (repo: TempRepo) => dirname(worktreePath(session, repo, 'x'));
    // Everything under the worktrees folder of `repo`, so "nothing was created" is checkable.
    const worktreeListing = (repo: TempRepo) => {
      const dir = projectWorktrees(repo);
      return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];
    };
    const isListed = async (path: string) => (await entryTitles(session.page)).includes(path);
    const waitListed = (path: string) => poll(() => isListed(path), Boolean, UI_TIMEOUT);
    const waitUnlisted = (path: string) => poll(() => isListed(path), (listed) => !listed, UI_TIMEOUT);

    test('AC1 — the project menu holds "New workspace…" above "Remove from Cockpit", and opens a dialog titled "New workspace in <project>" with an empty, focused Name and a Base select', async () => {
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      await addRepository(session, clone);

      await openMenu(page, clone.root);
      const items = await page.getByRole('menuitem').allInnerTexts();
      expect(items).toHaveLength(2);
      expect(items[0]!.trim()).toBe('New workspace…');
      expect(items[1]!.split('\n')[0]!.trim()).toBe('Remove from Cockpit');
      await page.getByRole('menuitem', { name: 'New workspace…' }).click({ timeout: UI_TIMEOUT });

      const dialog = newWorkspaceDialog(page, clone);
      await dialog.waitFor({ timeout: UI_TIMEOUT });
      const lines = await linesOf(dialog);
      expect(lines).toContain(`New workspace in ${clone.name}`);
      expect(lines).toContain('Name');
      expect(lines).toContain('Base');
      expect(await nameField(dialog).inputValue()).toBe('');
      const focused = await poll(
        () => nameField(dialog).evaluate((element) => element === document.activeElement),
        Boolean,
        UI_TIMEOUT,
      );
      expect(focused, 'the Name field has the focus').toBe(true);
      expect(await baseSelect(dialog).count()).toBe(1);
      await dismissDialogs(page);
    });

    test('AC2 — the Base select lists local branches under "Local" and origin/* branches under "Remote" (no origin/HEAD), preselects origin/main and runs no fetch', async () => {
      const { page } = session;
      // A commit only a fetch would bring in.
      gitIn(clone.upstream.root, 'commit', '--allow-empty', '-m', 'newer on origin');
      const originMain = gitIn(clone.root, 'rev-parse', 'refs/remotes/origin/main');
      const fetchHead = join(clone.root, '.git', 'FETCH_HEAD');
      const fetchHeadBefore = existsSync(fetchHead);

      const dialog = await openNewWorkspaceDialog(page, clone);
      expect(await poll(() => selectedBase(dialog), (value) => value === 'origin/main', UI_TIMEOUT)).toBe('origin/main');
      const groups = await readBaseOptions(page, dialog);

      expect(Object.keys(groups)).toEqual(['Local', 'Remote']);
      expect([...groups.Local!].sort()).toEqual(['local-topic', 'main', 'topic/nested']);
      expect([...groups.Remote!].sort()).toEqual(['origin/develop', 'origin/feature/x', 'origin/main', 'origin/release/1.0']);
      expect(await selectedBase(dialog)).toBe('origin/main');
      expect(gitIn(clone.root, 'rev-parse', 'refs/remotes/origin/main')).toBe(originMain);
      expect(existsSync(fetchHead)).toBe(fetchHeadBefore);
      await dismissDialogs(page);
    });

    test('AC4 — "Create" is disabled while Name is empty or only whitespace', async () => {
      const { page } = session;
      const dialog = await openNewWorkspaceDialog(page, clone);
      await poll(() => selectedBase(dialog), (value) => value === 'origin/main', UI_TIMEOUT);

      expect(await createButton(dialog).isDisabled()).toBe(true);
      await nameField(dialog).fill('   ');
      expect(await createButton(dialog).isDisabled()).toBe(true);
      await nameField(dialog).fill('\t  \t');
      expect(await createButton(dialog).isDisabled()).toBe(true);
      await nameField(dialog).fill('something');
      expect(await createButton(dialog).isDisabled()).toBe(false);
      await nameField(dialog).fill('');
      expect(await createButton(dialog).isDisabled()).toBe(true);
      await dismissDialogs(page);
    });

    test('AC3 — without a default base nothing is preselected and "Create" stays disabled until a base is chosen', async () => {
      const { page } = session;
      await addRepository(session, noDefault);

      const dialog = await openNewWorkspaceDialog(page, noDefault);
      const groups = await readBaseOptions(page, dialog);
      expect(groups.Local).toContain('main');
      expect(await selectedBase(dialog), 'no base is preselected').not.toBe('main');
      expect(await selectedBase(dialog)).not.toBe('');
      await nameField(dialog).fill('some-work');
      expect(await createButton(dialog).isDisabled()).toBe(true);

      await chooseBase(page, dialog, 'main');
      expect(await createButton(dialog).isDisabled()).toBe(false);
      await dismissDialogs(page);

      await removeThroughMenu(page, noDefault.root);
      await waitForEntries(page, [clone.root]);
    });

    test('AC5 — "Create" (or Enter in Name) creates the branch from origin/main and the worktree under $COCKPIT_HOME, closes the dialog and lists the workspace; the name is trimmed', async () => {
      const { page } = session;
      const originMain = gitIn(clone.root, 'rev-parse', 'origin/main');
      expect(gitIn(clone.root, 'rev-parse', 'main'), 'local main differs from origin/main').not.toBe(originMain);
      // The launch's COCKPIT_HOME is inside its temporary folder.
      expect(await session.evaluateInMain<string>('process.env.COCKPIT_HOME')).toBe(session.cockpitHome);
      expect(session.cockpitHome.startsWith(`${session.dataDir}/`)).toBe(true);

      const dialog = await openNewWorkspaceDialog(page, clone);
      await poll(() => selectedBase(dialog), (value) => value === 'origin/main', UI_TIMEOUT);
      await nameField(dialog).fill(`  ${loginBranch}  `);
      await createButton(dialog).click({ timeout: UI_TIMEOUT });
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });

      const path = worktreePath(session, clone, loginBranch);
      expect(existsSync(join(path, 'README.md'))).toBe(true);
      expect(linkedWorktrees(clone)).toContainEqual({ path, branch: loginBranch });
      expect(gitIn(clone.root, 'rev-parse', loginBranch)).toBe(originMain);
      expect(localBranches(clone)).toContain(loginBranch);
      expect(existsSync(join(homedir(), '.cockpit', 'worktrees', `${clone.name}-${sha8(clone.root)}`))).toBe(false);
      await waitListed(path);
      const row = (await sidebarEntries(page)).find((entry) => entry.title === path);
      expect(row!.text).toContain(loginBranch);
      expect(await isBelowProjectsHeader(page, { title: path })).toBe(true);

      // Enter in the Name field does the same.
      const second = await openNewWorkspaceDialog(page, clone);
      await poll(() => selectedBase(second), (value) => value === 'origin/main', UI_TIMEOUT);
      await nameField(second).fill(enterBranch);
      await nameField(second).press('Enter');
      await second.waitFor({ state: 'hidden', timeout: 15_000 });

      const secondPath = worktreePath(session, clone, enterBranch);
      expect(existsSync(join(secondPath, 'README.md'))).toBe(true);
      expect(linkedWorktrees(clone)).toContainEqual({ path: secondPath, branch: enterBranch });
      expect(gitIn(clone.root, 'rev-parse', enterBranch)).toBe(originMain);
      await waitListed(secondPath);
      // Under their project, in `git worktree list` order.
      expect(linkedWorktrees(clone).map((worktree) => worktree.path).sort()).toEqual([path, secondPath].sort());
      await waitForEntries(page, [clone.root, ...linkedWorktrees(clone).map((worktree) => worktree.path)]);
    });

    test('AC6 — a name that is already a local branch keeps the dialog open with "A branch named <name> already exists." and creates nothing', async () => {
      const { page } = session;
      const before = { git: gitState(clone), listing: worktreeListing(clone) };

      const dialog = await openNewWorkspaceDialog(page, clone);
      await poll(() => selectedBase(dialog), (value) => value === 'origin/main', UI_TIMEOUT);
      await nameField(dialog).fill(loginBranch);
      await createButton(dialog).click({ timeout: UI_TIMEOUT });
      await waitForDialogLine(dialog, (line) => line === `A branch named ${loginBranch} already exists.`);
      await sleep(300);

      expect(await dialog.isVisible()).toBe(true);
      expect(gitState(clone)).toEqual(before.git);
      expect(worktreeListing(clone)).toEqual(before.listing);
      await dismissDialogs(page);
    });

    test('AC7 — a name git refuses keeps the dialog open with "<name> is not a valid branch name." and creates nothing', async () => {
      const { page } = session;
      const before = { git: gitState(clone), listing: worktreeListing(clone) };

      const dialog = await openNewWorkspaceDialog(page, clone);
      await poll(() => selectedBase(dialog), (value) => value === 'origin/main', UI_TIMEOUT);
      for (const name of ['my feature', 'a..b']) {
        await nameField(dialog).fill(name);
        await createButton(dialog).click({ timeout: UI_TIMEOUT });
        await waitForDialogLine(dialog, (line) => line === `${name} is not a valid branch name.`);
        await sleep(300);

        expect(await dialog.isVisible()).toBe(true);
        expect(gitState(clone)).toEqual(before.git);
        expect(worktreeListing(clone)).toEqual(before.listing);
      }
      await dismissDialogs(page);
    });

    test('AC8 — a base deleted after the dialog opened keeps it open with the error message and creates nothing', async () => {
      const { page } = session;
      const develop = gitIn(clone.root, 'rev-parse', 'refs/remotes/origin/develop');
      const before = { git: gitState(clone), listing: worktreeListing(clone) };

      const dialog = await openNewWorkspaceDialog(page, clone);
      await chooseBase(page, dialog, 'origin/develop');
      await nameField(dialog).fill('orphan-base');
      const linesBefore = await linesOf(dialog);
      gitIn(clone.root, 'update-ref', '-d', 'refs/remotes/origin/develop');
      try {
        await createButton(dialog).click({ timeout: UI_TIMEOUT });
        // A new line that names the base git could not find.
        const message = await waitForDialogLine(dialog, (line) => !linesBefore.includes(line) && line.includes('origin/develop'));
        expect(message.length).toBeGreaterThan(0);
        await sleep(300);

        expect(await dialog.isVisible()).toBe(true);
        expect(localBranches(clone)).not.toContain('orphan-base');
        expect(worktreeListing(clone)).toEqual(before.listing);
      } finally {
        gitIn(clone.root, 'update-ref', 'refs/remotes/origin/develop', develop);
      }
      expect(gitState(clone)).toEqual(before.git);
      await dismissDialogs(page);
    });

    // A workspace added with git itself (on a new branch from origin/main), listed after a reload.
    async function addExternalWorkspace(name: string): Promise<string> {
      const path = join(clone.parent, `wt-${name}`);
      gitIn(clone.root, 'worktree', 'add', '--quiet', '-b', name, path, 'origin/main');
      await session.page.reload();
      await session.page.getByText(versionLabel).waitFor();
      await waitListed(path);
      return path;
    }

    // Leaves the session with no project.
    async function clearProjects() {
      const { page } = session;
      await page.evaluate(async () => {
        const { projects } = (globalThis as unknown as { api: { projects: { list(): Promise<{ path: string }[]>; remove(path: string): Promise<void> } } }).api;
        for (const project of await projects.list()) await projects.remove(project.path);
      });
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitForEntries(page, []);
    }

    test('AC14, AC15 — the workspace menu holds "Delete workspace…", which opens "Delete <name>?" naming the folder; Cancel and Escape change nothing', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('review-ws');
      const before = { git: gitState(clone), listing: worktreeListing(clone) };

      await openMenu(page, path);
      const items = await page.getByRole('menuitem').allInnerTexts();
      expect(items.map((item) => item.trim())).toContain('Delete workspace…');
      await page.keyboard.press('Escape');
      await page.getByRole('menuitem').first().waitFor({ state: 'hidden', timeout: UI_TIMEOUT });

      for (const dismiss of ['Cancel', 'Escape'] as const) {
        await startDeletion(page, path);
        const dialog = deleteDialog(page, 'Delete review-ws?');
        await dialog.waitFor({ timeout: UI_TIMEOUT });
        const text = await dialog.innerText();
        expect(text).toContain(path);
        expect(text).toMatch(/deleted/);
        expect(text).toMatch(/merged/);
        expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(1);
        expect(await dialog.getByRole('button', { name: 'Delete', exact: true }).count()).toBe(1);

        if (dismiss === 'Cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: UI_TIMEOUT });
        else await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: UI_TIMEOUT });
        await sleep(300);

        expect(existsSync(join(path, 'README.md'))).toBe(true);
        expect(gitState(clone)).toEqual(before.git);
        expect(worktreeListing(clone)).toEqual(before.listing);
        expect(await isListed(path)).toBe(true);
      }
    });

    test('AC16 — confirming the deletion of a clean workspace with no new commit removes the folder, the worktree, the branch and the row', async () => {
      const { page } = session;
      const path = worktreePath(session, clone, loginBranch);

      await startDeletion(page, path);
      const dialog = deleteDialog(page, `Delete ${loginBranch}?`);
      await dialog.waitFor({ timeout: UI_TIMEOUT });
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(clone)).not.toContain(loginBranch);
      expect((await sidebarLines(page)).filter((line) => line.startsWith('Branch '))).toEqual([]);
    });

    test('AC17 — an unmerged branch is kept: the worktree is removed and "Branch <branch> was kept: it is not merged." shows under the Projects header', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('unmerged-ws');
      gitIn(path, 'commit', '--allow-empty', '-m', 'work in progress');
      const commit = gitIn(path, 'rev-parse', 'HEAD');

      await startDeletion(page, path);
      const dialog = deleteDialog(page, 'Delete unmerged-ws?');
      await dialog.waitFor({ timeout: UI_TIMEOUT });
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
      const message = 'Branch unmerged-ws was kept: it is not merged.';
      await waitForLine(page, message);
      await waitUnlisted(path);

      expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(clone)).toContain('unmerged-ws');
      expect(gitIn(clone.root, 'rev-parse', 'unmerged-ws')).toBe(commit);
    });

    test('AC18 — a workspace with uncommitted changes shows a warning first; Cancel keeps everything; "Delete anyway" removes it, changes included, and applies the branch rule', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('dirty-ws');
      writeFileSync(join(path, 'README.md'), 'changed\n');
      writeFileSync(join(path, 'notes.txt'), 'untracked\n');
      const before = gitState(clone);

      await startDeletion(page, path);
      const dialog = deleteDialog(page, 'Delete dirty-ws?');
      await dialog.waitFor({ timeout: UI_TIMEOUT });
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
      const warning = deleteDialog(page, 'dirty-ws has uncommitted changes');
      await warning.waitFor({ timeout: UI_TIMEOUT });
      expect(await warning.innerText()).toMatch(/lost/i);
      expect(await warning.getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(1);
      expect(await warning.getByRole('button', { name: 'Delete anyway', exact: true }).count()).toBe(1);
      await sleep(300);
      // Nothing is deleted yet.
      expect(existsSync(path)).toBe(true);
      expect(gitState(clone)).toEqual(before);

      await warning.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: UI_TIMEOUT });
      await warning.waitFor({ state: 'hidden', timeout: UI_TIMEOUT });
      expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('changed\n');
      expect(readFileSync(join(path, 'notes.txt'), 'utf8')).toBe('untracked\n');
      expect(gitState(clone)).toEqual(before);
      expect(await isListed(path)).toBe(true);

      await startDeletion(page, path);
      await deleteDialog(page, 'Delete dirty-ws?').getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
      const again = deleteDialog(page, 'dirty-ws has uncommitted changes');
      await again.waitFor({ timeout: UI_TIMEOUT });
      await again.getByRole('button', { name: 'Delete anyway', exact: true }).click({ timeout: UI_TIMEOUT });
      await again.waitFor({ state: 'hidden', timeout: 15_000 });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      // No commit outside its base: the branch goes too (AC16).
      expect(localBranches(clone)).not.toContain('dirty-ws');
    });

    test('AC18 — "Delete anyway" on a workspace whose branch has unmerged commits removes the worktree, keeps the branch and says so (AC17)', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('dirty-kept');
      gitIn(path, 'commit', '--allow-empty', '-m', 'unmerged work');
      writeFileSync(join(path, 'notes.txt'), 'untracked\n');
      const commit = gitIn(path, 'rev-parse', 'HEAD');

      await startDeletion(page, path);
      await deleteDialog(page, 'Delete dirty-kept?').getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
      const warning = deleteDialog(page, 'dirty-kept has uncommitted changes');
      await warning.waitFor({ timeout: UI_TIMEOUT });
      await warning.getByRole('button', { name: 'Delete anyway', exact: true }).click({ timeout: UI_TIMEOUT });
      await warning.waitFor({ state: 'hidden', timeout: 15_000 });
      const message = 'Branch dirty-kept was kept: it is not merged.';
      await waitForLine(page, message);
      await waitUnlisted(path);

      expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(localBranches(clone)).toContain('dirty-kept');
      expect(gitIn(clone.root, 'rev-parse', 'dirty-kept')).toBe(commit);
    });

    test('AC19 — a deletion git refuses (locked worktree) keeps the dialog open with the error message and the workspace listed', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('locked-ws');
      gitIn(clone.root, 'worktree', 'lock', '--reason', 'kept for a test', path);
      const before = gitState(clone);

      try {
        await startDeletion(page, path);
        const dialog = deleteDialog(page, 'Delete locked-ws?');
        await dialog.waitFor({ timeout: UI_TIMEOUT });
        const linesBefore = await linesOf(dialog);
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
        const message = await waitForDialogLine(dialog, (line) => !linesBefore.includes(line) && /lock/i.test(line));
        expect(message.length).toBeGreaterThan(0);
        await sleep(300);

        expect(await dialog.isVisible()).toBe(true);
        expect(await dialog.innerText()).toContain('Delete locked-ws?');
        expect(existsSync(path)).toBe(true);
        expect(gitState(clone)).toEqual(before);
        expect(await isListed(path)).toBe(true);
        await dismissDialogs(page);
      } finally {
        gitIn(clone.root, 'worktree', 'unlock', path);
      }
    });

    test('AC10, AC11 — workspaces added outside the app are listed under their project in git order, by branch or folder name, titled with their path; a focus event or a reload lists new ones', async () => {
      const { page } = session;
      await clearProjects();

      const external = makeLightRepo('ws-external');
      folders.push(external);
      const add = (...args: string[]) => gitIn(external.root, 'worktree', 'add', '--quiet', ...args);
      add('-b', 'topic-a', join(external.parent, 'wt-a'));
      add('--detach', join(external.parent, 'detached-folder'));
      add('-b', 'topic/b', join(external.parent, 'wt-b'));
      const expectedRows = () => linkedWorktrees(external).map((worktree) => ({ title: worktree.path, name: worktree.branch ?? basename(worktree.path) }));
      expect(expectedRows()).toHaveLength(3);
      expect(expectedRows().map((row) => row.name).sort()).toEqual(['detached-folder', 'topic-a', 'topic/b']);

      await addRepository(session, external);
      await waitForEntries(page, [external.root, ...expectedRows().map((row) => row.title)]);
      const entries = await sidebarEntries(page);
      expect(entries[0]!.text).toContain(external.name);
      expectedRows().forEach((row, index) => {
        expect(entries[index + 1]!.title).toBe(row.title);
        expect(entries[index + 1]!.text).toContain(row.name);
      });
      expect(await isBelowProjectsHeader(page, { title: expectedRows()[0]!.title })).toBe(true);

      // AC11: the focus event.
      const lateFocus = join(external.parent, 'late-focus');
      add('-b', 'late-focus', lateFocus);
      await sleep(500);
      expect(await isListed(lateFocus), 'the list does not refresh by itself').toBe(false);
      await dispatchFocus(page);
      await waitForEntries(page, [external.root, ...expectedRows().map((row) => row.title)]);
      expect(await isListed(lateFocus)).toBe(true);

      // AC11: a reload.
      const lateReload = join(external.parent, 'late-reload');
      add('-b', 'late-reload', lateReload);
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitForEntries(page, [external.root, ...expectedRows().map((row) => row.title)]);
      expect(await isListed(lateReload)).toBe(true);

      await removeThroughMenu(page, external.root);
      await waitForEntries(page, []);
      expect(existsSync(lateReload), 'removing a project deletes no worktree').toBe(true);
    });

    test('AC12, AC8 — a project whose folder is gone stays listed with a muted "<path> is not a git repository." and no workspace, logs no error, offers an unusable New workspace dialog and can be removed', async () => {
      const { page } = session;
      await clearProjects();
      const vanishing = makeLightRepo('ws-vanishing');
      folders.push(vanishing);
      await addRepository(session, vanishing);
      const mark = await errorMark(session);

      rmSync(vanishing.parent, { recursive: true, force: true });
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      const line = `${vanishing.root} is not a git repository.`;
      await waitForLine(page, line);

      expect(await entryTitles(page)).toEqual([vanishing.root]);
      expect((await sidebarEntries(page))[0]!.text).toContain(vanishing.name);
      expect(await isBelowProjectsHeader(page, { text: line })).toBe(true);
      expect(await colorOfLine(page, line), 'the line is muted').toBe(await mutedColor(page));
      expect(projectsInState(session.dataDir)).toContainEqual({ path: vanishing.root });

      // AC8: listing the branches fails, the dialog says so and "Create" stays disabled.
      const dialog = await openNewWorkspaceDialog(page, vanishing);
      const linesNow = await waitForDialogLine(dialog, (found) => found.includes(vanishing.root));
      expect(linesNow.length).toBeGreaterThan(0);
      await nameField(dialog).fill('anything');
      expect(await createButton(dialog).isDisabled()).toBe(true);
      await dismissDialogs(page);

      await removeThroughMenu(page, vanishing.root);
      await waitForEntries(page, []);
      await poll(() => projectsInState(session.dataDir), (projects) => Array.isArray(projects) && projects.length === 0, UI_TIMEOUT);
      expect(projectsInState(session.dataDir)).toEqual([]);
      await expectNoNewErrors(session, mark);
    });

    test.runIf(mode === 'built app')('AC13 — with 30 projects the Projects header and the footer stay in the window and the list scrolls to its last entry', async () => {
      const { page } = session;
      await clearProjects();
      const repos = Array.from({ length: 30 }, (_, index) => makeLightRepo(`crowded-${String(index).padStart(2, '0')}`));
      folders.push(...repos);
      const last = repos[29]!;
      // A workspace under the last project: the list ends with its row once workspaces are listed.
      gitIn(last.root, 'worktree', 'add', '--quiet', '-b', 'last-workspace', join(last.parent, 'last-workspace'));
      const addApi = () =>
        page.evaluate(() => (globalThis as unknown as { api: { projects: { add(): Promise<unknown> } } }).api.projects.add());
      for (const repo of repos) {
        await stubPicker(session, repo.root);
        await addApi();
      }
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await poll(() => entryTitles(page), (titles) => titles.includes(last.root), UI_TIMEOUT);
      expect((await entryTitles(page)).filter((title) => repos.some((repo) => repo.root === title))).toHaveLength(30);

      const layout = await page.evaluate(
        ({ footerText }) => {
          const all = [...document.querySelectorAll('aside *')] as HTMLElement[];
          const deepest = (matches: (element: HTMLElement) => boolean) =>
            all.filter(matches).filter((element) => !all.some((other) => other !== element && element.contains(other) && matches(other)))[0];
          const header = deepest((element) => (element.textContent ?? '').trim() === 'Projects');
          const footer = deepest((element) => (element.textContent ?? '').trim() === footerText);
          // The last entry of the list, a workspace row when there is one.
          const lastEntry = all.filter((element) => element.hasAttribute('title')).at(-1);
          if (!header || !footer || !lastEntry) return null;
          let scroller: HTMLElement | null = lastEntry.parentElement;
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
            scroller = scroller.parentElement;
          }
          const rect = (element: Element) => {
            const { top, bottom } = element.getBoundingClientRect();
            return { top, bottom };
          };
          const before = { header: rect(header), footer: rect(footer), last: rect(lastEntry) };
          lastEntry.scrollIntoView({ block: 'end' });
          const after = { header: rect(header), footer: rect(footer), last: rect(lastEntry) };
          return {
            innerHeight: window.innerHeight,
            scrollable: scroller ? { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollTop: scroller.scrollTop } : null,
            before,
            after,
          };
        },
        { footerText: versionLabel },
      );

      expect(layout, 'the header, the footer and the last entry are in the sidebar').not.toBeNull();
      const { innerHeight, scrollable, before, after } = layout!;
      for (const [name, rects] of Object.entries({ before, after })) {
        expect(rects.header.top, `${name}: header top`).toBeGreaterThanOrEqual(0);
        expect(rects.header.bottom, `${name}: header bottom`).toBeLessThanOrEqual(innerHeight);
        expect(rects.footer.top, `${name}: footer top`).toBeGreaterThanOrEqual(0);
        expect(rects.footer.bottom, `${name}: footer bottom`).toBeLessThanOrEqual(innerHeight);
      }
      expect(scrollable, 'a scrollable container holds the list').not.toBeNull();
      expect(scrollable!.scrollHeight).toBeGreaterThan(scrollable!.clientHeight);
      expect(scrollable!.scrollTop, 'the list scrolled to its last entry').toBeGreaterThan(0);
      expect(after.last.bottom).toBeLessThanOrEqual(after.footer.top + 1);
      expect(after.last.top).toBeGreaterThanOrEqual(after.header.bottom - 1);

      // Leaves the session as it was.
      for (const repo of repos) {
        await page.evaluate(
          (path) => (globalThis as unknown as { api: { projects: { remove(path: string): Promise<void> } } }).api.projects.remove(path),
          repo.root,
        );
      }
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitForEntries(page, []);
    }, 120_000);
  });

  // Setup and teardown scripts of a workspace (COCKPIT-32): the repository's `.cockpit/config.json`
  // is rewritten by each test. The commands call the scripts `writeScripts` keeps in the main
  // working tree and wait on marker files the test creates, so a test decides when a command ends.
  // The tests share the session, with no agent (the setup that starts one is in `sessions: built app`).
  describe.runIf(full)('workspace scripts', () => {
    let repo: TempRepo;
    const folders: TempRepo[] = [];

    beforeAll(async () => {
      repo = makeLightRepo('ws-scripts');
      folders.push(repo);
      writeScripts(repo);
      await session.page.getByText(versionLabel).waitFor();
      await addRepository(session, repo);
    });

    afterEach(async () => {
      const { page } = session;
      const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
      for (let attempt = 0; attempt < 4; attempt++) {
        const open = await overlays.count();
        if (open === 0) break;
        await page.keyboard.press('Escape');
        await poll(() => overlays.count(), (count) => count < open, 1_000);
      }
    });

    afterAll(async () => {
      try {
        await session.page.evaluate(async () => {
          const { projects } = (globalThis as unknown as { api: { projects: { list(): Promise<{ path: string }[]>; remove(path: string): Promise<void> } } }).api;
          for (const project of await projects.list()) await projects.remove(project.path);
        });
        await session.page.reload();
        await session.page.getByText(versionLabel).waitFor();
        await waitForEntries(session.page, []);
      } finally {
        for (const folder of folders) rmSync(folder.parent, { recursive: true, force: true });
      }
    });

    const isListed = async (path: string) => (await entryTitles(session.page)).includes(path);
    const waitListed = (path: string) => poll(() => isListed(path), Boolean, UI_TIMEOUT);
    const waitUnlisted = (path: string) => poll(() => isListed(path), (listed) => !listed, UI_TIMEOUT);

    // A workspace made with git itself (no setup), listed once the window gains the focus.
    async function addExternal(name: string): Promise<string> {
      const path = join(repo.parent, `wt-${name}`);
      gitIn(repo.root, 'worktree', 'add', '--quiet', '-b', name, path, 'main');
      await dispatchFocus(session.page);
      await waitListed(path);
      return path;
    }

    // Creates a workspace through the dialog (the base is the preselected one).
    async function createWorkspace(name: string) {
      const { page } = session;
      const dialog = await openNewWorkspaceDialog(page, repo);
      await fillNewWorkspace(page, dialog, { name });
      await createButton(dialog).click({ timeout: UI_TIMEOUT });
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
      return worktreePath(session, repo, name);
    }

    // Opens the deletion dialog of a workspace and confirms it.
    async function confirmDeletion(path: string) {
      const { page } = session;
      await startDeletion(page, path);
      const dialog = openDialogs(page);
      await dialog.first().waitFor({ timeout: UI_TIMEOUT });
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
      return dialog;
    }

    const records = (file: string) => readRecords(repo, file);
    const linesIn = (file: string) => {
      const path = join(repo.root, file);
      return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
    };

    test('AC1, AC2, AC4 — Create opens the setup page: each command after a "$ <command>" line, in order, in the worktree with the login-shell environment; the Setup link shows Running then Done, Home and back keeps the terminal and the process, and the page ends on "Setup finished" with no button', async () => {
      const { page } = session;
      const record = 'sh "$COCKPIT_ROOT_PATH/record.sh" setup-env.txt';
      const wait = 'sh "$COCKPIT_ROOT_PATH/waitfor.sh" go-ok';
      writeConfig(repo, { setup: [record, 'echo second-output', wait] });

      const path = await createWorkspace('setup-ok');

      await setupHeading(page, 'setup-ok').waitFor({ timeout: UI_TIMEOUT });
      expect(new URL(page.url()).pathname).toBe('/setup');
      await waitListed(path);
      expect(existsSync(path)).toBe(true);
      await waitForRow(page, `$ ${wait}`);
      const rows = await terminalRows(page);
      const at = (row: string) => rows.indexOf(row);
      expect(at(`$ ${record}`)).toBeGreaterThanOrEqual(0);
      expect(at(`$ ${record}`)).toBeLessThan(at('$ echo second-output'));
      expect(rows[at('$ echo second-output') + 1]).toBe('second-output');
      expect(at('$ echo second-output')).toBeLessThan(at(`$ ${wait}`));
      expect(await waitForSetupStatus(page, path, 'Running')).toBe('Running');

      // The environment the first command saw.
      const [env] = await poll(() => records('setup-env.txt'), (found) => found.length > 0, UI_TIMEOUT);
      expect(env!.root).toBe(repo.root);
      expect(env!.ws).toBe(path);
      expect(env!.name).toBe('setup-ok');
      expect(env!.term).toBe('xterm-256color');
      expect(env!.pwd).toBe(path);
      expect(normalizeFnm(env!.path!)).toBe(normalizeFnm(await getShellPath(page)));
      expect(records('setup-env.txt')).toHaveLength(1);

      // Home and back through the link: the same terminal, and the process was not interrupted.
      const pid = await startedWaiter(repo, 'go-ok');
      await goHome(page);
      expect(await setupLinkStatus(page, path)).toBe('Running');
      await openSetupLink(page, path);
      await setupHeading(page, 'setup-ok').waitFor({ timeout: UI_TIMEOUT });
      await waitForRow(page, 'second-output');
      expect(waiters(repo, 'go-ok')).toEqual([pid]);
      expect(isAlive(pid)).toBe(true);

      // AC4: it finishes, the page stays with its status and no button.
      release(repo, 'go-ok');
      await page.getByText('Setup finished').waitFor({ timeout: UI_TIMEOUT });
      expect(await waitForSetupStatus(page, path, 'Done')).toBe('Done');
      expect(await retryButton(page).count()).toBe(0);
      expect(await startAnywayButton(page).count()).toBe(0);
      expect(await setupHeading(page, 'setup-ok').isVisible()).toBe(true);
      expect(waiters(repo, 'go-ok')).toEqual([]);
    }, 60_000);

    test('AC9 — a failing setup with no agent shows the output, "Setup failed with exit code N" and Retry setup only; the commands after it do not run, and a retry that exits 0 shows "Setup finished" on the same page', async () => {
      const { page } = session;
      writeConfig(repo, { setup: ['echo before-failure', 'test -f "$COCKPIT_ROOT_PATH/ok9" || exit 4', 'echo after-failure'] });

      const path = await createWorkspace('retry-ok');

      await setupHeading(page, 'retry-ok').waitFor({ timeout: UI_TIMEOUT });
      await page.getByText('Setup failed with exit code 4').waitFor({ timeout: UI_TIMEOUT });
      expect(await retryButton(page).count()).toBe(1);
      expect(await startAnywayButton(page).count()).toBe(0);
      await waitForRow(page, 'before-failure');
      expect(await terminalRows(page)).not.toContain('after-failure');
      expect(await waitForSetupStatus(page, path, 'Failed')).toBe('Failed');
      expect(existsSync(path)).toBe(true);
      expect(await isListed(path)).toBe(true);

      writeFileSync(join(repo.root, 'ok9'), '');
      await retryButton(page).click({ timeout: UI_TIMEOUT });
      await page.getByText('Setup finished').waitFor({ timeout: UI_TIMEOUT });
      expect(await waitForSetupStatus(page, path, 'Done')).toBe('Done');
      expect(await retryButton(page).count()).toBe(0);
      expect(await setupHeading(page, 'retry-ok').isVisible()).toBe(true);
    });

    test('AC10 — a config that readWorkspaceConfig refuses keeps the workspace and shows its error message in place of the output, with Retry setup; once the file is fixed, Retry setup runs the setup', async () => {
      const { page } = session;
      writeConfig(repo, { run: ['bun dev'] });

      const path = await createWorkspace('bad-config');

      await setupHeading(page, 'bad-config').waitFor({ timeout: UI_TIMEOUT });
      // The message is the one the IPC call answers (and it names the file and the key at fault).
      const refused = await runCommandsApi(page, repo.root, path, 'setup');
      expect(refused.status).toBe('refused');
      expect(refused.message).toContain('config.json');
      await page.getByText(refused.message!).first().waitFor({ timeout: UI_TIMEOUT });
      expect(await page.getByText('Setup failed with exit code').count()).toBe(0);
      expect(await visiblePanes(page)).toHaveLength(0);
      expect(await retryButton(page).count()).toBe(1);
      expect(await startAnywayButton(page).count()).toBe(0);
      expect(await waitForSetupStatus(page, path, 'Failed')).toBe('Failed');
      expect(existsSync(path)).toBe(true);
      expect(await isListed(path)).toBe(true);

      writeConfig(repo, { setup: ['echo fixed-config'] });
      await retryButton(page).click({ timeout: UI_TIMEOUT });
      await page.getByText('Setup finished').waitFor({ timeout: UI_TIMEOUT });
      await waitForRow(page, '$ echo fixed-config');
      expect(await waitForSetupStatus(page, path, 'Done')).toBe('Done');
    });

    test('AC12 — deleting a workspace, or removing its project, ends its running setup and removes its Setup link', async () => {
      const { page } = session;
      writeConfig(repo, { setup: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-a'] });
      const pathA = await createWorkspace('end-a');
      await waitForSetupStatus(page, pathA, 'Running');
      writeConfig(repo, { setup: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-b'] });
      const pathB = await createWorkspace('end-b');
      await waitForSetupStatus(page, pathB, 'Running');
      const pidA = await startedWaiter(repo, 'never-a');
      const pidB = await startedWaiter(repo, 'never-b');

      // The workspace is deleted.
      await goHome(page);
      const dialog = await confirmDeletion(pathA);
      await dialog.first().waitFor({ state: 'hidden', timeout: 15_000 });
      await waitUnlisted(pathA);
      expect(await endsWithin(pidA)).toBe(true);
      expect(await setupLinkStatus(page, pathA)).toBeNull();
      // The other one runs on.
      expect(isAlive(pidB)).toBe(true);
      expect(await setupLinkStatus(page, pathB)).toBe('Running');

      // Its project is removed.
      await removeThroughMenu(page, repo.root);
      await waitForEntries(page, []);
      expect(await endsWithin(pidB)).toBe(true);
      expect(await setupLinkCount(page)).toBe(0);

      // Added again, the workspace is listed without a link.
      await addRepository(session, repo);
      await waitListed(pathB);
      expect(await setupLinkStatus(page, pathB)).toBeNull();
      expect(await setupLinkCount(page)).toBe(0);
    }, 60_000);

    test('AC12 — a reload ends the running setup and drops its link and output: /setup for that workspace shows "No setup ran for this workspace in this window."', async () => {
      const { page } = session;
      writeConfig(repo, { setup: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-c'] });
      const path = await createWorkspace('end-c');
      await waitForSetupStatus(page, path, 'Running');
      const pid = await startedWaiter(repo, 'never-c');

      await page.reload();
      await page.getByText('No setup ran for this workspace in this window.').waitFor({ timeout: UI_TIMEOUT });

      expect(new URL(page.url()).pathname).toBe('/setup');
      expect(await endsWithin(pid)).toBe(true);
      await waitListed(path);
      expect(await setupLinkStatus(page, path)).toBeNull();
      expect(await setupLinkCount(page)).toBe(0);
      expect(await visiblePanes(page)).toHaveLength(0);
    }, 60_000);

    // The two cases run right after a reload test, so the sidebar holds no Setup link before them.
    test.each([
      ['no config file', undefined],
      ['a config without setup commands', { teardown: ['echo only-teardown'] }],
    ])('AC11 — with %s, Create closes the dialog as before: no setup page opens and no Setup link appears', async (label, config) => {
      const { page } = session;
      await goHome(page);
      if (config) writeConfig(repo, config);
      else rmSync(join(repo.root, '.cockpit'), { recursive: true, force: true });
      const name = config ? 'no-setup-teardown-only' : 'no-setup-no-config';

      const path = await createWorkspace(name);

      await waitListed(path);
      expect(existsSync(path)).toBe(true);
      expect(new URL(page.url()).pathname, label).not.toBe('/setup');
      expect(await setupHeading(page, name).count()).toBe(0);
      expect(await setupLinkStatus(page, path)).toBeNull();
      expect(await setupLinkCount(page)).toBe(0);
    });

    test('AC13, AC17 — Delete runs the teardown in a terminal of the dialog (shell, order, environment, worktree as cwd), and once it exits 0 the folder, the worktree, the branch and the row go', async () => {
      const { page } = session;
      const record = 'sh "$COCKPIT_ROOT_PATH/record.sh" teardown-env.txt';
      const wait = 'sh "$COCKPIT_ROOT_PATH/waitfor.sh" go-td';
      writeConfig(repo, { teardown: [record, 'echo teardown-second', wait] });
      const path = await addExternal('td-ok');

      const dialog = await confirmDeletion(path);
      const pane = await dialogTerminal(page);
      await waitForRow(page, `$ ${wait}`, pane);
      const rows = await rowsOf(pane);
      const at = (row: string) => rows.indexOf(row);
      expect(at(`$ ${record}`)).toBeGreaterThanOrEqual(0);
      expect(at(`$ ${record}`)).toBeLessThan(at('$ echo teardown-second'));
      expect(rows[at('$ echo teardown-second') + 1]).toBe('teardown-second');
      expect(at('$ echo teardown-second')).toBeLessThan(at(`$ ${wait}`));
      // Nothing is removed while the teardown runs.
      expect(existsSync(path)).toBe(true);
      expect(await isListed(path)).toBe(true);
      expect(await dialog.first().isVisible()).toBe(true);

      release(repo, 'go-td');
      await dialog.first().waitFor({ state: 'hidden', timeout: 15_000 });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(repo).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(repo)).not.toContain('td-ok');
      const found = records('teardown-env.txt');
      expect(found).toHaveLength(1);
      expect(found[0]!.root).toBe(repo.root);
      expect(found[0]!.ws).toBe(path);
      expect(found[0]!.name).toBe('td-ok');
      expect(found[0]!.term).toBe('xterm-256color');
      expect(found[0]!.pwd).toBe(path);
      expect(normalizeFnm(found[0]!.path!)).toBe(normalizeFnm(await getShellPath(page)));
    }, 60_000);

    test('AC14 — a failing teardown keeps the worktree and the row and shows the output, "Teardown failed with exit code N" and Delete anyway, which removes the workspace (an unmerged branch is kept and says so) without running the teardown again', async () => {
      const { page } = session;
      writeConfig(repo, { teardown: ['echo td-fail-output', 'echo ran >> "$COCKPIT_ROOT_PATH/td14.log"; exit 5'] });
      const path = await addExternal('td-fail');
      gitIn(path, 'commit', '--allow-empty', '-m', 'unmerged work');

      const dialog = await confirmDeletion(path);
      await dialog.getByText('Teardown failed with exit code 5').waitFor({ timeout: UI_TIMEOUT });
      expect(await rowsOf(await dialogTerminal(page))).toContain('td-fail-output');
      expect(await dialog.getByRole('button', { name: 'Delete anyway', exact: true }).count()).toBe(1);
      expect(existsSync(path)).toBe(true);
      expect(await isListed(path)).toBe(true);
      expect(linesIn('td14.log')).toHaveLength(1);

      await dialog.getByRole('button', { name: 'Delete anyway', exact: true }).click({ timeout: UI_TIMEOUT });
      await dialog.first().waitFor({ state: 'hidden', timeout: 15_000 });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(repo).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(repo)).toContain('td-fail');
      await waitForLine(page, 'Branch td-fail was kept: it is not merged.');
      expect(linesIn('td14.log')).toHaveLength(1);
    }, 60_000);

    test('AC15 — after a teardown that exited 0, the uncommitted-changes step does not run it a second time', async () => {
      const { page } = session;
      writeConfig(repo, { teardown: ['echo ran >> "$COCKPIT_ROOT_PATH/td15.log"'] });
      const path = await addExternal('td-dirty');
      writeFileSync(join(path, 'notes.txt'), 'untracked\n');

      await confirmDeletion(path);
      const warning = deleteDialog(page, 'td-dirty has uncommitted changes');
      await warning.waitFor({ timeout: UI_TIMEOUT });
      expect(linesIn('td15.log')).toHaveLength(1);
      expect(existsSync(path)).toBe(true);

      await warning.getByRole('button', { name: 'Delete anyway', exact: true }).click({ timeout: UI_TIMEOUT });
      await warning.waitFor({ state: 'hidden', timeout: 15_000 });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linesIn('td15.log')).toHaveLength(1);
    });

    test('AC15 — Escape on a running teardown ends its process and keeps the workspace', async () => {
      const { page } = session;
      writeConfig(repo, { teardown: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-td'] });
      const path = await addExternal('td-cancel');

      const dialog = await confirmDeletion(path);
      const pid = await startedWaiter(repo, 'never-td');

      await page.keyboard.press('Escape');
      await dialog.first().waitFor({ state: 'hidden', timeout: UI_TIMEOUT });

      expect(await endsWithin(pid)).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(linkedWorktrees(repo).map((worktree) => worktree.path)).toContain(path);
      expect(localBranches(repo)).toContain('td-cancel');
      expect(await isListed(path)).toBe(true);
    });

    test('AC14 — Ctrl+C in the teardown terminal is a failure: "Teardown ended before it finished." with Delete anyway, and the worktree and the row stay', async () => {
      const { page } = session;
      writeConfig(repo, { teardown: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-sig-td'] });
      const path = await addExternal('td-signal');

      const dialog = await confirmDeletion(path);
      const pid = await startedWaiter(repo, 'never-sig-td');
      await focusPane(await dialogTerminal(page));
      await page.keyboard.press('Control+c');

      await dialog.getByText('Teardown ended before it finished.').waitFor({ timeout: UI_TIMEOUT });
      expect(await endsWithin(pid)).toBe(true);
      expect(await dialog.getByRole('button', { name: 'Delete anyway', exact: true }).count()).toBe(1);
      expect(existsSync(path)).toBe(true);
      expect(linkedWorktrees(repo).map((worktree) => worktree.path)).toContain(path);
      expect(localBranches(repo)).toContain('td-signal');
      expect(await isListed(path)).toBe(true);
    });

    test('AC16 — a config readWorkspaceConfig refuses removes nothing on Delete and shows its message with Delete anyway, which removes the workspace', async () => {
      writeConfig(repo, { run: ['bun dev'] });
      const path = await addExternal('td-bad');
      const { page } = session;
      const refused = await runCommandsApi(page, repo.root, path, 'teardown');
      expect(refused.status).toBe('refused');

      const dialog = await confirmDeletion(path);
      await dialog.getByText(refused.message!).first().waitFor({ timeout: UI_TIMEOUT });
      expect(await dialog.getByRole('button', { name: 'Delete anyway', exact: true }).count()).toBe(1);
      expect(existsSync(path)).toBe(true);
      expect(localBranches(repo)).toContain('td-bad');
      expect(await isListed(path)).toBe(true);

      await dialog.getByRole('button', { name: 'Delete anyway', exact: true }).click({ timeout: UI_TIMEOUT });
      await dialog.first().waitFor({ state: 'hidden', timeout: 15_000 });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(localBranches(repo)).not.toContain('td-bad');
    });

    test('AC18 — workspaces.runCommands refuses a project that is not in Cockpit and a path that is not one of its linked worktrees, and spawns nothing', async () => {
      const { page } = session;
      writeConfig(repo, { setup: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-18'], teardown: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-18'] });
      const elsewhere = join(repo.parent, 'not-a-worktree');
      mkdirSync(elsewhere);

      for (const which of ['setup', 'teardown'] as const) {
        expect(await runCommandsApi(page, '/no/such/project', '/no/such/project/ws', which)).toEqual({
          status: 'refused',
          message: '/no/such/project is not a project in Cockpit.',
        });
        expect(await runCommandsApi(page, repo.root, elsewhere, which)).toEqual({
          status: 'refused',
          message: `${elsewhere} is not a workspace of ${repo.name}.`,
        });
        // The main working tree is the project, not a workspace.
        expect(await runCommandsApi(page, repo.root, repo.root, which)).toEqual({
          status: 'refused',
          message: `${repo.root} is not a workspace of ${repo.name}.`,
        });
      }

      // The daemon answers in order: once it ran a probe shell it has handled any spawn the calls would have sent.
      await ptyHostPid(page);
      expect(waiters(repo, 'never-18')).toEqual([]);
    });
  });

  // One smoke path per feature in the modes that do not run its full block: it
  // goes through the IPC end to end, with the same helpers as the full blocks.
  // In the launchd-environment mode these are the paths that spawn git.
  describe.runIf(!full)('smoke paths', () => {
    const folders: TempRepo[] = [];

    afterAll(() => {
      for (const folder of folders) rmSync(folder.parent, { recursive: true, force: true });
    });

    test.runIf(mode === 'dev server')(
      'single instance smoke path (AC1, AC2) — a second `bun run dev` on the same data folder exits with code 0 and the running app shows and focuses its window',
      async () => {
        await stubFocus(session);
        await clearFocusCalls(session);
        const before = stateSnapshot(session.dataDir);
        const env = launchEnv(true, session.dataDir, { ...process.env, SHELL: '/bin/sh' }, session.cockpitHome).env;

        const second = await runSecondLaunch(
          'bun',
          ['run', 'dev', '--remoteDebuggingPort', String(await freePort()), '--inspect', String(await freePort())],
          env,
          60_000,
        );

        expect(second.exit, `the second dev launch exited (output: ${second.output})`).toEqual({ code: 0, signal: null });
        expect([...new Set(await frontCalls(session))].sort()).toEqual(FRONT_CALLS);
        expect(stateSnapshot(session.dataDir)).toEqual(before);
        expect(session.isRunning()).toBe(true);
        expect(front.pids.has(session.pid)).toBe(false);
      },
      120_000,
    );

    test('smoke path (a) — projects: a repository added through the picker is listed and stored, then removed through the "…" menu and left on disk', async () => {
      const { page } = session;
      const repo = makeRepo('smoke-project');
      folders.push(repo);
      await page.getByText(versionLabel).waitFor();
      expect(await entryTitles(page)).toEqual([]);

      await addProject(session, repo.root);
      await waitForEntries(page, [repo.root]);
      expect((await sidebarEntries(page))[0]!.text).toContain(repo.name);
      await poll(() => projectsInState(session.dataDir), (projects) => Array.isArray(projects) && projects.length > 0, UI_TIMEOUT);
      expect(projectsInState(session.dataDir)).toEqual([{ path: repo.root }]);

      const onDisk = snapshotRepo(repo);
      await removeThroughMenu(page, repo.root);
      await waitForEntries(page, []);
      await poll(() => projectsInState(session.dataDir), (projects) => Array.isArray(projects) && projects.length === 0, UI_TIMEOUT);
      expect(projectsInState(session.dataDir)).toEqual([]);
      expect(snapshotRepo(repo)).toEqual(onDisk);
      expect(onDisk.hasGit).toBe(true);
    });

    test('smoke path (b), workspace scripts AC19 — workspaces: "New workspace…" creates a worktree under COCKPIT_HOME from the preselected base main and lists it, its setup writes the login-shell PATH and the worktree path and the setup page shows "Setup finished"; "Delete workspace…" runs the teardown, then removes the folder, the worktree, the branch and the row', async () => {
      const { page } = session;
      const repo = makeRepo('smoke-workspace');
      folders.push(repo);
      const branch = 'smoke-ws';
      writeConfig(repo, {
        setup: ['printf \'%s\\n\' "$PATH" "$(pwd -P)" > "$COCKPIT_ROOT_PATH/setup-out.txt"'],
        teardown: ['touch "$COCKPIT_ROOT_PATH/teardown-ran"'],
      });
      await addRepository(session, repo);
      const path = worktreePath(session, repo, branch);

      const dialog = await openNewWorkspaceDialog(page, repo);
      await poll(() => selectedBase(dialog), (value) => value === 'main', UI_TIMEOUT);
      await nameField(dialog).fill(branch);
      await createButton(dialog).click({ timeout: UI_TIMEOUT });
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
      await waitForEntries(page, [repo.root, path]);

      expect(existsSync(join(path, 'README.md'))).toBe(true);
      expect(linkedWorktrees(repo)).toContainEqual({ path, branch });
      expect(localBranches(repo)).toContain(branch);

      // The setup ran in the worktree with the login shell's PATH, on its page.
      await setupHeading(page, branch).waitFor({ timeout: UI_TIMEOUT });
      await page.getByText('Setup finished').waitFor({ timeout: UI_TIMEOUT });
      expect(await waitForSetupStatus(page, path, 'Done')).toBe('Done');
      const [setupPath, setupCwd] = readFileSync(join(repo.root, 'setup-out.txt'), 'utf8').split('\n');
      expect(normalizeFnm(setupPath!)).toBe(normalizeFnm(await getShellPath(page)));
      expect(setupCwd).toBe(path);

      expect(existsSync(join(repo.root, 'teardown-ran'))).toBe(false);
      await startDeletion(page, path);
      const confirm = deleteDialog(page, `Delete ${branch}?`);
      await confirm.waitFor({ timeout: UI_TIMEOUT });
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
      await confirm.waitFor({ state: 'hidden', timeout: 15_000 });
      await waitForEntries(page, [repo.root]);

      expect(existsSync(join(repo.root, 'teardown-ran'))).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(repo)).toEqual([]);
      expect(localBranches(repo)).not.toContain(branch);

      await removeThroughMenu(page, repo.root);
      await waitForEntries(page, []);
      expect(projectsInState(session.dataDir)).toEqual([]);
    });
  });

  test('logs no error and keeps running', async () => {
    const { page } = session;
    expect(await allConsoleErrorsOf(page)).toEqual([]);
    expect(await allPageErrorsOf(page)).toEqual([]);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(session.isRunning()).toBe(true);
    // Still never the frontmost app, after every check above.
    expect(front.pids.has(session.pid)).toBe(false);
  });

  // A navigation away from the app, scripted from the page (a real Finder drop
  // cannot be produced over CDP), must change nothing: same URL, same page, same
  // shell. Not run in the launchd-environment mode (it runs the developer's real shell).
  describe.runIf(inIsolatedShell)('navigations away from the app', () => {
    // The file:// URL of a file that exists.
    const existingFileUrl = pathToFileURL(import.meta.filename).href;

    // The console messages and page errors of earlier tests are not this
    // suite's business, and its own (Chromium's refusal of the file:// URL) must
    // not reach the tests that follow.
    beforeAll(async () => {
      await session.page.clearConsoleMessages();
      await session.page.clearPageErrors();
    });
    afterAll(async () => {
      await session.page.clearConsoleMessages();
      await session.page.clearPageErrors();
    });

    // The main process's `will-navigate` events, recorded through the inspector. The app's
    // own guard listens first, so `prevented` tells whether it refused the URL.
    const watchNavigations = () =>
      session.evaluateInMain(`(() => {
        if (globalThis.__navigations) return;
        globalThis.__navigations = [];
        for (const contents of require('electron').webContents.getAllWebContents()) {
          contents.on('will-navigate', (event, url) => globalThis.__navigations.push({ url, prevented: event.defaultPrevented }));
        }
      })()`);

    // Waits until the attempt has reached its verdict: the main process saw `will-navigate`
    // for the URL and the guard refused it, or, for a `file://` URL that Chromium refuses before any navigation, the
    // console reports the refusal.
    async function waitForAttempt(target: string) {
      const { page } = session;
      const seen =
        new URL(target).protocol === 'file:'
          ? await poll(
              async () => (await allConsoleErrorsOf(page)).includes(`Not allowed to load local resource: ${target}`),
              Boolean,
              UI_TIMEOUT,
            )
          : await poll(
              async () =>
                (await session.evaluateInMain<Array<{ url: string; prevented: boolean }>>('globalThis.__navigations ?? []')).some(
                  ({ url, prevented }) => prevented && new URL(url).href === new URL(target).href,
                ),
              Boolean,
              UI_TIMEOUT,
            );
      expect(seen, `the attempt to navigate to ${target} was seen and refused`).toBe(true);
    }

    // After a navigation attempt Playwright keeps a pending navigation that never
    // commits, and locator waits (`waitFor`, `click`) hang on it: from the attempt
    // on, the page is read and driven through `page.evaluate` and the keyboard only.
    async function attemptNavigation(target: string) {
      const { page } = session;
      await openTerminal(page);
      await watchNavigations();
      const appUrl = await page.evaluate(() => location.href);
      await typeLine(page, 'echo pid-$$');
      const [pid] = (await captureRow(page, /^pid-(\d+)$/)).map(Number);
      expect(isAlive(pid!)).toBe(true);

      try {
        await page.evaluate((url) => {
          location.href = url;
        }, target);
        await waitForAttempt(target);

        expect(await page.evaluate(() => location.href)).toBe(appUrl);
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll('h1, h2, h3, [role="heading"]')].some((heading) => heading.textContent?.trim() === 'Terminal'),
          ),
        ).toBe(true);
        expect(isAlive(pid!)).toBe(true);

        await page.evaluate(() => (document.querySelector('.xterm-helper-textarea') as HTMLElement | null)?.focus());
        await typeLine(page, 'echo cockpit-$((6*7))');
        await waitForRow(page, 'cockpit-42');
      } finally {
        // Load the app page again, whether or not the page left it, so the pending
        // navigation is gone and the next test can click.
        await page.goto(appUrl);
        await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
      }
    }

    test('navigation AC2 — app://other/ leaves the page, its shell and its terminal as they were', async () => {
      await attemptNavigation('app://other/');
    });

    test('navigation AC3 — https://example.com/ leaves the page, its shell and its terminal as they were', async () => {
      await attemptNavigation('https://example.com/');
    });

    test('navigation AC4 — the file:// URL of an existing file leaves the page, its shell and its terminal as they were', async () => {
      await attemptNavigation(existingFileUrl);
    });

    test('navigation AC5 — those attempts log no console error but Chromium refusing the file:// URL they tried, no page error and no main-process error', async () => {
      const { page } = session;
      const errors = await allConsoleErrorsOf(page);
      // Only the refusal of the exact URL of navigation AC4 is allowed (tabs AC12).
      expect(unexpectedConsoleErrors(errors, existingFileUrl)).toEqual([]);
      expect(await allPageErrorsOf(page)).toEqual([]);
      expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
      expect(session.isRunning()).toBe(true);
    });

    // The URL is on the app's origin, so the navigation is allowed, and it ends on
    // an error page. The shell keeps running all the same (COCKPIT-55: only commands
    // terminals end with their page), and the app page shows it again.
    async function expectShellSurvivesNavigationTo(path: string) {
      const { page } = session;
      await openTerminal(page);
      const appUrl = await page.evaluate(() => location.href);
      const pid = await pidOf(page);
      expect(isAlive(pid)).toBe(true);

      try {
        await page
          .evaluate((path) => {
            location.href = new URL(path, location.href).href;
          }, path)
          .catch(() => {});
        // Not ended within the time an ended shell would be gone.
        expect(await endsWithin(pid, 2_000), 'the shell keeps running').toBe(false);
        expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
        expect(session.isRunning()).toBe(true);
      } finally {
        await page.goto(appUrl);
        await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
      }
      expect(isAlive(pid)).toBe(true);
      expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    }

    test.runIf(full)('tabs AC11 — a same-origin navigation to a missing file (a 404) leaves the shell running, with no main-process error', async () => {
      await expectShellSurvivesNavigationTo('/missing.js');
    });

    // The app's protocol handler throws on a malformed percent-encoding
    // (`decodeURIComponent`), so the load fails instead of answering a 404 with a
    // document: the navigation commits an error page, and `did-navigate` is not
    // what the main process hears (a 404 does commit a document, which is why the
    // test above passes without `did-fail-load`).
    test.runIf(full)('tabs AC11 — a same-origin navigation the app cannot serve (error page, no document) leaves the shell running, with no main-process error', async () => {
      await expectShellSurvivesNavigationTo('/%');
    });
  });

  // The host is stopped before the terminal page opens, so the spawn of the first
  // tab's shell cannot resolve while the keys are typed: they must be held, then
  // reach the shell in order. The first tab of a new visit is the one to use: its
  // spawn is sent after the SIGSTOP whatever ran before, and it is the terminal
  // "just opened" of the criterion. It runs before any test that kills the host.
  test.runIf(full)('early keys AC1 — keys typed into a tab before its shell is spawned reach it once the pty host resumes', async () => {
    const { page } = session;
    // The host's pid, from the parent of a shell it runs (as the host-kill test).
    const id = await spawnShell(page);
    await ptyWrite(page, id, 'echo ppid-$PPID\n');
    await waitForOutput(page, id, /ppid-\d+/);
    const hostPid = Number(/ppid-(\d+)/.exec(await outputOf(page, id))![1]);
    expect(hostPid).not.toBe(session.pid);
    await ptyKill(page, id);
    await waitForExit(page, id);

    process.kill(hostPid, 'SIGSTOP');
    let pane: Pane;
    try {
      await openTerminal(page);
      pane = await focusedPane(page);
      await typeLine(page, 'echo early-$((6*7))');
    } finally {
      process.kill(hostPid, 'SIGCONT');
    }

    // The echoed command line shows `$((6*7))`: only the shell prints `early-42`.
    await waitForRow(page, 'early-42', pane);
  });

  // The smoke path of tabs and splits in the dev server and the packaged app (the
  // launchd-environment mode keeps the developer's shell out of the terminal
  // tests): a split in both directions, the focus after "Close terminal", a tab
  // opened and closed, then the pty host killed and a new terminal that runs a
  // command (tabs AC13). The built app runs the full block above (tabs AC5 and AC8
  // cover AC13 there). It kills the pty host last, so nothing runs after it.
  test.runIf(!full && inIsolatedShell)('smoke path (c) — terminal tabs: splits, "Close terminal" gives the focus to the sibling, a closed tab ends its shell, Home and back keeps the shells, and after the pty host dies a new terminal runs commands', async () => {
    const { page } = session;
    await openTerminal(page);
    const a = await focusedPane(page);
    const aPid = await pidOf(page, a);
    const b = await splitPane(page, a, 'right');
    const bPid = await pidOf(page, b);
    const c = await splitPane(page, b, 'down');
    const cPid = await pidOf(page, c);
    expect(new Set([aPid, bPid, cPid]).size).toBe(3);

    // In A | (B / C), closing C: its shell ends, and the keyboard is in B, not A.
    await clickPaneButton(c, 'Close terminal');
    expect(await endsWithin(cPid)).toBe(true);
    await poll(async () => (await visiblePanes(page)).length, (count) => count === 2, UI_TIMEOUT);
    const active = await poll(() => activePane(page), Boolean, UI_TIMEOUT);
    expect(active, 'a visible terminal holds the keyboard focus').not.toBeNull();
    expect(await isSamePane(active!, b), 'the sibling B holds the focus').toBe(true);
    await typeLine(page, 'echo sibling-$((6*7))');
    await waitForRow(page, 'sibling-42', b);
    expect((await rowsOf(a)).join('\n')).not.toContain('echo sibling-');
    expect(isAlive(aPid)).toBe(true);

    // A second tab, then closed: its shell ends, the first tab is selected again.
    await openTab(page);
    const tabPid = await pidOf(page);
    await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 2');
    await closeTab(page, 2);
    await expectTabs(page, ['Terminal 1'], 'Terminal 1');
    expect(await endsWithin(tabPid)).toBe(true);
    expect(isAlive(aPid) && isAlive(bPid)).toBe(true);

    // Home and back (COCKPIT-46): the shells and their output are kept, B still takes a command.
    await goHome(page);
    expect(isAlive(aPid) && isAlive(bPid)).toBe(true);
    await goToTerminalPage(page);
    await expectTabs(page, ['Terminal 1'], 'Terminal 1');
    expect(isAlive(aPid) && isAlive(bPid)).toBe(true);
    expect(await rowsOf(a)).toContain(`pid-${aPid}`);
    expect(await rowsOf(b)).toContain(`pid-${bPid}`);
    await focusPane(b);
    await typeLine(page, 'echo back-$((3*5))');
    await waitForRow(page, 'back-15', b);

    // The pty host dies: the remaining terminals end, and a new terminal runs commands (tabs AC13).
    await killPtyHost(page);
    await waitForRow(page, '[Process ended]', a);
    await waitForRow(page, '[Process ended]', b);
    const fresh = await openTab(page);
    await waitForPrompt(page, fresh);
    await typeLine(page, 'echo cockpit-$((6*7))');
    await waitForRow(page, 'cockpit-42', fresh);
    expect(isAlive(tabPid)).toBe(false);
    await selectTab(page, 1);
    await poll(() => a.isVisible(), Boolean, UI_TIMEOUT);
    expect(await rowsOf(a)).toContain('[Process ended]');
    await expectNoErrors(session);
  });

  // These kill the pty host and rely on the next spawn starting it again, so they
  // come after every test that does not need to.
  test.runIf(full)('tabs AC8 — when the pty host dies every terminal shows [Process ended], and a new tab or a new half runs a shell again', async () => {
    const { page } = session;
    await openTerminal(page);
    const first = await focusedPane(page);
    await pidOf(page, first);
    await openTab(page);
    const second = await focusedPane(page);
    await pidOf(page, second);
    const third = await splitPane(page, second, 'down');
    await pidOf(page, third);

    await killPtyHost(page);

    // Every terminal of every tab: the selected one, then the first tab.
    for (const pane of await visiblePanes(page)) await waitForRow(page, '[Process ended]', pane);
    await selectTab(page, 1);
    await poll(() => first.isVisible(), Boolean, UI_TIMEOUT);
    await waitForRow(page, '[Process ended]', first);

    // A new tab: its shell runs commands.
    const fresh = await openTab(page);
    await waitForPrompt(page, fresh);
    await typeLine(page, 'echo cockpit-$((6*7))');
    await waitForRow(page, 'cockpit-42', fresh);
    await expectTabs(page, ['Terminal 1', 'Terminal 2', 'Terminal 3'], 'Terminal 3');

    // A split of an ended terminal: the new half runs commands, the ended one stays ended.
    await selectTab(page, 1);
    await poll(() => first.isVisible(), Boolean, UI_TIMEOUT);
    const half = await splitPane(page, first, 'right');
    await waitForPrompt(page, half);
    await typeLine(page, 'echo cockpit-$((7*8))');
    await waitForRow(page, 'cockpit-56', half);
    expect(await rowsOf(first)).toContain('[Process ended]');
    expect((await rowsOf(first)).some((row) => row.includes('cockpit-'))).toBe(false);

    await selectTab(page, 2);
    await poll(() => second.isVisible(), Boolean, UI_TIMEOUT);
    for (const pane of await visiblePanes(page)) {
      expect(await rowsOf(pane)).toContain('[Process ended]');
      expect((await rowsOf(pane)).some((row) => row.includes('cockpit-'))).toBe(false);
    }
    await expectNoErrors(session);
  });

  // The pty host is killed here and started again by the next spawn, so the tests
  // that follow work all the same.
  test.runIf(full)('AC4 — survives the pty host being killed, and reports the open sessions as exited (terminal AC10: the open terminal shows [Process ended])', async () => {
    const { page } = session;
    // The terminal page is open with a running shell.
    await openTerminal(page);
    await typeLine(page, 'echo up-$((1+1))');
    await waitForRow(page, 'up-2');

    const id = await spawnShell(page);
    await ptyWrite(page, id, 'echo ppid-$PPID\n');
    await waitForOutput(page, id, /ppid-\d+/);
    const hostPid = Number(/ppid-(\d+)/.exec(await outputOf(page, id))![1]);

    // The host is a process of its own, not the main process.
    expect(hostPid).not.toBe(session.pid);

    process.kill(hostPid, 'SIGKILL');

    await waitForExit(page, id);
    expect(await exitsOf(page, id)).toEqual([{ exitCode: null, signal: null }]);
    await waitForRow(page, '[Process ended]');
    await page.getByRole('heading', { name: 'Terminal' }).waitFor();
    await page.getByText(versionLabel).waitFor();
    expect(session.isRunning()).toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(await page.pageErrors()).toEqual([]);
    expect(await consoleErrorsOf(page)).toEqual([]);
  });

  // That the old ids stay inert is a unit test (packages/pty).
  test.runIf(full)('tabs AC9 — once the pty host is dead, spawn resolves with an id no session used', async () => {
    const { page } = session;
    // Kills the host (again): `old` is the last session it ran.
    const old = await killPtyHost(page);

    const fresh = await spawnShell(page);
    expect(fresh).toBeGreaterThan(old);

    await ptyKill(page, fresh);
    await waitForExit(page, fresh);
    expect(session.isRunning()).toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(await consoleErrorsOf(page)).toEqual([]);
  });

  // Last of the session on purpose: the refusal must come without any error, and
  // an app that lets the failure through would log one that the "logs no error"
  // checks of the tests above would then report in their place.
  test.runIf(full)('workspaces AC20 — a failing save refuses the add with "Cockpit could not save its data: <error>", lists nothing, leaves state.json as it was and logs no error', async () => {
    const { page } = session;
    const repo = makeLightRepo('ws-save');
    try {
      await page.getByText(versionLabel).waitFor();
      expect(await entryTitles(page)).toEqual([]);
      const mark = await errorMark(session);
      const before = stateSnapshot(session.dataDir);
      const blocker = join(session.dataDir, 'state.json.tmp');
      mkdirSync(blocker);

      try {
        await addProject(session, repo.root);
        const [message] = await poll(
          async () => (await sidebarLines(page)).filter((line) => line.startsWith('Cockpit could not save its data: ')),
          (found) => found.length > 0,
          UI_TIMEOUT,
        );
        await sleep(300);

        expect(message).toBeDefined();
        expect(message!.length).toBeGreaterThan('Cockpit could not save its data: '.length);
        expect(message).toContain('EISDIR');
        expect(await isBelowProjectsHeader(page, { text: message! })).toBe(true);
        expect(await entryTitles(page)).toEqual([]);
        expect(stateSnapshot(session.dataDir)).toEqual(before);
        await expectNoNewErrors(session, mark);
      } finally {
        rmSync(blocker, { recursive: true, force: true });
      }

      // Nothing was kept in memory either: the same add works once the folder is gone.
      await addProject(session, repo.root);
      await waitForEntries(page, [repo.root]);
      expect(projectsInState(session.dataDir)).toEqual([{ path: repo.root }]);
      expect((await sidebarLines(page)).filter((line) => line.startsWith('Cockpit could not save'))).toEqual([]);
      await removeThroughMenu(page, repo.root);
      await waitForEntries(page, []);
    } finally {
      rmSync(repo.parent, { recursive: true, force: true });
    }
  });
});

// The matcher of the navigation tests (tabs AC12): the refusal of the file:// URL
// the test tried is the only console error they allow.
test('tabs AC12 — only the refusal of the exact file:// URL tried is allowed, any other "Not allowed to load local resource" fails', () => {
  const tried = 'file:///tmp/cockpit/test.ts';
  expect(unexpectedConsoleErrors([`Not allowed to load local resource: ${tried}`], tried)).toEqual([]);
  const other = [
    'Not allowed to load local resource: file:///etc/hosts',
    `Not allowed to load local resource: ${tried}/more`,
    'Not allowed to load local resource: ',
    'Not allowed to load local resource',
  ];
  for (const message of other) expect(unexpectedConsoleErrors([message], tried), message).toEqual([message]);
  expect(unexpectedConsoleErrors(['TypeError: x'], tried)).toEqual(['TypeError: x']);
});

interface QuickRun {
  exit: { code: number | null; signal: NodeJS.Signals | null } | 'timeout';
  /** Everything the app wrote to stderr. */
  stderr: string;
}

// Starts the packaged app on a data folder it must refuse, and waits for it to
// exit. The app quits before any window, so there is no page to attach to, and
// no debugging port either: "opens no window" is proven by the traces a window
// leaves in the data folder (`windowTracesIn`), not by watching the browser,
// which the app can outrun (it creates a window and exits within one task).
async function runUntilExit(dataDir: string): Promise<QuickRun> {
  const { env } = launchEnv(true, dataDir);
  // Its own process group, so a hung run leaves no Electron helper behind.
  const child = spawn(join(packagedAppDir(), 'Contents/MacOS/Cockpit'), [], {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const timedOut = sleep(20_000).then(() => 'timeout' as const);
  const exit = await Promise.race([exited, timedOut]);
  if (exit === 'timeout') await stopGroup(child);
  // A normal exit can leave helpers that still write in the data folder: wait for the whole group.
  else await waitForGroupGone(child.pid!);
  // Lets the last stderr chunks arrive after the exit.
  await sleep(200);
  return { exit, stderr };
}

// What Chromium writes into the data folder only once a window exists (its
// profile: preferences, storage, caches). The app that quits before opening one
// leaves none of it. AC4 and AC8 check they are absent after the exit; the
// guard in the restart test checks a normal start does create them, so an
// Electron that stops writing them fails the guard instead of passing the
// check silently.
const WINDOW_TRACES = ['Preferences', 'Local Storage', 'Session Storage', 'Cache'];
const windowTracesIn = (dir: string) => readdirSync(dir).filter((name) => WINDOW_TRACES.includes(name));

const stateFileIn = (dir: string) => join(dir, 'state.json');
const backupsIn = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'));

// The state file across restarts of the packaged app, always on a data folder
// the test creates and removes.
describe('packaged app state file', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTestDir('d-');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function expectHomePageWithoutError(session: Session) {
    await session.page.getByText(versionLabel).waitFor();
    await session.page.getByRole('heading', { name: 'Home' }).waitFor();
    expect(await consoleErrorsOf(session.page)).toEqual([]);
    expect(await session.page.pageErrors()).toEqual([]);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  }

  test('AC2 — a second start leaves state.json unchanged and sets nothing aside', async () => {
    const first = await launchPackaged({ dataDir });
    await expectHomePageWithoutError(first);
    // Guard for AC4 and AC8: a normal start leaves window traces (Chromium may
    // write them shortly after the page shows), so their absence there means
    // something.
    const traces = await poll(() => windowTracesIn(dataDir), (found) => found.length > 0, 5_000);
    expect(traces, 'a normal start leaves window traces in the data folder').not.toEqual([]);
    await first.close();

    const file = stateFileIn(dataDir);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    const before = { content: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs };

    const second = await launchPackaged({ dataDir });
    try {
      await expectHomePageWithoutError(second);
    } finally {
      await second.close();
    }

    expect(readFileSync(file, 'utf8')).toBe(before.content);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(backupsIn(dataDir)).toEqual([]);
    expect(existsSync(join(dataDir, 'state.json.tmp'))).toBe(false);
  });

  test('AC7 — a project survives a restart on the same data folder, and removing it leaves the repository on disk', async () => {
    const repo = makeRepo('persistent-project');
    try {
      const first = await launchPackaged({ dataDir });
      try {
        await first.page.getByText(versionLabel).waitFor();
        await addProject(first, repo.root);
        await waitForEntries(first.page, [repo.root]);
        await poll(() => projectsInState(dataDir), (projects) => Array.isArray(projects) && projects.length > 0, UI_TIMEOUT);
        expect(projectsInState(dataDir)).toEqual([{ path: repo.root }]);
      } finally {
        await first.close();
      }

      const repoOnDisk = snapshotRepo(repo);
      const second = await launchPackaged({ dataDir });
      try {
        await second.page.getByText(versionLabel).waitFor();
        await waitForEntries(second.page, [repo.root]);
        expect((await sidebarEntries(second.page))[0]!.text).toContain(repo.name);
        expect(projectsInState(dataDir)).toEqual([{ path: repo.root }]);

        await removeThroughMenu(second.page, repo.root);
        await waitForEntries(second.page, []);
        await poll(() => projectsInState(dataDir), (projects) => Array.isArray(projects) && projects.length === 0, UI_TIMEOUT);
        expect(projectsInState(dataDir)).toEqual([]);
        expect(backupsIn(dataDir)).toEqual([]);
        expect(snapshotRepo(repo)).toEqual(repoOnDisk);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(repo.parent, { recursive: true, force: true });
    }
  });

  test('AC8 — a state.json from an earlier build, without projects, shows no project and is left unchanged', async () => {
    const file = stateFileIn(dataDir);
    writeFileSync(file, '{ "version": 1 }\n');
    const before = stateSnapshot(dataDir);

    const session = await launchPackaged({ dataDir });
    try {
      await expectHomePageWithoutError(session);
      // The Projects section is there, empty.
      await session.page.getByRole('button', { name: 'Add project', exact: true }).waitFor({ timeout: UI_TIMEOUT });
      expect(await sidebarLines(session.page)).toContain('Projects');
      expect(await entryTitles(session.page)).toEqual([]);
    } finally {
      await session.close();
    }

    expect(stateSnapshot(dataDir)).toEqual(before);
    expect(backupsIn(dataDir)).toEqual([]);
    expect(existsSync(join(dataDir, 'state.json.tmp'))).toBe(false);
  });

  test('AC3 — a corrupted state.json is set aside and replaced, and the app starts', async () => {
    const corrupt = '{not json';
    writeFileSync(stateFileIn(dataDir), corrupt);

    const session = await launchPackaged({ dataDir });
    try {
      await expectHomePageWithoutError(session);
      const backups = backupsIn(dataDir);
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(dataDir, backups[0]!), 'utf8')).toBe(corrupt);
      expect(JSON.parse(readFileSync(stateFileIn(dataDir), 'utf8'))).toEqual({ version: 1 });
      expect(session.output()).toContain(backups[0]!);
    } finally {
      await session.close();
    }
  });

  test('AC4 — a state.json from a newer version opens no window, exits with code 1 and is left untouched', async () => {
    const newer = '{"version":2}';
    const file = stateFileIn(dataDir);
    writeFileSync(file, newer);
    const mtimeMs = statSync(file).mtimeMs;

    const run = await runUntilExit(dataDir);

    expect(run.exit).toEqual({ code: 1, signal: null });
    expect(run.stderr).toContain('written by a newer version of Cockpit');
    expect(readFileSync(file, 'utf8')).toBe(newer);
    expect(statSync(file).mtimeMs).toBe(mtimeMs);
    expect(readdirSync(dataDir).filter((name) => name.startsWith('state.json.'))).toEqual([]);
    expect(windowTracesIn(dataDir)).toEqual([]);
  });

  test('AC8 — a state.json that cannot be read opens no window, exits with code 1 and is left alone', async () => {
    const file = stateFileIn(dataDir);
    // Reading a folder fails with EISDIR, whatever the user's permissions.
    mkdirSync(file);

    const run = await runUntilExit(dataDir);

    expect(run.exit).toEqual({ code: 1, signal: null });
    expect(run.stderr).toContain('Cockpit cannot read its data');
    expect(run.stderr).toContain(file);
    expect(run.stderr).toContain('EISDIR');
    expect(statSync(file).isDirectory()).toBe(true);
    expect(readdirSync(file)).toEqual([]);
    expect(readdirSync(dataDir).filter((name) => name.startsWith('state.json'))).toEqual(['state.json']);
    expect(windowTracesIn(dataDir)).toEqual([]);
  });
});

// Quitting as Cmd+Q does (`app.quit()`): no shell may be left running behind the
// user's back.
// A login shell that prints an environment whose PATH holds no git. A real
// `/bin/sh -l` would source `/etc/profile`, whose `path_helper` puts `/usr/bin`
// back, so the fake shell sets the PATH of the shell that prints the environment
// itself (`$2` is the command `resolveShellEnv` asks for: `env -0`, by absolute
// path, between two printf markers).
function makeShellWithoutGit(dir: string): string {
  const empty = join(dir, 'empty-bin');
  mkdirSync(empty);
  const shell = join(dir, 'shell-without-git');
  writeFileSync(shell, `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\nPATH='${empty}' /bin/sh -c "$2"\n`);
  chmodSync(shell, 0o755);
  // macOS scans a new executable the first time it runs.
  execFileSync(shell, ['--warmup']);
  // The premise of the test: no git on the PATH this shell prints.
  const printed = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  expect(printed).toBe(empty);
  return shell;
}

describe('built app with no git on the login shell PATH', () => {
  let folder: string;
  let repo: TempRepo;
  let session: Session;

  beforeAll(async () => {
    folder = makeTestDir('f-');
    repo = makeRepo('no-git-project');
    const executablePath: string = createRequire(import.meta.url)('electron');
    session = await launchSpawned(executablePath, ['.'], true, undefined, {
      ...process.env,
      SHELL: makeShellWithoutGit(folder),
    });
  });

  afterAll(async () => {
    await session?.close();
    rmSync(folder, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  test('AC12 — adding a repository is refused with "git is not installed", no entry, and state.json untouched', async () => {
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    const before = stateSnapshot(session.dataDir);

    await addProject(session, repo.root);
    await waitForLine(page, 'git is not installed');
    await sleep(300);

    expect(await entryTitles(page)).toEqual([]);
    expect(await isBelowProjectsHeader(page, { text: 'git is not installed' })).toBe(true);
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    expect(projectsInState(session.dataDir) ?? []).toEqual([]);
    expect(existsSync(join(session.dataDir, 'state.json.tmp'))).toBe(false);
  });
});

// --- Sessions (COCKPIT-25) ---------------------------------------------------

// A harness that is not a harness: prints what the tests check (working
// directory, arguments, pid, `$TERM`, `$PATH`), then echoes every line it reads and
// exits with code 3 on `exit`. `pwd -P` because macOS temporary folders sit
// behind a symlink (`/var` is `/private/var`). Its `--version` sleeps 1 s while a
// `<stub>.slow` file exists (see `slowVersion` in `makeSessionsFixture`).
const STUB_HARNESS = `#!/bin/sh
#VERSION_LOG#
if [ "$1" = "--version" ]; then [ -e "$0.slow" ] && sleep 1; echo 9.9.9; exit 0; fi
# The launch as it reached the process: its arguments, one per line, then the OpenCode config variable.
printf '%s\\n' "$@" "OPENCODE_CONFIG_CONTENT=\${OPENCODE_CONFIG_CONTENT-unset}" > "$0.launch.$$"
# What the session status feature adds before the other arguments (session status, COCKPIT-36) is
# set aside, so everything below sees only the arguments the user's choices produce.
SETTINGS=""
case "$1" in
  --settings) SETTINGS="$2"; shift 2 ;;
  --no-daemon) shift; if [ "$1" = -c ]; then shift 2; fi ;;
  --standalone) shift ;;
esac
#START_LOG#
echo "session:\${COCKPIT_SESSION_ID-unset}"
echo "workspace:\${COCKPIT_WORKSPACE_PATH-unset}"
echo "socket:\${COCKPIT_SOCKET-unset}"
echo "cwd:$(pwd -P)"
echo "args:$#:$*"
echo "pid:$$"
echo "term:$TERM"
echo "path:$PATH"
echo "ready"
while IFS= read -r line; do
  case "$line" in
    exit) exit 3 ;;
    quit) exit 0 ;;
    "hook "*)
      # Runs the command the --settings the stub got holds for that event, as Claude Code does.
      event="\${line#hook }"
      command=$(printf '%s' "$SETTINGS" | /usr/bin/plutil -extract "hooks.$event.0.hooks.0.command" raw -o - - 2>/dev/null)
      [ -n "$command" ] && /bin/sh -c "$command"
      echo "hooked:$event" ;;
    *) echo "got:$line" ;;
  esac
done
`;

interface SessionsFixture {
  /** The temporary folder that holds everything below, removed by the test. */
  root: string;
  /** The folder of the stubs: the first entry of the login shell's `PATH`. */
  bin: string;
  /** The fake login shell. */
  shell: string;
  /** The file the fake login shell appends its arguments to on every run (but its warm-up). */
  shellLog: string;
  /** The environment to launch the app with. */
  env(): NodeJS.ProcessEnv;
  /** The file the stubs append a line to on every run, when the fixture was made with `log`. */
  runLog: string;
  /**
   * The file the `git` wrapper appends `<working directory> <arguments>` to on every run, when the
   * fixture was made with `gitLog`.
   */
  gitLog: string;
}

// Stubs named after the given catalogue binaries in a folder of their own, and
// a login shell, like `makeShellWithoutGit`, whose printed environment has
// `PATH=<that folder>:/usr/bin:/bin`: a real CLI installed on the developer's
// machine never shows up.
//
// With `log`, every stub first appends `<binary> <arguments>` to `runLog`, which
// is empty once the fixture is ready (its own warm-up runs are not counted).
// With `slowVersion`, the stubs' `--version` sleeps 1 s once the fixture is ready.
// With `gitLog`, `bin` also holds a `git` that appends `<physical working directory> <arguments>`
// to `gitLog` and runs the real git, so a test sees every git command the app runs.
function makeSessionsFixture(
  binaries: string[],
  { log = false, slowVersion = false, gitLog = false }: { log?: boolean; slowVersion?: boolean; gitLog?: boolean } = {},
): SessionsFixture {
  const root = realpathSync(makeTestDir('s-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const runLog = join(root, 'runs.log');
  const logLine = `echo "$(basename "$0") $*" >> '${runLog}'`;
  const script = STUB_HARNESS.replace('#VERSION_LOG#', log ? `[ "$1" = --version ] && ${logLine}` : '').replace('#START_LOG#', log ? logLine : '');
  for (const name of binaries) {
    const stub = join(bin, name);
    writeFileSync(stub, script);
    chmodSync(stub, 0o755);
    // macOS scans a new executable the first time it runs.
    expect(execFileSync(stub, ['--version'], { encoding: 'utf8' }).trim()).toBe('9.9.9');
  }
  const gitLogFile = join(root, 'git-runs.log');
  if (gitLog) {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapper = join(bin, 'git');
    writeFileSync(wrapper, `#!/bin/sh\necho "$(pwd -P) $*" >> '${gitLogFile}'\nexec '${realGit}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    // macOS scans a new executable the first time it runs.
    execFileSync(wrapper, ['--version']);
    writeFileSync(gitLogFile, '');
  }
  const shell = join(root, 'login-shell');
  const shellLog = join(root, 'shell-args.log');
  writeFileSync(
    shell,
    `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\necho "$*" >> '${shellLog}'\nPATH='${bin}:/usr/bin:/bin' /bin/sh -c "$2"\n`,
  );
  chmodSync(shell, 0o755);
  execFileSync(shell, ['--warmup']);
  const printed = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  expect(printed).toBe(`${bin}:/usr/bin:/bin`);
  if (log) writeFileSync(runLog, '');
  if (slowVersion) for (const name of binaries) writeFileSync(join(bin, `${name}.slow`), '');
  // Its own checks above ran the shell: only what the app makes it run is counted.
  writeFileSync(shellLog, '');

  return { root, bin, shell, shellLog, env: () => ({ ...process.env, SHELL: shell }), runLog, gitLog: gitLogFile };
}

const launchBuiltWith = (env: NodeJS.ProcessEnv, dataDir?: string | null, cockpitHome?: string | null) =>
  launchSpawned(createRequire(import.meta.url)('electron') as string, ['.'], true, dataDir, env, cockpitHome);

const launchPackagedWith = (env: NodeJS.ProcessEnv, dataDir?: string) => launchPackaged({ env, dataDir });

const launchDevWith = (env: NodeJS.ProcessEnv, dataDir?: string | null, cockpitHome?: string | null) => launchDev(env, dataDir, cockpitHome);

interface StoredSession {
  id: string;
  name: string;
  harness: string;
  directory: string;
  createdAt: string;
  /** The repository root, for a session started in a workspace. */
  project?: string;
}

const sessionsInState = (dataDir: string): StoredSession[] =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { sessions?: StoredSession[] }).sessions ?? [];

// The id in the page URL (`/sessions/<id>`), if the page is a session page.
const sessionIdOf = (page: Page) => /^\/sessions\/([^/]+)$/.exec(new URL(page.url()).pathname)?.[1];

interface SessionEntry {
  id: string;
  name: string;
  /** The row's end dot: "Ended" or "Exited N". */
  ended: boolean;
  /** The accessible name of the row's status dot (session status, COCKPIT-36), `null` when it has none. */
  status: string | null;
}

// The session links of the Sessions section (the sessions outside any project) or
// of the workspace at `workspace` (a path), whose sessions are nested under its
// row in the Projects section: the name is the first text of the entry, the status
// is the accessible name of its dot (`role="img"`).
const sessionLinks = (page: Page, scope: 'sessions' | { workspace: string }): Promise<SessionEntry[]> =>
  page.evaluate((scope) => {
    const root =
      scope === 'sessions'
        ? [...document.querySelectorAll('aside section')].find((section) => section.querySelector('h2')?.textContent?.trim() === 'Sessions')
        : [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === scope.workspace)?.closest('li');
    if (!root) return [];
    return [...root.querySelectorAll('a[href*="/sessions/"]')].map((link) => {
      const entry = link.closest('li') ?? link;
      const texts: string[] = [];
      const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node.textContent ?? '').trim();
        if (text) texts.push(text);
      }
      const status = entry.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') ?? null;
      return {
        id: link.getAttribute('href')!.split('/').pop()!,
        name: texts[0] ?? '',
        ended: status === 'Ended' || /^Exited \d+$/.test(status ?? ''),
        status,
      };
    });
  }, scope);

const sessionEntries = (page: Page) => sessionLinks(page, 'sessions');

// Every session link of the sidebar, wherever it is shown.
const allSessionLinkIds = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('aside a[href*="/sessions/"]')].map((link) => link.getAttribute('href')!.split('/').pop()!));

const waitForSessionEntries = (page: Page, expected: Array<[name: string, ended: boolean]>) =>
  poll(
    async () => (await sessionEntries(page)).map((entry) => [entry.name, entry.ended]),
    (entries) => JSON.stringify(entries) === JSON.stringify(expected),
    UI_TIMEOUT,
  );

const START_MENU = 'Start session';

const LOADING_ITEM = 'Detecting agent CLIs…';

// Opens the menu and waits until it lists the harnesses (or says there is none).
async function openStartMenu(page: Page) {
  await page.getByRole('button', { name: START_MENU, exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('menuitem').filter({ hasNotText: LOADING_ITEM }).first().waitFor({ timeout: UI_TIMEOUT });
}

// Waits for the session page of a session other than `previous`.
async function waitForSessionPage(page: Page, previous: string | undefined, pageName: string): Promise<string> {
  await page.getByRole('heading', { name: pageName, exact: true }).waitFor({ timeout: UI_TIMEOUT });
  const id = await poll(() => (sessionIdOf(page) === previous ? undefined : sessionIdOf(page)), Boolean, UI_TIMEOUT);
  expect(id, `the URL ${page.url()} is /sessions/<id> of a new session`).toBeTruthy();
  return id!;
}

// Picks a harness in the "Start session" menu and waits for its session page.
async function startSession(page: Page, harnessName: string, pageName: string): Promise<string> {
  const previous = sessionIdOf(page);
  await openStartMenu(page);
  await page.getByRole('menuitem', { name: harnessName, exact: true }).click({ timeout: UI_TIMEOUT });
  return waitForSessionPage(page, previous, pageName);
}

async function openSessionEntry(page: Page, name: string) {
  // The Sessions section's links only: a workspace's sessions can bear the same name.
  const section = page.locator('aside section').filter({ has: page.getByRole('heading', { name: 'Sessions', exact: true }) });
  const entry = section.locator('a[href*="/sessions/"]', { hasText: new RegExp(`^\\s*${escapeRegExp(name)}(\\s|$)`) });
  await entry.first().click({ timeout: UI_TIMEOUT });
  await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: UI_TIMEOUT });
}

interface StubFacts {
  cwd: string;
  argCount: number;
  args: string;
  pid: number;
  term: string;
  path: string;
}

// What the stub printed, read from the terminal once it printed its last line.
// A long line wraps onto the next row, so the rows are joined before parsing.
async function readStub(page: Page): Promise<StubFacts> {
  await waitForRow(page, 'ready');
  const text = (await terminalRows(page)).join('');
  const found = /cwd:(.+?)args:(\d+):(.*?)pid:(\d+)term:(.+?)path:(.+?)ready/.exec(text);
  if (!found) throw new Error(`The terminal does not show the stub's output:\n${text}`);
  return { cwd: found[1]!, argCount: Number(found[2]), args: found[3]!, pid: Number(found[4]), term: found[5]!, path: found[6]! };
}

interface StubEnv {
  session: string;
  workspace: string;
  socket: string;
}

// The control variables the stub printed (`unset` when the variable is not in its environment).
async function readStubEnv(page: Page): Promise<StubEnv> {
  await waitForRow(page, 'ready');
  const text = (await terminalRows(page)).join('');
  const found = /session:(.*?)workspace:(.*?)socket:(.*?)cwd:/.exec(text);
  if (!found) throw new Error(`The terminal does not show the stub's control variables:\n${text}`);
  return { session: found[1]!, workspace: found[2]!, socket: found[3]! };
}

// --- Control endpoint (COCKPIT-31) -------------------------------------------

// Values the app is launched with to prove that neither a terminal nor a session inherits them.
const INHERITED_CONTROL_ENV = {
  COCKPIT_SESSION_ID: 'sentinel-session-id',
  COCKPIT_WORKSPACE_PATH: '/sentinel/workspace',
  COCKPIT_SOCKET: '/sentinel/control.sock',
};

// What a client (a hook) sees of `POST /session-events` on the app's socket.
function postSessionEvent(socketPath: string, { authorization, body }: { authorization?: string; body: unknown }) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (authorization !== undefined) headers.authorization = authorization;
    const req = httpRequest({ socketPath, method: 'POST', path: '/session-events', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const controlTokenIn = (cockpitHome: string) => readFileSync(daemonSocketIn(cockpitHome).replace(/\.sock$/, '.token'), 'utf8');

// The status dot of a session's row (`role="img"`, wherever the row is in the sidebar): its accessible
// name and its `title`, or `null` when the row has none.
const dotOf = (page: Page, id: string) =>
  page.evaluate((id) => {
    const dot = document.querySelector(`aside a[href$="/sessions/${id}"]`)?.closest('li')?.querySelector('[role="img"][aria-label]');
    return dot ? { label: dot.getAttribute('aria-label'), title: dot.getAttribute('title') } : null;
  }, id);

// Waits (2 s: "within 2 s of each report") until the row of session `id` shows the dot `label`, `null`
// being no dot at all, and checks that the dot's `title` says the same.
async function expectDot(page: Page, id: string, label: string | null, timeout = 2_000) {
  const dot = await poll(() => dotOf(page, id), (found) => (found?.label ?? null) === label, timeout);
  expect(dot?.label ?? null, `the dot of session ${id}`).toBe(label);
  if (label !== null) expect(dot?.title).toBe(label);
}

// The smoke path of the control endpoint and of the status reporting, on the session page that is
// open: the stub got its session id and the socket, and a `hook UserPromptSubmit` line (the stub runs
// the command its --settings hold for that event) turns the row's dot to "Working". It reports
// `working` only, which raises no notification.
async function expectControlEndpoint(session: Session): Promise<void> {
  const { page } = session;
  const socketPath = daemonSocketIn(session.cockpitHome);
  const env = await readStubEnv(page);
  expect(env.session).toBe(sessionIdOf(page));
  expect(env.socket).toBe(socketPath);

  await expectDot(page, env.session, null);
  await focusTerminal(page);
  await typeLine(page, 'hook UserPromptSubmit');
  await waitForRow(page, 'hooked:UserPromptSubmit');
  await expectDot(page, env.session, 'Working');
}

// Whether the deepest element whose text starts with `text` sits below the
// "Sessions" header of the sidebar.
const isBelowSessionsHeader = (page: Page, text: string) =>
  page.evaluate((text) => {
    const all = [...document.querySelectorAll('aside *')] as HTMLElement[];
    const deepest = (matches: (element: HTMLElement) => boolean) =>
      all.filter(matches).filter((element) => !all.some((other) => other !== element && element.contains(other) && matches(other)))[0];
    const header = deepest((element) => (element.textContent ?? '').trim() === 'Sessions');
    const found = deepest((element) => (element.textContent ?? '').trim().startsWith(text));
    if (!header || !found) return false;
    return found.getBoundingClientRect().top >= header.getBoundingClientRect().bottom - 1;
  }, text);

// The processes whose parent is `pid`.
const childPidsOf = (pid: number): number[] =>
  execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === pid)
    .map(([child]) => child!);

const sessionFoldersIn = (home: string) => {
  const folder = join(home, 'sessions');
  return existsSync(folder) ? readdirSync(folder).sort() : [];
};

async function expectNoErrors(session: Session) {
  expect(session.isRunning()).toBe(true);
  expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  expect(await allPageErrorsOf(session.page)).toEqual([]);
  expect(await allConsoleErrorsOf(session.page)).toEqual([]);
}

// --- Sessions in a workspace (COCKPIT-28) ------------------------------------

const agentSelect = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('combobox', { name: 'Agent', exact: true });
const promptField = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('textbox', { name: 'Prompt', exact: true });

async function chooseAgent(page: Page, dialog: ReturnType<Page['locator']>, agent: string) {
  await agentSelect(dialog).click({ timeout: UI_TIMEOUT });
  await page.getByRole('option', { name: agent, exact: true }).click({ timeout: UI_TIMEOUT });
  await poll(async () => (await agentSelect(dialog).innerText()).trim(), (value) => value === agent, UI_TIMEOUT);
}

// Fills the New workspace dialog (base: the preselected one) without clicking "Create".
async function fillNewWorkspace(
  page: Page,
  dialog: ReturnType<Page['locator']>,
  { name, agent, prompt }: { name: string; agent?: string; prompt?: string },
) {
  await poll(() => selectedBase(dialog), (value) => value !== '' && !/select a base/i.test(value), UI_TIMEOUT);
  await nameField(dialog).fill(name);
  if (agent) await chooseAgent(page, dialog, agent);
  if (prompt !== undefined) await promptField(dialog).fill(prompt);
}

// Creates a workspace with an agent through the dialog and waits for the new session's page.
async function createWorkspaceWithAgent(
  page: Page,
  repo: TempRepo,
  options: { name: string; agent: string; prompt?: string },
  pageName: string,
): Promise<string> {
  const previous = sessionIdOf(page);
  const dialog = await openNewWorkspaceDialog(page, repo);
  await fillNewWorkspace(page, dialog, options);
  await createButton(dialog).click({ timeout: UI_TIMEOUT });
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
  return waitForSessionPage(page, previous, pageName);
}

// Puts the pointer over the page's bottom right corner, away from the sidebar's rows.
async function moveMouseAway(page: Page) {
  const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight] as const);
  await page.mouse.move(width - 2, height - 2);
}

const startPlusLabel = (workspaceName: string) => `Start session in ${workspaceName}`;

// Hovers the workspace row and opens its "Start session in <name>" menu.
async function openWorkspaceStartMenu(page: Page, workspacePath: string, workspaceName: string) {
  await page.getByTitle(workspacePath, { exact: true }).first().hover({ timeout: UI_TIMEOUT });
  await page.getByRole('button', { name: startPlusLabel(workspaceName), exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('menuitem').filter({ hasNotText: LOADING_ITEM }).first().waitFor({ timeout: UI_TIMEOUT });
}

async function startInWorkspace(page: Page, workspacePath: string, workspaceName: string, harnessName: string, pageName: string) {
  const previous = sessionIdOf(page);
  await openWorkspaceStartMenu(page, workspacePath, workspaceName);
  await page.getByRole('menuitem', { name: harnessName, exact: true }).click({ timeout: UI_TIMEOUT });
  return waitForSessionPage(page, previous, pageName);
}

const waitForWorkspaceLinks = (page: Page, workspacePath: string, expected: Array<[name: string, ended: boolean]>) =>
  poll(
    async () => (await sessionLinks(page, { workspace: workspacePath })).map((entry) => [entry.name, entry.ended]),
    (entries) => JSON.stringify(entries) === JSON.stringify(expected),
    UI_TIMEOUT,
  );

// The pids of the stubs running as sessions (`pgrep -f` on their path).
function stubPids(fx: SessionsFixture): number[] {
  try {
    return execFileSync('pgrep', ['-f', `${escapeRegExp(fx.bin)}/(claude|codex)`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .sort();
  } catch {
    // `pgrep` exits with 1 when nothing matches.
    return [];
  }
}

// The lines of the stubs' run log: `<binary> <arguments>`.
const stubRuns = (fx: SessionsFixture) => readFileSync(fx.runLog, 'utf8').split('\n').filter(Boolean);
const versionRuns = (fx: SessionsFixture) => stubRuns(fx).filter((line) => line.endsWith(' --version')).sort();
const startRuns = (fx: SessionsFixture) => stubRuns(fx).filter((line) => !line.endsWith(' --version'));

const startApi = (page: Page, options: unknown) =>
  page.evaluate(
    (options) =>
      (
        window as unknown as {
          api: { sessions: { start(harness: string, size: { cols: number; rows: number }, options: unknown): Promise<unknown> } };
        }
      ).api.sessions.start('claude-code', { cols: 80, rows: 24 }, options),
    options,
  );

// --- Open a workspace in an editor, a terminal or the Finder (COCKPIT-33) -----

interface OpenFixture {
  /** The folder `COCKPIT_TEST_APPLICATIONS_DIR` points at: it holds the fake bundles. */
  apps: string;
  /** The file the stub `open` appends one line to per run: its arguments, tab-separated. */
  log: string;
  /** The folder whose `code` and `stderr` files set how the stub `open` ends. */
  control: string;
  /** The launch environment: the fixture's, plus the applications folder. */
  env(): NodeJS.ProcessEnv;
}

const OPEN_BUNDLES = ['Visual Studio Code.app', 'Cursor.app', 'Terminal.app', 'Ghostty.app'];

// A stub `open` first on the fake login shell's `PATH` (the real one would open real apps on
// the developer's screen) and an applications folder of empty fake bundles: Zed, iTerm2 and
// Warp are not detected.
function addOpenFixture(fx: SessionsFixture): OpenFixture {
  const apps = join(fx.root, 'Applications');
  mkdirSync(apps);
  for (const bundle of OPEN_BUNDLES) mkdirSync(join(apps, bundle));
  const log = join(fx.root, 'open.log');
  const control = join(fx.root, 'open-control');
  mkdirSync(control);
  const stub = join(fx.bin, 'open');
  writeFileSync(
    stub,
    `#!/bin/sh
printf '%s\\t' "$@" >> '${log}'
echo >> '${log}'
[ -s '${control}/stderr' ] && cat '${control}/stderr' >&2
[ -e '${control}/code' ] && exit "$(cat '${control}/code')"
exit 0
`,
  );
  chmodSync(stub, 0o755);
  // macOS scans a new executable the first time it runs; the run is not counted.
  execFileSync(stub, ['--warmup']);
  writeFileSync(log, '');
  return { apps, log, control, env: () => ({ ...fx.env(), COCKPIT_TEST_APPLICATIONS_DIR: apps }) };
}

// The runs of the stub `open`, one array of arguments each.
const openRuns = (open: OpenFixture): string[][] =>
  readFileSync(open.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t').slice(0, -1));

const waitForOpenRuns = (open: OpenFixture, count: number) =>
  poll(() => openRuns(open), (runs) => runs.length >= count, UI_TIMEOUT);

// How the next runs of the stub `open` end: exit code and stderr (none for a success).
function setOpenOutcome(open: OpenFixture, { code, stderr }: { code?: number; stderr?: string } = {}) {
  rmSync(join(open.control, 'code'), { force: true });
  rmSync(join(open.control, 'stderr'), { force: true });
  if (code !== undefined) writeFileSync(join(open.control, 'code'), String(code));
  if (stderr !== undefined) writeFileSync(join(open.control, 'stderr'), stderr);
}

const rememberedApps = (dataDir: string) => {
  const { editor, terminal } = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { editor?: unknown; terminal?: unknown };
  return { editor, terminal };
};

// The text of the items of the menu that is open, trimmed. The first menu is the "…" menu; a
// submenu opened from it is the last.
const trimmed = (texts: string[]) => texts.map((text) => text.trim());
const topLevelItems = async (page: Page) => trimmed(await page.getByRole('menu').first().getByRole('menuitem').allInnerTexts());

// Opens the "…" menu of the workspace at `path` and waits until the items above "Delete workspace…"
// are exactly `expected` (in any order), "Delete workspace…" being last.
async function openWorkspaceMenu(page: Page, path: string, expected: string[]) {
  await openMenu(page, path);
  const wanted = [...expected].sort();
  const shown = (items: string[]) => items.at(-1) === 'Delete workspace…' && JSON.stringify(items.slice(0, -1).sort()) === JSON.stringify(wanted);
  const items = await poll(() => topLevelItems(page), shown, UI_TIMEOUT);
  expect(items.at(-1), 'the app items sit above "Delete workspace…"').toBe('Delete workspace…');
  expect(items.slice(0, -1).sort()).toEqual(wanted);
}

// Opens a submenu of the "…" menu (hover, then a click when hover did not open it) and returns its items.
// A submenu still open from before is closed first (one Escape closes only the submenu): with hover
// opening, Base UI leaves the parent popup at `pointer-events: none` until the next real mouse move,
// and a stale submenu would pass for the requested one.
async function openSubmenu(page: Page, trigger: 'Open in editor' | 'Open in terminal') {
  const menus = page.getByRole('menu');
  if ((await menus.count()) > 1) {
    await page.keyboard.press('Escape');
    await poll(() => menus.count(), (count) => count === 1, UI_TIMEOUT);
  }
  const item = page.getByRole('menuitem', { name: trigger, exact: true });
  await item.hover({ timeout: UI_TIMEOUT });
  if ((await poll(() => menus.count(), (count) => count >= 2, 2_000)) < 2) {
    await item.click({ timeout: UI_TIMEOUT });
    await poll(() => menus.count(), (count) => count >= 2, UI_TIMEOUT);
  }
  return menus.last().getByRole('menuitem');
}

const submenuTexts = async (page: Page, trigger: 'Open in editor' | 'Open in terminal') =>
  trimmed(await (await openSubmenu(page, trigger)).allInnerTexts());

async function pickInSubmenu(page: Page, trigger: 'Open in editor' | 'Open in terminal', app: string) {
  const items = await openSubmenu(page, trigger);
  await items.filter({ hasText: new RegExp(`^\\s*${escapeRegExp(app)}\\s*$`) }).first().click({ timeout: UI_TIMEOUT });
}

// Escape until no menu is open (a submenu takes one Escape of its own).
async function closeMenus(page: Page) {
  const menus = page.getByRole('menu');
  for (let attempt = 0; attempt < 4 && (await menus.count()) > 0; attempt++) {
    await page.keyboard.press('Escape');
    await poll(() => menus.count(), (count) => count === 0, 500);
  }
  expect(await menus.count()).toBe(0);
}

const pickTopItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true }).click({ timeout: UI_TIMEOUT });

// The whole menu of a workspace when every fake bundle is there and nothing is remembered.
const FIRST_MENU = ['Open in Visual Studio Code', 'Open in Terminal', 'Reveal in Finder', 'Open in editor', 'Open in terminal'];

const workspacesApi = (page: Page, call: 'reveal' | 'open', args: unknown[]) =>
  page.evaluate(
    ([call, args]) =>
      (window as unknown as { api: { workspaces: Record<string, (...args: unknown[]) => Promise<unknown>> } }).api.workspaces[call]!(...args),
    [call, args] as const,
  );

// Creates a workspace without an agent through the dialog and waits until it is listed.
async function createPlainWorkspace(session: Session, repo: TempRepo, name: string): Promise<string> {
  const { page } = session;
  const dialog = await openNewWorkspaceDialog(page, repo);
  await fillNewWorkspace(page, dialog, { name });
  await createButton(dialog).click({ timeout: UI_TIMEOUT });
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
  const path = worktreePath(session, repo, name);
  await poll(() => entryTitles(page), (titles) => titles.includes(path), UI_TIMEOUT);
  expect(await entryTitles(page)).toContain(path);
  return path;
}

// The full block runs in the built app only (see the split rule in AGENTS.md).
describe('sessions: built app', () => {
  let fx: SessionsFixture;
  let session: Session;
  // Shared by the tests below, which run in order on one launch.
  const known = {
    claude1: { id: '', pid: 0 },
    claude2: { id: '', pid: 0 },
    codex1: { id: '', pid: 0 },
    claude3: { id: '', pid: 0 },
  };

  // The repository the workspace tests (COCKPIT-28) work in.
  let repo: TempRepo;
  // The stub `open` and the applications folder of the open workspace tests (COCKPIT-33).
  let open: OpenFixture;
  // The workspaces they create, and what runs in them.
  const ws = {
    fix: { path: '', id: '', pid: 0 },
    blank: { path: '', id: '', pid: 0 },
    plus: { path: '', ids: [] as string[], pids: [] as number[] },
  };

  beforeAll(async () => {
    // The stubs log every run, and their `--version` sleeps 1 s (workspace sessions AC13, AC14).
    fx = makeSessionsFixture(['claude', 'codex'], { log: true, slowVersion: true });
    // A stub `open` and fake editor and terminal bundles (open workspace, COCKPIT-33).
    open = addOpenFixture(fx);
    repo = makeRepo('agent-ws');
    // The app itself is launched with the three control variables set, as when it runs from a session's terminal.
    session = await launchBuiltWith({ ...open.env(), ...INHERITED_CONTROL_ENV });
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  // A failing test must not leave a menu or a dialog that blocks the tests after it.
  // Escape only while something is open (at most 4 times), and wait for it to close. Never
  // while the keyboard is in a terminal: the Escape would reach its agent.
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

  test('workspace sessions AC4, AC14 — the New workspace dialog opens with Agent "None" and a disabled Prompt; no --version ran at startup nor on the dialog open', async () => {
    const { page } = session;
    await addRepository(session, repo);

    const dialog = await openNewWorkspaceDialog(page, repo);
    const lines = await linesOf(dialog);
    expect(lines).toContain('Agent');
    expect(lines).toContain('Prompt');
    expect((await agentSelect(dialog).innerText()).trim()).toBe('None');
    expect(await promptField(dialog).isDisabled()).toBe(true);
    // Detection waits for the select to open (or a menu): neither the startup nor the dialog
    // ran anything. The log is cumulative, so this one check covers both.
    await sleep(500);
    expect(stubRuns(fx)).toEqual([]);
    await dismissDialogs(page);
  });

  // Detection runs on this first open and takes about 1 s. A start the page calls while it
  // runs, then a reload, must start nothing once detection ends: `sessions:start` reads the
  // page's ending count at its entry (the pending-spawn case is `survive AC8` below).
  test('workspace sessions AC13, AC12 — the first "Start session" menu open shows one disabled "Detecting agent CLIs…" item; a start called and a reload during detection start nothing, no folder, no stored session and no handler error', async () => {
    const { page } = session;
    expect(await sidebarLines(page)).toContain('Sessions');
    const before = {
      state: stateSnapshot(session.dataDir),
      folders: sessionFoldersIn(session.cockpitHome),
      runs: stubRuns(fx),
    };
    expect(before.runs).toEqual([]);

    await page.getByRole('button', { name: START_MENU, exact: true }).click({ timeout: UI_TIMEOUT });
    const items = page.getByRole('menuitem');
    await items.first().waitFor({ timeout: UI_TIMEOUT });
    expect(await items.count()).toBe(1);
    expect((await items.first().innerText()).trim()).toBe(LOADING_ITEM);
    expect(await items.first().isDisabled()).toBe(true);

    // Detection is running: the start waits for it, and the page is reloaded meanwhile.
    await page.evaluate(() => {
      void (
        window as unknown as { api: { sessions: { start(harness: string, size: { cols: number; rows: number }): Promise<unknown> } } }
      ).api.sessions.start('claude-code', { cols: 80, rows: 24 });
    });
    await page.reload();
    await page.getByText(versionLabel).waitFor({ timeout: UI_TIMEOUT });

    // The end of AC13: the menu lists the harnesses once detection has ended.
    await openStartMenu(page);
    expect((await items.allInnerTexts()).map((text) => text.trim())).toEqual(['Claude Code', 'Codex']);
    await page.keyboard.press('Escape');
    await items.first().waitFor({ state: 'detached', timeout: UI_TIMEOUT });

    // The host answers in order: once it ran a probe shell it has handled a spawn the start would have sent.
    const hostPid = await ptyHostPid(page);
    expect(stubPids(fx)).toEqual([]);
    expect(await poll(() => childPidsOf(hostPid), (children) => children.length === 0, 5_000)).toEqual([]);
    expect(startRuns(fx)).toEqual([]);
    expect(sessionFoldersIn(session.cockpitHome)).toEqual(before.folders);
    expect(stateSnapshot(session.dataDir)).toEqual(before.state);
    expect(session.output()).not.toContain('Error occurred in handler');
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });

  test('AC1, workspace sessions AC14 — the menu lists Claude Code then Codex; each --version ran once, and a second open runs none', async () => {
    const { page } = session;
    expect(versionRuns(fx)).toEqual(['claude --version', 'codex --version']);

    await openStartMenu(page);
    expect((await page.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())).toEqual(['Claude Code', 'Codex']);
    await sleep(500);
    expect(versionRuns(fx)).toEqual(['claude --version', 'codex --version']);
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem').first().waitFor({ state: 'detached', timeout: UI_TIMEOUT });
  });

  test('AC3 — picking Claude Code opens its page, runs the stub in a new folder and stores the session', async () => {
    const { page } = session;
    const id = await startSession(page, 'Claude Code', 'Claude Code 1');
    known.claude1.id = id;

    const home = join(session.cockpitHome, 'sessions', id);
    const stub = await readStub(page);
    // The stub prints its physical path (`pwd -P`); the temporary folder may sit behind a symlink.
    expect(stub.cwd).toBe(realpathSync(home));
    expect(stub.argCount).toBe(0);
    expect(stub.args).toBe('');
    expect(stub.term).toBe('xterm-256color');
    expect(isAlive(stub.pid)).toBe(true);
    known.claude1.pid = stub.pid;
    expect(statSync(home).isDirectory()).toBe(true);

    expect(await waitForSessionEntries(page, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);

    const stored = await poll(() => sessionsInState(session.dataDir), (list) => list.length > 0, UI_TIMEOUT);
    expect(stored).toEqual([
      { id, name: 'Claude Code 1', harness: 'claude-code', directory: home, createdAt: expect.any(String) },
    ]);
    expect(new Date(stored[0]!.createdAt).toISOString()).toBe(stored[0]!.createdAt);
  });

  test('daemon AC1 — daemon-1-<build>.sock and .token sit in COCKPIT_HOME, both with mode 0600, the token being 64 lowercase hex characters and nothing else, next to the daemon\'s .pid and .log', () => {
    const socketPath = daemonSocketIn(session.cockpitHome);
    const tokenPath = socketPath.replace(/\.sock$/, '.token');
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(tokenPath).isFile()).toBe(true);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenPath, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(socketPath.replace(/\.sock$/, '.pid'))).toBe(true);
    expect(existsSync(socketPath.replace(/\.sock$/, '.log'))).toBe(true);
  });

  test('control AC8, AC9 — a session outside any project gets its own id and the socket, no workspace path, and not the values the app inherited', async () => {
    const env = await readStubEnv(session.page);
    expect(env.session).toBe(known.claude1.id);
    expect(env.socket).toBe(daemonSocketIn(session.cockpitHome));
    expect(env.workspace).toBe('unset');
    expect(sessionsInState(session.dataDir)[0]!.id).toBe(env.session);
    expect(Object.values(env)).not.toContain(INHERITED_CONTROL_ENV.COCKPIT_SESSION_ID);
    expect(env.socket).not.toBe(INHERITED_CONTROL_ENV.COCKPIT_SOCKET);
  });

  test('control AC4 — an id that is not a stored session gets 404 { "error": "unknown session" }', async () => {
    const answer = await postSessionEvent(daemonSocketIn(session.cockpitHome), {
      authorization: `Bearer ${controlTokenIn(session.cockpitHome)}`,
      body: { sessionId: randomUUID(), event: 'working' },
    });
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.text)).toEqual({ error: 'unknown session' });
  });

  test('control AC9 — a shell of the terminal page gets COCKPIT_SOCKET and neither a session id nor a workspace path, whatever the app inherited', async () => {
    const { page } = session;
    // No `env` in the request: the main process fills in the default environment.
    const id = await spawnShell(page, { command: '/bin/sh', cols: 80, rows: 24 });
    await ptyWrite(page, id, `printf 'sock=<%s> sid=<%s> ws=<%s>\\n' "\${COCKPIT_SOCKET-unset}" "\${COCKPIT_SESSION_ID-unset}" "\${COCKPIT_WORKSPACE_PATH-unset}"\n`);
    await waitForOutput(page, id, /sock=<[^%>][^>]*> sid=<[^>]*> ws=<[^>]*>/);
    const printed = /sock=<([^%>][^>]*)> sid=<([^>]*)> ws=<([^>]*)>/.exec(await outputOf(page, id))!;
    expect(printed.slice(1)).toEqual([daemonSocketIn(session.cockpitHome), 'unset', 'unset']);
    await ptyKill(page, id);
    await waitForExit(page, id);
  });

  test('workspace sessions AC14 — a session start runs no --version', async () => {
    expect(versionRuns(fx)).toEqual(['claude --version', 'codex --version']);
    expect(startRuns(fx)).toContain('claude ');
  });

  test('AC4 — a line typed in the terminal reaches the harness and its answer shows', async () => {
    const { page } = session;
    await focusTerminal(page);
    await typeLine(page, 'hello');
    await waitForRow(page, 'got:hello');
  });

  test('AC6 — going Home and back keeps the process, its output and its input', async () => {
    const { page } = session;
    await goHome(page);
    expect(isAlive(known.claude1.pid)).toBe(true);

    await openSessionEntry(page, 'Claude Code 1');
    await waitForRow(page, 'got:hello');
    const stub = await readStub(page);
    expect(stub.pid).toBe(known.claude1.pid);
    expect(isAlive(known.claude1.pid)).toBe(true);

    await focusTerminal(page);
    await typeLine(page, 'again');
    await waitForRow(page, 'got:again');
  });

  test('AC5 — the next sessions are numbered per harness, and the list shows the newest first', async () => {
    const { page } = session;
    known.claude2.id = await startSession(page, 'Claude Code', 'Claude Code 2');
    known.claude2.pid = (await readStub(page)).pid;
    known.codex1.id = await startSession(page, 'Codex', 'Codex 1');
    known.codex1.pid = (await readStub(page)).pid;

    expect(await waitForSessionEntries(page, [['Codex 1', false], ['Claude Code 2', false], ['Claude Code 1', false]])).toEqual([
      ['Codex 1', false],
      ['Claude Code 2', false],
      ['Claude Code 1', false],
    ]);
    expect((await sessionEntries(page)).map((entry) => entry.id)).toEqual([known.codex1.id, known.claude2.id, known.claude1.id]);
    expect(new Set([known.claude1.pid, known.claude2.pid, known.codex1.pid]).size).toBe(3);
    expect(sessionsInState(session.dataDir).map((stored) => stored.name)).toEqual(['Claude Code 1', 'Claude Code 2', 'Codex 1']);
    expect(sessionsInState(session.dataDir).map((stored) => stored.harness)).toEqual(['claude-code', 'claude-code', 'codex']);
  });

  test('AC7 — typing exit shows the exit code in the terminal and the "Exited 3" dot on the entry; the other entries keep none', async () => {
    const { page } = session;
    await focusTerminal(page);
    await typeLine(page, 'exit');

    await waitForRow(page, '[Process exited with code 3]');
    expect(
      await waitForSessionEntries(page, [['Codex 1', true], ['Claude Code 2', false], ['Claude Code 1', false]]),
    ).toEqual([
      ['Codex 1', true],
      ['Claude Code 2', false],
      ['Claude Code 1', false],
    ]);
    await expectDot(page, known.codex1.id, 'Exited 3');
    expect((await sessionEntries(page)).map((entry) => entry.status)).toEqual(['Exited 3', null, null]);
    await poll(() => isAlive(known.codex1.pid), (alive) => !alive, UI_TIMEOUT);
    expect(isAlive(known.codex1.pid)).toBe(false);
    expect(isAlive(known.claude2.pid)).toBe(true);
  });

  test('daemon AC4 — reloading the page keeps the processes: the running session shows no "Ended" dot, its page shows the running agent and a typed line reaches it', async () => {
    const { page } = session;
    await openSessionEntry(page, 'Claude Code 2');
    expect(isAlive(known.claude2.pid)).toBe(true);

    await page.reload();

    // The page shows the stub's output from before the reload: the same process.
    expect((await readStub(page)).pid).toBe(known.claude2.pid);
    expect(sessionIdOf(page)).toBe(known.claude2.id);
    expect(isAlive(known.claude2.pid)).toBe(true);
    expect((await sessionEntries(page)).find((entry) => entry.name === 'Claude Code 2')?.ended).toBe(false);
    expect(await page.getByText('This session has ended.').count()).toBe(0);
    await focusTerminal(page);
    await typeLine(page, 'after-reload');
    await waitForRow(page, 'got:after-reload');
  });

  test('AC14 — with the pty host dead, picking a harness starts the session: its page opens, the stub runs in a new folder under COCKPIT_HOME, and it is listed and stored', async () => {
    const { page } = session;
    await killPtyHost(page);
    const stored = sessionsInState(session.dataDir).length;
    const entriesBefore = await sessionEntries(page);

    const id = await startSession(page, 'Claude Code', 'Claude Code 3');
    known.claude3.id = id;

    const home = join(session.cockpitHome, 'sessions', id);
    const stub = await readStub(page);
    expect(stub.cwd).toBe(realpathSync(home));
    expect(stub.term).toBe('xterm-256color');
    expect(isAlive(stub.pid)).toBe(true);
    known.claude3.pid = stub.pid;
    expect(statSync(home).isDirectory()).toBe(true);

    expect((await sidebarLines(page)).filter((line) => line.startsWith('Could not start'))).toEqual([]);
    const entries = await poll(() => sessionEntries(page), (list) => list.length === entriesBefore.length + 1, UI_TIMEOUT);
    expect(entries.map((entry) => [entry.name, entry.ended])).toEqual([['Claude Code 3', false], ...entriesBefore.map((entry) => [entry.name, entry.ended])]);
    const list = await poll(() => sessionsInState(session.dataDir), (found) => found.length === stored + 1, UI_TIMEOUT);
    expect(list.at(-1)).toEqual({ id, name: 'Claude Code 3', harness: 'claude-code', directory: home, createdAt: expect.any(String) });
    expect(sessionFoldersIn(session.cockpitHome)).toContain(id);
  });

  test('AC15 — a running session shows as ended when the pty host dies: [Process ended] in its terminal, the "Ended" dot on its entry', async () => {
    const { page } = session;
    // The session AC14 started runs on the new host and is open on its page.
    expect(sessionIdOf(page)).toBe(known.claude3.id);
    expect(isAlive(known.claude3.pid)).toBe(true);
    expect((await sessionEntries(page)).find((entry) => entry.id === known.claude3.id)?.ended).toBe(false);

    await killPtyHost(page);

    await waitForRow(page, '[Process ended]');
    expect(
      await waitForSessionEntries(page, [['Claude Code 3', true], ['Codex 1', true], ['Claude Code 2', true], ['Claude Code 1', true]]),
    ).toEqual([
      ['Claude Code 3', true],
      ['Codex 1', true],
      ['Claude Code 2', true],
      ['Claude Code 1', true],
    ]);
    await expectDot(page, known.claude3.id, 'Ended');
    // The same as when the agent exits (AC7): the page keeps its terminal, it does not turn into an error.
    expect(sessionIdOf(page)).toBe(known.claude3.id);
    await page.getByRole('heading', { name: 'Claude Code 3', exact: true }).waitFor({ timeout: UI_TIMEOUT });
  });

  // A folder named `state.json.tmp` in the data folder makes `saveState` fail
  // after the spawn succeeded, which runs the whole rollback. (A removed stub
  // would not do: node-pty does not throw on a missing executable.)
  test('AC16 — with a folder named state.json.tmp in the data folder, picking Claude Code is refused under the Sessions header and changes nothing', async () => {
    const { page } = session;
    // The menu detected the stubs (AC1) and keeps the answer.
    await openStartMenu(page);
    expect((await page.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())).toEqual(['Claude Code', 'Codex']);
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem').first().waitFor({ state: 'detached', timeout: UI_TIMEOUT });

    // The pty host runs (AC15 killed it, this spawn starts a new one) with no pty of its own.
    const probe = await spawnShell(page);
    await ptyWrite(page, probe, 'echo ppid-$PPID\n');
    await waitForOutput(page, probe, /ppid-\d+/);
    const hostPid = Number(/ppid-(\d+)/.exec(await outputOf(page, probe))![1]);
    await ptyKill(page, probe);
    await waitForExit(page, probe);
    expect(await poll(() => childPidsOf(hostPid), (children) => children.length === 0, 5_000)).toEqual([]);

    const entriesBefore = await sessionEntries(page);
    const stateBefore = stateSnapshot(session.dataDir);
    const foldersBefore = sessionFoldersIn(session.cockpitHome);
    const blocker = join(session.dataDir, 'state.json.tmp');
    mkdirSync(blocker);
    try {
      await openStartMenu(page);
      await page.getByRole('menuitem', { name: 'Claude Code', exact: true }).click({ timeout: UI_TIMEOUT });

      const lines = await poll(() => sidebarLines(page), (found) => found.some((line) => line.startsWith('Could not start Claude Code:')), UI_TIMEOUT);
      expect(lines.some((line) => line.startsWith('Could not start Claude Code:'))).toBe(true);
      expect(await isBelowSessionsHeader(page, 'Could not start Claude Code:')).toBe(true);

      // The refusal comes after the rollback: the spawned pty is killed, the folder removed, no change in the state.
      expect(isAlive(hostPid)).toBe(true);
      expect(await poll(() => childPidsOf(hostPid), (children) => children.length === 0, 5_000)).toEqual([]);
      expect(await sessionEntries(page)).toEqual(entriesBefore);
      expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
      expect(sessionFoldersIn(session.cockpitHome)).toEqual(foldersBefore);
      expect(statSync(blocker).isDirectory()).toBe(true);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  });

  // --- Sessions in a workspace (COCKPIT-28). They run in order on this launch, with the
  // repository added above.

  test('workspace sessions AC4 — the Agent select lists None and the detected harnesses; a harness enables Prompt, None disables it again', async () => {
    const { page } = session;
    const dialog = await openNewWorkspaceDialog(page, repo);

    await agentSelect(dialog).click({ timeout: UI_TIMEOUT });
    const options = page.getByRole('option');
    const listed = await poll(
      async () => (await options.allInnerTexts()).map((text) => text.trim()),
      (found) => found.length >= 3,
      UI_TIMEOUT,
    );
    expect(listed).toEqual(['None', 'Claude Code', 'Codex']);
    await page.keyboard.press('Escape');
    await options.first().waitFor({ state: 'hidden', timeout: UI_TIMEOUT });

    await chooseAgent(page, dialog, 'Claude Code');
    expect(await promptField(dialog).isEnabled()).toBe(true);
    await chooseAgent(page, dialog, 'None');
    expect(await promptField(dialog).isDisabled()).toBe(true);
    expect(versionRuns(fx)).toEqual(['claude --version', 'codex --version']);
    await dismissDialogs(page);
  });

  test('workspace sessions AC5 — Create with Agent Claude Code and Prompt "fix the tests" creates the worktree, opens the session page and runs the harness there with that one argument', async () => {
    const { page } = session;
    const foldersBefore = sessionFoldersIn(session.cockpitHome);
    const id = await createWorkspaceWithAgent(page, repo, { name: 'fix-tests', agent: 'Claude Code', prompt: 'fix the tests' }, 'Claude Code 1');
    const path = worktreePath(session, repo, 'fix-tests');
    ws.fix = { path, id, pid: 0 };

    expect(existsSync(join(path, 'README.md'))).toBe(true);
    expect(linkedWorktrees(repo)).toContainEqual({ path, branch: 'fix-tests' });
    const stub = await readStub(page);
    expect(stub.cwd).toBe(path);
    expect(stub.argCount).toBe(1);
    expect(stub.args).toBe('fix the tests');
    expect(isAlive(stub.pid)).toBe(true);
    ws.fix.pid = stub.pid;

    expect(await waitForWorkspaceLinks(page, path, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
    expect((await sessionEntries(page)).map((entry) => entry.id)).not.toContain(id);
    const stored = sessionsInState(session.dataDir).find((entry) => entry.id === id);
    expect(stored).toEqual({
      id,
      name: 'Claude Code 1',
      harness: 'claude-code',
      directory: path,
      project: repo.root,
      createdAt: expect.any(String),
    });
    expect(sessionFoldersIn(session.cockpitHome)).toEqual(foldersBefore);
  });

  test('workspace sessions AC6 — a Prompt of spaces only runs the harness in the new worktree with no argument', async () => {
    const { page } = session;
    const id = await createWorkspaceWithAgent(page, repo, { name: 'blank-prompt', agent: 'Claude Code', prompt: '   ' }, 'Claude Code 1');
    const path = worktreePath(session, repo, 'blank-prompt');
    ws.blank = { path, id, pid: 0 };

    const stub = await readStub(page);
    expect(stub.cwd).toBe(path);
    expect(stub.argCount).toBe(0);
    expect(stub.args).toBe('');
    ws.blank.pid = stub.pid;
    expect(await waitForWorkspaceLinks(page, path, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
  });

  test('workspace sessions AC1 — the "Start session in <workspace>" button shows on hover and on focus next to the "…" button, and opens the harness menu', async () => {
    const { page } = session;
    // A workspace made with git itself, listed when the window gains the focus.
    const path = join(repo.parent, 'wt-plus');
    gitIn(repo.root, 'worktree', 'add', '--quiet', '-b', 'ws-plus', path, 'main');
    await dispatchFocus(page);
    await poll(() => entryTitles(page), (titles) => titles.includes(path), UI_TIMEOUT);
    ws.plus.path = path;

    const plus = page.getByRole('button', { name: startPlusLabel('ws-plus'), exact: true });
    const opacity = () => plus.evaluate((button) => getComputedStyle(button).opacity);
    expect(await plus.count()).toBe(1);

    // Pointer away: hidden.
    await moveMouseAway(page);
    expect(await poll(opacity, (value) => value === '0', 2_000)).toBe('0');
    // Pointer over the row: shown.
    await page.getByTitle(path, { exact: true }).first().hover({ timeout: UI_TIMEOUT });
    expect(await poll(opacity, (value) => value === '1', 2_000)).toBe('1');
    // Next to the "…" button of the row.
    const dots = await page.getByRole('button', { name: 'Actions for ws-plus', exact: true }).boundingBox();
    const box = await plus.boundingBox();
    expect(dots && box).toBeTruthy();
    expect(Math.abs(box!.y - dots!.y)).toBeLessThan(4);
    expect(Math.abs(box!.x - dots!.x)).toBeLessThan(40);

    // Keyboard focus: shown with the pointer elsewhere.
    await moveMouseAway(page);
    await poll(opacity, (value) => value === '0', 2_000);
    await page.keyboard.press('Shift');
    await plus.focus();
    expect(await poll(opacity, (value) => value === '1', 2_000)).toBe('1');
    await plus.blur();

    await openWorkspaceStartMenu(page, path, 'ws-plus');
    expect((await page.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())).toEqual(['Claude Code', 'Codex']);
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem').first().waitFor({ state: 'detached', timeout: UI_TIMEOUT });
  });

  test('workspace sessions AC2 — picking Claude Code in the menu runs the harness in the worktree with no argument and the login shell PATH, lists it under the workspace and stores it with its project, with no session folder', async () => {
    const { page } = session;
    const foldersBefore = sessionFoldersIn(session.cockpitHome);

    const id = await startInWorkspace(page, ws.plus.path, 'ws-plus', 'Claude Code', 'Claude Code 1');
    ws.plus.ids.push(id);

    const stub = await readStub(page);
    expect(stub.cwd).toBe(ws.plus.path);
    expect(stub.argCount).toBe(0);
    expect(stub.term).toBe('xterm-256color');
    expect(stub.path).toBe(`${fx.bin}:/usr/bin:/bin`);
    expect(stub.path).not.toBe(process.env.PATH);
    expect(isAlive(stub.pid)).toBe(true);
    ws.plus.pids.push(stub.pid);

    expect(await waitForWorkspaceLinks(page, ws.plus.path, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
    expect((await sessionEntries(page)).map((entry) => entry.id)).not.toContain(id);
    expect(sessionsInState(session.dataDir).find((entry) => entry.id === id)).toEqual({
      id,
      name: 'Claude Code 1',
      harness: 'claude-code',
      directory: ws.plus.path,
      project: repo.root,
      createdAt: expect.any(String),
    });
    expect(sessionFoldersIn(session.cockpitHome)).toEqual(foldersBefore);
  });

  test('control AC8, AC9 — a session started in a workspace gets its id, the socket and the worktree path stored as its directory', async () => {
    const env = await readStubEnv(session.page);
    const stored = sessionsInState(session.dataDir).find((entry) => entry.id === ws.plus.ids[0])!;
    expect(env.session).toBe(ws.plus.ids[0]);
    expect(env.workspace).toBe(stored.directory);
    expect(env.workspace).toBe(ws.plus.path);
    expect(env.socket).toBe(daemonSocketIn(session.cockpitHome));
  });

  test('workspace sessions AC3 — sessions are numbered per workspace, newest first, and apart from the Sessions section', async () => {
    const { page } = session;
    const id = await startInWorkspace(page, ws.plus.path, 'ws-plus', 'Claude Code', 'Claude Code 2');
    ws.plus.ids.push(id);
    ws.plus.pids.push((await readStub(page)).pid);

    expect(await waitForWorkspaceLinks(page, ws.plus.path, [['Claude Code 2', false], ['Claude Code 1', false]])).toEqual([
      ['Claude Code 2', false],
      ['Claude Code 1', false],
    ]);
    expect((await sessionLinks(page, { workspace: ws.plus.path })).map((entry) => entry.id)).toEqual([id, ws.plus.ids[0]]);
    // Another workspace keeps its own count.
    expect((await sessionLinks(page, { workspace: ws.fix.path })).map((entry) => entry.name)).toEqual(['Claude Code 1']);

    // The Sessions header counts the sessions outside any project only.
    const outside = sessionsInState(session.dataDir).filter((entry) => entry.harness === 'claude-code' && entry.project === undefined);
    const name = `Claude Code ${outside.length + 1}`;
    expect(outside.length).toBeGreaterThan(0);
    const headerId = await startSession(page, 'Claude Code', name);
    expect((await sessionEntries(page))[0]).toMatchObject({ id: headerId, name });
    expect(sessionsInState(session.dataDir).find((entry) => entry.id === headerId)?.project).toBeUndefined();
    expect((await sessionLinks(page, { workspace: ws.plus.path })).map((entry) => entry.name)).toEqual(['Claude Code 2', 'Claude Code 1']);
  });

  test('workspace sessions AC7 — a save that fails after the spawn keeps the new workspace and its files, shows "Could not start Claude Code: …" under the Projects header, leaves no harness process and the sessions unchanged', async () => {
    const { page } = session;
    const before = {
      state: stateSnapshot(session.dataDir),
      sessions: sessionsInState(session.dataDir),
      folders: sessionFoldersIn(session.cockpitHome),
      pids: stubPids(fx),
    };
    const blocker = join(session.dataDir, 'state.json.tmp');
    mkdirSync(blocker);
    try {
      const dialog = await openNewWorkspaceDialog(page, repo);
      await fillNewWorkspace(page, dialog, { name: 'save-fails', agent: 'Claude Code' });
      await createButton(dialog).click({ timeout: UI_TIMEOUT });
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });

      const path = worktreePath(session, repo, 'save-fails');
      await poll(() => entryTitles(page), (titles) => titles.includes(path), UI_TIMEOUT);
      expect(await entryTitles(page)).toContain(path);
      expect(existsSync(join(path, 'README.md'))).toBe(true);
      expect(linkedWorktrees(repo)).toContainEqual({ path, branch: 'save-fails' });

      const lines = await poll(() => sidebarLines(page), (found) => found.some((line) => line.startsWith('Could not start Claude Code:')), UI_TIMEOUT);
      const message = lines.find((line) => line.startsWith('Could not start Claude Code:'))!;
      expect(message).toBeTruthy();
      // Only a save after a successful spawn raises it.
      expect(message).toContain('EISDIR');
      expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
      expect(await isBelowSessionsHeader(page, message)).toBe(false);

      // The harness was spawned (the message carries the save error), then killed by the rollback.
      expect(await poll(() => stubPids(fx), (pids) => JSON.stringify(pids) === JSON.stringify(before.pids), 5_000)).toEqual(before.pids);
      expect(sessionsInState(session.dataDir)).toEqual(before.sessions);
      expect(stateSnapshot(session.dataDir)).toEqual(before.state);
      expect(sessionFoldersIn(session.cockpitHome)).toEqual(before.folders);
      expect(statSync(blocker).isDirectory()).toBe(true);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  });

  test('workspace sessions AC8 — sessions.start refuses a workspace of an unknown project or a path that is not a linked worktree, and changes nothing', async () => {
    const { page } = session;
    const before = {
      state: stateSnapshot(session.dataDir),
      folders: sessionFoldersIn(session.cockpitHome),
      pids: stubPids(fx),
      runs: stubRuns(fx),
    };
    const elsewhere = join(repo.parent, 'not-a-worktree');
    mkdirSync(elsewhere);

    expect(await startApi(page, { workspace: { project: '/no/such/project', path: '/no/such/project/ws' } })).toEqual({
      status: 'refused',
      message: '/no/such/project is not a project in Cockpit.',
    });
    expect(await startApi(page, { workspace: { project: repo.root, path: elsewhere } })).toEqual({
      status: 'refused',
      message: `${elsewhere} is not a workspace of ${repo.name}.`,
    });
    // The main working tree is the project, not a workspace.
    expect(await startApi(page, { workspace: { project: repo.root, path: repo.root } })).toEqual({
      status: 'refused',
      message: `${repo.root} is not a workspace of ${repo.name}.`,
    });

    await sleep(300);
    expect(stubPids(fx)).toEqual(before.pids);
    expect(stubRuns(fx)).toEqual(before.runs);
    expect(sessionFoldersIn(session.cockpitHome)).toEqual(before.folders);
    expect(stateSnapshot(session.dataDir)).toEqual(before.state);
  });

  test('workspace sessions AC8 — a project whose folder is gone is refused with "<project path> is not a git repository.", nothing is spawned and the state is unchanged', async () => {
    const { page } = session;
    const gone = makeRepo('agent-gone');
    try {
      await addRepository(session, gone);
      // Deleted after it was added: the state still lists it.
      rmSync(gone.parent, { recursive: true, force: true });
      const before = {
        state: stateSnapshot(session.dataDir),
        folders: sessionFoldersIn(session.cockpitHome),
        pids: stubPids(fx),
        runs: stubRuns(fx),
      };

      expect(await startApi(page, { workspace: { project: gone.root, path: join(gone.parent, 'wt') } })).toEqual({
        status: 'refused',
        message: `${gone.root} is not a git repository.`,
      });

      await sleep(300);
      expect(stubPids(fx)).toEqual(before.pids);
      expect(stubRuns(fx)).toEqual(before.runs);
      expect(sessionFoldersIn(session.cockpitHome)).toEqual(before.folders);
      expect(stateSnapshot(session.dataDir)).toEqual(before.state);

      await removeThroughMenu(page, gone.root);
      await poll(() => entryTitles(page), (titles) => !titles.includes(gone.root), UI_TIMEOUT);
    } finally {
      rmSync(gone.parent, { recursive: true, force: true });
    }
  });

  test('workspace sessions AC11 — pty.spawn with a command and no args runs it with no argument; without a command it runs the login shell with -l', async () => {
    const { page } = session;
    const id = await spawnShell(page, { command: join(fx.bin, 'claude'), cols: 80, rows: 24 });
    await waitForOutput(page, id, 'ready');
    expect(await outputOf(page, id)).toContain('args:0:');
    await ptyKill(page, id);
    await waitForExit(page, id);

    const loginShellRuns = () => readFileSync(fx.shellLog, 'utf8').split('\n').filter((line) => line === '-l').length;
    const before = loginShellRuns();
    const shellId = await spawnShell(page, { cols: 80, rows: 24 });
    await waitForExit(page, shellId);
    expect(loginShellRuns()).toBe(before + 1);
  });

  test('workspace sessions AC9 — deleting a workspace ends its running sessions once the removal succeeds (not at the uncommitted-changes step); the entries go, state.json keeps them', async () => {
    const { page } = session;
    expect(ws.fix.path, 'the AC5 test created the workspace').not.toBe('');
    writeFileSync(join(ws.fix.path, 'notes.txt'), 'untracked\n');
    expect(isAlive(ws.fix.pid)).toBe(true);
    const sessionsBefore = sessionsInState(session.dataDir);

    await startDeletion(page, ws.fix.path);
    const dialog = deleteDialog(page, 'Delete fix-tests?');
    await dialog.waitFor({ timeout: UI_TIMEOUT });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
    const warning = deleteDialog(page, 'fix-tests has uncommitted changes');
    await warning.waitFor({ timeout: UI_TIMEOUT });
    await sleep(500);
    expect(isAlive(ws.fix.pid), 'the harness runs while the warning is shown').toBe(true);
    expect(existsSync(ws.fix.path)).toBe(true);

    await warning.getByRole('button', { name: 'Delete anyway', exact: true }).click({ timeout: UI_TIMEOUT });
    await warning.waitFor({ state: 'hidden', timeout: 15_000 });
    await poll(() => entryTitles(page), (titles) => !titles.includes(ws.fix.path), UI_TIMEOUT);

    expect(existsSync(ws.fix.path)).toBe(false);
    expect(await endsWithin(ws.fix.pid)).toBe(true);
    expect(await allSessionLinkIds(page)).not.toContain(ws.fix.id);
    expect(sessionsInState(session.dataDir)).toEqual(sessionsBefore);
    expect(sessionsInState(session.dataDir).map((entry) => entry.id)).toContain(ws.fix.id);
  });

  test('workspace sessions AC10 — removing the project ends its workspaces\' running sessions and hides them; adding it again lists them as "Ended", and state.json held them throughout', async () => {
    const { page } = session;
    const running = [ws.blank.pid, ...ws.plus.pids];
    for (const pid of running) expect(isAlive(pid)).toBe(true);
    const sessionsBefore = sessionsInState(session.dataDir);

    await removeThroughMenu(page, repo.root);
    await poll(() => entryTitles(page), (titles) => !titles.includes(repo.root), UI_TIMEOUT);

    for (const pid of running) expect(await endsWithin(pid)).toBe(true);
    const shown = await allSessionLinkIds(page);
    for (const id of [ws.blank.id, ...ws.plus.ids]) expect(shown).not.toContain(id);
    expect(sessionsInState(session.dataDir)).toEqual(sessionsBefore);

    await addRepository(session, repo);
    expect(await waitForWorkspaceLinks(page, ws.blank.path, [['Claude Code 1', true]])).toEqual([['Claude Code 1', true]]);
    expect(await waitForWorkspaceLinks(page, ws.plus.path, [['Claude Code 2', true], ['Claude Code 1', true]])).toEqual([
      ['Claude Code 2', true],
      ['Claude Code 1', true],
    ]);
    expect(sessionsInState(session.dataDir)).toEqual(sessionsBefore);
  });

  // --- Open a workspace in an editor, a terminal or the Finder (COCKPIT-33). They run in
  // order on this launch, with the repository added above and a workspace of their own. The
  // fake bundles are Visual Studio Code, Cursor, Terminal and Ghostty.

  const launcher = { path: '' };
  const bundle = (name: string) => join(open.apps, `${name}.app`);
  const restoreBundles = () => {
    for (const name of OPEN_BUNDLES) mkdirSync(join(open.apps, name), { recursive: true });
  };
  const messagesShown = async (page: Page) =>
    (await sidebarLines(page)).filter((line) => /^Could not (open|reveal) |^Cockpit could not save its data/.test(line));

  test('open workspace AC1 — the workspace menu lists, above "Delete workspace…", the editor and the terminal shown, "Reveal in Finder" and the two submenus of the detected apps only; opening it runs nothing', async () => {
    const { page } = session;
    launcher.path = await createPlainWorkspace(session, repo, 'open-in');
    const stateBefore = stateSnapshot(session.dataDir);

    // Nothing remembered: the first detected editor and terminal in catalogue order are shown.
    await openWorkspaceMenu(page, launcher.path, FIRST_MENU);
    expect(await submenuTexts(page, 'Open in editor')).toEqual(['Visual Studio Code', 'Cursor']);
    expect(await submenuTexts(page, 'Open in terminal')).toEqual(['Terminal', 'Ghostty']);
    for (const item of await page.getByRole('menu').last().getByRole('menuitem').all()) expect(await item.isDisabled()).toBe(false);

    expect(openRuns(open)).toEqual([]);
    expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
    expect(rememberedApps(session.dataDir)).toEqual({ editor: undefined, terminal: undefined });
  });

  test('open workspace AC3 — "Reveal in Finder" runs open -R <worktree path>', async () => {
    const { page } = session;
    await openWorkspaceMenu(page, launcher.path, FIRST_MENU);
    await pickTopItem(page, 'Reveal in Finder');

    expect(await waitForOpenRuns(open, 1)).toEqual([['-R', launcher.path]]);
    await sleep(300);
    expect(openRuns(open)).toEqual([['-R', launcher.path]]);
    expect(await messagesShown(page)).toEqual([]);
  });

  test('open workspace AC4, AC5 — "Open in <name>" and the submenu items run open -a <bundle path> <worktree path>; an app opened with nothing remembered is remembered', async () => {
    const { page } = session;
    await openWorkspaceMenu(page, launcher.path, FIRST_MENU);
    await pickTopItem(page, 'Open in Visual Studio Code');
    await waitForOpenRuns(open, 2);
    expect(openRuns(open).at(-1)).toEqual(['-a', bundle('Visual Studio Code'), launcher.path]);
    // AC5: nothing was remembered, so the app opened differs from it.
    expect((await poll(() => rememberedApps(session.dataDir), ({ editor }) => editor !== undefined, UI_TIMEOUT)).editor).toBe('vscode');

    await openWorkspaceMenu(page, launcher.path, ['Open in Visual Studio Code', 'Open in Terminal', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
    await pickInSubmenu(page, 'Open in editor', 'Cursor');
    await waitForOpenRuns(open, 3);
    expect(openRuns(open).at(-1)).toEqual(['-a', bundle('Cursor'), launcher.path]);
    await poll(() => rememberedApps(session.dataDir), ({ editor }) => editor === 'cursor', UI_TIMEOUT);

    await openWorkspaceMenu(page, launcher.path, ['Open in Cursor', 'Open in Terminal', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
    await pickInSubmenu(page, 'Open in terminal', 'Ghostty');
    await waitForOpenRuns(open, 4);
    expect(openRuns(open).at(-1)).toEqual(['-a', bundle('Ghostty'), launcher.path]);
    await poll(() => rememberedApps(session.dataDir), ({ terminal }) => terminal === 'ghostty', UI_TIMEOUT);
    expect(await messagesShown(page)).toEqual([]);
  });

  test('open workspace AC5 — the apps opened last are in state.json and shown by the next menu; one already remembered writes nothing', async () => {
    const { page } = session;
    expect(await poll(() => rememberedApps(session.dataDir), ({ terminal }) => terminal === 'ghostty', UI_TIMEOUT)).toEqual({
      editor: 'cursor',
      terminal: 'ghostty',
    });
    await openWorkspaceMenu(page, launcher.path, ['Open in Cursor', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);

    // A different editor replaces the remembered one, and the menu shows it next.
    await pickInSubmenu(page, 'Open in editor', 'Visual Studio Code');
    await waitForOpenRuns(open, 5);
    expect(await poll(() => rememberedApps(session.dataDir), ({ editor }) => editor === 'vscode', UI_TIMEOUT)).toEqual({
      editor: 'vscode',
      terminal: 'ghostty',
    });
    await openWorkspaceMenu(page, launcher.path, ['Open in Visual Studio Code', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);

    // The remembered app again: the run happens, the file is not written.
    const before = stateSnapshot(session.dataDir);
    await pickTopItem(page, 'Open in Visual Studio Code');
    await waitForOpenRuns(open, 6);
    expect(openRuns(open).at(-1)).toEqual(['-a', bundle('Visual Studio Code'), launcher.path]);
    await sleep(500);
    expect(stateSnapshot(session.dataDir)).toEqual(before);

    // Back to Cursor for the tests below.
    await openWorkspaceMenu(page, launcher.path, ['Open in Visual Studio Code', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
    await pickInSubmenu(page, 'Open in editor', 'Cursor');
    await waitForOpenRuns(open, 7);
    expect(await poll(() => rememberedApps(session.dataDir), ({ editor }) => editor === 'cursor', UI_TIMEOUT)).toEqual({
      editor: 'cursor',
      terminal: 'ghostty',
    });
  });

  test('open workspace AC6 — a remembered editor that is no longer detected is replaced in the menu by the first detected one, absent from its submenu, and stays in state.json', async () => {
    const { page } = session;
    rmSync(bundle('Cursor'), { recursive: true });
    try {
      const before = stateSnapshot(session.dataDir);
      await openWorkspaceMenu(page, launcher.path, ['Open in Visual Studio Code', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
      expect(await submenuTexts(page, 'Open in editor')).toEqual(['Visual Studio Code']);

      expect(stateSnapshot(session.dataDir)).toEqual(before);
      expect(rememberedApps(session.dataDir).editor).toBe('cursor');
    } finally {
      restoreBundles();
    }
    // Detected again, the remembered editor is shown again.
    await closeMenus(page);
    await openWorkspaceMenu(page, launcher.path, ['Open in Cursor', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
  });

  test('open workspace AC2 — with no detected editor (or terminal) the menu has no "Open in <name>" for it and its submenu holds one disabled "No editor found" ("No terminal found"); "Reveal in Finder" stays', async () => {
    const { page } = session;
    try {
      // No editor: the terminal side is untouched.
      rmSync(bundle('Visual Studio Code'), { recursive: true });
      rmSync(bundle('Cursor'), { recursive: true });
      await openWorkspaceMenu(page, launcher.path, ['Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
      const noEditor = await openSubmenu(page, 'Open in editor');
      expect(trimmed(await noEditor.allInnerTexts())).toEqual(['No editor found']);
      expect(await noEditor.first().isDisabled()).toBe(true);
      expect(await submenuTexts(page, 'Open in terminal')).toEqual(['Terminal', 'Ghostty']);
      await closeMenus(page);

      // No terminal either.
      rmSync(bundle('Terminal'), { recursive: true });
      rmSync(bundle('Ghostty'), { recursive: true });
      await openWorkspaceMenu(page, launcher.path, ['Reveal in Finder', 'Open in editor', 'Open in terminal']);
      const noTerminal = await openSubmenu(page, 'Open in terminal');
      expect(trimmed(await noTerminal.allInnerTexts())).toEqual(['No terminal found']);
      expect(await noTerminal.first().isDisabled()).toBe(true);
      await noTerminal.first().click({ force: true, timeout: UI_TIMEOUT }).catch(() => {});
      await sleep(300);
      expect(openRuns(open)).toHaveLength(7);
    } finally {
      restoreBundles();
    }
  });

  test('open workspace AC9 — reveal and open refuse a project that is not in Cockpit, a path that is not a linked worktree and an app that is not detected, run nothing, and reject from another origin', async () => {
    const { page } = session;
    const runs = openRuns(open);
    const stateBefore = stateSnapshot(session.dataDir);
    const elsewhere = join(repo.parent, 'not-a-worktree');
    mkdirSync(elsewhere, { recursive: true });
    const noProject = (project: string) => ({ status: 'refused', message: `${project} is not a project in Cockpit.` });
    const noWorkspace = (path: string) => ({ status: 'refused', message: `${path} is not a workspace of ${repo.name}.` });

    expect(await workspacesApi(page, 'reveal', ['/no/such/project', '/no/such/project/ws'])).toEqual(noProject('/no/such/project'));
    expect(await workspacesApi(page, 'open', ['/no/such/project', '/no/such/project/ws', 'cursor'])).toEqual(noProject('/no/such/project'));
    expect(await workspacesApi(page, 'reveal', [repo.root, elsewhere])).toEqual(noWorkspace(elsewhere));
    expect(await workspacesApi(page, 'open', [repo.root, elsewhere, 'cursor'])).toEqual(noWorkspace(elsewhere));
    // The main working tree is the project, not a workspace.
    expect(await workspacesApi(page, 'reveal', [repo.root, repo.root])).toEqual(noWorkspace(repo.root));
    expect(await workspacesApi(page, 'open', [repo.root, repo.root, 'cursor'])).toEqual(noWorkspace(repo.root));
    // An app of the catalogue that is not detected, and an id outside it.
    expect(await workspacesApi(page, 'open', [repo.root, launcher.path, 'zed'])).toEqual({ status: 'refused', message: 'Zed is not installed.' });
    expect(await workspacesApi(page, 'open', [repo.root, launcher.path, 'nope'])).toEqual({ status: 'refused', message: 'nope is not installed.' });

    // From another origin the handlers reject.
    const origins = await session.evaluateInMain<Record<string, string>>(`(async () => {
      const handlers = require('electron').ipcMain._invokeHandlers;
      const calls = {
        'workspaces:apps': [],
        'workspaces:reveal': [${JSON.stringify(repo.root)}, ${JSON.stringify(launcher.path)}],
        'workspaces:open': [${JSON.stringify(repo.root)}, ${JSON.stringify(launcher.path)}, 'cursor'],
      };
      const results = {};
      for (const [channel, args] of Object.entries(calls)) {
        const handler = handlers.get(channel);
        if (!handler) { results[channel] = 'no handler'; continue; }
        try {
          await handler({ senderFrame: { url: 'https://example.com/' }, sender: null }, ...args);
          results[channel] = 'resolved';
        } catch {
          results[channel] = 'rejected';
        }
      }
      return results;
    })()`);
    expect(origins).toEqual({ 'workspaces:apps': 'rejected', 'workspaces:reveal': 'rejected', 'workspaces:open': 'rejected' });

    await sleep(300);
    expect(openRuns(open)).toEqual(runs);
    expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
    expect(await messagesShown(page)).toEqual([]);
  });

  test('open workspace AC8 — a run that exits non-zero shows "Could not open … in <app>: <reason>" or "Could not reveal … in the Finder: <reason>" in the Projects message slot, remembers nothing, and the next success clears it', async () => {
    const { page } = session;
    const menu = ['Open in Cursor', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal'];
    const stateBefore = stateSnapshot(session.dataDir);
    expect(rememberedApps(session.dataDir)).toEqual({ editor: 'cursor', terminal: 'ghostty' });

    // The stderr, trimmed. Another editor than the remembered one: it must not be remembered.
    setOpenOutcome(open, { code: 3, stderr: '  Unable to find application\n\n' });
    await openWorkspaceMenu(page, launcher.path, menu);
    await pickInSubmenu(page, 'Open in editor', 'Visual Studio Code');
    const openMessage = `Could not open ${launcher.path} in Visual Studio Code: Unable to find application`;
    await waitForLine(page, openMessage);
    expect(await isBelowProjectsHeader(page, { text: openMessage })).toBe(true);
    expect(await messagesShown(page)).toEqual([openMessage]);
    await sleep(300);
    expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
    await openWorkspaceMenu(page, launcher.path, menu);

    // Empty stderr: the exit code. The next refusal replaces the message.
    setOpenOutcome(open, { code: 5 });
    await pickTopItem(page, 'Reveal in Finder');
    const revealMessage = `Could not reveal ${launcher.path} in the Finder: open exited with code 5`;
    await waitForLine(page, revealMessage);
    expect(await messagesShown(page)).toEqual([revealMessage]);

    // A reveal that succeeds clears it.
    setOpenOutcome(open);
    await openWorkspaceMenu(page, launcher.path, menu);
    await pickTopItem(page, 'Reveal in Finder');
    await poll(() => messagesShown(page), (found) => found.length === 0, UI_TIMEOUT);
    expect(await messagesShown(page)).toEqual([]);

    // An open that fails with an empty stderr, then an open that succeeds.
    setOpenOutcome(open, { code: 2 });
    await openWorkspaceMenu(page, launcher.path, menu);
    await pickTopItem(page, 'Open in Ghostty');
    await waitForLine(page, `Could not open ${launcher.path} in Ghostty: open exited with code 2`);
    setOpenOutcome(open);
    await openWorkspaceMenu(page, launcher.path, menu);
    await pickTopItem(page, 'Open in Cursor');
    await poll(() => messagesShown(page), (found) => found.length === 0, UI_TIMEOUT);
    expect(await messagesShown(page)).toEqual([]);

    expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
    expect(rememberedApps(session.dataDir)).toEqual({ editor: 'cursor', terminal: 'ghostty' });
  });

  // A folder named `state.json.tmp` makes `saveState` fail after the run succeeded.
  test('open workspace AC10 — when the run succeeds and the save fails, the Projects message slot shows "Cockpit could not save its data: …", state.json is unchanged and so is the remembered app', async () => {
    const { page } = session;
    const menu = ['Open in Cursor', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal'];
    setOpenOutcome(open);
    const runs = openRuns(open).length;
    const blocker = join(session.dataDir, 'state.json.tmp');
    mkdirSync(blocker);
    try {
      const stateBefore = stateSnapshot(session.dataDir);
      await openWorkspaceMenu(page, launcher.path, menu);
      await pickInSubmenu(page, 'Open in editor', 'Visual Studio Code');

      const lines = await poll(() => messagesShown(page), (found) => found.length > 0, UI_TIMEOUT);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Cockpit could not save its data: .*EISDIR/);
      expect(await isBelowProjectsHeader(page, { text: lines[0]! })).toBe(true);
      expect(openRuns(open)).toHaveLength(runs + 1);
      expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
      expect(statSync(blocker).isDirectory()).toBe(true);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }

    // The remembered editor in memory is still Cursor.
    await openWorkspaceMenu(page, launcher.path, menu);
  });

  // --- Setup before an agent session (COCKPIT-32). The stub `claude` logs every run in `fx.runLog`,
  // and `mark.sh <text>` appends a line to the same log, so the order of a setup's last command and
  // the stub's start shows in it. The tests run in order on this launch, with the repository above.

  // Creates a workspace with Claude Code and a prompt through the dialog and returns its path. The
  // page it leaves is the caller's to wait for.
  async function createWorkspaceWithSetup(name: string, prompt: string): Promise<string> {
    const { page } = session;
    writeScripts(repo, { 'mark.sh': `echo "$1" >> '${fx.runLog}'\n` });
    const dialog = await openNewWorkspaceDialog(page, repo);
    await fillNewWorkspace(page, dialog, { name, agent: 'Claude Code', prompt });
    await createButton(dialog).click({ timeout: UI_TIMEOUT });
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
    return worktreePath(session, repo, name);
  }

  const storedIn = (directory: string) => sessionsInState(session.dataDir).filter((entry) => entry.directory === directory);

  // Nothing of the agent ran: no stub process, no run of it, no stored session.
  function expectNoSessionStarted(before: { pids: number[]; runs: string[] }, directory: string) {
    expect(stubPids(fx)).toEqual(before.pids);
    expect(startRuns(fx)).toEqual(before.runs);
    expect(storedIn(directory)).toEqual([]);
  }

  test('workspace scripts AC5 — with the setup page shown, no session starts until the setup exited; then the stub runs in the worktree with the prompt and the session page opens', async () => {
    const { page } = session;
    writeConfig(repo, {
      setup: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" go-s5', 'sh "$COCKPIT_ROOT_PATH/mark.sh" setup-done'],
    });
    const before = { pids: stubPids(fx), runs: startRuns(fx) };

    const path = await createWorkspaceWithSetup('setup-then-agent', 'do the thing');

    await setupHeading(page, 'setup-then-agent').waitFor({ timeout: UI_TIMEOUT });
    await startedWaiter(repo, 'go-s5');
    await sleep(500);
    expectNoSessionStarted(before, path);
    expect(existsSync(path)).toBe(true);
    expect(new URL(page.url()).pathname).toBe('/setup');

    release(repo, 'go-s5');
    const id = await waitForSessionPage(page, undefined, 'Claude Code 1');

    const stub = await readStub(page);
    expect(stub.cwd).toBe(path);
    expect(stub.argCount).toBe(1);
    expect(stub.args).toBe('do the thing');
    expect(waiters(repo, 'go-s5')).toEqual([]);
    // The last command of the setup ran before the stub did.
    expect(startRuns(fx).slice(before.runs.length)).toEqual(['setup-done', 'claude do the thing']);
    expect(await waitForWorkspaceLinks(page, path, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
    expect(await waitForSetupStatus(page, path, 'Done')).toBe('Done');
    expect(await setupAboveSessions(page, path)).toBe(true);
    expect(storedIn(path)).toEqual([
      { id, name: 'Claude Code 1', harness: 'claude-code', directory: path, project: repo.root, createdAt: expect.any(String) },
    ]);
  }, 60_000);

  test('workspace scripts AC5 — when the user has left the setup page, the session still starts in the worktree with the prompt, the page does not change and the session is listed under the workspace', async () => {
    const { page } = session;
    writeConfig(repo, { setup: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" go-s5b'] });
    const before = { pids: stubPids(fx), runs: startRuns(fx) };

    const path = await createWorkspaceWithSetup('setup-left', 'run it');
    await setupHeading(page, 'setup-left').waitFor({ timeout: UI_TIMEOUT });
    await startedWaiter(repo, 'go-s5b');
    await goHome(page);
    expectNoSessionStarted(before, path);

    release(repo, 'go-s5b');
    await poll(() => startRuns(fx).slice(before.runs.length), (runs) => runs.includes('claude run it'), UI_TIMEOUT);
    expect(await waitForWorkspaceLinks(page, path, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);

    // The page it was on did not change.
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await page.getByRole('heading', { name: 'Home', exact: true }).isVisible()).toBe(true);
    const [stored] = storedIn(path);
    expect(stored).toMatchObject({ name: 'Claude Code 1', directory: path, project: repo.root });
    expect(await waitForSetupStatus(page, path, 'Done')).toBe('Done');
  }, 60_000);

  test('workspace scripts AC6, AC7 — a failing setup starts no session and keeps the workspace; Retry setup reads the config again, replaces the terminal, fails again with both buttons, then starts the session once the setup passes', async () => {
    const { page } = session;
    const count = 'echo run >> "$COCKPIT_ROOT_PATH/runs-s7"; wc -l < "$COCKPIT_ROOT_PATH/runs-s7"';
    const check = 'test -f "$COCKPIT_ROOT_PATH/ok-s7" || exit 6';
    writeConfig(repo, { setup: [count, check] });
    const before = { pids: stubPids(fx), runs: startRuns(fx) };

    const path = await createWorkspaceWithSetup('setup-fails', 'p7');

    await setupHeading(page, 'setup-fails').waitFor({ timeout: UI_TIMEOUT });
    await page.getByText('Setup failed with exit code 6').waitFor({ timeout: UI_TIMEOUT });
    expect(await retryButton(page).count()).toBe(1);
    expect(await startAnywayButton(page).count()).toBe(1);
    expect(await waitForSetupStatus(page, path, 'Failed')).toBe('Failed');
    await sleep(300);
    expectNoSessionStarted(before, path);
    expect(linkedWorktrees(repo)).toContainEqual({ path, branch: 'setup-fails' });
    expect(localBranches(repo)).toContain('setup-fails');
    expect(await entryTitles(page)).toContain(path);
    expect(await sessionLinks(page, { workspace: path })).toEqual([]);

    // Still failing: the new terminal replaces the old one (its counter says 2, the check is shown once).
    await retryButton(page).click({ timeout: UI_TIMEOUT });
    await waitForRow(page, /^\s*2$/);
    await page.getByText('Setup failed with exit code 6').waitFor({ timeout: UI_TIMEOUT });
    expect(await retryButton(page).count()).toBe(1);
    expect(await startAnywayButton(page).count()).toBe(1);
    expect((await terminalRows(page)).filter((row) => row === `$ ${check}`)).toHaveLength(1);
    expect(await visiblePanes(page)).toHaveLength(1);
    expectNoSessionStarted(before, path);

    // The config is read again: a command added now runs after the check passes.
    writeConfig(repo, { setup: [count, check, 'echo reread >> "$COCKPIT_ROOT_PATH/runs-s7"'] });
    writeFileSync(join(repo.root, 'ok-s7'), '');
    await retryButton(page).click({ timeout: UI_TIMEOUT });
    await waitForSessionPage(page, undefined, 'Claude Code 1');

    const stub = await readStub(page);
    expect(stub.cwd).toBe(path);
    expect(stub.args).toBe('p7');
    expect(readFileSync(join(repo.root, 'runs-s7'), 'utf8').split('\n').filter(Boolean)).toEqual(['run', 'run', 'run', 'reread']);
    expect(startRuns(fx).filter((run) => run === 'claude p7')).toHaveLength(1);
    expect(await waitForSetupStatus(page, path, 'Done')).toBe('Done');
    expect(storedIn(path)).toHaveLength(1);
  }, 60_000);

  test('workspace scripts AC6, AC8 — Start anyway starts the session in the worktree with the prompt and opens its page; the link stays Failed, the setup page then offers Retry setup only, and a successful retry starts no second session', async () => {
    const { page } = session;
    writeConfig(repo, { setup: ['test -f "$COCKPIT_ROOT_PATH/ok-s8" || exit 8'] });
    const before = { pids: stubPids(fx), runs: startRuns(fx) };

    const path = await createWorkspaceWithSetup('setup-anyway', 'p8');
    await setupHeading(page, 'setup-anyway').waitFor({ timeout: UI_TIMEOUT });
    await page.getByText('Setup failed with exit code 8').waitFor({ timeout: UI_TIMEOUT });
    expectNoSessionStarted(before, path);

    const previous = sessionIdOf(page);
    await startAnywayButton(page).click({ timeout: UI_TIMEOUT });
    await waitForSessionPage(page, previous, 'Claude Code 1');
    const stub = await readStub(page);
    expect(stub.cwd).toBe(path);
    expect(stub.argCount).toBe(1);
    expect(stub.args).toBe('p8');
    expect(await waitForSetupStatus(page, path, 'Failed')).toBe('Failed');

    await openSetupLink(page, path);
    await setupHeading(page, 'setup-anyway').waitFor({ timeout: UI_TIMEOUT });
    await page.getByText('Setup failed with exit code 8').waitFor({ timeout: UI_TIMEOUT });
    expect(await retryButton(page).count()).toBe(1);
    expect(await startAnywayButton(page).count()).toBe(0);

    writeFileSync(join(repo.root, 'ok-s8'), '');
    await retryButton(page).click({ timeout: UI_TIMEOUT });
    await page.getByText('Setup finished').waitFor({ timeout: UI_TIMEOUT });
    expect(await waitForSetupStatus(page, path, 'Done')).toBe('Done');
    // Still the setup page, and no second session: one stub run, one stored session, one link.
    expect(new URL(page.url()).pathname).toBe('/setup');
    await sleep(500);
    expect(startRuns(fx).filter((run) => run === 'claude p8')).toHaveLength(1);
    expect(storedIn(path)).toHaveLength(1);
    expect(await waitForWorkspaceLinks(page, path, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
  }, 60_000);

  // The sidebar list scrolls once it holds this many rows, and its scrollbar then covers the "…" trigger
  // of the project row (Playwright's click on it hits the list). The tests below open that menu, so they
  // start from a project without workspaces: removed through the API (the sessions stay in state.json,
  // hidden), then the list is read again.
  async function removeAllWorkspaces() {
    const { page } = session;
    await page.evaluate(async (project) => {
      const { api } = globalThis as unknown as {
        api: {
          projects: { list(): Promise<{ path: string; workspaces: { path: string }[] }[]> };
          workspaces: { remove(project: string, path: string, options: { force: boolean }): Promise<unknown> };
        };
      };
      const found = (await api.projects.list()).find((entry) => entry.path === project);
      for (const workspace of found?.workspaces ?? []) await api.workspaces.remove(project, workspace.path, { force: true });
    }, repo.root);
    await dispatchFocus(page);
    await waitForEntries(page, [repo.root]);
  }

  test('workspace scripts AC10 — with an agent chosen, a config readWorkspaceConfig refuses starts no session: the setup page shows the message with Retry setup and Start anyway, and once the file is fixed Retry setup starts the session', async () => {
    const { page } = session;
    await removeAllWorkspaces();
    writeConfig(repo, { run: ['bun dev'] });
    const before = { pids: stubPids(fx), runs: startRuns(fx) };

    const path = await createWorkspaceWithSetup('setup-bad-config', 'p10');

    await setupHeading(page, 'setup-bad-config').waitFor({ timeout: UI_TIMEOUT });
    const refused = await runCommandsApi(page, repo.root, path, 'setup');
    expect(refused.status).toBe('refused');
    expect(refused.message).toContain('config.json');
    await page.getByText(refused.message!).first().waitFor({ timeout: UI_TIMEOUT });
    expect(await page.getByText('Setup failed with exit code').count()).toBe(0);
    expect(await retryButton(page).count()).toBe(1);
    expect(await startAnywayButton(page).count()).toBe(1);
    expect(await waitForSetupStatus(page, path, 'Failed')).toBe('Failed');
    await sleep(300);
    expect(new URL(page.url()).pathname).toBe('/setup');
    expectNoSessionStarted(before, path);
    expect(existsSync(path)).toBe(true);
    expect(await entryTitles(page)).toContain(path);
    expect(await sessionLinks(page, { workspace: path })).toEqual([]);

    writeConfig(repo, { setup: ['echo fixed-config'] });
    await retryButton(page).click({ timeout: UI_TIMEOUT });
    await waitForSessionPage(page, undefined, 'Claude Code 1');
    const stub = await readStub(page);
    expect(stub.cwd).toBe(path);
    expect(stub.args).toBe('p10');
    expect(startRuns(fx).filter((run) => run === 'claude p10')).toHaveLength(1);
    expect(storedIn(path)).toHaveLength(1);
  }, 60_000);

  test('workspace scripts AC5, AC6 — Ctrl+C in the setup terminal is a failure, not a success: "Setup ended before it finished." with both buttons, and no session starts', async () => {
    const { page } = session;
    writeConfig(repo, { setup: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-sig-setup'] });
    const before = { pids: stubPids(fx), runs: startRuns(fx) };

    const path = await createWorkspaceWithSetup('setup-signal', 'p-signal');
    await setupHeading(page, 'setup-signal').waitFor({ timeout: UI_TIMEOUT });
    const pid = await startedWaiter(repo, 'never-sig-setup');
    await focusTerminal(page);
    await page.keyboard.press('Control+c');

    await page.getByText('Setup ended before it finished.').waitFor({ timeout: UI_TIMEOUT });
    expect(await endsWithin(pid)).toBe(true);
    expect(await page.getByText('Setup finished').count()).toBe(0);
    expect(await retryButton(page).count()).toBe(1);
    expect(await startAnywayButton(page).count()).toBe(1);
    expect(await waitForSetupStatus(page, path, 'Failed')).toBe('Failed');
    await sleep(300);
    expect(new URL(page.url()).pathname).toBe('/setup');
    expectNoSessionStarted(before, path);
    expect(existsSync(path)).toBe(true);
    expect(await sessionLinks(page, { workspace: path })).toEqual([]);
  }, 60_000);

  test('logs no error and keeps running', async () => {
    expect(await sidebarLines(session.page)).toContain('Sessions');
    await expectNoErrors(session);
    // The endpoint started: the "off" line belongs to the launch that provokes it.
    expect(session.output()).not.toContain("Cockpit's background service could not start");
  });
});

// --- Changes sidebar (COCKPIT-34) --------------------------------------------

const changesToggle = (page: Page) => page.getByRole('button', { name: 'Changes', exact: true });

const PANEL = '[data-test-changes-panel]';

// The right sidebar has no test hook and no role the tests could rely on: it is the element 360 px
// wide against the window's right edge that shows "Changes". Marks it (and only it) so locators can be
// scoped to it, and says whether it was found.
const markChangesPanel = (page: Page) =>
  page.evaluate((marker) => {
    for (const marked of document.querySelectorAll(marker)) marked.removeAttribute(marker.slice(1, -1));
    const panel = [...document.querySelectorAll<HTMLElement>('body *')].find((element) => {
      const box = element.getBoundingClientRect();
      return (
        Math.abs(box.width - 360) <= 1 &&
        Math.abs(box.right - window.innerWidth) <= 1 &&
        box.height > 100 &&
        (element.textContent ?? '').includes('Changes')
      );
    });
    panel?.setAttribute(marker.slice(1, -1), '');
    return panel !== undefined;
  }, PANEL);

const panelBox = async (page: Page) => ((await markChangesPanel(page)) ? page.locator(PANEL).boundingBox() : null);

// Runs `read` in the page on the sidebar, `null` when it is not open.
async function panelEval<T, A>(page: Page, read: (panel: HTMLElement, arg: A) => T, arg: A): Promise<T | null> {
  if (!(await markChangesPanel(page))) return null;
  return page
    .locator(PANEL)
    .evaluate(read as unknown as (panel: HTMLElement | SVGElement, arg: unknown) => T, arg, { timeout: 2_000 })
    .catch(() => null);
}

const panelText = async (page: Page) => (await panelEval(page, (panel) => panel.innerText, null)) ?? '';

const waitForPanelText = (page: Page, matches: (text: string) => boolean, timeout = UI_TIMEOUT) =>
  poll(() => panelText(page), matches, timeout);

// The sidebar's hunk headers (`@@ … @@`).
const hunkHeaders = async (page: Page) =>
  (await panelEval(
    page,
    (panel) => {
      const pattern = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/;
      const text = (element: Element) => (element.textContent ?? '').trim();
      return [...panel.querySelectorAll('*')]
        .filter((element) => pattern.test(text(element)) && ![...element.children].some((child) => pattern.test(text(child))))
        .map(text);
    },
    null,
  )) ?? [];

interface FileRow {
  /** The row's text, one entry per word, with "−" read as "-". */
  tokens: string[];
  /** The computed color of each piece of text of the row, by its text. */
  colors: Record<string, string>;
}

// The row of the file list that shows the file name `name`: its text pieces and their colors. The first
// match in document order is the list's (the diff area comes after it). `others` are the names of the
// other rows, which tell where the row ends.
const fileRow = (page: Page, name: string, others: string[]) =>
  panelEval(
    page,
    (panel, { name, others }): { tokens: string[]; colors: Record<string, string> } | null => {
      const text = (element: Element) => (element.textContent ?? '').trim();
      const leaves = [...panel.querySelectorAll<HTMLElement>('*')].filter((element) => element.children.length === 0 && text(element) !== '');
      const shows = (leaf: Element, wanted: string) => text(leaf) === wanted || text(leaf).startsWith(`${wanted} `);
      const nameLeaf = leaves.find((leaf) => shows(leaf, name));
      if (!nameLeaf) return null;
      let row: HTMLElement = nameLeaf;
      while (row.parentElement && row.parentElement !== panel) {
        const parent: HTMLElement = row.parentElement;
        if (others.some((other) => leaves.some((leaf) => parent.contains(leaf) && shows(leaf, other)))) break;
        row = parent;
      }
      const inRow = leaves.filter((leaf) => row.contains(leaf));
      return {
        tokens: inRow.flatMap((leaf) => text(leaf).split(/\s+/)).map((token) => token.replace(/−/g, '-')),
        colors: Object.fromEntries(inRow.map((leaf) => [text(leaf), getComputedStyle(leaf).color])),
      };
    },
    { name, others },
  ) as Promise<FileRow | null>;

// The names of the files the list shows, with their status letters and counts, for a workspace
// whose files are `names`.
const listedNames = async (page: Page, names: string[]) => {
  const rows = await Promise.all(names.map(async (name) => [name, await fileRow(page, name, names.filter((other) => other !== name))] as const));
  return rows.filter(([, row]) => row !== null).map(([name]) => name);
};

interface DiffLineFacts {
  /** Whether the line or one of its containers is painted with the `--diff-added` token (background or text). */
  added: boolean;
  /** The same for `--diff-removed`. */
  removed: boolean;
}

// One line of the diff: its text is the line number, the `+`, `-` or space prefix and the content
// (whitespace ignored, "−" read as "-"). `null` when no element shows it.
const diffLine = (page: Page, number: number, prefix: '+' | '-' | ' ', content: string) =>
  panelEval(
    page,
    (panel, expected): DiffLineFacts | null => {
      const normalise = (text: string) => text.replace(/\s+/g, '').replace(/−/g, '-');
      const token = (name: string, property: 'color' | 'backgroundColor') => {
        const probe = document.createElement('span');
        if (property === 'color') probe.style.color = `var(${name})`;
        else probe.style.backgroundColor = `var(${name})`;
        document.body.append(probe);
        const value = getComputedStyle(probe)[property];
        probe.remove();
        return value;
      };
      const matches = [...panel.querySelectorAll<HTMLElement>('*')].filter((element) => normalise(element.textContent ?? '') === expected);
      const line = matches.find((element) => !matches.some((other) => other !== element && element.contains(other)));
      if (!line) return null;
      const chain: HTMLElement[] = [];
      for (let node: HTMLElement | null = line; node && node !== panel.parentElement; node = node.parentElement) chain.push(node);
      // A token the page does not define would resolve to the inherited text color: it paints nothing.
      const painted = (name: string) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() !== '' &&
        chain.some((node) => {
          const style = getComputedStyle(node);
          return style.backgroundColor === token(name, 'backgroundColor') || style.color === token(name, 'color');
        });
      return { added: painted('--diff-added'), removed: painted('--diff-removed') };
    },
    `${number}${prefix === ' ' ? '' : prefix}${content}`.replace(/\s+/g, ''),
  ) as Promise<DiffLineFacts | null>;

const waitForDiffLine = (page: Page, number: number, prefix: '+' | '-' | ' ', content: string, timeout = UI_TIMEOUT) =>
  poll(() => diffLine(page, number, prefix, content), (facts) => facts !== null, timeout);

// Opens (or closes) the sidebar through the toggle in the page header and waits for it.
async function setChangesOpen(page: Page, open: boolean) {
  const toggle = changesToggle(page);
  await toggle.waitFor({ timeout: UI_TIMEOUT });
  if ((await toggle.getAttribute('aria-pressed')) !== String(open)) await toggle.click({ timeout: UI_TIMEOUT });
  await poll(() => toggle.getAttribute('aria-pressed'), (pressed) => pressed === String(open), UI_TIMEOUT);
  const found = await poll(() => markChangesPanel(page), (shown) => shown === open, UI_TIMEOUT);
  expect(found, open ? 'the Changes sidebar opens' : 'the Changes sidebar closes').toBe(open);
}

// Clicks the file `name` in the sidebar's list.
async function selectChangedFile(page: Page, name: string) {
  expect(await markChangesPanel(page)).toBe(true);
  await page.locator(PANEL).getByText(name, { exact: true }).first().click({ timeout: UI_TIMEOUT });
}

// Opens a session's page through its link in the left sidebar.
async function openSessionById(page: Page, id: string) {
  await page.locator(`a[href="/sessions/${id}"]`).first().click({ timeout: UI_TIMEOUT });
  await poll(() => sessionIdOf(page), (current) => current === id, UI_TIMEOUT);
}

// A repository whose files give the sidebar something to show: `a.txt` (20 lines), `c.txt` (3), `d.txt` (10)
// besides `README.md` and `src/main.ts`.
function makeChangesRepo(name: string): TempRepo {
  const repo = makeRepo(name);
  const numbered = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join('');
  writeFileSync(join(repo.root, 'a.txt'), numbered('line', 20));
  writeFileSync(join(repo.root, 'c.txt'), numbered('c', 3));
  writeFileSync(join(repo.root, 'd.txt'), numbered('d', 10));
  gitIn(repo.root, 'add', '.');
  gitIn(repo.root, 'commit', '-m', 'files for the changes sidebar');
  return repo;
}

// Every kind of change in a worktree of `makeChangesRepo`, uncommitted: `a.txt` edited in two places
// (two hunks), `src/main.ts` edited, `c.txt` deleted, `d.txt` renamed to `e.txt`, an untracked `new.txt`, a
// binary `bin.dat` and a `big.txt` whose diff is over 1 MiB. Listed by path: a.txt, big.txt, bin.dat, c.txt,
// e.txt, new.txt, src/main.ts.
const CHANGED_NAMES = ['a.txt', 'big.txt', 'bin.dat', 'c.txt', 'e.txt', 'new.txt', 'main.ts'];
function writeChanges(worktree: string) {
  const a = readFileSync(join(worktree, 'a.txt'), 'utf8').replace(/^line 2$/m, 'line two').replace(/^line 18$/m, 'line eighteen');
  writeFileSync(join(worktree, 'a.txt'), a);
  writeFileSync(join(worktree, 'src', 'main.ts'), 'export const answer = 42;\n');
  rmSync(join(worktree, 'c.txt'));
  renameSync(join(worktree, 'd.txt'), join(worktree, 'e.txt'));
  writeFileSync(join(worktree, 'new.txt'), 'alpha\nbeta\n');
  writeFileSync(join(worktree, 'bin.dat'), Buffer.from([0, 1, 2]));
  writeFileSync(join(worktree, 'big.txt'), `${'x'.repeat(79)}\n`.repeat(15_000));
}

interface ChangesApi {
  workspaces: {
    changes(project: string, path: string): Promise<unknown>;
    diff(project: string, path: string, file: unknown): Promise<unknown>;
    watch(project: string, path: string, listener: () => void): (() => void) | Promise<() => void>;
  };
}
type ChangesWindow = Window & { api: ChangesApi; __changedEvents?: number; __stopWatching?: () => void };

const changesApi = (page: Page, method: 'changes' | 'diff', project: string, path: string) =>
  page.evaluate(
    ([method, project, path]) => {
      const { workspaces } = (window as unknown as ChangesWindow).api;
      return method === 'changes'
        ? workspaces.changes(project!, path!)
        : workspaces.diff(project!, path!, { path: 'a.txt', status: 'modified', additions: 1, deletions: 1 });
    },
    [method, project, path] as const,
  );

// Starts `window.api.workspaces.watch` in the page and counts the `changed` events it delivers.
const startWatching = (page: Page, project: string, path: string) =>
  page.evaluate(
    async ([project, path]) => {
      const w = window as unknown as ChangesWindow;
      w.__changedEvents = 0;
      w.__stopWatching = await w.api.workspaces.watch(project!, path!, () => {
        w.__changedEvents = (w.__changedEvents ?? 0) + 1;
      });
    },
    [project, path] as const,
  );
const changedEvents = (page: Page) => page.evaluate(() => (window as unknown as ChangesWindow).__changedEvents ?? 0);
const stopWatching = (page: Page) => page.evaluate(() => (window as unknown as ChangesWindow).__stopWatching?.());

// The git runs the wrapper logged that mention `folder` (as working directory or argument).
const gitRunsIn = (fx: SessionsFixture, folder: string) =>
  readFileSync(fx.gitLog, 'utf8').split('\n').filter((line) => line.includes(folder));

// What the smoke paths check on a workspace page: a file the test writes in the worktree shows in the
// sidebar's list with its diff.
async function expectChangesShowNewFile(page: Page, worktree: string) {
  await setChangesOpen(page, true);
  writeFileSync(join(worktree, 'smoke-changes.txt'), 'hello from the smoke path\n');
  await poll(() => listedNames(page, ['smoke-changes.txt']), (names) => names.length === 1, UI_TIMEOUT);
  expect(await listedNames(page, ['smoke-changes.txt'])).toEqual(['smoke-changes.txt']);
  expect(await waitForDiffLine(page, 1, '+', 'hello from the smoke path')).not.toBeNull();
}

// --- Ship a workspace: commit, push, pull request, cleanup (COCKPIT-38) --------
//
// The contract of the five new `window.api.workspaces` calls these tests use, beyond the spec's:
// `status(project, path)`, `commit(project, path, message)`, `push(project, path)`,
// `pullRequest(project, path)` and `createPullRequest(project, path, title, body)`, each resolving to
// `{ status: 'refused', message }` on a refusal.

// The git the app runs ignores the developer's configuration (a signing key, a global hook) and has an
// identity of its own, so a commit made through the sidebar works on any machine.
const GIT_APP_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const PR_URL = 'https://github.test/acme/app/pull/7';

type PrChecks = 'none' | 'pending' | 'passing' | 'failing' | 'unknown';
const ROLLUPS: Record<PrChecks, object[]> = {
  none: [],
  pending: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }],
  passing: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  failing: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
  unknown: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STALE' }],
};

// What `gh pr list --json …` prints for one pull request.
const prJson = ({ state = 'OPEN', checks = 'none', title = 'Fix the bug' }: { state?: string; checks?: PrChecks; title?: string } = {}) =>
  JSON.stringify([{ number: 7, title, url: PR_URL, state, statusCheckRollup: ROLLUPS[checks] }]);

interface GhFixture {
  /** The folder whose files set how the stub `gh` answers. */
  control: string;
  /** The file the stub appends every run to. */
  log: string;
}

// A stub `gh` on the fake login shell's `PATH` (the real one would reach GitHub). Every run is logged
// (fields separated by US, runs by RS, so a multi-line argument survives): the working directory,
// GH_PROMPT_DISABLED, then the arguments. `pr list` prints `pr-list` (`[]` without it) after failing as
// `code` and `stderr` say; `pr create` fails with `create-stderr`, else copies `after-create` over
// `pr-list` and prints a URL.
function addGhFixture(fx: SessionsFixture): GhFixture {
  const control = join(fx.root, 'gh-control');
  mkdirSync(control);
  const log = join(fx.root, 'gh.log');
  const stub = join(fx.bin, 'gh');
  writeFileSync(
    stub,
    `#!/bin/sh
printf '%s\\037' "$(pwd -P)" "$GH_PROMPT_DISABLED" "$@" >> '${log}'
printf '\\036' >> '${log}'
if [ "$1 $2" = "pr create" ]; then
  if [ -s '${control}/create-stderr' ]; then cat '${control}/create-stderr' >&2; exit 1; fi
  [ -e '${control}/after-create' ] && cp '${control}/after-create' '${control}/pr-list'
  echo '${PR_URL}'
  exit 0
fi
[ -s '${control}/stderr' ] && cat '${control}/stderr' >&2
[ -e '${control}/code' ] && exit "$(cat '${control}/code')"
if [ -e '${control}/pr-list' ]; then cat '${control}/pr-list'; else echo '[]'; fi
`,
  );
  chmodSync(stub, 0o755);
  // macOS scans a new executable the first time it runs; the run is not counted.
  execFileSync(stub, ['--warmup']);
  writeFileSync(log, '');
  return { control, log };
}

// How the stub answers from now on: everything not given is back to the default (`[]`, exit 0).
function setGh(
  gh: GhFixture,
  { list, code, stderr, createStderr, afterCreate }: { list?: string; code?: number; stderr?: string; createStderr?: string; afterCreate?: string } = {},
) {
  for (const name of ['pr-list', 'code', 'stderr', 'create-stderr', 'after-create']) rmSync(join(gh.control, name), { force: true });
  const files = { 'pr-list': list, code: code?.toString(), stderr, 'create-stderr': createStderr, 'after-create': afterCreate };
  for (const [name, content] of Object.entries(files)) if (content !== undefined) writeFileSync(join(gh.control, name), content);
}

interface GhRun {
  cwd: string;
  /** `GH_PROMPT_DISABLED` as the stub saw it. */
  prompt: string;
  args: string[];
}
const ghRuns = (gh: GhFixture): GhRun[] =>
  readFileSync(gh.log, 'utf8')
    .split('\x1e')
    .filter(Boolean)
    .map((run) => {
      const [cwd, prompt, ...args] = run.split('\x1f').slice(0, -1);
      return { cwd: cwd!, prompt: prompt!, args };
    });

// `origin`: a bare repository next to `repo`, holding `main`. Returns its path.
function addOrigin(repo: TempRepo): string {
  const origin = join(repo.parent, `${repo.name}-origin.git`);
  gitIn(repo.parent, 'init', '--quiet', '--bare', '-b', 'main', origin);
  gitIn(repo.root, 'remote', 'add', 'origin', origin);
  gitIn(repo.root, 'push', '--quiet', 'origin', 'main');
  gitIn(repo.root, 'fetch', '--quiet', 'origin');
  return origin;
}

// A branch's commit in a bare repository, '' when it has none.
const remoteRef = (origin: string, branch: string) => {
  try {
    return gitIn(origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  } catch {
    return '';
  }
};

const shipButton = (page: Page, name: string) => page.locator(PANEL).getByRole('button', { name, exact: true });
const commitField = (page: Page) => page.locator(PANEL).getByRole('textbox', { name: 'Commit message', exact: true });
const prDialog = (page: Page) => page.getByRole('dialog', { name: 'Create pull request' });

// Waits until the sidebar's text satisfies `matches`, and fails when it does not within `timeout`.
async function waitForShipText(page: Page, matches: (text: string) => boolean, timeout = 5_000) {
  const text = await waitForPanelText(page, matches, timeout);
  expect(matches(text), `the sidebar does not show the expected text, it shows:\n${text}`).toBe(true);
  return text;
}

// Waits until the sidebar lists exactly `names` among `names` (the files the test wrote or removed).
async function expectListed(page: Page, names: string[], expected: string[]) {
  const listed = await poll(() => listedNames(page, names), (found) => JSON.stringify(found) === JSON.stringify(expected), UI_TIMEOUT);
  expect(listed).toEqual(expected);
}

// Opens a session's page and its Changes sidebar.
async function openShip(page: Page, sessionId: string) {
  await openSessionById(page, sessionId);
  await setChangesOpen(page, true);
}

// Types `message` in the commit field and presses "Commit".
async function commitThroughPanel(page: Page, message: string) {
  await commitField(page).fill(message);
  await shipButton(page, 'Commit').click({ timeout: UI_TIMEOUT });
}

// The smoke path of the dev server and the packaged app, on a workspace page whose Changes sidebar is
// open with an uncommitted file, in a repository with a local bare `origin`: a pull request the stub
// answers shows in the sidebar, then a commit and a push reach `origin`.
async function expectShipSmoke(page: Page, gh: GhFixture, worktree: string, origin: string, branch: string) {
  setGh(gh, { list: prJson({ checks: 'pending' }) });
  await dispatchFocus(page);
  await page.locator(PANEL).getByRole('link', { name: '#7 Fix the bug', exact: true }).waitFor({ timeout: UI_TIMEOUT });
  await waitForShipText(page, (text) => text.includes('Checks pending'));

  await commitThroughPanel(page, 'Smoke commit');
  expect(await poll(() => gitIn(worktree, 'log', '-1', '--format=%B'), (subject) => subject === 'Smoke commit', UI_TIMEOUT)).toBe('Smoke commit');
  expect(gitIn(worktree, 'status', '--porcelain')).toBe('');

  await shipButton(page, 'Push').click({ timeout: UI_TIMEOUT });
  const head = gitIn(worktree, 'rev-parse', 'HEAD');
  expect(await poll(() => remoteRef(origin, branch), (ref) => ref === head, UI_TIMEOUT)).toBe(head);
  // `origin` holds the commit before the app's `git push --set-upstream` has finished writing in the
  // repository's `.git` (the remote-tracking ref, its reflog, the upstream in `.git/config`). Return
  // only once the push is done locally, so a caller removing the repository never races it.
  const pushedLocally = () => {
    try {
      return (
        gitIn(worktree, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`) === head &&
        gitIn(worktree, 'config', '--get', `branch.${branch}.remote`) === 'origin' &&
        gitIn(worktree, 'config', '--get', `branch.${branch}.merge`) === `refs/heads/${branch}`
      );
    } catch {
      return false;
    }
  };
  expect(await poll(pushedLocally, Boolean, UI_TIMEOUT), 'the push finished locally: tracking ref and upstream set').toBe(true);
}

describe('changes sidebar: built app', () => {
  let fx: SessionsFixture;
  let gh: GhFixture;
  let session: Session;
  let repo: TempRepo;
  const A = { path: '', id: '' };
  const B = { path: '', id: '' };

  beforeAll(async () => {
    fx = makeSessionsFixture(['claude'], { gitLog: true });
    // A stub `gh` for the ship section (COCKPIT-38).
    gh = addGhFixture(fx);
    repo = makeChangesRepo('changes-ws');
    session = await launchBuiltWith({ ...fx.env(), ...GIT_APP_ENV });
    await session.page.getByText(versionLabel).waitFor();
    await addRepository(session, repo);
    // Two workspaces with a running session each (created through the New workspace dialog, which records the base).
    A.id = await createWorkspaceWithAgent(session.page, repo, { name: 'ws-a', agent: 'Claude Code' }, 'Claude Code 1');
    A.path = worktreePath(session, repo, 'ws-a');
    B.id = await createWorkspaceWithAgent(session.page, repo, { name: 'ws-b', agent: 'Claude Code' }, 'Claude Code 1');
    B.path = worktreePath(session, repo, 'ws-b');
    writeChanges(A.path);
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  test('changes AC9 — the "Changes" toggle docks a 360 px sidebar next to the main area, the terminal refits to the narrower area, and closing it gives the width back', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    const toggle = changesToggle(page);
    await toggle.waitFor({ timeout: UI_TIMEOUT });
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    expect(await markChangesPanel(page)).toBe(false);
    const screen = page.locator('.xterm-screen:visible').first();
    await screen.waitFor({ timeout: UI_TIMEOUT });
    const widthBefore = (await screen.boundingBox())!.width;

    await toggle.click({ timeout: UI_TIMEOUT });
    expect(await toggle.getAttribute('aria-pressed')).toBe('true');
    const panel = await poll(() => panelBox(page), Boolean, UI_TIMEOUT);
    expect(panel, 'a Changes sidebar 360 px wide against the right edge of the window').toBeTruthy();
    const main = (await page.locator('main').boundingBox())!;
    expect(Math.abs(panel!.width - 360)).toBeLessThanOrEqual(1);
    // Docked: the main area ends where the sidebar starts, and both are visible.
    expect(main.width).toBeGreaterThan(0);
    expect(main.x + main.width).toBeLessThanOrEqual(panel!.x + 1);
    expect(Math.abs(main.x + main.width - panel!.x)).toBeLessThanOrEqual(2);
    const narrower = await poll(
      async () => (await screen.boundingBox())!.width,
      (width) => width <= widthBefore - 300,
      UI_TIMEOUT,
    );
    expect(narrower).toBeLessThanOrEqual(widthBefore - 300);

    await toggle.click({ timeout: UI_TIMEOUT });
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    await poll(() => markChangesPanel(page), (shown) => !shown, UI_TIMEOUT);
    expect(await markChangesPanel(page)).toBe(false);
    const restored = await poll(
      async () => (await screen.boundingBox())!.width,
      (width) => Math.abs(width - widthBefore) <= 10,
      UI_TIMEOUT,
    );
    expect(Math.abs(restored - widthBefore)).toBeLessThanOrEqual(10);
  });

  test('changes AC10 — no button and no sidebar on Home, the Terminal page or a session outside any project; back on a workspace page the sidebar shows again, open', async () => {
    const { page } = session;
    await setChangesOpen(page, true);

    await goHome(page);
    expect(await changesToggle(page).count()).toBe(0);
    expect(await markChangesPanel(page)).toBe(false);

    await goToTerminalPage(page);
    expect(await changesToggle(page).count()).toBe(0);
    expect(await markChangesPanel(page)).toBe(false);

    await startSession(page, 'Claude Code', 'Claude Code 1');
    expect(await changesToggle(page).count()).toBe(0);
    expect(await markChangesPanel(page)).toBe(false);

    await openSessionById(page, A.id);
    await changesToggle(page).waitFor({ timeout: UI_TIMEOUT });
    expect(await changesToggle(page).getAttribute('aria-pressed')).toBe('true');
    expect(await poll(() => markChangesPanel(page), Boolean, UI_TIMEOUT)).toBe(true);
    // A reload starts with it closed: see changes AC17 below, which reloads the page.
  });

  test('changes AC11 — the strip, the file list (letter, name, folder, counts), the first file selected with its diff by hunk, a click selecting another file, and "No changes against main." without changes', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await setChangesOpen(page, true);

    const text = (await waitForPanelText(page, (shown) => shown.includes('main.ts'))).replace(/\s+/g, ' ');
    expect(text).toContain('Changes');
    expect(text).toContain('against main');

    const row = async (name: string) => {
      const found = await fileRow(page, name, CHANGED_NAMES.filter((other) => other !== name));
      expect(found, `a row for ${name}`).not.toBeNull();
      return found!;
    };
    const counts = (found: FileRow) => found.tokens.filter((token) => /^[+-]\d+$/.test(token));

    const a = await row('a.txt');
    expect(a.tokens[0]).toBe('M');
    expect(counts(a)).toEqual(['+2', '-2']);
    const big = await row('big.txt');
    expect(big.tokens[0]).toBe('A');
    expect(counts(big)).toEqual(['+15000']);
    const bin = await row('bin.dat');
    expect(bin.tokens[0]).toBe('A');
    expect(counts(bin), 'nothing for a binary file').toEqual([]);
    const c = await row('c.txt');
    expect(c.tokens[0]).toBe('D');
    expect(counts(c)).toEqual(['-3']);
    const e = await row('e.txt');
    expect(e.tokens[0]).toBe('R');
    expect(e.tokens).toContain('d.txt');
    const created = await row('new.txt');
    expect(created.tokens[0]).toBe('A');
    expect(counts(created)).toEqual(['+2']);
    const main = await row('main.ts');
    expect(main.tokens[0]).toBe('M');
    expect(counts(main)).toEqual(['+1', '-1']);
    const folder = main.tokens.find((token) => /^src\/?$/.test(token));
    expect(folder, 'the folder of src/main.ts').toBeTruthy();
    expect(main.colors[folder!]).toBe(await mutedColor(page));
    // Listed by path.
    const order = await page.evaluate((names) => {
      const leaves = [...document.querySelectorAll<HTMLElement>('[data-test-changes-panel] *')].filter((element) => element.children.length === 0);
      return names.map((name) => leaves.findIndex((leaf) => (leaf.textContent ?? '').trim().startsWith(name)));
    }, CHANGED_NAMES);
    expect(order, 'every file is listed, in path order').toEqual([...order].sort((x, y) => x - y));
    expect(order.every((index) => index >= 0)).toBe(true);

    // The first file is selected: its diff, one block per hunk, each line with one number and its prefix.
    const headers = await poll(() => hunkHeaders(page), (found) => found.length === 2, UI_TIMEOUT);
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain('@@ -1,5 +1,5 @@');
    expect(headers[1]).toContain('@@ -15,6 +15,6 @@');
    expect(await diffLine(page, 1, ' ', 'line 1')).toEqual({ added: false, removed: false });
    expect(await diffLine(page, 2, '-', 'line 2')).toEqual({ added: false, removed: true });
    expect(await diffLine(page, 2, '+', 'line two')).toEqual({ added: true, removed: false });
    expect(await diffLine(page, 3, ' ', 'line 3')).toEqual({ added: false, removed: false });
    expect(await diffLine(page, 18, '-', 'line 18')).toEqual({ added: false, removed: true });
    expect(await diffLine(page, 18, '+', 'line eighteen')).toEqual({ added: true, removed: false });

    // Another file: its diff replaces it.
    await selectChangedFile(page, 'new.txt');
    const newHeaders = await poll(() => hunkHeaders(page), (found) => found.length === 1, UI_TIMEOUT);
    expect(newHeaders[0]).toContain('@@ -0,0 +1,2 @@');
    expect(await waitForDiffLine(page, 1, '+', 'alpha')).toEqual({ added: true, removed: false });
    expect(await diffLine(page, 2, '+', 'beta')).toEqual({ added: true, removed: false });
    expect(await diffLine(page, 2, '-', 'line 2')).toBeNull();

    // A workspace without changes.
    await openSessionById(page, B.id);
    await waitForPanelText(page, (shown) => shown.includes('No changes against main.'));
    expect(await panelText(page)).toContain('No changes against main.');
    expect(await hunkHeaders(page)).toEqual([]);
    expect(await listedNames(page, CHANGED_NAMES)).toEqual([]);
  });

  test('changes AC14 — a binary file shows "Binary file" and a diff over 1 MiB "Diff too large to display", with no error logged', async () => {
    const { page } = session;
    const mark = await errorMark(session);
    await openSessionById(page, A.id);
    await setChangesOpen(page, true);
    await waitForPanelText(page, (shown) => shown.includes('bin.dat'));

    await selectChangedFile(page, 'bin.dat');
    await waitForPanelText(page, (shown) => shown.includes('Binary file'));
    expect(await panelText(page)).toContain('Binary file');
    expect(await hunkHeaders(page)).toEqual([]);

    await selectChangedFile(page, 'big.txt');
    await waitForPanelText(page, (shown) => shown.includes('Diff too large to display'));
    expect(await panelText(page)).toContain('Diff too large to display');
    expect(await hunkHeaders(page)).toEqual([]);

    await expectNoNewErrors(session, mark);
  });

  test('changes AC12 — a file written in the worktree appears in the list within 5 s, a line appended to it shows in the diff within 5 s, and removing it takes it out of the list within 5 s', async () => {
    const { page } = session;
    await openSessionById(page, B.id);
    await setChangesOpen(page, true);
    await waitForPanelText(page, (shown) => shown.includes('No changes against main.'));
    const file = join(B.path, 'live.txt');

    writeFileSync(file, 'first\n');
    expect(await poll(() => listedNames(page, ['live.txt']), (names) => names.length === 1, 5_000)).toEqual(['live.txt']);
    expect(await waitForDiffLine(page, 1, '+', 'first', 5_000)).not.toBeNull();

    appendFileSync(file, 'second\n');
    expect(await waitForDiffLine(page, 2, '+', 'second', 5_000)).toEqual({ added: true, removed: false });

    rmSync(file);
    expect(await poll(() => listedNames(page, ['live.txt']), (names) => names.length === 0, 5_000)).toEqual([]);
    await waitForPanelText(page, (shown) => shown.includes('No changes against main.'), 5_000);
  });

  test('changes AC13 — opening the page of a session in workspace B lists B\'s changes, not A\'s', async () => {
    const { page } = session;
    writeFileSync(join(B.path, 'only-b.txt'), 'b\n');
    await openSessionById(page, A.id);
    await setChangesOpen(page, true);
    await waitForPanelText(page, (shown) => shown.includes('main.ts'));
    expect(await listedNames(page, ['a.txt', 'only-b.txt'])).toEqual(['a.txt']);

    await openSessionById(page, B.id);
    const names = await poll(() => listedNames(page, ['a.txt', 'big.txt', 'only-b.txt']), (found) => found.includes('only-b.txt') && !found.includes('a.txt'), UI_TIMEOUT);
    expect(names).toEqual(['only-b.txt']);
    expect(await panelText(page)).toContain('against main');
    rmSync(join(B.path, 'only-b.txt'));
  });

  test('changes AC5 — through window.api.workspaces.changes, a workspace with no recorded base in a repository with no default base is refused with "No base branch to compare <name> with."', async () => {
    const { page } = session;
    const bare = makeRepo('changes-no-base');
    try {
      const path = join(bare.parent, 'wt-no-base');
      gitIn(bare.root, 'worktree', 'add', '--quiet', '-b', 'no-base', path, 'main');
      // Detached in the main working tree and without origin: nothing to default to.
      gitIn(bare.root, 'checkout', '--quiet', '--detach');
      await addRepository(session, bare);

      expect(await changesApi(page, 'changes', bare.root, path)).toEqual({
        status: 'refused',
        message: 'No base branch to compare no-base with.',
      });
      await removeThroughMenu(page, bare.root);
      await poll(() => entryTitles(page), (titles) => !titles.includes(bare.root), UI_TIMEOUT);
    } finally {
      rmSync(bare.parent, { recursive: true, force: true });
    }
  });

  test('changes AC15 — an unknown project or a path that is no linked worktree is refused by changes and diff, and watch sends no event for it', async () => {
    const { page } = session;
    await goHome(page);
    const elsewhere = join(repo.parent, 'not-a-worktree');
    mkdirSync(elsewhere);
    const mark = await errorMark(session);

    for (const method of ['changes', 'diff'] as const) {
      expect(await changesApi(page, method, '/no/such/project', '/no/such/project/ws')).toEqual({
        status: 'refused',
        message: '/no/such/project is not a project in Cockpit.',
      });
      expect(await changesApi(page, method, repo.root, elsewhere)).toEqual({
        status: 'refused',
        message: `${elsewhere} is not a workspace of ${repo.name}.`,
      });
      // The main working tree is the project, not a workspace.
      expect(await changesApi(page, method, repo.root, repo.root)).toEqual({
        status: 'refused',
        message: `${repo.root} is not a workspace of ${repo.name}.`,
      });
    }

    // The same watch on a real workspace delivers events: the refusals below are not a broken listener.
    await startWatching(page, repo.root, B.path);
    writeFileSync(join(B.path, 'watched.txt'), 'x\n');
    expect(await poll(() => changedEvents(page), (count) => count > 0, 5_000)).toBeGreaterThan(0);
    await stopWatching(page);
    rmSync(join(B.path, 'watched.txt'));

    for (const [project, label] of [['/no/such/project', 'unknown project'], [repo.root, 'not a worktree']] as const) {
      await startWatching(page, project, elsewhere);
      writeFileSync(join(elsewhere, `${label.replace(' ', '-')}.txt`), 'x\n');
      await sleep(1_000);
      expect(await changedEvents(page), `no event for ${label}`).toBe(0);
      await stopWatching(page);
    }

    await expectNoNewErrors(session, mark);
  });

  test('changes AC17 (and AC10 for the reload) — closing the sidebar, leaving for a page without it or reloading stops the watcher: a file written afterwards starts no git command in the worktree; opening the sidebar again lists the changes again', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await setChangesOpen(page, true);
    await waitForPanelText(page, (shown) => shown.includes('main.ts'));

    // Control: with the sidebar open, a write does start git commands in the worktree (the wrapper logs them).
    const settleGit = async () => {
      let last = -1;
      await poll(
        async () => {
          const now = gitRunsIn(fx, A.path).length;
          const stable = now === last;
          last = now;
          await sleep(400);
          return stable;
        },
        Boolean,
        UI_TIMEOUT,
      );
    };
    const runsBefore = gitRunsIn(fx, A.path).length;
    writeFileSync(join(A.path, 'probe.txt'), 'probe\n');
    await poll(() => listedNames(page, ['probe.txt']), (names) => names.length === 1, UI_TIMEOUT);
    expect(gitRunsIn(fx, A.path).length).toBeGreaterThan(runsBefore);
    rmSync(join(A.path, 'probe.txt'));
    await poll(() => listedNames(page, ['probe.txt']), (names) => names.length === 0, UI_TIMEOUT);

    // Writes `name`, waits 1 s (5 times the debounce) and returns the git runs in the worktree since `before`.
    const gitRunsAfterWrite = async (name: string) => {
      await settleGit();
      const before = gitRunsIn(fx, A.path).length;
      writeFileSync(join(A.path, name), 'x\n');
      await sleep(1_000);
      return gitRunsIn(fx, A.path).slice(before);
    };

    // (a) The sidebar is closed.
    await setChangesOpen(page, false);
    expect(await gitRunsAfterWrite('after-close.txt')).toEqual([]);
    await setChangesOpen(page, true);
    expect(await poll(() => listedNames(page, ['after-close.txt']), (names) => names.length === 1, UI_TIMEOUT)).toEqual(['after-close.txt']);

    // (b) The user is on a page without it.
    await goHome(page);
    expect(await gitRunsAfterWrite('after-home.txt')).toEqual([]);
    await openSessionById(page, A.id);
    await changesToggle(page).waitFor({ timeout: UI_TIMEOUT });
    expect(await changesToggle(page).getAttribute('aria-pressed')).toBe('true');
    expect(await poll(() => listedNames(page, ['after-home.txt']), (names) => names.length === 1, UI_TIMEOUT)).toEqual(['after-home.txt']);

    // (c) The page reloads, and starts with the sidebar closed.
    await page.reload();
    await page.getByText(versionLabel).waitFor({ timeout: UI_TIMEOUT });
    await changesToggle(page).waitFor({ timeout: UI_TIMEOUT });
    expect(await changesToggle(page).getAttribute('aria-pressed')).toBe('false');
    expect(await markChangesPanel(page)).toBe(false);
    expect(await gitRunsAfterWrite('after-reload.txt')).toEqual([]);
    await setChangesOpen(page, true);
    expect(await poll(() => listedNames(page, ['after-reload.txt']), (names) => names.length === 1, UI_TIMEOUT)).toEqual(['after-reload.txt']);
  });

  // COCKPIT-38: the ship section of the sidebar. It runs after the tests above, on a project of its own
  // with a local bare `origin`, a workspace per story, and the stub `gh` of the launch.
  describe('ship section', () => {
    let ship: TempRepo;
    let origin: string;
    // The workspaces: a pull request opened outside Cockpit, the commit, push and pull request flow, and a
    // rejected push.
    const W1 = { path: '', id: '' };
    const W2 = { path: '', id: '' };
    const W3 = { path: '', id: '' };
    // A workspace whose commit and push are made outside the section (AC13).
    const W4 = { path: '', id: '' };

    beforeAll(async () => {
      ship = makeChangesRepo('ship-ws');
      writeFileSync(join(ship.root, '.gitignore'), '*.log\n');
      gitIn(ship.root, 'add', '.gitignore');
      gitIn(ship.root, 'commit', '-m', 'ignore logs');
      origin = addOrigin(ship);
      await addRepository(session, ship);
      for (const [workspace, name] of [[W1, 'ship-pr'], [W2, 'ship-flow'], [W3, 'ship-reject'], [W4, 'ship-outside']] as const) {
        workspace.id = await createWorkspaceWithAgent(session.page, ship, { name, agent: 'Claude Code' }, 'Claude Code 1');
        workspace.path = worktreePath(session, ship, name);
      }
      setGh(gh);
    });

    afterAll(() => {
      if (ship) rmSync(ship.parent, { recursive: true, force: true });
    });

    // A failing test must not leave a menu or a dialog that blocks the tests after it.
    afterEach(async () => {
      const { page } = session;
      const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
      for (let attempt = 0; attempt < 4; attempt++) {
        const shown = await overlays.count();
        if (shown === 0 || (await page.evaluate(() => !!document.activeElement?.closest('.xterm')))) break;
        await page.keyboard.press('Escape');
        await poll(() => overlays.count(), (count) => count < shown, 1_000);
      }
    });

    const waitForText = (matches: (text: string) => boolean, timeout = 5_000) => waitForShipText(session.page, matches, timeout);

    test('ship AC1 — a pull request opened outside Cockpit shows "#7 Fix the bug" as a link to its URL, its state and its CI summary, and no "Create pull request" button; each state and summary follows the answer', async () => {
      const { page } = session;
      setGh(gh, { list: prJson({ checks: 'pending' }) });
      await openShip(page, W1.id);

      const link = page.locator(PANEL).getByRole('link', { name: '#7 Fix the bug', exact: true });
      await link.waitFor({ timeout: UI_TIMEOUT });
      expect(await link.getAttribute('href')).toBe(PR_URL);
      const text = await waitForText((shown) => shown.includes('Checks pending'));
      expect(text).toMatch(/\bOpen\b/);
      expect(await shipButton(page, 'Create pull request').count()).toBe(0);
      // Nothing to commit and nothing to push in a fresh workspace.
      expect(await shipButton(page, 'Push').count()).toBe(0);

      for (const [checks, label] of [['unknown', 'Checks unknown'], ['failing', 'Checks failing'], ['passing', 'Checks passing']] as const) {
        setGh(gh, { list: prJson({ checks }) });
        await dispatchFocus(page);
        await waitForText((shown) => shown.includes(label));
      }
      // No check: no summary at all.
      setGh(gh, { list: prJson({ checks: 'none' }) });
      await dispatchFocus(page);
      await waitForText((shown) => !shown.includes('Checks '));
      expect(await panelText(page)).toMatch(/\bOpen\b/);

      setGh(gh, { list: prJson({ state: 'CLOSED' }) });
      await dispatchFocus(page);
      await waitForText((shown) => /\bClosed\b/.test(shown));
      // AC10: a branch with only closed pull requests can have a new one.
      await shipButton(page, 'Create pull request').waitFor({ timeout: UI_TIMEOUT });
      expect(await shipButton(page, 'Create pull request').count()).toBe(1);
    });

    test('ship AC2 — clicking the pull request link opens its URL in the system browser and the window stays on its page', async () => {
      const { page } = session;
      await session.evaluateInMain(`(() => {
        const { shell } = require('electron');
        const opened = (globalThis.__openedExternally = []);
        const stub = async (url) => { opened.push(url); };
        shell.openExternal = stub;
        if (shell.openExternal !== stub) throw new Error('shell.openExternal cannot be replaced');
      })()`);
      setGh(gh, { list: prJson({ checks: 'passing' }) });
      await openShip(page, W1.id);
      await dispatchFocus(page);
      const link = page.locator(PANEL).getByRole('link', { name: '#7 Fix the bug', exact: true });
      await link.waitFor({ timeout: UI_TIMEOUT });
      const url = page.url();

      await link.click({ timeout: UI_TIMEOUT });

      const opened = await poll(() => session.evaluateInMain<string[]>('globalThis.__openedExternally'), (urls) => urls.length > 0, UI_TIMEOUT);
      expect(opened).toEqual([PR_URL]);
      expect(page.url()).toBe(url);
      expect(await markChangesPanel(page)).toBe(true);
    });

    test('ship AC3, AC4 — a change in the worktree reads no pull request, the window gaining focus does (within 5 s), and no gh runs while the sidebar is closed, left or reloaded', async () => {
      const { page } = session;
      const leftovers = ['tick.txt', 'closed.txt', 'reloaded.txt'];
      try {
        // The previous test left "Checks passing" on screen, so each wait below is for an answer the
        // page does not show yet. Once the newest read shows "pending", an earlier read (the page
        // opening, the first focus) has returned or was dropped, and the log holds every run of them.
        setGh(gh, { list: prJson({ checks: 'failing' }) });
        await openShip(page, W1.id);
        await dispatchFocus(page);
        await waitForText((shown) => shown.includes('Checks failing'));
        setGh(gh, { list: prJson({ checks: 'pending' }) });
        await dispatchFocus(page);
        await waitForText((shown) => shown.includes('Checks pending'));

        // The pull request merged meanwhile; a file written in the worktree must not read it.
        setGh(gh, { list: prJson({ state: 'MERGED', checks: 'passing' }) });
        const before = ghRuns(gh).length;
        writeFileSync(join(W1.path, 'tick.txt'), 'x\n');
        await expectListed(page, ['tick.txt'], ['tick.txt']);
        await sleep(1_000);
        expect(ghRuns(gh)).toHaveLength(before);
        expect(await panelText(page)).toMatch(/\bOpen\b/);

        await dispatchFocus(page);
        await waitForText((shown) => /\bMerged\b/.test(shown));
        rmSync(join(W1.path, 'tick.txt'));

        // Closed, then reloaded: a write starts no gh run.
        await setChangesOpen(page, false);
        const runs = ghRuns(gh).length;
        writeFileSync(join(W1.path, 'closed.txt'), 'x\n');
        await sleep(1_000);
        expect(ghRuns(gh)).toHaveLength(runs);

        await page.reload();
        await page.getByText(versionLabel).waitFor({ timeout: UI_TIMEOUT });
        await changesToggle(page).waitFor({ timeout: UI_TIMEOUT });
        expect(await markChangesPanel(page)).toBe(false);
        writeFileSync(join(W1.path, 'reloaded.txt'), 'x\n');
        await sleep(1_000);
        expect(ghRuns(gh)).toHaveLength(runs);
      } finally {
        // A failure must leave neither a file in the worktree nor an answer of this test to the next one.
        for (const name of leftovers) rmSync(join(W1.path, name), { force: true });
        setGh(gh);
      }
    });

    test('ship AC5 — gh not installed, not logged in or failing shows its message and no "Create pull request" button', async () => {
      const { page } = session;
      setGh(gh, { code: 4, stderr: 'authentication required\n' });
      await openShip(page, W1.id);
      await waitForText((shown) => shown.includes('gh is not logged in. Run gh auth login in a terminal.'));
      expect(await shipButton(page, 'Create pull request').count()).toBe(0);

      setGh(gh, { code: 1, stderr: '  boom\n\n' });
      await dispatchFocus(page);
      await waitForText((shown) => shown.includes('Could not read the pull request: boom'));
      expect(await shipButton(page, 'Create pull request').count()).toBe(0);

      const stub = join(fx.bin, 'gh');
      renameSync(stub, `${stub}.away`);
      try {
        setGh(gh);
        await dispatchFocus(page);
        await waitForText((shown) => shown.includes('The GitHub CLI (gh) is not installed.'));
        expect(await shipButton(page, 'Create pull request').count()).toBe(0);
      } finally {
        renameSync(`${stub}.away`, stub);
      }

      await dispatchFocus(page);
      await waitForText((shown) => !shown.includes('gh)') && !shown.includes('Could not read'));
    });

    test('ship AC3 — after a commit and after a push succeed, the pull request is read again and the section shows its new state within 5 s, with no window focus', async () => {
      const { page } = session;
      try {
        setGh(gh);
        await openShip(page, W1.id);
        await shipButton(page, 'Create pull request').waitFor({ timeout: UI_TIMEOUT });
        writeFileSync(join(W1.path, 'after-actions.txt'), 'x\n');
        await expectListed(page, ['after-actions.txt'], ['after-actions.txt']);

        // A pull request opens meanwhile: nothing reads it until the commit succeeds.
        setGh(gh, { list: prJson({ title: 'After the commit', checks: 'pending' }) });
        await commitThroughPanel(page, 'Commit then read');
        await page.locator(PANEL).getByRole('link', { name: '#7 After the commit', exact: true }).waitFor({ timeout: 5_000 });
        await waitForText((shown) => shown.includes('Checks pending'));

        // It merges meanwhile: nothing reads it until the push succeeds.
        setGh(gh, { list: prJson({ title: 'After the commit', state: 'MERGED', checks: 'passing' }) });
        await shipButton(page, 'Push').click({ timeout: UI_TIMEOUT });
        await waitForText((shown) => /\bMerged\b/.test(shown));
        expect(await shipButton(page, 'Delete workspace…').count()).toBe(1);
      } finally {
        setGh(gh);
      }
    });

    test('ship AC6, AC5 — Commit puts every change in one commit with the trimmed message, clears the field and is disabled while the message is blank or nothing is uncommitted, with gh failing', async () => {
      const { page } = session;
      setGh(gh, { code: 1, stderr: 'boom' });
      await openShip(page, W2.id);
      await waitForText((shown) => shown.includes('Could not read the pull request: boom'));
      const head = gitIn(W2.path, 'rev-parse', 'HEAD');
      writeFileSync(join(W2.path, 'a.txt'), 'edited\n');
      rmSync(join(W2.path, 'c.txt'));
      writeFileSync(join(W2.path, 'new.txt'), 'new\n');
      writeFileSync(join(W2.path, 'ignored.log'), 'ignored\n');
      await expectListed(page, ['new.txt'], ['new.txt']);

      const commit = shipButton(page, 'Commit');
      expect(await commit.isDisabled()).toBe(true);
      await commitField(page).fill('   ');
      expect(await commit.isDisabled()).toBe(true);

      await commitThroughPanel(page, '  Edit, delete and add  ');

      await poll(() => gitIn(W2.path, 'rev-parse', 'HEAD'), (now) => now !== head, UI_TIMEOUT);
      expect(gitIn(W2.path, 'rev-list', '--count', `${head}..HEAD`)).toBe('1');
      expect(gitIn(W2.path, 'log', '-1', '--format=%B')).toBe('Edit, delete and add');
      expect(gitIn(W2.path, 'status', '--porcelain')).toBe('');
      expect(gitIn(W2.path, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort()).toEqual(['A\tnew.txt', 'D\tc.txt', 'M\ta.txt']);
      expect(gitIn(W2.path, 'ls-files', 'ignored.log')).toBe('');
      expect(await poll(() => commitField(page).inputValue(), (value) => value === '', UI_TIMEOUT)).toBe('');
      // Nothing is uncommitted any more: a message does not enable the button.
      await commitField(page).fill('Nothing left');
      await poll(() => commit.isDisabled(), Boolean, UI_TIMEOUT);
      expect(await commit.isDisabled()).toBe(true);
      await commitField(page).fill('');
    });

    test('ship AC7 — a failing pre-commit hook shows "Could not commit: …" with git\'s message, creates no commit and keeps the message in the field', async () => {
      const { page } = session;
      const hook = join(ship.root, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
      chmodSync(hook, 0o755);
      try {
        const head = gitIn(W2.path, 'rev-parse', 'HEAD');
        writeFileSync(join(W2.path, 'second.txt'), 'second\n');
        await expectListed(page, ['second.txt'], ['second.txt']);

        await commitThroughPanel(page, 'Add the second file');

        const text = await waitForText((shown) => /Could not commit: [\s\S]*hook says no/.test(shown));
        expect(text).toMatch(/Could not commit: [\s\S]*hook says no/);
        expect(gitIn(W2.path, 'rev-parse', 'HEAD')).toBe(head);
        expect(await commitField(page).inputValue()).toBe('Add the second file');
      } finally {
        rmSync(hook, { force: true });
      }
      // The message was kept: pressing Commit again, the hook gone, commits.
      await shipButton(page, 'Commit').click({ timeout: UI_TIMEOUT });
      expect(await poll(() => gitIn(W2.path, 'log', '-1', '--format=%B'), (subject) => subject === 'Add the second file', UI_TIMEOUT)).toBe('Add the second file');
      expect(gitIn(W2.path, 'status', '--porcelain')).toBe('');
    });

    test('ship AC10 — with gh ready and no pull request, "Create pull request" is disabled with "Push the branch first." while the branch is not pushed', async () => {
      const { page } = session;
      setGh(gh);
      await dispatchFocus(page);
      const create = shipButton(page, 'Create pull request');
      await create.waitFor({ timeout: UI_TIMEOUT });
      expect(await create.isDisabled()).toBe(true);
      expect(await panelText(page)).toContain('Push the branch first.');
      await shipButton(page, 'Push').waitFor({ timeout: UI_TIMEOUT });
    });

    test('ship AC8 — Push runs git push --set-upstream origin <branch> (never forced), origin has the branch at HEAD, the upstream is origin/<branch> and the button goes', async () => {
      const { page } = session;
      expect(remoteRef(origin, 'ship-flow')).toBe('');

      await shipButton(page, 'Push').click({ timeout: UI_TIMEOUT });

      const head = gitIn(W2.path, 'rev-parse', 'HEAD');
      expect(await poll(() => remoteRef(origin, 'ship-flow'), (ref) => ref === head, UI_TIMEOUT)).toBe(head);
      expect(gitIn(W2.path, 'rev-parse', '--abbrev-ref', 'ship-flow@{upstream}')).toBe('origin/ship-flow');
      await poll(() => shipButton(page, 'Push').count(), (count) => count === 0, UI_TIMEOUT);
      expect(await shipButton(page, 'Push').count()).toBe(0);
      const pushes = gitRunsIn(fx, W2.path).filter((line) => line.startsWith(`${W2.path} push`));
      expect(pushes).toEqual([`${W2.path} push --set-upstream origin ship-flow`]);
      // Whatever git ran in the whole launch: no push is forced.
      const everyPush = readFileSync(fx.gitLog, 'utf8').split('\n').filter((line) => / push( |$)/.test(line));
      expect(everyPush.length).toBeGreaterThan(0);
      for (const line of everyPush) expect(line).not.toMatch(/--force|--force-with-lease| -f( |$)| \+/);
    });

    test('ship AC10 — "Create pull request" opens a dialog into the base with the title of HEAD\'s commit focused; a failing gh shows its message and keeps it open; Create runs gh pr create and shows the pull request', async () => {
      const { page } = session;
      const create = shipButton(page, 'Create pull request');
      expect(await poll(() => create.isDisabled(), (disabled) => !disabled, UI_TIMEOUT)).toBe(false);
      expect(await panelText(page)).not.toContain('Push the branch first.');

      await create.click({ timeout: UI_TIMEOUT });
      const dialog = prDialog(page);
      await dialog.waitFor({ timeout: UI_TIMEOUT });
      expect(await dialog.innerText()).toContain('into main');
      const title = dialog.getByRole('textbox', { name: 'Title', exact: true });
      const description = dialog.getByRole('textbox', { name: 'Description', exact: true });
      const createButtonOfDialog = dialog.getByRole('button', { name: 'Create', exact: true });
      expect(await title.inputValue()).toBe('Add the second file');
      expect(await poll(() => title.evaluate((field) => field === document.activeElement), Boolean, UI_TIMEOUT)).toBe(true);
      expect(await description.inputValue()).toBe('');

      await title.fill('   ');
      expect(await createButtonOfDialog.isDisabled()).toBe(true);
      await title.fill('  Ship the flow  ');
      await description.fill('Line 1\nLine 2');
      expect(await createButtonOfDialog.isDisabled()).toBe(false);

      setGh(gh, { createStderr: '  gh: GraphQL: boom\n\n' });
      await createButtonOfDialog.click({ timeout: UI_TIMEOUT });
      expect(await waitForDialogLine(dialog, (line) => line === 'Could not create the pull request: gh: GraphQL: boom')).toHaveLength(1);
      expect(await dialog.isVisible()).toBe(true);

      setGh(gh, { afterCreate: prJson({ title: 'Ship the flow', checks: 'pending' }) });
      await createButtonOfDialog.click({ timeout: UI_TIMEOUT });
      await dialog.waitFor({ state: 'hidden', timeout: UI_TIMEOUT });

      const link = page.locator(PANEL).getByRole('link', { name: '#7 Ship the flow', exact: true });
      await link.waitFor({ timeout: 5_000 });
      expect(await link.getAttribute('href')).toBe(PR_URL);
      await waitForText((shown) => shown.includes('Checks pending'));
      expect(await shipButton(page, 'Create pull request').count()).toBe(0);
      const creates = ghRuns(gh).filter((run) => run.args[0] === 'pr' && run.args[1] === 'create');
      const args = ['pr', 'create', '--base', 'main', '--head', 'ship-flow', '--title', 'Ship the flow', '--body', 'Line 1\nLine 2'];
      expect(creates).toEqual([
        { cwd: W2.path, prompt: '1', args },
        { cwd: W2.path, prompt: '1', args },
      ]);
    });

    test('ship AC11 — once the pull request is merged, "Delete workspace…" opens the Delete dialog; confirming removes the worktree, the branch and the row, and the session page has no Changes button', async () => {
      const { page } = session;
      setGh(gh, { list: prJson({ title: 'Ship the flow', state: 'MERGED', checks: 'passing' }) });
      await dispatchFocus(page);
      await waitForText((shown) => /\bMerged\b/.test(shown));

      await shipButton(page, 'Delete workspace…').click({ timeout: UI_TIMEOUT });
      const dialog = deleteDialog(page, 'Delete ship-flow?');
      await dialog.waitFor({ timeout: UI_TIMEOUT });
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });

      await poll(() => existsSync(W2.path), (exists) => !exists, UI_TIMEOUT);
      expect(existsSync(W2.path)).toBe(false);
      // The app deletes the branch in a git call after the folder is gone.
      expect(await poll(() => localBranches(ship), (branches) => !branches.includes('ship-flow'), UI_TIMEOUT)).not.toContain('ship-flow');
      expect(await poll(() => entryTitles(page), (titles) => !titles.includes(W2.path), UI_TIMEOUT)).not.toContain(W2.path);
      expect(await sidebarLines(page)).not.toContain('Branch ship-flow was kept: it is not merged.');
      expect(await allSessionLinkIds(page)).not.toContain(W2.id);
      await poll(() => changesToggle(page).count(), (count) => count === 0, UI_TIMEOUT);
      expect(await changesToggle(page).count()).toBe(0);
      expect(await markChangesPanel(page)).toBe(false);
    });

    test('ship AC9 — a push git refuses (origin has a commit the worktree lacks) shows "Could not push <branch>: …", leaves origin as it was and keeps "Push"', async () => {
      const { page } = session;
      const git = (cwd: string, ...args: string[]) => gitIn(cwd, ...args);
      writeFileSync(join(W3.path, 'one.txt'), 'one\n');
      git(W3.path, 'add', 'one.txt');
      git(W3.path, 'commit', '-m', 'one');
      git(W3.path, 'push', '--quiet', '--set-upstream', 'origin', 'ship-reject');
      // Someone else pushes to origin/ship-reject, then the worktree commits on its own.
      const other = join(ship.parent, 'other-clone');
      git(ship.parent, 'clone', '--quiet', origin, other);
      git(other, 'switch', '--quiet', 'ship-reject');
      writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
      git(other, 'add', 'theirs.txt');
      git(other, 'commit', '-m', 'theirs');
      git(other, 'push', '--quiet', 'origin', 'ship-reject');
      const theirs = remoteRef(origin, 'ship-reject');
      writeFileSync(join(W3.path, 'two.txt'), 'two\n');
      git(W3.path, 'add', 'two.txt');
      git(W3.path, 'commit', '-m', 'two');

      setGh(gh);
      await openShip(page, W3.id);
      await shipButton(page, 'Push').click({ timeout: UI_TIMEOUT });

      const text = await waitForText((shown) => /Could not push ship-reject: [\s\S]*rejected/.test(shown));
      expect(text).toMatch(/Could not push ship-reject: /);
      expect(remoteRef(origin, 'ship-reject')).toBe(theirs);
      expect(await shipButton(page, 'Push').count()).toBe(1);
    });

    test('ship AC13 — a commit then a push made outside the section (in the worktree, as its terminal would) update it within 5 s with no window focus, and once it settled no git runs in the worktree', async () => {
      const { page } = session;
      setGh(gh);
      writeFileSync(join(W4.path, 'a.txt'), 'edited outside\n');
      await openShip(page, W4.id);
      await expectListed(page, ['a.txt'], ['a.txt']);
      const create = shipButton(page, 'Create pull request');
      await create.waitFor({ timeout: UI_TIMEOUT });
      const commit = shipButton(page, 'Commit');
      await commitField(page).fill('Typed, not pressed');
      expect(await poll(() => commit.isDisabled(), (disabled) => !disabled, UI_TIMEOUT)).toBe(false);
      expect(await shipButton(page, 'Push').count()).toBe(0);

      // The commit: "Push" shows and "Commit" is disabled (nothing is uncommitted any more).
      gitIn(W4.path, 'commit', '-q', '-am', 'Committed in the terminal');
      await shipButton(page, 'Push').waitFor({ timeout: 5_000 });
      expect(await poll(() => commit.isDisabled(), Boolean, 5_000)).toBe(true);
      expect(await create.isDisabled()).toBe(true);

      // The push: "Push" goes and "Create pull request" is enabled.
      gitIn(W4.path, 'push', '-q', '-u', 'origin', 'ship-outside');
      expect(await poll(() => shipButton(page, 'Push').count(), (count) => count === 0, 5_000)).toBe(0);
      expect(await poll(() => create.isDisabled(), (disabled) => !disabled, 5_000)).toBe(false);
      expect(await panelText(page)).not.toContain('Push the branch first.');

      // Reading the state writes nothing under the gitdir, so it does not start itself again: within
      // the time to settle, there is a second with no git run in the worktree.
      const quiet = await poll(
        async () => {
          const before = gitRunsIn(fx, W4.path).length;
          await sleep(1_000);
          return gitRunsIn(fx, W4.path).length === before;
        },
        Boolean,
        UI_TIMEOUT,
      );
      expect(quiet, 'git keeps running in the worktree').toBe(true);
    });

    test('ship AC12 — the new window.api.workspaces calls refuse an unknown project, a path that is not a linked worktree, a blank message or title, and a detached HEAD with the messages of the spec, run nothing, and reject from another origin', async () => {
      const { page } = session;
      await setChangesOpen(page, false);
      await goHome(page);
      setGh(gh);
      const branch = join(ship.parent, 'wt-api');
      const clean = join(ship.parent, 'wt-api-clean');
      const detached = join(ship.parent, 'wt-api-detached');
      gitIn(ship.root, 'worktree', 'add', '--quiet', '-b', 'ship-api', branch, 'main');
      gitIn(ship.root, 'worktree', 'add', '--quiet', '-b', 'ship-api-clean', clean, 'main');
      gitIn(ship.root, 'worktree', 'add', '--quiet', '--detach', detached, 'main');
      writeFileSync(join(branch, 'dirty.txt'), 'dirty\n');
      const elsewhere = join(ship.parent, 'not-a-worktree');
      mkdirSync(elsewhere);

      const call = (method: string, args: unknown[]) =>
        page.evaluate(
          ([method, args]) =>
            (window as unknown as { api: { workspaces: Record<string, (...args: unknown[]) => Promise<unknown>> } }).api.workspaces[method as string]!(
              ...(args as unknown[]),
            ),
          [method, args] as const,
        );
      const refused = (message: string) => ({ status: 'refused', message });
      const gitLines = () => readFileSync(fx.gitLog, 'utf8').split('\n').filter(Boolean).length;
      const headsBefore = [branch, clean, detached].map((path) => gitIn(path, 'rev-parse', 'HEAD'));
      const originBefore = gitIn(origin, 'for-each-ref');
      const ghBefore = ghRuns(gh).length;
      const gitBefore = gitLines();

      const extra: Record<string, unknown[]> = { status: [], commit: ['A message'], push: [], pullRequest: [], createPullRequest: ['A title', 'A body'] };
      for (const [method, args] of Object.entries(extra)) {
        expect(await call(method, ['/no/such/project', '/no/such/project/ws', ...args]), `${method}: unknown project`).toEqual(
          refused('/no/such/project is not a project in Cockpit.'),
        );
        expect(await call(method, [ship.root, elsewhere, ...args]), `${method}: not a worktree`).toEqual(refused(`${elsewhere} is not a workspace of ${ship.name}.`));
        expect(await call(method, [ship.root, ship.root, ...args]), `${method}: main working tree`).toEqual(refused(`${ship.root} is not a workspace of ${ship.name}.`));
      }
      expect(await call('commit', [ship.root, branch, '   '])).toEqual(refused('Write a commit message.'));
      expect(await call('commit', [ship.root, clean, 'A message'])).toEqual(refused('Nothing to commit.'));
      expect(await call('createPullRequest', [ship.root, clean, '   ', ''])).toEqual(refused('Write a title.'));
      expect(await call('push', [ship.root, detached])).toEqual(refused('wt-api-detached has no branch.'));
      expect(await call('createPullRequest', [ship.root, detached, 'A title', ''])).toEqual(refused('wt-api-detached has no branch.'));

      // Nothing ran: no commit, push or pull request, no gh run, the dirty file still uncommitted.
      expect(ghRuns(gh)).toHaveLength(ghBefore);
      const ran = readFileSync(fx.gitLog, 'utf8').split('\n').filter(Boolean).slice(gitBefore);
      expect(ran.filter((line) => ['add', 'commit', 'push'].includes(line.split(' ')[1]!))).toEqual([]);
      expect([branch, clean, detached].map((path) => gitIn(path, 'rev-parse', 'HEAD'))).toEqual(headsBefore);
      expect(gitIn(branch, 'status', '--porcelain')).toBe('?? dirty.txt');
      expect(gitIn(origin, 'for-each-ref')).toBe(originBefore);

      // From another origin the handlers reject.
      const origins = await session.evaluateInMain<Record<string, string>>(`(async () => {
        const handlers = require('electron').ipcMain._invokeHandlers;
        const calls = {
          'workspaces:status': [${JSON.stringify(ship.root)}, ${JSON.stringify(clean)}],
          'workspaces:commit': [${JSON.stringify(ship.root)}, ${JSON.stringify(branch)}, 'A message'],
          'workspaces:push': [${JSON.stringify(ship.root)}, ${JSON.stringify(clean)}],
          'workspaces:pull-request': [${JSON.stringify(ship.root)}, ${JSON.stringify(clean)}],
          'workspaces:create-pull-request': [${JSON.stringify(ship.root)}, ${JSON.stringify(clean)}, 'A title', ''],
        };
        const results = {};
        for (const [channel, args] of Object.entries(calls)) {
          const handler = handlers.get(channel);
          if (!handler) { results[channel] = 'no handler'; continue; }
          try {
            await handler({ senderFrame: { url: 'https://example.com/' }, sender: null }, ...args);
            results[channel] = 'resolved';
          } catch {
            results[channel] = 'rejected';
          }
        }
        return results;
      })()`);
      expect(origins).toEqual({
        'workspaces:status': 'rejected',
        'workspaces:commit': 'rejected',
        'workspaces:push': 'rejected',
        'workspaces:pull-request': 'rejected',
        'workspaces:create-pull-request': 'rejected',
      });
      expect(ghRuns(gh)).toHaveLength(ghBefore);
      expect(gitIn(branch, 'status', '--porcelain')).toBe('?? dirty.txt');
      expect(gitIn(origin, 'for-each-ref')).toBe(originBefore);
    });
  });

  test('logs no error and keeps running', async () => {
    await expectNoErrors(session);
  });
});

// One smoke path through the sessions IPC in the dev server: the page, the
// main process, the pty host and the disk. It needs a launch of its own with
// the fake login shell that holds the stubs. The packaged app's smoke path is
// folded into the first launch of the AC9 restart test below. The
// launchd-environment mode has none: its point is the user's real login shell,
// where a session would run a real CLI.
// --- Session status (COCKPIT-36) ---------------------------------------------

// What a stub was started with: its arguments as the harness got them (the status flags included),
// and the OpenCode config variable (`unset` when the variable was not in its environment).
function readLaunch(fx: SessionsFixture, binary: string, pid: number) {
  const lines = readFileSync(join(fx.bin, `${binary}.launch.${pid}`), 'utf8').split('\n').slice(0, -1);
  const config = lines.pop()!.slice('OPENCODE_CONFIG_CONTENT='.length);
  return { args: lines, openCodeConfig: config };
}

const launchFiles = (fx: SessionsFixture) => readdirSync(fx.bin).filter((name) => name.includes('.launch.')).sort();

// Reports a status the way a hook does, straight to the endpoint with the token.
async function reportStatus(session: Session, id: string, event: 'working' | 'waiting' | 'finished') {
  const answer = await postSessionEvent(daemonSocketIn(session.cockpitHome), {
    authorization: `Bearer ${controlTokenIn(session.cockpitHome)}`,
    body: { sessionId: id, event },
  });
  expect(answer.status, `${event} for ${id}`).toBe(204);
}

// Tests never show a real notification: `Notification.prototype.show` records what would be shown, and
// `BrowserWindow.getFocusedWindow` answers `null` until a test says a window is focused.
const stubNotifications = (session: Session) =>
  session.evaluateInMain(`(() => {
    const { Notification, BrowserWindow } = require('electron');
    globalThis.__notified = [];
    globalThis.__focused = false;
    Notification.prototype.show = function () {
      globalThis.__notified.push({ title: this.title, body: this.body, notification: this });
    };
    BrowserWindow.getFocusedWindow = () => (globalThis.__focused ? BrowserWindow.getAllWindows()[0] ?? null : null);
  })()`);

const notifications = (session: Session) =>
  session.evaluateInMain<Array<{ title: string; body: string }>>('globalThis.__notified.map(({ title, body }) => ({ title, body }))');

const clearNotifications = (session: Session) => session.evaluateInMain('globalThis.__notified.length = 0');

const setWindowFocused = (session: Session, focused: boolean) => session.evaluateInMain(`globalThis.__focused = ${focused}`);

// Closes a menu or dialog a failed test left open (never while the keyboard is in a terminal).
async function closeOverlays(page: Page) {
  const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
  for (let attempt = 0; attempt < 4; attempt++) {
    const open = await overlays.count();
    if (open === 0 || (await page.evaluate(() => !!document.activeElement?.closest('.xterm')))) break;
    await page.keyboard.press('Escape');
    await poll(() => overlays.count(), (count) => count < open, 1_000);
  }
}

describe('session status: built app', () => {
  let fx: SessionsFixture;
  let session: Session;
  let repo: TempRepo;
  const known = {
    claude: { id: '', pid: 0 },
    codex: { id: '', pid: 0 },
    opencode: { id: '', pid: 0 },
    second: { id: '', pid: 0 },
    workspace: { id: '', path: '' },
    notified: { id: '', name: '' },
  };

  beforeAll(async () => {
    fx = makeSessionsFixture(['claude', 'codex', 'opencode'], { log: true });
    repo = makeRepo('status-ws');
    // The user's own OpenCode config is none: the tests of the merge are the package's.
    const env = fx.env();
    delete env.OPENCODE_CONFIG_CONTENT;
    session = await launchBuiltWith(env);
    await session.page.getByText(versionLabel).waitFor();
    await stubNotifications(session);
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  afterEach(() => closeOverlays(session.page));

  test('AC2, AC3, AC4, AC9, single instance AC8 — Claude Code, Codex and OpenCode are started with the arguments statusLaunch gives, OpenCode with its config variable and the plugin written under COCKPIT_HOME; none shows a dot before it reports', async () => {
    const { page } = session;
    // Every session is started before anything is checked: the tests after this one need them.
    for (const [menuName, id] of [
      ['Claude Code', 'claude'],
      ['Codex', 'codex'],
      ['OpenCode', 'opencode'],
    ] as const) {
      known[id].id = await startSession(page, menuName, `${menuName} 1`);
      known[id].pid = (await readStub(page)).pid;
    }

    // The plugin of the expected launch goes to a folder of the test's own.
    const expectedPlugins = join(fx.root, 'expected-plugins');
    const expected = (id: 'claude-code' | 'codex' | 'opencode') => statusLaunch(id, { command: statusCommand, pluginsDir: expectedPlugins, env: {} });

    const claude = readLaunch(fx, 'claude', known.claude.pid);
    expect(claude.args.length).toBe(2);
    expect(claude.args).toEqual((await expected('claude-code')).args);
    expect(claude.openCodeConfig).toBe('unset');

    const codex = readLaunch(fx, 'codex', known.codex.pid);
    expect(codex.args.slice(0, 2)).toEqual(['--no-daemon', '-c']);
    expect(codex.args).toEqual((await expected('codex')).args);

    const opencode = readLaunch(fx, 'opencode', known.opencode.pid);
    const folder = join(session.cockpitHome, 'plugins', 'opencode-status');
    expect(opencode.args).toEqual(['--standalone']);
    expect(JSON.parse(opencode.openCodeConfig)).toEqual({ plugins: [folder] });
    // The plugin the app wrote is the one statusLaunch writes for the same commands.
    const written = readFileSync(join(folder, 'server.js'), 'utf8');
    await expected('opencode');
    expect(written).toBe(readFileSync(join(expectedPlugins, 'opencode-status', 'server.js'), 'utf8'));

    // AC9: running, nothing reported yet.
    expect((await sessionEntries(page)).map((entry) => [entry.name, entry.status])).toEqual([
      ['OpenCode 1', null],
      ['Codex 1', null],
      ['Claude Code 1', null],
    ]);
    // The daemon is up: nothing says status is off.
    expect((await sidebarLines(page)).filter((line) => line.startsWith('Session status is off'))).toEqual([]);
  });

  test('AC7 — Claude Code hooks turn the row to "Working", "Needs input", "Working", "Ready" within 2 s of each report, another row is unchanged, and exiting with code 3 shows "Exited 3"', async () => {
    const { page } = session;
    // A second Claude Code session, which stays silent while the first one reports.
    known.second.id = await startSession(page, 'Claude Code', 'Claude Code 2');
    await readStub(page);
    await openSessionEntry(page, 'Claude Code 1');
    await focusTerminal(page);
    const silent = [known.second.id, known.codex.id, known.opencode.id];

    for (const [hook, dot] of [
      ['UserPromptSubmit', 'Working'],
      ['PermissionRequest', 'Needs input'],
      ['PostToolUse', 'Working'],
      ['Stop', 'Ready'],
    ] as const) {
      await typeLine(page, `hook ${hook}`);
      await waitForRow(page, `hooked:${hook}`);
      await expectDot(page, known.claude.id, dot);
      for (const id of silent) await expectDot(page, id, null, 0);
    }

    await typeLine(page, 'exit');
    await waitForRow(page, '[Process exited with code 3]');
    await expectDot(page, known.claude.id, 'Exited 3');
    for (const id of silent) await expectDot(page, id, null, 0);
  });

  test('AC7 — the same under a workspace: the dot shows on the session listed under the workspace row', async () => {
    const { page } = session;
    await addRepository(session, repo);
    const path = await createPlainWorkspace(session, repo, 'status-ws');
    known.workspace.path = path;
    known.workspace.id = await startInWorkspace(page, path, 'status-ws', 'Claude Code', 'Claude Code 1');
    await readStub(page);
    await focusTerminal(page);

    await typeLine(page, 'hook UserPromptSubmit');
    await waitForRow(page, 'hooked:UserPromptSubmit');

    await expectDot(page, known.workspace.id, 'Working');
    expect((await sessionLinks(page, { workspace: path })).map((entry) => entry.status)).toEqual(['Working']);
    // The sessions of the Sessions section are not touched.
    expect((await sessionEntries(page)).find((entry) => entry.id === known.second.id)?.status).toBe(null);
  });

  test('AC8 — an agent that exits with code 0 shows the "Ended" dot, whatever it reported before', async () => {
    const { page } = session;
    await openSessionEntry(page, 'Claude Code 2');
    await focusTerminal(page);
    await typeLine(page, 'hook Stop');
    await waitForRow(page, 'hooked:Stop');
    await expectDot(page, known.second.id, 'Ready');

    await typeLine(page, 'quit');
    await waitForRow(page, '[Process exited with code 0]');

    await expectDot(page, known.second.id, 'Ended');
  });

  test('AC11 — with no Cockpit window focused, a change to "Needs input" or "Ready" shows one notification titled with the session name; a repeat, a change to "Working" and any report while a window is focused show none', async () => {
    const { page } = session;
    known.notified.id = await startSession(page, 'Claude Code', 'Claude Code 3');
    known.notified.name = 'Claude Code 3';
    await readStub(page);
    await clearNotifications(session);
    const { id, name } = known.notified;

    await reportStatus(session, id, 'working');
    await expectDot(page, id, 'Working');
    expect(await notifications(session)).toEqual([]);

    await reportStatus(session, id, 'waiting');
    await expectDot(page, id, 'Needs input');
    expect(await notifications(session)).toEqual([{ title: name, body: 'Needs input' }]);

    await reportStatus(session, id, 'waiting');
    await expectDot(page, id, 'Needs input');
    expect(await notifications(session)).toHaveLength(1);

    await reportStatus(session, id, 'finished');
    await expectDot(page, id, 'Ready');
    expect(await notifications(session)).toEqual([
      { title: name, body: 'Needs input' },
      { title: name, body: 'Ready' },
    ]);

    await reportStatus(session, id, 'working');
    await expectDot(page, id, 'Working');
    expect(await notifications(session)).toHaveLength(2);

    await setWindowFocused(session, true);
    await reportStatus(session, id, 'waiting');
    await expectDot(page, id, 'Needs input');
    expect(await notifications(session)).toHaveLength(2);
    await setWindowFocused(session, false);

    await reportStatus(session, id, 'finished');
    await expectDot(page, id, 'Ready');
    expect(await notifications(session)).toHaveLength(3);
    expect((await notifications(session)).at(-1)).toEqual({ title: name, body: 'Ready' });
  });

  test("AC12 — clicking the notification shows and focuses the session's window and opens the session's page", async () => {
    const { page } = session;
    expect((await notifications(session)).length, 'the notification of the previous test').toBeGreaterThan(0);
    await goHome(page);
    expect(sessionIdOf(page)).toBeUndefined();
    // The window must not really be shown nor focused: the test records the calls.
    await session.evaluateInMain(`(() => {
      const { BrowserWindow } = require('electron');
      const window = BrowserWindow.getAllWindows()[0];
      globalThis.__windowCalls = [];
      window.show = () => globalThis.__windowCalls.push('show');
      window.focus = () => globalThis.__windowCalls.push('focus');
      globalThis.__notified.at(-1).notification.emit('click');
    })()`);

    await page.getByRole('heading', { name: known.notified.name, exact: true }).waitFor({ timeout: UI_TIMEOUT });
    expect(sessionIdOf(page)).toBe(known.notified.id);
    const calls = await session.evaluateInMain<string[]>('globalThis.__windowCalls');
    expect(calls).toContain('show');
    expect(calls).toContain('focus');
  });

  test('AC13 — a harness whose binary was removed after detection is refused under the Sessions header: "Could not start Claude Code: <path> not found.", no folder, nothing spawned, state.json unchanged', async () => {
    const { page } = session;
    const binary = join(fx.bin, 'claude');
    // The menu detected the stubs at the first start and keeps the answer.
    const before = {
      state: stateSnapshot(session.dataDir),
      folders: sessionFoldersIn(session.cockpitHome),
      runs: startRuns(fx),
      launches: launchFiles(fx),
      entries: await sessionEntries(page),
    };

    renameSync(binary, `${binary}.gone`);
    try {
      await openStartMenu(page);
      expect((await page.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())).toContain('Claude Code');
      await page.getByRole('menuitem', { name: 'Claude Code', exact: true }).click({ timeout: UI_TIMEOUT });

      const message = `Could not start Claude Code: ${binary} not found.`;
      const lines = await waitForLine(page, message);
      expect(lines).toContain(message);
      expect(await isBelowSessionsHeader(page, message)).toBe(true);
      expect(sessionFoldersIn(session.cockpitHome)).toEqual(before.folders);
      expect(startRuns(fx)).toEqual(before.runs);
      expect(launchFiles(fx)).toEqual(before.launches);
      expect(stateSnapshot(session.dataDir)).toEqual(before.state);
      expect(await sessionEntries(page)).toEqual(before.entries);
    } finally {
      renameSync(`${binary}.gone`, binary);
    }
  });

  test('AC8 — when the pty host dies, every running session shows the "Ended" dot, the ones that had reported included', async () => {
    const { page } = session;
    await reportStatus(session, known.codex.id, 'working');
    await expectDot(page, known.codex.id, 'Working');

    await killPtyHost(page);

    for (const id of [known.codex.id, known.opencode.id, known.workspace.id, known.notified.id]) await expectDot(page, id, 'Ended', UI_TIMEOUT);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});

describe('sessions smoke path: dev server', () => {
  let fx: SessionsFixture;
  let open: OpenFixture;
  let gh: GhFixture;
  let session: Session;

  beforeAll(async () => {
    fx = makeSessionsFixture(['claude']);
    open = addOpenFixture(fx);
    // A stub `gh` for the ship section (COCKPIT-38).
    gh = addGhFixture(fx);
    session = await launchDevWith({ ...open.env(), ...GIT_APP_ENV });
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  test('smoke path — picking Claude Code runs the stub in a new folder under COCKPIT_HOME, lists the session and stores it', async () => {
    const { page } = session;
    const id = await startSession(page, 'Claude Code', 'Claude Code 1');
    const home = join(session.cockpitHome, 'sessions', id);

    const stub = await readStub(page);
    expect(stub.cwd).toBe(realpathSync(home));
    expect(stub.term).toBe('xterm-256color');
    expect(await waitForSessionEntries(page, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
    const stored = await poll(() => sessionsInState(session.dataDir), (list) => list.length > 0, UI_TIMEOUT);
    expect(stored.map((s) => [s.name, s.directory])).toEqual([['Claude Code 1', home]]);
  });

  test('control smoke path — the stub gets its session id and the socket, and a hook line turns the row to "Working"', async () => {
    await expectControlEndpoint(session);
  });

  test('workspace sessions smoke path, changes AC16 — a new workspace with Claude Code and a prompt runs the stub in the worktree with the prompt, lists the session under the workspace and stores it, and the Changes sidebar shows a file written in the worktree with its diff', async () => {
    const { page } = session;
    const repo = makeRepo('smoke-agent-ws');
    const origin = addOrigin(repo);
    try {
      await addRepository(session, repo);
      const id = await createWorkspaceWithAgent(page, repo, { name: 'smoke-agent', agent: 'Claude Code', prompt: 'fix the tests' }, 'Claude Code 1');
      const path = worktreePath(session, repo, 'smoke-agent');

      const stub = await readStub(page);
      expect(stub.cwd).toBe(path);
      expect(stub.argCount).toBe(1);
      expect(stub.args).toBe('fix the tests');
      expect(await waitForWorkspaceLinks(page, path, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
      const stored = await poll(() => sessionsInState(session.dataDir), (list) => list.some((entry) => entry.id === id), UI_TIMEOUT);
      expect(stored.find((entry) => entry.id === id)).toMatchObject({ name: 'Claude Code 1', directory: path, project: repo.root });
      // Changes sidebar (COCKPIT-34 AC16): a file written in the worktree shows with its diff.
      await expectChangesShowNewFile(page, path);
      // Ship section (COCKPIT-38): the stub's pull request shows, then a commit and a push reach origin.
      await expectShipSmoke(page, gh, path, origin, 'smoke-agent');
    } finally {
      rmSync(repo.parent, { recursive: true, force: true });
    }
  });

  test('open workspace smoke path — "Open in editor" then Cursor runs open -a <Cursor.app> <worktree> and stores editor "cursor"', async () => {
    const { page } = session;
    const repo = makeRepo('smoke-open-ws');
    try {
      await addRepository(session, repo);
      const path = await createPlainWorkspace(session, repo, 'smoke-open');

      await openWorkspaceMenu(page, path, FIRST_MENU);
      await pickInSubmenu(page, 'Open in editor', 'Cursor');

      expect(await waitForOpenRuns(open, 1)).toEqual([['-a', join(open.apps, 'Cursor.app'), path]]);
      expect((await poll(() => rememberedApps(session.dataDir), ({ editor }) => editor !== undefined, UI_TIMEOUT)).editor).toBe('cursor');
    } finally {
      rmSync(repo.parent, { recursive: true, force: true });
    }
  });

  test('logs no error and keeps running', async () => {
    await expectNoErrors(session);
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

  test('AC2 — the "Start session" menu shows one disabled item "No agent CLI found"', async () => {
    const { page } = session;
    const before = stateSnapshot(session.dataDir);

    await openStartMenu(page);

    const items = page.getByRole('menuitem');
    expect(await items.count()).toBe(1);
    expect((await items.first().innerText()).trim()).toBe('No agent CLI found');
    expect(await items.first().isDisabled()).toBe(true);

    await items.first().click({ force: true, timeout: UI_TIMEOUT }).catch(() => {});
    await sleep(300);
    expect(await sessionEntries(page)).toEqual([]);
    expect(sessionIdOf(page)).toBeUndefined();
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    await expectNoErrors(session);
  });
});

// COCKPIT-61: an unpackaged build keeps its data in `~/.cockpit-dev/<folder>` (its Cockpit home) and
// its `userData` in `~/.cockpit-dev/<folder>/user-data`, `<folder>` being `devFolderName` of the
// worktree root (`app.getAppPath()` is `<root>/apps/desktop`). Only the running app shows which
// path `app.getAppPath()` gives and that `userData` is set before the daemon and the lock.
// Imported when a test runs, so the rest of this file loads whether or not the module exists.
const devFolderOfThisWorktree = async () => (await import('../src/main/dev-folder')).devFolderName(resolve(appDir, '../..'));
const devHomeIn = (userHome: string, folder: string) => join(userHome, '.cockpit-dev', folder);

describe('built app default folders when COCKPIT_HOME and COCKPIT_USER_DATA_DIR are unset', () => {
  let fx: SessionsFixture;

  beforeAll(() => {
    fx = makeSessionsFixture(['claude']);
  });

  afterAll(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  test.each([
    ['unset', undefined],
    ['empty', ''],
  ])('AC1, AC4, AC5 — with COCKPIT_HOME %s, COCKPIT_USER_DATA_DIR unset and HOME=<tmp>, the unpackaged app puts the session folder in <tmp>/.cockpit-dev/<folder>/sessions/<id>, the socket next to it, state.json in <folder>/user-data, and nothing else under <tmp>/.cockpit-dev nor under <tmp>/.cockpit', async (_label, value) => {
    // A short folder: the socket path is limited to 103 bytes on macOS (`<fx.root>/…` would exceed it).
    const devFolder = await devFolderOfThisWorktree();
    const userHome = realpathSync(makeTestDir('u'));
    const session = await launchBuiltWith({ ...fx.env(), HOME: userHome }, null, value ?? null);
    try {
      await session.page.getByText(versionLabel).waitFor();
      const id = await startSession(session.page, 'Claude Code', 'Claude Code 1');
      const home = devHomeIn(userHome, devFolder);
      const directory = join(home, 'sessions', id);

      expect((await readStub(session.page)).cwd).toBe(directory);
      expect(statSync(directory).isDirectory()).toBe(true);
      // The daemon's socket is <HOME>/.cockpit-dev/<folder>/daemon-1-<build>.sock, and the session gets it.
      expect(statSync(daemonSocketIn(home)).isSocket()).toBe(true);
      expect((await readStubEnv(session.page)).socket).toBe(daemonSocketIn(home));
      // userData is <folder>/user-data: state.json is there, with the session, and not in the data folder.
      const userData = join(home, 'user-data');
      expect(JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))).toMatchObject({ version: 1 });
      const stored = await poll(() => sessionsInState(userData), (list) => list.length > 0, UI_TIMEOUT);
      expect(stored.map((s) => s.directory)).toEqual([directory]);
      expect(existsSync(join(session.dataDir, 'state.json'))).toBe(false);
      // <HOME>/.cockpit-dev holds only the worktree's folder, and the installed app's home is left alone.
      expect(readdirSync(join(userHome, '.cockpit-dev'))).toEqual([devFolder]);
      expect(existsSync(join(userHome, '.cockpit'))).toBe(false);
      // Nothing went to the developer's own folders.
      expect(existsSync(join(homedir(), '.cockpit', 'sessions', id))).toBe(false);
      expect(existsSync(join(homedir(), '.cockpit-dev', devFolder, 'sessions', id))).toBe(false);
      expect(existsSync(join(homedir(), '.cockpit-dev', 'sessions', id))).toBe(false);
      await expectNoErrors(session);
    } finally {
      await session.close();
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  test('AC6 — with COCKPIT_HOME set and COCKPIT_USER_DATA_DIR unset, the given home holds the daemon and userData defaults to <HOME>/.cockpit-dev/<folder>/user-data', async () => {
    const devFolder = await devFolderOfThisWorktree();
    const userHome = realpathSync(makeTestDir('u'));
    const cockpitHome = makeTestDir('h');
    const session = await launchBuiltWith({ ...fx.env(), HOME: userHome }, null, cockpitHome);
    try {
      await session.page.getByText(versionLabel).waitFor();

      expect(statSync(daemonSocketIn(cockpitHome)).isSocket()).toBe(true);
      expect(JSON.parse(readFileSync(join(devHomeIn(userHome, devFolder), 'user-data', 'state.json'), 'utf8'))).toMatchObject({ version: 1 });
      // The default home is not used: <folder> holds user-data only.
      expect(readdirSync(devHomeIn(userHome, devFolder))).toEqual(['user-data']);
      expect(existsSync(join(userHome, '.cockpit'))).toBe(false);
      await expectNoErrors(session);
    } finally {
      await session.close();
      rmSync(userHome, { recursive: true, force: true });
      rmSync(cockpitHome, { recursive: true, force: true });
    }
  });

  test('AC6 — with COCKPIT_USER_DATA_DIR set and COCKPIT_HOME unset, state.json is in the given folder and the home defaults to <HOME>/.cockpit-dev/<folder>', async () => {
    const devFolder = await devFolderOfThisWorktree();
    const userHome = realpathSync(makeTestDir('u'));
    const dataDir = makeTestDir('d-');
    const session = await launchBuiltWith({ ...fx.env(), HOME: userHome }, dataDir, null);
    try {
      await session.page.getByText(versionLabel).waitFor();
      const home = devHomeIn(userHome, devFolder);

      expect(statSync(daemonSocketIn(home)).isSocket()).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ version: 1 });
      // userData is the given folder: <folder> holds no user-data.
      expect(existsSync(join(home, 'user-data'))).toBe(false);
      expect(existsSync(join(userHome, '.cockpit'))).toBe(false);
      await expectNoErrors(session);
    } finally {
      await session.close();
      rmSync(userHome, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('dev server default folders', () => {
  test('AC1, AC4, AC5 smoke path — under electron-vite dev with COCKPIT_HOME and COCKPIT_USER_DATA_DIR unset and HOME=<tmp>, state.json is in <tmp>/.cockpit-dev/<folder>/user-data and the daemon\'s socket in <tmp>/.cockpit-dev/<folder>', async () => {
    // A short folder, so the socket path fits 103 bytes. The temporary HOME applies to the whole
    // `bun run dev` tree (bun and install-electron included); the Electron binary is already in node_modules.
    const devFolder = await devFolderOfThisWorktree();
    const userHome = realpathSync(makeTestDir('u'));
    const session = await launchDevWith({ ...process.env, SHELL: '/bin/sh', HOME: userHome }, null, null);
    try {
      await session.page.getByText(versionLabel).waitFor();
      const home = devHomeIn(userHome, devFolder);

      expect(JSON.parse(readFileSync(join(home, 'user-data', 'state.json'), 'utf8'))).toMatchObject({ version: 1 });
      expect(statSync(daemonSocketIn(home)).isSocket()).toBe(true);
      expect(readdirSync(join(userHome, '.cockpit-dev'))).toEqual([devFolder]);
      expect(existsSync(join(userHome, '.cockpit'))).toBe(false);
      expect(existsSync(join(session.dataDir, 'state.json'))).toBe(false);
      await expectNoErrors(session);
    } finally {
      await session.close();
      rmSync(userHome, { recursive: true, force: true });
    }
  });
});

// --- Single instance (COCKPIT-54) ----------------------------------------------

interface SecondLaunch {
  exit: { code: number | null; signal: NodeJS.Signals | null } | 'timeout';
  /** Everything the second process wrote to stdout and stderr. */
  output: string;
  elapsedMs: number;
}

// Starts the app a second time with the environment of a running one and waits for it to exit. It
// takes no debugging port: a second launch is expected to leave before it opens a window. A launch
// that is still running after `timeout` ms is stopped and reported as `'timeout'`.
async function runSecondLaunch(command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 10_000): Promise<SecondLaunch> {
  const child = spawn(command, args, { cwd: appDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const started = Date.now();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  // 'close' fires once the process ended and all its stdio streams are closed, so every chunk it
  // wrote has been read.
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const exit = await Promise.race([exited, sleep(timeout).then(() => 'timeout' as const)]);
  const elapsedMs = Date.now() - started;
  if (exit === 'timeout') await stopGroup(child);
  else await waitForGroupGone(child.pid!);
  await closed;
  return { exit, output, elapsedMs };
}

// Replaces the focus calls of the running app's window and of `app` with recorders, so a second
// launch never takes the user's focus. `isMinimized` answers what `setMinimized` says.
const stubFocus = (session: Session) =>
  session.evaluateInMain(`(() => {
    const { app, BrowserWindow } = require('electron');
    const calls = (globalThis.__focusCalls = []);
    globalThis.__minimized = false;
    const window = BrowserWindow.getAllWindows()[0];
    window.show = () => void calls.push('show');
    window.focus = () => void calls.push('focus');
    window.restore = () => void calls.push('restore');
    window.isMinimized = () => globalThis.__minimized;
    app.focus = (options) => void calls.push('app.focus ' + JSON.stringify(options));
  })()`);

const focusCalls = (session: Session) => session.evaluateInMain<string[]>('globalThis.__focusCalls.slice()');
const clearFocusCalls = (session: Session) => session.evaluateInMain('globalThis.__focusCalls.length = 0');
const setMinimized = (session: Session, minimized: boolean) => session.evaluateInMain(`globalThis.__minimized = ${minimized}`);
const windowCount = (session: Session) => session.evaluateInMain<number>(`require('electron').BrowserWindow.getAllWindows().length`);

// What a second launch must leave alone in the running app's folders.
const filesOfRunningApp = (session: Session) => {
  const socket = daemonSocketIn(session.cockpitHome);
  return {
    state: stateSnapshot(session.dataDir),
    socketInode: statSync(socket).ino,
    token: controlTokenIn(session.cockpitHome),
  };
};

// The socket still answers 401 to a request without the token.
async function expectSocketAnswers401(session: Session) {
  const answer = await postSessionEvent(daemonSocketIn(session.cockpitHome), { body: { sessionId: randomUUID(), event: 'working' } });
  expect(answer).toEqual({ status: 401, text: '' });
}

// A second launch on the running app's folders: exits 0 within 10 s, prints no error, opens no
// window, leaves state.json and the daemon's socket and token alone, and the first process runs on.
async function expectSecondLaunchLeaves(session: Session, launch: () => Promise<SecondLaunch>) {
  const before = filesOfRunningApp(session);
  const second = await launch();
  expect(second.exit, `the second launch exited (output: ${second.output})`).toEqual({ code: 0, signal: null });
  expect(second.elapsedMs).toBeLessThan(10_000);
  expect(second.output).not.toMatch(MAIN_PROCESS_ERROR);
  expect(second.output).not.toContain("Cockpit's background service could not start");
  expect(filesOfRunningApp(session)).toEqual(before);
  await expectSocketAnswers401(session);
  expect(await windowCount(session)).toBe(1);
  expect(session.isRunning()).toBe(true);
  expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
}

// The calls the running app made to bring its window to the front, once the second launch has
// reached it.
const frontCalls = (session: Session) => poll(() => focusCalls(session), (calls) => calls.includes('show'), 5_000);

const FRONT_CALLS = ['app.focus {"steal":true}', 'focus', 'show'];

describe('single instance: built app', () => {
  let session: Session;
  let dataDir: string;
  let front: ReturnType<typeof watchFrontmost>;
  const electron: string = createRequire(import.meta.url)('electron');
  const secondLaunch = (timeout?: number) =>
    runSecondLaunch(
      electron,
      ['--remote-debugging-port=0', '--inspect=0', '.'],
      launchEnv(true, dataDir, { ...process.env, SHELL: '/bin/sh' }, session.cockpitHome).env,
      timeout,
    );

  beforeAll(async () => {
    front = watchFrontmost();
    dataDir = makeTestDir('d-');
    session = await launchBuiltWith({ ...process.env, SHELL: '/bin/sh' }, dataDir);
    await session.page.getByText(versionLabel).waitFor();
    await stubFocus(session);
  });

  afterAll(async () => {
    await front?.stop();
    await session?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC1 — a second launch on the same userData folder exits with code 0 within 10 s, prints no error, opens no window and leaves state.json and the daemon\'s socket and token untouched while the first process keeps running', async () => {
    await expectSecondLaunchLeaves(session, () => secondLaunch());
  });

  test('AC2 — a second launch makes the running app show its window, focus it and activate the app, without restoring a window that is not minimized', async () => {
    await clearFocusCalls(session);
    await setMinimized(session, false);

    await secondLaunch();

    const calls = await frontCalls(session);
    expect([...new Set(calls)].sort()).toEqual(FRONT_CALLS);
    expect(calls).not.toContain('restore');
  });

  test('AC2 — a minimized window is restored before it is shown', async () => {
    await clearFocusCalls(session);
    await setMinimized(session, true);

    await secondLaunch();

    const calls = await frontCalls(session);
    expect(calls).toContain('restore');
    expect(calls.indexOf('restore')).toBeLessThan(calls.indexOf('show'));
    expect([...new Set(calls)].sort()).toEqual(['app.focus {"steal":true}', 'focus', 'restore', 'show']);
    await setMinimized(session, false);
    // The stubbed calls never took the user's focus: the app was not frontmost at any time.
    expect(front.pids.has(session.pid)).toBe(false);
  });

  test('AC4 — two launches with their own userData folders and COCKPIT_HOME, started together, both render the home page and neither prints that the background service could not start', async () => {
    const [one, two] = await Promise.all([launchBuilt(), launchBuilt()]);
    try {
      for (const other of [one, two]) {
        await other.page.getByText(versionLabel).waitFor();
        await other.page.getByRole('heading', { name: 'Home' }).waitFor();
        expect(other.output()).not.toContain("Cockpit's background service could not start");
        expect(other.output()).not.toMatch(MAIN_PROCESS_ERROR);
      }
      expect(one.dataDir).not.toBe(two.dataDir);
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  });

  // Last: it destroys the window the other tests stubbed.
  test('AC3 — with no window open, a second launch opens one new window that loads the home page', async () => {
    await session.evaluateInMain(`require('electron').BrowserWindow.getAllWindows().forEach((window) => window.destroy())`);
    expect(await windowCount(session)).toBe(0);
    expect(session.isRunning()).toBe(true);

    const second = await secondLaunch();
    expect(second.exit).toEqual({ code: 0, signal: null });

    expect(await poll(() => windowCount(session), (count) => count === 1, 5_000)).toBe(1);
    const loaded = await poll(
      () => session.evaluateInMain<{ url: string; loading: boolean }>(`(() => {
        const { webContents } = require('electron').BrowserWindow.getAllWindows()[0];
        return { url: webContents.getURL(), loading: webContents.isLoading() };
      })()`),
      ({ url, loading }) => url !== '' && !loading,
      10_000,
    );
    const url = new URL(loaded.url);
    // `URL.origin` is "null" for a custom protocol: rebuild it.
    expect(`${url.protocol}//${url.host}`).toBe('app://renderer');
    expect(url.pathname).toBe('/');
    expect(loaded.loading).toBe(false);
    expect(await windowCount(session)).toBe(1);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});

describe('single instance: packaged app', () => {
  let session: Session;
  let dataDir: string;
  let userHome: string;
  let front: ReturnType<typeof watchFrontmost>;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    front = watchFrontmost();
    dataDir = makeTestDir('d-');
    // A short folder: the socket path is limited to 103 bytes on macOS.
    userHome = makeTestDir('u');
    env = { ...process.env, SHELL: '/bin/sh', HOME: userHome };
    // COCKPIT_HOME unset: the packaged app's default home.
    session = await launchSpawned(join(packagedAppDir(), 'Contents/MacOS/Cockpit'), [], true, dataDir, env, null);
    await session.page.getByText(versionLabel).waitFor();
    await stubFocus(session);
  });

  afterAll(async () => {
    await front?.stop();
    await session?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (userHome) rmSync(userHome, { recursive: true, force: true });
  });

  test('AC6 — with COCKPIT_HOME unset and HOME=<tmp>, the daemon\'s socket is <tmp>/.cockpit/daemon-1-<build>.sock and <tmp>/.cockpit-dev does not exist', () => {
    expect(statSync(daemonSocketIn(join(userHome, '.cockpit'))).isSocket()).toBe(true);
    expect(existsSync(join(userHome, '.cockpit-dev'))).toBe(false);
    expect(session.output()).not.toContain("Cockpit's background service could not start");
  });

  test('AC1, AC2 smoke path — a second launch of the packaged app exits with code 0 and leaves the files alone, and the running app shows and focuses its window', async () => {
    const second = () =>
      runSecondLaunch(
        join(packagedAppDir(), 'Contents/MacOS/Cockpit'),
        ['--remote-debugging-port=0', '--inspect=0'],
        launchEnv(true, dataDir, env, null).env,
      );
    // The running app's home is <HOME>/.cockpit, not a folder inside the data folder.
    const home = join(userHome, '.cockpit');
    const files = () => ({ state: stateSnapshot(dataDir), socketInode: statSync(daemonSocketIn(home)).ino, token: controlTokenIn(home) });
    const before = files();
    await clearFocusCalls(session);

    const launched = await second();

    expect(launched.exit, `the second launch exited (output: ${launched.output})`).toEqual({ code: 0, signal: null });
    expect(launched.elapsedMs).toBeLessThan(10_000);
    expect(launched.output).not.toMatch(MAIN_PROCESS_ERROR);
    expect(files()).toEqual(before);
    expect([...new Set(await frontCalls(session))].sort()).toEqual(FRONT_CALLS);
    expect(await windowCount(session)).toBe(1);
    expect(session.isRunning()).toBe(true);
    expect(front.pids.has(session.pid)).toBe(false);
  });
});

// Sessions across a restart of the packaged app, on a data folder the test
// creates and removes; the launch's Cockpit home is inside it.
describe('packaged app sessions after a restart', () => {
  let fx: SessionsFixture;
  let dataDir: string;

  let repo: TempRepo;
  let origin: string;
  let open: OpenFixture;
  let gh: GhFixture;

  beforeEach(() => {
    fx = makeSessionsFixture(['claude', 'codex']);
    open = addOpenFixture(fx);
    // A stub `gh` for the ship section (COCKPIT-38).
    gh = addGhFixture(fx);
    dataDir = makeTestDir('d-');
    repo = makeRepo('packaged-agent-ws');
    origin = addOrigin(repo);
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo.parent, { recursive: true, force: true });
  });

  test('AC9, changes AC16 — sessions of a previous launch are listed as "Ended", newest first, open as ended and leave state.json and their folders alone (the first launch also runs the Changes sidebar, ship section and open-workspace smoke paths)', async () => {
    const first = await launchPackagedWith({ ...open.env(), ...GIT_APP_ENV }, dataDir);
    try {
      await first.page.getByText(versionLabel).waitFor();
      // The packaged app's sessions smoke path: the stub runs in a new folder
      // under COCKPIT_HOME, the entry shows as running, the session is stored.
      const id = await startSession(first.page, 'Claude Code', 'Claude Code 1');
      const home = join(first.cockpitHome, 'sessions', id);
      const stub = await readStub(first.page);
      expect(stub.cwd).toBe(realpathSync(home));
      expect(stub.term).toBe('xterm-256color');
      expect(await waitForSessionEntries(first.page, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
      const storedFirst = await poll(() => sessionsInState(dataDir), (list) => list.length > 0, UI_TIMEOUT);
      expect(storedFirst.map((s) => [s.name, s.directory])).toEqual([['Claude Code 1', home]]);
      // Control endpoint smoke path.
      await expectControlEndpoint(first);

      await startSession(first.page, 'Codex', 'Codex 1');
      await poll(() => sessionsInState(dataDir), (list) => list.length === 2, UI_TIMEOUT);

      // Workspace sessions smoke path: a new workspace with Claude Code and a prompt.
      await addRepository(first, repo);
      const wsId = await createWorkspaceWithAgent(first.page, repo, { name: 'smoke-agent', agent: 'Claude Code', prompt: 'fix the tests' }, 'Claude Code 1');
      const wsPath = worktreePath(first, repo, 'smoke-agent');
      const wsStub = await readStub(first.page);
      expect(wsStub.cwd).toBe(wsPath);
      expect(wsStub.argCount).toBe(1);
      expect(wsStub.args).toBe('fix the tests');
      expect(await waitForWorkspaceLinks(first.page, wsPath, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
      const storedWs = await poll(() => sessionsInState(dataDir), (list) => list.some((entry) => entry.id === wsId), UI_TIMEOUT);
      expect(storedWs.find((entry) => entry.id === wsId)).toMatchObject({ name: 'Claude Code 1', directory: wsPath, project: repo.root });

      // Open workspace smoke path: "Open in editor" then Cursor.
      await openWorkspaceMenu(first.page, wsPath, FIRST_MENU);
      await pickInSubmenu(first.page, 'Open in editor', 'Cursor');
      expect(await waitForOpenRuns(open, 1)).toEqual([['-a', join(open.apps, 'Cursor.app'), wsPath]]);
      expect((await poll(() => rememberedApps(dataDir), ({ editor }) => editor !== undefined, UI_TIMEOUT)).editor).toBe('cursor');

      // Changes sidebar smoke path (COCKPIT-34 AC16): a file written in the worktree shows with its diff.
      await expectChangesShowNewFile(first.page, wsPath);
      // Ship section smoke path (COCKPIT-38): the stub's pull request shows, then a commit and a push reach origin.
      await expectShipSmoke(first.page, gh, wsPath, origin, 'smoke-agent');
      await expectNoErrors(first);
    } finally {
      await first.close();
    }

    const stored = sessionsInState(dataDir).filter((entry) => entry.project === undefined);
    expect(stored.map((s) => s.name)).toEqual(['Claude Code 1', 'Codex 1']);
    const before = stateSnapshot(dataDir);

    const second = await launchPackagedWith(fx.env(), dataDir);
    try {
      await second.page.getByText(versionLabel).waitFor();
      expect(await waitForSessionEntries(second.page, [['Codex 1', true], ['Claude Code 1', true]])).toEqual([
        ['Codex 1', true],
        ['Claude Code 1', true],
      ]);
      // Statuses are not kept: a session of an earlier launch shows the "Ended" dot, never "Exited N".
      expect((await sessionEntries(second.page)).map((entry) => entry.status)).toEqual(['Ended', 'Ended']);

      await openSessionEntry(second.page, 'Claude Code 1');
      await second.page.getByText('This session has ended.').waitFor({ timeout: UI_TIMEOUT });
      await second.page.getByText(stored[0]!.directory).first().waitFor({ timeout: UI_TIMEOUT });
      expect(statSync(stored[0]!.directory).isDirectory()).toBe(true);
      expect(statSync(stored[1]!.directory).isDirectory()).toBe(true);
      await expectNoErrors(second);
    } finally {
      await second.close();
    }

    expect(stateSnapshot(dataDir)).toEqual(before);
    expect(backupsIn(dataDir)).toEqual([]);
  });
});

// The real launch, as a user starts the app. It opens a visible window, so it
// runs in CI only, never on a developer's machine.
describe.runIf(process.env.CI)('packaged app without the background switch', () => {
  let session: Session;

  beforeAll(async () => {
    session = await launchPackaged({ background: false });
  });

  afterAll(async () => {
    await session?.close();
    if (session) expect(existsSync(session.dataDir)).toBe(false);
  });

  test('opens a visible window as a regular app', async () => {
    // A window that was never shown reports `hidden`.
    const visibility = await poll(
      () => session.page.evaluate(() => document.visibilityState),
      (state) => state === 'visible',
      5_000,
    );
    expect(visibility).toBe('visible');
    expect(await applicationType(session.pid)).toContain('"Foreground"');
  });

  test('AC7 — the output holds what the app wrote from its first line', () => {
    expect(session.output()).toContain('DevTools listening on');
  });
});
