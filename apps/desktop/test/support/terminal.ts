import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, rmSync, watch, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { type ElementHandle, type Page } from 'playwright-core';
import { expect } from 'vitest';
import { launchPackaged, type Session, truthy, untilIn, untilRead } from '../launch';
import { makeTestDir } from '../run-root';
import { addRepository, dispatchFocus, makeRepo, waitForEntry, waitForNoEntry, worktreePath } from './projects';

// What the page sees of the main process's `Api.getShellPath`.
export const getShellPath = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { api: { getShellPath(): Promise<string> } }).api.getShellPath());

// The PATH launchd gives an app started from the Finder or the Dock.
export const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

// The environment launchd gives an app started from the Finder or the Dock,
// minus the few variables it adds that no startup file is expected to need.
export const LAUNCHD_ENV: Record<string, string> = (() => {
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
export const normalizeFnm = (path: string) => path.replace(/fnm_multishells\/[^/:]+/g, 'fnm_multishells/<id>');

export const launchLaunchd = () => launchPackaged({ env: LAUNCHD_ENV });

export const run = promisify(execFile);

// An empty answer means lsappinfo has nothing to report (no frontmost app, an
// app it does not know yet).
export async function lsappinfo(...args: string[]): Promise<string> {
  return run('lsappinfo', args).then(({ stdout }) => stdout.trim(), () => '');
}

// Resolves once `path` exists.
export function untilExists(path: string): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    };
    const watcher = watch(dirname(path), check);
    check();
  });
}

// `lsappinfo listen +<code>…` prints one `Notification:` line per Launch Services event while its `wait` runs. The
// commands run in order, so the file `createFile` makes says the listener is registered (an event after it is
// printed), and `wait -gone` ends it when `stop()` removes the file it waits on. Checked on a CI runner
// (COCKPIT-81): `appCreation` carries `"ApplicationType"` and `"pid"` of an app spawned directly, `becameFrontmost`
// the `LSASN` of the app.
export function listenLaunchServices(codes: string[], onLine: (line: string) => void = () => {}) {
  const folder = makeTestDir('l-');
  const registered = join(folder, 'registered');
  const alive = join(folder, 'alive');
  writeFileSync(alive, '');
  const child = spawn('lsappinfo', ['listen', ...codes.map((code) => `+${code}`), 'createFile', registered, 'wait', '-gone', alive], { stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = once(child, 'close');
  const lines: string[] = [];
  const waiting: Array<() => void> = [];
  let partial = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const parts = (partial + chunk).split('\n');
    partial = parts.pop()!;
    for (const line of parts.filter((each) => each.startsWith('Notification:'))) {
      lines.push(line);
      onLine(line);
    }
    for (const wake of waiting.splice(0)) wake();
  });
  return {
    registered: Promise.race([untilExists(registered), closed.then(() => Promise.reject(new Error('lsappinfo listen ended before it listened')))]),
    // The first notification, already printed or to come, that `matches`.
    async next(matches: (line: string) => boolean): Promise<string> {
      for (let seen = 0; ; ) {
        const found = lines.slice(seen).find(matches);
        if (found) return found;
        seen = lines.length;
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },
    async stop() {
      rmSync(alive, { force: true });
      await closed;
    },
  };
}

// Reports `ApplicationType` `UIElement` for an app without a Dock icon and `Foreground` for a regular one. A
// launched app is not registered with Launch Services right away: the listener is up first, then one query, then
// the `appCreation` of the app (its payload holds the type) when the query had nothing yet.
export async function applicationType(pid: number): Promise<string> {
  const listener = listenLaunchServices(['appCreation']);
  try {
    await listener.registered;
    const answer = await lsappinfo('info', '-only', 'ApplicationType', String(pid));
    if (/ApplicationType"="/.test(answer)) return answer;
    const created = await listener.next((line) => new RegExp(`"pid"=${pid}\\b`).test(line));
    return /"ApplicationType"="[^"]*"/.exec(created)![0];
  } finally {
    await listener.stop();
  }
}

// Collects the pids of the apps that became the frontmost one. Started (and `await`ed) before the launch, so an
// activation at startup is seen too. The notification names the app by its ASN: its pid is asked once per
// notification, and `activated` waits for those answers.
export async function watchFrontmost() {
  const pids = new Set<number>();
  const asked: Array<Promise<void>> = [];
  const listener = listenLaunchServices(['becameFrontmost'], (line) => {
    const asn = /"LSASN"=(ASN:[0-9a-fx-]+:)/.exec(line)?.[1];
    if (!asn) return;
    asked.push(
      lsappinfo('info', '-only', 'pid', asn).then((answer) => {
        const pid = /"pid"=(\d+)/.exec(answer)?.[1];
        if (pid) pids.add(Number(pid));
      }),
    );
  });
  await listener.registered;
  return {
    // Whether the app of `pid` became the frontmost one since the watch began.
    activated: async (pid: number) => {
      for (let seen = 0; seen < asked.length; ) {
        seen = asked.length;
        await Promise.all(asked);
      }
      return pids.has(pid);
    },
    stop: () => listener.stop(),
  };
}

// What `window.api.pty` must look like. Declared here, not imported, because
// the test project does not include the app sources.
export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}
export interface PtyExit {
  exitCode: number | null;
  signal: number | null;
}
export interface PtyApi {
  spawn(options: PtySpawnOptions): Promise<number>;
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  kill(id: number): void;
  list(): Promise<Array<{ id: number; kind?: string; sessionId?: string }>>;
  attach(id: number): Promise<unknown>;
  onData(listener: (id: number, data: string) => void): () => void;
  onExit(listener: (id: number, exit: PtyExit) => void): () => void;
}
/** What the renderer collected from `onData` and `onExit`, per session id. */
export interface PtyLog {
  data: Record<number, string>;
  exits: Record<number, PtyExit[]>;
  /** Called after each chunk of output and each exit: what a wait on either resolves from. */
  changed: Array<() => void>;
}
export type PtyWindow = Window & { api: { pty: PtyApi }; __ptyLog?: PtyLog };

export const shellOptions: PtySpawnOptions = {
  command: '/bin/sh',
  args: [],
  cwd: homedir(),
  env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
};

// Starts the page's log of the output and exits of every terminal, once per page load. Spawning registers it
// before the spawn, so no output is missed; a test waiting for the exit of a terminal it did not spawn calls it
// before the action that ends it.
export function ensurePtyLog(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as PtyWindow;
    if (!w.api.pty) throw new Error('window.api.pty is not exposed');
    if (w.__ptyLog) return;
    const log: PtyLog = { data: {}, exits: {}, changed: [] };
    w.api.pty.onData((id, data) => {
      log.data[id] = (log.data[id] ?? '') + data;
      for (const notify of log.changed.slice()) notify();
    });
    w.api.pty.onExit((id, exit) => {
      (log.exits[id] ??= []).push(exit);
      for (const notify of log.changed.slice()) notify();
    });
    w.__ptyLog = log;
  });
}

// Spawns a shell through `window.api.pty` from the renderer.
export async function spawnShell(page: Page, options: Partial<PtySpawnOptions> = shellOptions): Promise<number> {
  await ensurePtyLog(page);
  return page.evaluate((options) => (window as unknown as PtyWindow).api.pty.spawn(options as PtySpawnOptions), options);
}

// The id the page's list holds for the terminal of a session, while it runs.
export async function terminalOfSession(page: Page, sessionId: string): Promise<number> {
  const listed = await page.evaluate(() => (window as unknown as PtyWindow).api.pty.list());
  const found = listed.find((terminal) => terminal.sessionId === sessionId);
  if (!found) throw new Error(`no terminal listed for session ${sessionId}`);
  return found.id;
}

// The number of terminals whose exit the page's log holds.
export const exitCount = (page: Page) => page.evaluate(() => Object.keys((window as unknown as PtyWindow).__ptyLog!.exits).length);

export const ptyWrite = (page: Page, id: number, data: string) =>
  page.evaluate(([id, data]) => (window as unknown as PtyWindow).api.pty.write(id, data), [id, data] as const);

export const ptyResize = (page: Page, id: number, cols: number, rows: number) =>
  page.evaluate(([id, cols, rows]) => (window as unknown as PtyWindow).api.pty.resize(id, cols, rows), [id, cols, rows] as const);

export const ptyKill = (page: Page, id: number) =>
  page.evaluate((id) => (window as unknown as PtyWindow).api.pty.kill(id), id);

// Resolves once `holds(log, arg)` is true: checked at once and after each chunk of output or exit the page
// receives (the `changed` listeners of `spawnShell`'s log). `holds` runs in the page, from its source text.
export const untilPtyLog = <A>(page: Page, holds: (log: PtyLog, arg: A) => boolean, arg: A) =>
  page.evaluate(`new Promise((resolve, reject) => {
    const log = window.__ptyLog;
    if (!log) return reject(new Error('no pty log: spawnShell has not run in this page'));
    const holds = ${holds.toString()};
    const arg = ${JSON.stringify(arg)};
    const check = () => {
      if (!holds(log, arg)) return;
      log.changed.splice(log.changed.indexOf(check), 1);
      resolve();
    };
    log.changed.push(check);
    check();
  })`);

// Waits until the output of the session contains `text`, or matches it when it
// is a regular expression.
export const waitForOutput = (page: Page, id: number, text: string | RegExp) =>
  untilPtyLog(
    page,
    (log, [id, source]: [number, string]) => new RegExp(source).test(log.data[id] ?? ''),
    [id, typeof text === 'string' ? text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : text.source],
  );

export const waitForExit = (page: Page, id: number) => untilPtyLog(page, (log, id: number) => (log.exits[id]?.length ?? 0) > 0, id);

export const exitsOf = (page: Page, id: number) =>
  page.evaluate((id) => (window as unknown as PtyWindow).__ptyLog?.exits[id] ?? [], id);

export const outputOf = (page: Page, id: number) =>
  page.evaluate((id) => (window as unknown as PtyWindow).__ptyLog?.data[id] ?? '', id);

export const consoleErrorsOf = async (page: Page) =>
  (await page.consoleMessages()).filter((m) => m.type() === 'error').map((m) => m.text());

// By default Playwright returns only what came after the last new-document
// navigation (a reload included). These read everything since the page was
// attached (or since the last clear), so a message logged before a reload counts.
export const allConsoleErrorsOf = async (page: Page) =>
  (await page.consoleMessages({ filter: 'all' })).filter((m) => m.type() === 'error').map((m) => m.text());

export const allPageErrorsOf = (page: Page) => page.pageErrors({ filter: 'all' });

// --- Terminal page helpers ---------------------------------------------------

// A terminal on the page. The page keeps every terminal of every tab in the DOM
// (the ones of other tabs are hidden), so a helper never reads "the terminal":
// it reads one pane, the one the keyboard is in unless the test gives another.
export type Pane = ElementHandle<HTMLElement>;

// The visible terminals (those of the selected tab), in DOM order.
// Read through `evaluateHandle`, not a locator: after a refused navigation a
// locator wait hangs (see the navigation tests).
export async function visiblePanes(page: Page): Promise<Pane[]> {
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
export async function activePane(page: Page): Promise<Pane | null> {
  const handle = await page.evaluateHandle(() => {
    const focused = document.activeElement?.closest('.xterm');
    if (!focused) return null;
    const { width, height } = focused.getBoundingClientRect();
    return width > 0 && height > 0 && getComputedStyle(focused).visibility === 'visible' ? focused : null;
  });
  return (handle.asElement() as Pane | null) ?? null;
}

// The terminal that holds the keyboard focus; else the first visible one.
export async function focusedPane(page: Page): Promise<Pane> {
  // A page-side wait, not a locator (see `visiblePanes`): until one terminal is visible.
  await untilRead(
    page,
    () =>
      [...document.querySelectorAll('.xterm')].some((element) => {
        const { width, height } = element.getBoundingClientRect();
        return width > 0 && height > 0 && getComputedStyle(element).visibility === 'visible';
      }),
    truthy,
  );
  const pane = (await activePane(page)) ?? (await visiblePanes(page))[0];
  if (!pane) throw new Error('No terminal is visible');
  return pane;
}

// The home page (`/`) is the composer with a project in Cockpit and the empty state without (COCKPIT-72).
export async function goHome(page: Page) {
  await page.getByRole('link', { name: 'New workspace', exact: true }).click();
  await page.getByRole('heading', { name: 'New workspace', exact: true }).or(page.getByText('No projects yet', { exact: true })).waitFor();
}

// Ends every shell of the daemon (COCKPIT-55: the shells outlive the page, so a reload shows them
// again), through `window.api.pty`, and waits until the daemon lists none. Sessions are left running.
export async function endShells(page: Page) {
  await page.evaluate(async () => {
    const { pty } = (window as unknown as PtyWindow).api;
    // The exit event of each killed shell is the end of it: listened for before the kill, and the page
    // attaches the shell first so that this window is the one the event goes to.
    const exits = new Map<number, () => void>();
    const off = pty.onExit((id) => exits.get(id)?.());
    const shells = (await pty.list()).filter((terminal) => (terminal.kind ?? 'shell') === 'shell').map((terminal) => terminal.id);
    const ended = shells.map((id) => new Promise<void>((resolve) => exits.set(id, resolve)));
    await Promise.all(shells.map((id) => pty.attach(id).catch(() => exits.get(id)?.())));
    for (const id of shells) pty.kill(id);
    await Promise.all(ended);
    off();
  });
}

// COCKPIT-70: the Terminal page is gone; a shell tab of a workspace page stands in for it where a test needs
// one terminal. A repository and a workspace are made once per session. Each call reloads on Home (the
// panes outlive a visit, and, once the shells are ended, a reload starts over), opens the workspace page
// through its sidebar row, starts a "Terminal" tab and focuses its terminal.
export const terminalWorkspaces = new WeakMap<Session, { path: string; root: string }>();

export async function openTerminal(session: Session) {
  const { page } = session;
  let path = terminalWorkspaces.get(session)?.path;
  if (!path) {
    const repo = makeRepo('terminal-repo');
    await addRepository(session, repo);
    const created = await page.evaluate(
      ([project, name]) =>
        (window as unknown as { api: { workspaces: { create(project: string, name: string, base: string): Promise<{ status: string }> } } }).api.workspaces.create(
          project!,
          name!,
          'main',
        ),
      [repo.root, 'term'] as const,
    );
    expect(created.status).toBe('created');
    await dispatchFocus(page);
    path = worktreePath(session, repo, 'term');
    terminalWorkspaces.set(session, { path, root: repo.root });
    await waitForEntry(page, path!);
  }
  await goHome(page);
  await endShells(page);
  await page.reload();
  await page.getByRole('heading', { name: 'New workspace', exact: true }).waitFor();
  await openShellTab(page, path);
}

// Ends the shells and removes the repository `openTerminal` made, so that the tests that follow list only their own
// projects.
export async function dropTerminalWorkspace(session: Session) {
  const found = terminalWorkspaces.get(session);
  if (!found) return;
  terminalWorkspaces.delete(session);
  const { page } = session;
  await endShells(page);
  await page.evaluate((root) => (window as unknown as { api: { projects: { remove(path: string): Promise<void> } } }).api.projects.remove(root), found.root);
  await dispatchFocus(page);
  await waitForNoEntry(page, found.root);
}

// Opens the page of a workspace through its sidebar row, starts a "Terminal" tab and focuses its terminal.
export async function openShellTab(page: Page, workspacePath: string) {
  await page.getByTitle(workspacePath, { exact: true }).first().click();
  await page.getByRole('tablist').first().waitFor();
  await page.getByRole('button', { name: 'New tab', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
  await focusTerminal(page);
}

// For a page with a single visible terminal.
export async function focusTerminal(page: Page) {
  const terminal = page.locator('.xterm:visible').first();
  await terminal.waitFor({ state: 'visible' });
  await terminal.click();
  await page.locator('.xterm:visible .xterm-helper-textarea').first().focus();
}

// Clicks a terminal and puts the keyboard in it.
export async function focusPane(pane: Pane) {
  await pane.click();
  await pane.$eval('.xterm-helper-textarea', (textarea) => (textarea as HTMLElement).focus());
}

// Types on the keyboard, as a user does: it goes to the focused terminal.
export async function typeLine(page: Page, text: string) {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

// The text of each row xterm.js renders (its DOM renderer) in one terminal, cell
// padding removed.
export const rowsOf = (pane: Pane) =>
  pane.evaluate((element) =>
    [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/ /g, ' ').trimEnd()),
  );

export const terminalRows = async (page: Page, pane?: Pane) => rowsOf(pane ?? (await focusedPane(page)));

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Waits until a row of the terminal is exactly `text`, or matches it when it is a
// regular expression. Output reaches the DOM on animation frames: the wait is on the DOM mutation.
export async function waitForRow(page: Page, text: string | RegExp, pane?: Pane) {
  await untilIn(
    pane ?? (await focusedPane(page)),
    (element, source: string) => {
      const pattern = new RegExp(source);
      return [...element.querySelectorAll('.xterm-rows > div')].some((row) =>
        pattern.test((row.textContent ?? '').replace(/ /g, ' ').trimEnd()),
      );
    },
    truthy,
    typeof text === 'string' ? `^${escapeRegExp(text)}$` : text.source,
  );
}

// Waits for a row matching `pattern` and returns its capture groups.
export async function captureRow(page: Page, pattern: RegExp, pane?: Pane): Promise<string[]> {
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
export const waitForPrompt = async (page: Page, pane?: Pane) =>
  untilIn(
    pane ?? (await focusedPane(page)),
    (element) => [...element.querySelectorAll('.xterm-rows > div')].some((row) => (row.textContent ?? '').trim() !== ''),
    truthy,
  );

// Types `stty size` and returns the `[rows, cols]` of its answer.
export async function terminalSize(page: Page, pane?: Pane): Promise<[number, number]> {
  const target = pane ?? (await focusedPane(page));
  const answers = (element: HTMLElement) =>
    [...element.querySelectorAll('.xterm-rows > div')].filter((row) => /^\d+\s\d+\s*$/.test(row.textContent ?? '')).length;
  const before = await target.evaluate(answers);
  await typeLine(page, 'stty size');
  await untilIn(
    target,
    (element, before: number) =>
      [...element.querySelectorAll('.xterm-rows > div')].filter((row) => /^\d+\s\d+\s*$/.test(row.textContent ?? '')).length > before,
    truthy,
    before,
  );
  const rows = await rowsOf(target);
  const last = rows.filter((row) => /^\d+ \d+$/.test(row)).at(-1)!;
  const [r, c] = last.split(' ').map(Number);
  return [r!, c!];
}

// Types `echo pid-$$` in a terminal and returns the shell's process id. With a
// pane, it clicks it first; without, it types where the keyboard already is.
export async function pidOf(page: Page, pane?: Pane): Promise<number> {
  if (pane) await focusPane(pane);
  const target = pane ?? (await focusedPane(page));
  await waitForPrompt(page, target);
  await typeLine(page, 'echo pid-$$');
  const [pid] = await captureRow(page, /^pid-(\d+)$/, target);
  return Number(pid);
}

// Whether the process is gone within `timeout` ms.

// The pid of the daemon (COCKPIT-55; it was the pty utility process), read from the parent of a probe shell (ended
// before the call returns, so it leaves nothing under the host).
export async function ptyHostPid(page: Page): Promise<number> {
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
export async function killPtyHost(page: Page): Promise<number> {
  const id = await spawnShell(page);
  await ptyWrite(page, id, 'echo ppid-$PPID\n');
  await waitForOutput(page, id, /ppid-\d+/);
  const hostPid = Number(/ppid-(\d+)/.exec(await outputOf(page, id))![1]);
  expect(hostPid, 'the host is a process of its own, not the main process').toBeGreaterThan(0);
  process.kill(hostPid, 'SIGKILL');
  await waitForExit(page, id);
  return id;
}

// The console errors of the navigation tests that are not the refusal of the
// file:// URL they tried: Chromium words it `Not allowed to load local resource:
// <url>`, and any other message of that kind is a failure.
export const unexpectedConsoleErrors = (errors: string[], fileUrl: string) =>
  errors.filter((text) => text !== `Not allowed to load local resource: ${fileUrl}`);

// What the terminal paints against what the tokens say, in `rgb()` form: a
// token is normalised through a 1x1 canvas, whatever notation it is written in.
export interface TerminalColors {
  actual: { text: string; background: string; red: string };
  expected: { text: string; background: string; red: string };
}
// Self-contained: it also runs in `untilRead`.
export const readTerminalColorsNow = (): TerminalColors => {
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
  };
