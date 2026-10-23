import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type ElementHandle, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

// Launches the app the four ways it runs: the dev server, the built app, the
// packaged app and the packaged app with the minimal environment launchd gives
// an app opened from the Finder or the Dock, and checks each one starts,
// renders, logs no error, stays in the background and writes its data in its
// own folder. In CI only, it also launches the packaged app without the
// background switch.

const appDir = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version: string };
// Shown in the sidebar from `window.api.getVersion()`, so it proves the
// renderer reaches the main process.
const versionLabel = `Cockpit ${version}`;

// Signs of an uncaught error in the main process.
const MAIN_PROCESS_ERROR = /\bUncaught\b|\bUnhandled\b|App threw an error/;

interface Session {
  page: Page;
  /** The app's main process. */
  pid: number;
  /** The folder the app was told to keep its data in, removed on close. */
  dataDir: string;
  /**
   * `COCKPIT_HOME` the app was launched with: inside `dataDir`, so it goes away with it. Empty
   * when the launch left it unset or empty.
   */
  cockpitHome: string;
  /** Everything the app wrote to stdout and stderr. */
  output(): string;
  /**
   * Evaluates an expression in the app's main process, through the Node
   * inspector, and returns its value. `require` is available in it (the
   * inspector's command-line API). The app has no test hook: this is how a test
   * replaces the folder picker.
   */
  evaluateInMain<T = unknown>(expression: string): Promise<T>;
  /**
   * Closes the connection to the main process's inspector. A Node process with a
   * connected inspector waits for it to disconnect before it exits, so a test
   * that makes the app quit disconnects first.
   */
  disconnectInspector(): Promise<void>;
  isRunning(): boolean;
  close(): Promise<void>;
}

// Every launch gets a fresh data folder, so no launch touches the data of
// another one or of the Cockpit the developer has open. The background switch
// keeps the app out of the Dock and out of the way: it never shows a window nor
// takes the focus. The spawned app's `env` replaces the environment, hence the spread
// of `base`, the test runner's environment unless the launch gives another one
// (the launchd launch gives its own minimal one).
// A test that must start the app twice on the same data folder creates the
// folder itself, passes it in and removes it afterwards: sessions leave a folder
// they were given in place.
// `COCKPIT_HOME` is a folder inside the data folder: the worktrees and session
// folders the app creates live under it and are removed with it, and no test
// touches the developer's `~/.cockpit`. Only a test of the default passes `null`
// (unset) or `''` (empty), with a `HOME` of its own.
// The terminal page runs whatever `$SHELL` says: by default `/bin/sh`, which keeps
// the developer's shell configuration from slowing or breaking the tests.
function launchEnv(
  background: boolean,
  dataDir = mkdtempSync(join(tmpdir(), 'cockpit-test-')),
  base: NodeJS.ProcessEnv = { ...process.env, SHELL: '/bin/sh' },
  cockpitHome: string | null = join(dataDir, 'cockpit-home'),
) {
  const env = { ...base, COCKPIT_USER_DATA_DIR: dataDir } as Record<string, string>;
  if (cockpitHome === null) delete env.COCKPIT_HOME;
  else env.COCKPIT_HOME = cockpitHome;
  if (background) env.COCKPIT_TEST_BACKGROUND = '1';
  else delete env.COCKPIT_TEST_BACKGROUND;
  return { dataDir, cockpitHome: cockpitHome ?? '', env };
}

// Attaches to a running Electron over the Chrome DevTools Protocol and returns
// its first window. Reloads it so the page's console output is captured from the
// start.
async function attach(endpoint: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  // The window's target starts as `about:blank` while its first navigation to the
  // app is pending: a reload racing that navigation waits for a load that never
  // comes. Wait until the page is on the app's URL and loaded.
  await page.waitForURL((url) => url.protocol !== 'about:', { timeout: 30_000 });
  await page.reload();
  return { browser, page };
}

// Signals a process group, which may already be gone.
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

// `kill(-pid, 0)` throws ESRCH once the group is gone.
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// Waits until no process of the group `pid` is alive: the helpers of a child can
// outlive it and still write in the data folder. The group gets SIGKILL 10 s after
// `started` if anything is left, and an error names it after 20 s.
async function waitForGroupGone(pid: number, started = Date.now()): Promise<void> {
  const killer = setTimeout(() => signalGroup(pid, 'SIGKILL'), Math.max(0, 10_000 - (Date.now() - started)));
  try {
    while (groupAlive(pid)) {
      if (Date.now() - started > 20_000) throw new Error(`the process group ${pid} is still alive after 20 s`);
      await sleep(100);
    }
  } finally {
    clearTimeout(killer);
  }
}

// Stops a process started with `detached: true` and everything in its process
// group, and waits until no process of the group is alive.
async function stopGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid!;
  const started = Date.now();
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve));
  signalGroup(pid, 'SIGTERM');
  await Promise.all([exited, waitForGroupGone(pid, started)]);
}

// Connects to the main process's Node inspector (`--inspect=0` prints
// `Debugger listening on ws://...` on stderr) with Node's own WebSocket, and
// evaluates expressions in it. The connection opens on the first evaluation.
// `Runtime.evaluate` with `includeCommandLineAPI` exposes `require`, which is
// what `electronApp.evaluate` of Playwright's Electron launcher does too.
function mainInspector(output: () => string) {
  let socket: Promise<WebSocket> | undefined;
  let lastId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  const connect = async () => {
    const url = await poll(() => /Debugger listening on (ws:\/\/\S+)/.exec(output())?.[1], Boolean, 15_000);
    if (!url) throw new Error(`the app did not open an inspector:\n${output()}`);
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to the inspector at ${url}`)), { once: true });
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: { result?: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
        error?: { message: string };
      };
      const waiting = message.id === undefined ? undefined : pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id!);
      const failure = message.result?.exceptionDetails;
      if (message.error) waiting.reject(new Error(message.error.message));
      else if (failure) waiting.reject(new Error(failure.exception?.description ?? failure.text));
      else waiting.resolve(message.result?.result?.value);
    });
    return ws;
  };

  return {
    async evaluate<T>(expression: string): Promise<T> {
      const ws = await (socket ??= connect());
      const id = ++lastId;
      const answer = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true },
        }),
      );
      return (await answer) as T;
    },
    // An inspector left connected can hold the process at exit.
    async close() {
      const ws = await socket?.catch(() => undefined);
      ws?.close();
    },
  };
}

// Spawns the Electron binary itself, with its output piped from the first line,
// and attaches over CDP. Chromium prints the port it picked on stderr
// (`--remote-debugging-port=0`).
async function launchSpawned(
  executablePath: string,
  args: string[],
  background: boolean,
  givenDataDir?: string,
  base?: NodeJS.ProcessEnv,
  givenCockpitHome?: string | null,
): Promise<Session> {
  const { dataDir, cockpitHome, env } = launchEnv(background, givenDataDir, base, givenCockpitHome);
  // Its own process group, so closing stops Electron and its helpers together.
  const child = spawn(executablePath, ['--remote-debugging-port=0', '--inspect=0', ...args], {
    cwd: appDir,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const removeDataDir = () => {
    if (givenDataDir === undefined) rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    const deadline = Date.now() + 30_000;
    let port: string | undefined;
    while (!(port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1])) {
      if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode}:\n${output}`);
      if (Date.now() > deadline) throw new Error(`the app did not open a debugging port:\n${output}`);
      await sleep(50);
    }
    const { browser, page } = await attach(`http://127.0.0.1:${port}`);
    const inspector = mainInspector(() => output);
    return {
      page,
      pid: child.pid!,
      dataDir,
      cockpitHome,
      output: () => output,
      evaluateInMain: inspector.evaluate,
      disconnectInspector: inspector.close,
      isRunning: () => child.exitCode === null,
      close: async () => {
        await inspector.close();
        await browser.close();
        await stopGroup(child);
        removeDataDir();
      },
    };
  } catch (error) {
    await stopGroup(child);
    removeDataDir();
    throw error;
  }
}

function launchBuilt(): Promise<Session> {
  // The `electron` package exports the path to its binary, downloading it if
  // missing. Resolved here, not at import, so the dev test runs first without it.
  const executablePath: string = createRequire(import.meta.url)('electron');
  return launchSpawned(executablePath, ['.'], true);
}

function packagedAppDir(): string {
  if (process.platform !== 'darwin') throw new Error(`No packaged app path for ${process.platform}`);
  const releaseDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  return join(appDir, 'release', releaseDir, 'Cockpit.app');
}

function launchPackaged({
  background = true,
  dataDir,
  env,
}: { background?: boolean; dataDir?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Session> {
  const executablePath = join(packagedAppDir(), 'Contents/MacOS/Cockpit');
  return launchSpawned(executablePath, [], background, dataDir, env);
}

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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
      .listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      })
      .on('error', reject);
  });
}

// Runs the `dev` script as a developer would, then attaches over the Chrome
// DevTools Protocol.
async function launchDev(base?: NodeJS.ProcessEnv): Promise<Session> {
  const port = await freePort();
  const inspectPort = await freePort();
  const { dataDir, cockpitHome, env } = launchEnv(true, undefined, base);
  // Its own process group, so closing stops the dev server and Electron with it.
  // electron-vite ignores `--inspect 0` (0 is falsy for it): a free port instead.
  const dev = spawn('bun', ['run', 'dev', '--remoteDebuggingPort', String(port), '--inspect', String(inspectPort)], {
    cwd: appDir,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  dev.stdout.on('data', (chunk) => (output += chunk));
  dev.stderr.on('data', (chunk) => (output += chunk));
  const stop = () => stopGroup(dev);
  const removeDataDir = () => rmSync(dataDir, { recursive: true, force: true });

  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    while (!(await fetch(`${endpoint}/json/version`).then((r) => r.ok, () => false))) {
      if (dev.exitCode !== null) throw new Error(`dev exited with code ${dev.exitCode}:\n${output}`);
      if (Date.now() > deadline) throw new Error(`dev did not open a window:\n${output}`);
      await sleep(250);
    }
    const { browser, page } = await attach(endpoint);
    // The dev script runs Electron in the process group of `dev`; the helpers
    // are named `Electron Helper ...`, so `-x` matches the main process only.
    const pid = Number(execFileSync('pgrep', ['-g', String(dev.pid), '-x', 'Electron'], { encoding: 'utf8' }).split('\n')[0]);
    const inspector = mainInspector(() => output);
    return {
      page,
      pid,
      dataDir,
      cockpitHome,
      output: () => output,
      evaluateInMain: inspector.evaluate,
      disconnectInspector: inspector.close,
      isRunning: () => dev.exitCode === null,
      close: async () => {
        await inspector.close();
        await browser.close();
        await stop();
        removeDataDir();
      },
    };
  } catch (error) {
    await stop();
    removeDataDir();
    throw error;
  }
}

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

// Reads until `done` accepts the value or `timeout` ms pass, and returns the last value.
async function poll<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeout: number): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(100);
  }
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
function spawnShell(page: Page): Promise<number> {
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
    return w.api.pty.spawn(options);
  }, shellOptions);
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

const UI_TIMEOUT = 10_000;

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

// Reloads the page on Home (the tabs outlive a visit, a reload starts over), then
// opens the terminal page through the sidebar: each call opens a new page lifetime
// (one tab, one shell), and focuses the terminal.
async function openTerminal(page: Page) {
  await goHome(page);
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

// `process.kill(pid, 0)` throws ESRCH once the process is gone.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
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

// The pid of the pty utility process, read from the parent of a probe shell (ended
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

// Kills the pty utility process, the way a crash does, and returns the id of the
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
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-project-test-')));
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
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-project-test-')));
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
      const triggers = [...here.querySelectorAll('button[aria-haspopup="menu"]')].filter((button) => {
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
  join(realpathSync(session.dataDir), 'cockpit-home', 'worktrees', `${repo.name}-${sha8(repo.root)}`, branch);

// A repository with `origin` (a clone of `upstream`, which has `develop`,
// `feature/x` and `release/1.0` besides `main`), a local commit on `main` that
// `origin/main` lacks, and the local branches `local-topic` and `topic/nested`.
interface TempClone extends TempRepo {
  upstream: TempRepo;
}
function makeClone(name: string): TempClone {
  const upstream = makeRepo(`${name}-upstream`);
  for (const branch of ['develop', 'feature/x', 'release/1.0']) gitIn(upstream.root, 'branch', branch);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-project-test-')));
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
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-project-test-')));
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
const baseSelect = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('combobox');
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
    } finally {
      await releasePtySpawn(session);
    }

    try {
      await waitForPrompt(page, tab);
      await expectSizeMatchesDisplay(page, tab);
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

  test.runIf(full)('survive AC6 — after Home and back, reloading the page ends every shell of every tab, and the page starts over with one tab', async () => {
    const { page } = session;
    const pids = await openTwoTabsOneSplit(page);

    await goHome(page);
    await goToTerminalPage(page);
    await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 2');
    for (const pid of pids) expect(isAlive(pid)).toBe(true);

    await page.reload();
    await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });

    for (const pid of pids) expect(await endsWithin(pid), `shell ${pid} ends within 5 s`).toBe(true);
    await expectTabs(page, ['Terminal 1'], 'Terminal 1');
    await focusTerminal(page);
    await waitForPrompt(page);
    await typeLine(page, 'echo cockpit-$((6*7))');
    await waitForRow(page, 'cockpit-42');
  });

  // The host is stopped, so a new tab's spawn stays pending in the main process; the page
  // reloads and the host resumes: the pty that spawn creates belongs to a page that is gone
  // and must not outlive it. Only the shell of the new page's Terminal 1 may be left.
  test.runIf(full)('survive AC7 — a spawn still pending when the page reloads leaves no shell behind once the host resumes', async () => {
    const { page } = session;
    await openTerminal(page);
    const hostPid = await ptyHostPid(page);
    await replacePtySpawn(
      session,
      `async (...args) => { globalThis.__spawnCalls = (globalThis.__spawnCalls ?? 0) + 1; return original(...args); }`,
    );
    process.kill(hostPid, 'SIGSTOP');
    try {
      const calls = () => session.evaluateInMain<number>('globalThis.__spawnCalls ?? 0');
      const before = await calls();
      await newTerminal(page);
      await expectTabs(page, ['Terminal 1', 'Terminal 2'], 'Terminal 2');
      // The main process has received the spawn of the new tab, which the stopped host cannot answer.
      expect(await poll(calls, (count) => count > before, UI_TIMEOUT)).toBeGreaterThan(before);

      await page.reload();
      await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
    } finally {
      process.kill(hostPid, 'SIGCONT');
      await restorePtySpawn(session);
    }

    await expectTabs(page, ['Terminal 1'], 'Terminal 1');
    await focusTerminal(page);
    const pid = await pidOf(page);
    expect(
      await poll(() => childPidsOf(hostPid), (children) => children.length === 1 && children[0] === pid, 5_000),
      'the only child of the pty host is the shell of the reloaded page',
    ).toEqual([pid]);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
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

  // One smoke path per feature in the modes that do not run its full block: it
  // goes through the IPC end to end, with the same helpers as the full blocks.
  // In the launchd-environment mode these are the paths that spawn git.
  describe.runIf(!full)('smoke paths', () => {
    const folders: TempRepo[] = [];

    afterAll(() => {
      for (const folder of folders) rmSync(folder.parent, { recursive: true, force: true });
    });

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

    test('smoke path (b) — workspaces: "New workspace…" creates a worktree under COCKPIT_HOME from the preselected base main and lists it; "Delete workspace…" removes the folder, the worktree, the branch and the row', async () => {
      const { page } = session;
      const repo = makeRepo('smoke-workspace');
      folders.push(repo);
      const branch = 'smoke-ws';
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

      await startDeletion(page, path);
      const confirm = deleteDialog(page, `Delete ${branch}?`);
      await confirm.waitFor({ timeout: UI_TIMEOUT });
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: UI_TIMEOUT });
      await confirm.waitFor({ state: 'hidden', timeout: 15_000 });
      await waitForEntries(page, [repo.root]);

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
    // an error page. The shell must end all the same.
    async function expectShellEndsOnNavigationTo(path: string) {
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
        expect(await endsWithin(pid), 'the shell ends within 5 s').toBe(true);
        expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
        expect(session.isRunning()).toBe(true);
      } finally {
        await page.goto(appUrl);
        await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
      }
      expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    }

    test.runIf(full)('tabs AC11 — a same-origin navigation to a missing file (a 404) ends the shell, with no main-process error', async () => {
      await expectShellEndsOnNavigationTo('/missing.js');
    });

    // The app's protocol handler throws on a malformed percent-encoding
    // (`decodeURIComponent`), so the load fails instead of answering a 404 with a
    // document: the navigation commits an error page, and `did-navigate` is not
    // what the main process hears (a 404 does commit a document, which is why the
    // test above passes without `did-fail-load`).
    test.runIf(full)('tabs AC11 — a same-origin navigation the app cannot serve (error page, no document) ends the shell, with no main-process error', async () => {
      await expectShellEndsOnNavigationTo('/%');
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
    dataDir = mkdtempSync(join(tmpdir(), 'cockpit-test-'));
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
describe('packaged app quit', () => {
  test('tabs AC10 — quitting the app with two shells open ends the app and both shells within 5 s', async () => {
    const session = await launchPackaged();
    const pids: number[] = [];
    try {
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      await openTerminal(page);
      pids.push(await pidOf(page));
      await openTab(page);
      pids.push(await pidOf(page));
      for (const pid of pids) expect(isAlive(pid)).toBe(true);

      // `app.quit()` is what Cmd+Q does. It runs a moment later, so the test can
      // disconnect its inspector first: a Node process waits for a connected
      // inspector to disconnect before it exits.
      const quitAt = Date.now();
      await session.evaluateInMain(`(() => {
        const { app } = require('electron');
        setTimeout(() => app.quit(), 300);
      })()`);
      await session.disconnectInspector();
      const remaining = () => Math.max(0, 5_000 - (Date.now() - quitAt));

      expect(await poll(() => session.isRunning(), (running) => !running, remaining()), 'the app exits within 5 s').toBe(false);
      for (const pid of pids) {
        expect(await poll(() => isAlive(pid), (alive) => !alive, remaining()), `shell ${pid} is gone within 5 s`).toBe(false);
      }
    } finally {
      // A shell that survived must not outlive the test.
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      await Promise.race([session.close().catch(() => {}), sleep(15_000)]);
      rmSync(session.dataDir, { recursive: true, force: true });
    }
  });
});

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
    folder = mkdtempSync(join(tmpdir(), 'cockpit-fake-shell-'));
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
// directory, arguments, pid, `$TERM`), then echoes every line it reads and
// exits with code 3 on `exit`. `pwd -P` because macOS temporary folders sit
// behind a symlink (`/var` is `/private/var`).
const STUB_HARNESS = `#!/bin/sh
if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi
echo "cwd:$(pwd -P)"
echo "args:$#:$*"
echo "pid:$$"
echo "term:$TERM"
echo "ready"
while IFS= read -r line; do
  if [ "$line" = exit ]; then exit 3; fi
  echo "got:$line"
done
`;

interface SessionsFixture {
  /** The temporary folder that holds everything below, removed by the test. */
  root: string;
  /** The fake login shell. */
  shell: string;
  /** The environment to launch the app with. */
  env(): NodeJS.ProcessEnv;
  /** The file the stubs append a line to on every run, when the fixture was made with `log`. */
  runLog: string;
}

// Stubs named after the given catalogue binaries in a folder of their own, and
// a login shell, like `makeShellWithoutGit`, whose printed environment has
// `PATH=<that folder>:/usr/bin:/bin`: a real CLI installed on the developer's
// machine never shows up.
//
// With `log`, every stub first appends `<binary> <arguments>` to `runLog`, which
// is empty once the fixture is ready (its own warm-up runs are not counted).
function makeSessionsFixture(binaries: string[], { log = false }: { log?: boolean } = {}): SessionsFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-sessions-test-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const runLog = join(root, 'runs.log');
  const script = log ? STUB_HARNESS.replace('#!/bin/sh\n', `#!/bin/sh\necho "$(basename "$0") $*" >> '${runLog}'\n`) : STUB_HARNESS;
  for (const name of binaries) {
    const stub = join(bin, name);
    writeFileSync(stub, script);
    chmodSync(stub, 0o755);
    // macOS scans a new executable the first time it runs.
    expect(execFileSync(stub, ['--version'], { encoding: 'utf8' }).trim()).toBe('9.9.9');
  }
  const shell = join(root, 'login-shell');
  writeFileSync(shell, `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\nPATH='${bin}:/usr/bin:/bin' /bin/sh -c "$2"\n`);
  chmodSync(shell, 0o755);
  execFileSync(shell, ['--warmup']);
  const printed = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  expect(printed).toBe(`${bin}:/usr/bin:/bin`);
  if (log) writeFileSync(runLog, '');

  return { root, shell, env: () => ({ ...process.env, SHELL: shell }), runLog };
}

const launchBuiltWith = (env: NodeJS.ProcessEnv, dataDir?: string, cockpitHome?: string | null) =>
  launchSpawned(createRequire(import.meta.url)('electron') as string, ['.'], true, dataDir, env, cockpitHome);

const launchPackagedWith = (env: NodeJS.ProcessEnv, dataDir?: string) => launchPackaged({ env, dataDir });

const launchDevWith = (env: NodeJS.ProcessEnv) => launchDev(env);

interface StoredSession {
  id: string;
  name: string;
  harness: string;
  directory: string;
  createdAt: string;
}

const sessionsInState = (dataDir: string): StoredSession[] =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { sessions?: StoredSession[] }).sessions ?? [];

// The id in the page URL (`/sessions/<id>`), if the page is a session page.
const sessionIdOf = (page: Page) => /^\/sessions\/([^/]+)$/.exec(new URL(page.url()).pathname)?.[1];

interface SessionEntry {
  id: string;
  name: string;
  ended: boolean;
}

// The links of the Sessions section: the name is the first text of the entry,
// "Ended" is a text of its own.
const sessionEntries = (page: Page): Promise<SessionEntry[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('aside a[href*="/sessions/"]')].map((link) => {
      const entry = link.closest('li') ?? link;
      const texts: string[] = [];
      const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node.textContent ?? '').trim();
        if (text) texts.push(text);
      }
      return {
        id: link.getAttribute('href')!.split('/').pop()!,
        name: texts[0] ?? '',
        ended: texts.includes('Ended'),
      };
    }),
  );

const waitForSessionEntries = (page: Page, expected: Array<[name: string, ended: boolean]>) =>
  poll(
    async () => (await sessionEntries(page)).map((entry) => [entry.name, entry.ended]),
    (entries) => JSON.stringify(entries) === JSON.stringify(expected),
    UI_TIMEOUT,
  );

const START_MENU = 'Start session';

async function openStartMenu(page: Page) {
  await page.getByRole('button', { name: START_MENU, exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('menuitem').first().waitFor({ timeout: UI_TIMEOUT });
}

// Picks a harness in the "Start session" menu and waits for its session page.
async function startSession(page: Page, harnessName: string, pageName: string): Promise<string> {
  await openStartMenu(page);
  await page.getByRole('menuitem', { name: harnessName, exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('heading', { name: pageName, exact: true }).waitFor({ timeout: UI_TIMEOUT });
  const id = await poll(() => sessionIdOf(page), Boolean, UI_TIMEOUT);
  expect(id, `the URL ${page.url()} is /sessions/<id>`).toBeTruthy();
  return id!;
}

async function openSessionEntry(page: Page, name: string) {
  const entry = page.locator('aside a[href*="/sessions/"]', { hasText: new RegExp(`^\\s*${escapeRegExp(name)}(\\s|$)`) });
  await entry.first().click({ timeout: UI_TIMEOUT });
  await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: UI_TIMEOUT });
}

interface StubFacts {
  cwd: string;
  argCount: number;
  args: string;
  pid: number;
  term: string;
}

// What the stub printed, read from the terminal once it printed its last line.
// A long line wraps onto the next row, so the rows are joined before parsing.
async function readStub(page: Page): Promise<StubFacts> {
  await waitForRow(page, 'ready');
  const text = (await terminalRows(page)).join('');
  const found = /cwd:(.+?)args:(\d+):(.*?)pid:(\d+)term:(.+?)ready/.exec(text);
  if (!found) throw new Error(`The terminal does not show the stub's output:\n${text}`);
  return { cwd: found[1]!, argCount: Number(found[2]), args: found[3]!, pid: Number(found[4]), term: found[5]! };
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

  beforeAll(async () => {
    fx = makeSessionsFixture(['claude', 'codex']);
    session = await launchBuiltWith(fx.env());
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  test('AC1 — the "Start session" menu lists Claude Code then Codex, and nothing else', async () => {
    const { page } = session;
    expect(await sidebarLines(page)).toContain('Sessions');

    await openStartMenu(page);

    const items = (await page.getByRole('menuitem').allInnerTexts()).map((text) => text.trim());
    expect(items).toEqual(['Claude Code', 'Codex']);
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

  test('AC7 — typing exit shows the exit code in the terminal and "Ended" on the entry', async () => {
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
    await poll(() => isAlive(known.codex1.pid), (alive) => !alive, UI_TIMEOUT);
    expect(isAlive(known.codex1.pid)).toBe(false);
    expect(isAlive(known.claude2.pid)).toBe(true);
  });

  test('AC8 — reloading the page ends the processes, marks every entry "Ended" and shows the ended page', async () => {
    const { page } = session;
    await openSessionEntry(page, 'Claude Code 2');
    const directory = sessionsInState(session.dataDir).find((stored) => stored.id === known.claude2.id)!.directory;
    expect(isAlive(known.claude2.pid)).toBe(true);

    await page.reload();

    await page.getByText('This session has ended.').waitFor({ timeout: UI_TIMEOUT });
    await page.getByText(directory).first().waitFor({ timeout: UI_TIMEOUT });
    expect(sessionIdOf(page)).toBe(known.claude2.id);
    expect(await poll(() => [isAlive(known.claude1.pid), isAlive(known.claude2.pid)], (alive) => !alive.includes(true), 10_000)).toEqual([
      false,
      false,
    ]);
    expect(await waitForSessionEntries(page, [['Codex 1', true], ['Claude Code 2', true], ['Claude Code 1', true]])).toEqual([
      ['Codex 1', true],
      ['Claude Code 2', true],
      ['Claude Code 1', true],
    ]);
  });

  // COCKPIT-46: the host is stopped, so the spawn of the session stays pending in the main
  // process while the page reloads. Once the host resumes, the pty that spawn creates
  // belongs to a page that is gone: no process may be left, and the start leaves no trace.
  test('survive AC8 — a start whose spawn is pending when the page reloads leaves no process under the host, no folder and no stored session once the host resumes', async () => {
    const { page } = session;
    const hostPid = await ptyHostPid(page);
    expect(await poll(() => childPidsOf(hostPid), (children) => children.length === 0, 5_000)).toEqual([]);
    const foldersBefore = sessionFoldersIn(session.cockpitHome);
    const storedBefore = sessionsInState(session.dataDir);

    process.kill(hostPid, 'SIGSTOP');
    try {
      await openStartMenu(page);
      await page.getByRole('menuitem', { name: 'Claude Code', exact: true }).click({ timeout: UI_TIMEOUT });
      // The main process created the session folder and waits for the stopped host to spawn.
      expect(
        await poll(() => sessionFoldersIn(session.cockpitHome).length, (count) => count > foldersBefore.length, UI_TIMEOUT),
      ).toBeGreaterThan(foldersBefore.length);

      await page.reload();
      await page.getByText(versionLabel).waitFor({ timeout: UI_TIMEOUT });
    } finally {
      process.kill(hostPid, 'SIGCONT');
    }

    // The host answers in order: once it ran a probe shell it has handled the stale spawn too.
    expect(await ptyHostPid(page)).toBe(hostPid);
    expect(await poll(() => childPidsOf(hostPid), (children) => children.length === 0, 5_000), 'no stub runs under the host').toEqual([]);
    expect(await poll(() => sessionFoldersIn(session.cockpitHome), (found) => found.length === foldersBefore.length, 5_000)).toEqual(foldersBefore);
    expect(sessionsInState(session.dataDir)).toEqual(storedBefore);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });

  // The pty host dies here and the next spawn starts it again, so AC15 and the
  // tests that follow work all the same.
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

  test('AC15 — a running session shows as ended when the pty host dies: [Process ended] in its terminal, "Ended" on its entry', async () => {
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

  test('logs no error and keeps running', async () => {
    expect(await sidebarLines(session.page)).toContain('Sessions');
    await expectNoErrors(session);
  });
});

// One smoke path through the sessions IPC in the dev server: the page, the
// main process, the pty host and the disk. It needs a launch of its own with
// the fake login shell that holds the stubs. The packaged app's smoke path is
// folded into the first launch of the AC9 restart test below. The
// launchd-environment mode has none: its point is the user's real login shell,
// where a session would run a real CLI.
describe('sessions smoke path: dev server', () => {
  let fx: SessionsFixture;
  let session: Session;

  beforeAll(async () => {
    fx = makeSessionsFixture(['claude']);
    session = await launchDevWith(fx.env());
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

  test('logs no error and keeps running', async () => {
    await expectNoErrors(session);
  });
});

// Harness detection runs `--version` on each harness: it must not happen at
// startup (a test launch must never run a real CLI), only when the menu first
// needs the list, and only once per launch.
describe('built app harness detection timing', () => {
  let fx: SessionsFixture;
  let session: Session;

  beforeAll(async () => {
    fx = makeSessionsFixture(['claude', 'codex'], { log: true });
    session = await launchBuiltWith(fx.env());
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  const runs = () =>
    readFileSync(fx.runLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .sort();

  test('AC14 — no stub runs at startup, each runs --version once on the first menu open, none on the next', async () => {
    const { page } = session;
    await page.getByRole('heading', { name: 'Home' }).waitFor({ timeout: UI_TIMEOUT });
    await sleep(2000);
    expect(runs()).toEqual([]);

    await openStartMenu(page);
    expect((await page.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())).toEqual(['Claude Code', 'Codex']);
    expect(runs()).toEqual(['claude --version', 'codex --version']);

    await page.keyboard.press('Escape');
    await page.getByRole('menuitem').first().waitFor({ state: 'detached', timeout: UI_TIMEOUT });
    await openStartMenu(page);
    await sleep(500);
    expect(runs()).toEqual(['claude --version', 'codex --version']);

    await page.keyboard.press('Escape');
    await expectNoErrors(session);
  });
});

describe('built app without any agent CLI on the login shell PATH', () => {
  let fx: SessionsFixture;
  let session: Session;

  beforeAll(async () => {
    fx = makeSessionsFixture([]);
    session = await launchBuiltWith(fx.env());
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
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

describe('built app sessions folder when COCKPIT_HOME is unset or empty', () => {
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
  ])('AC11 — with COCKPIT_HOME %s and HOME=<tmp>, the session folder is <tmp>/.cockpit/sessions/<id>', async (label, value) => {
    const userHome = join(fx.root, `user-home-${label}`);
    mkdirSync(userHome);
    const session = await launchBuiltWith({ ...fx.env(), HOME: userHome }, undefined, value ?? null);
    try {
      await session.page.getByText(versionLabel).waitFor();
      const id = await startSession(session.page, 'Claude Code', 'Claude Code 1');
      const directory = join(userHome, '.cockpit', 'sessions', id);

      expect((await readStub(session.page)).cwd).toBe(directory);
      expect(statSync(directory).isDirectory()).toBe(true);
      const stored = await poll(() => sessionsInState(session.dataDir), (list) => list.length > 0, UI_TIMEOUT);
      expect(stored.map((s) => s.directory)).toEqual([directory]);
      // Nothing went to the developer's own Cockpit home.
      expect(existsSync(join(homedir(), '.cockpit', 'sessions', id))).toBe(false);
      await expectNoErrors(session);
    } finally {
      await session.close();
    }
  });
});

// Sessions across a restart of the packaged app, on a data folder the test
// creates and removes; the launch's Cockpit home is inside it.
describe('packaged app sessions after a restart', () => {
  let fx: SessionsFixture;
  let dataDir: string;

  beforeEach(() => {
    fx = makeSessionsFixture(['claude', 'codex']);
    dataDir = mkdtempSync(join(tmpdir(), 'cockpit-test-'));
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC9 — sessions of a previous launch are listed as "Ended", newest first, open as ended and leave state.json and their folders alone', async () => {
    const first = await launchPackagedWith(fx.env(), dataDir);
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

      await startSession(first.page, 'Codex', 'Codex 1');
      await poll(() => sessionsInState(dataDir), (list) => list.length === 2, UI_TIMEOUT);
      await expectNoErrors(first);
    } finally {
      await first.close();
    }

    const stored = sessionsInState(dataDir);
    expect(stored.map((s) => s.name)).toEqual(['Claude Code 1', 'Codex 1']);
    const before = stateSnapshot(dataDir);

    const second = await launchPackagedWith(fx.env(), dataDir);
    try {
      await second.page.getByText(versionLabel).waitFor();
      expect(await waitForSessionEntries(second.page, [['Codex 1', true], ['Claude Code 1', true]])).toEqual([
        ['Codex 1', true],
        ['Claude Code 1', true],
      ]);

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
