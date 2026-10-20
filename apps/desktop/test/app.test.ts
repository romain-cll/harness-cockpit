import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';
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
  /** Everything the app wrote to stdout and stderr. */
  output(): string;
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
// The terminal page runs whatever `$SHELL` says: by default `/bin/sh`, which keeps
// the developer's shell configuration from slowing or breaking the tests.
function launchEnv(
  background: boolean,
  dataDir = mkdtempSync(join(tmpdir(), 'cockpit-test-')),
  base: NodeJS.ProcessEnv = { ...process.env, SHELL: '/bin/sh' },
) {
  const env = { ...base, COCKPIT_USER_DATA_DIR: dataDir } as Record<string, string>;
  if (background) env.COCKPIT_TEST_BACKGROUND = '1';
  else delete env.COCKPIT_TEST_BACKGROUND;
  return { dataDir, env };
}

// Attaches to a running Electron over the Chrome DevTools Protocol and returns
// its first window. Reloads it so the page's console output is captured from the
// start.
async function attach(endpoint: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.reload();
  return { browser, page };
}

// Stops a process started with `detached: true` and everything in its process
// group, and waits for it to exit.
async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  process.kill(-child.pid!, 'SIGTERM');
  const killer = setTimeout(() => process.kill(-child.pid!, 'SIGKILL'), 10_000);
  await exited;
  clearTimeout(killer);
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
): Promise<Session> {
  const { dataDir, env } = launchEnv(background, givenDataDir, base);
  // Its own process group, so closing stops Electron and its helpers together.
  const child = spawn(executablePath, ['--remote-debugging-port=0', ...args], {
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
    return {
      page,
      pid: child.pid!,
      dataDir,
      output: () => output,
      isRunning: () => child.exitCode === null,
      close: async () => {
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
async function launchDev(): Promise<Session> {
  const port = await freePort();
  const { dataDir, env } = launchEnv(true);
  // Its own process group, so closing stops the dev server and Electron with it.
  const dev = spawn('bun', ['run', 'dev', '--remoteDebuggingPort', String(port)], {
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
    return {
      page,
      pid,
      dataDir,
      output: () => output,
      isRunning: () => dev.exitCode === null,
      close: async () => {
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

// --- Terminal page helpers ---------------------------------------------------

const UI_TIMEOUT = 10_000;

// Goes Home, then to the terminal page through the sidebar, so each call opens
// a new shell, and focuses the terminal.
async function openTerminal(page: Page) {
  await page.getByRole('link', { name: 'Home', exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('heading', { name: 'Home' }).waitFor({ timeout: UI_TIMEOUT });
  await page.getByRole('link', { name: 'Terminal', exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
  await focusTerminal(page);
}

async function focusTerminal(page: Page) {
  const terminal = page.locator('.xterm');
  await terminal.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  await terminal.click({ timeout: UI_TIMEOUT });
  await page.locator('.xterm-helper-textarea').focus({ timeout: UI_TIMEOUT });
}

// Types on the keyboard, as a user does.
async function typeLine(page: Page, text: string) {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

// The text of each row xterm.js renders (its DOM renderer), cell padding removed.
const terminalRows = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/ /g, ' ').trimEnd()),
  );

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Waits until a row is exactly `text`, or matches it when it is a regular
// expression. Output reaches the DOM on animation frames, so it is polled.
const waitForRow = (page: Page, text: string | RegExp) =>
  page.waitForFunction(
    (source) => {
      const pattern = new RegExp(source);
      return [...document.querySelectorAll('.xterm-rows > div')].some((row) =>
        pattern.test((row.textContent ?? '').replace(/ /g, ' ').trimEnd()),
      );
    },
    typeof text === 'string' ? `^${escapeRegExp(text)}$` : text.source,
    { timeout: 15_000 },
  );

// Waits for a row matching `pattern` and returns its capture groups.
async function captureRow(page: Page, pattern: RegExp): Promise<string[]> {
  await waitForRow(page, pattern);
  for (const row of await terminalRows(page)) {
    const match = pattern.exec(row);
    if (match) return match.slice(1);
  }
  throw new Error(`No terminal row matches ${pattern}`);
}

// Types `stty size` and returns the `[rows, cols]` of its answer.
async function terminalSize(page: Page): Promise<[number, number]> {
  const answers = () => page.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows > div')].filter((row) => /^\d+\s\d+\s*$/.test(row.textContent ?? '')).length,
  );
  const before = await answers();
  await typeLine(page, 'stty size');
  await page.waitForFunction(
    (before) =>
      [...document.querySelectorAll('.xterm-rows > div')].filter((row) => /^\d+\s\d+\s*$/.test(row.textContent ?? '')).length > before,
    before,
    { timeout: 15_000 },
  );
  const rows = await terminalRows(page);
  const last = rows.filter((row) => /^\d+ \d+$/.test(row)).at(-1)!;
  const [r, c] = last.split(' ').map(Number);
  return [r!, c!];
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

  test('AC2 — resizes the pty', async () => {
    const { page } = session;
    const id = await spawnShell(page);

    await ptyResize(page, id, 100, 30);
    await ptyWrite(page, id, 'stty size\n');
    await waitForOutput(page, id, '30 100');

    await ptyKill(page, id);
  });

  test('AC3 — kill ends the session with a single exit, and later calls on it do nothing', async () => {
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

  test.runIf(inIsolatedShell)('terminal AC1 — the Terminal link opens a page with a heading and an xterm.js terminal under the header', async () => {
    const { page } = session;
    await page.getByRole('link', { name: 'Home', exact: true }).click({ timeout: UI_TIMEOUT });
    await page.getByRole('heading', { name: 'Home' }).waitFor({ timeout: UI_TIMEOUT });
    await page.getByRole('link', { name: 'Terminal', exact: true }).click({ timeout: UI_TIMEOUT });

    await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
    expect(await page.getByRole('link', { name: 'Terminal', exact: true }).getAttribute('aria-current')).toBe('page');
    await page.locator('.xterm').waitFor({ state: 'visible', timeout: UI_TIMEOUT });

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

  test.runIf(inIsolatedShell)('terminal AC3 — resizing the viewport resizes the pty to the terminal columns and rows', async () => {
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

  test.runIf(inIsolatedShell)('terminal AC4 — exit shows the exit code, and later keys do nothing', async () => {
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

  test.runIf(inIsolatedShell)('terminal AC5 — copy puts the selected word in the clipboard data as text/plain', async () => {
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

  test.runIf(inIsolatedShell)('terminal AC6 — pasting text then pressing Enter runs it', async () => {
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

  test.runIf(inIsolatedShell)('terminal AC7 — text, background and ANSI red follow the tokens as the color scheme changes', async () => {
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

  test.runIf(inIsolatedShell)('terminal AC8 — leaving the terminal page ends its shell', async () => {
    const { page } = session;
    await openTerminal(page);
    await typeLine(page, 'echo pid-$$');
    const [pid] = (await captureRow(page, /^pid-(\d+)$/)).map(Number);
    expect(isAlive(pid!)).toBe(true);

    await page.getByRole('link', { name: 'Home', exact: true }).click({ timeout: UI_TIMEOUT });
    await page.getByRole('heading', { name: 'Home' }).waitFor({ timeout: UI_TIMEOUT });

    expect(await poll(() => isAlive(pid!), (alive) => !alive, 5_000)).toBe(false);
  });

  test.runIf(inIsolatedShell)('terminal AC9 — reloading the page ends its shell and opens a new one', async () => {
    const { page } = session;
    await openTerminal(page);
    await typeLine(page, 'echo pid-$$');
    const [pid] = (await captureRow(page, /^pid-(\d+)$/)).map(Number);
    expect(isAlive(pid!)).toBe(true);

    await page.reload();
    await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
    expect(await poll(() => isAlive(pid!), (alive) => !alive, 5_000)).toBe(false);

    await focusTerminal(page);
    await typeLine(page, 'echo cockpit-$((6*7))');
    await waitForRow(page, 'cockpit-42');
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

  test('logs no error and keeps running', async () => {
    const { page } = session;
    expect(await consoleErrorsOf(page)).toEqual([]);
    expect(await page.pageErrors()).toEqual([]);
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
    const CHROMIUM_LOCAL_RESOURCE = /Not allowed to load local resource/;

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

    async function attemptNavigation(target: string) {
      const { page } = session;
      await openTerminal(page);
      const appUrl = page.url();
      await typeLine(page, 'echo pid-$$');
      const [pid] = (await captureRow(page, /^pid-(\d+)$/)).map(Number);
      expect(isAlive(pid!)).toBe(true);

      try {
        await page.evaluate((url) => {
          location.href = url;
        }, target);
        await sleep(2_000);

        expect(page.url()).toBe(appUrl);
        expect(await page.getByRole('heading', { name: 'Terminal' }).isVisible()).toBe(true);
        expect(isAlive(pid!)).toBe(true);

        await focusTerminal(page);
        await typeLine(page, 'echo cockpit-$((6*7))');
        await waitForRow(page, 'cockpit-42');
      } finally {
        // Load the app page again, whether or not the page left it: a blocked
        // navigation leaves Playwright waiting for a navigation that never
        // commits, which would stall the next click.
        await page.goto(appUrl);
        await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
      }
    }

    test('navigation AC1 — about:blank leaves the page, its shell and its terminal as they were', async () => {
      await attemptNavigation('about:blank');
    });

    test('navigation AC2 — app://other/ leaves the page, its shell and its terminal as they were', async () => {
      await attemptNavigation('app://other/');
    });

    test('navigation AC3 — https://example.com/ leaves the page, its shell and its terminal as they were', async () => {
      await attemptNavigation('https://example.com/');
    });

    test('navigation AC4 — the file:// URL of an existing file leaves the page, its shell and its terminal as they were', async () => {
      await attemptNavigation(existingFileUrl);
    });

    test('navigation AC5 — those attempts log no console error but Chromium refusing the file:// URL, no page error and no main-process error', async () => {
      const { page } = session;
      const errors = await consoleErrorsOf(page);
      expect(errors.filter((text) => !CHROMIUM_LOCAL_RESOURCE.test(text))).toEqual([]);
      expect(await page.pageErrors()).toEqual([]);
      expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
      expect(session.isRunning()).toBe(true);
    });
  });

  // Kills the pty host, so it stays the last test that needs a working one.
  test('AC4 — survives the pty host being killed, and reports the open session as exited (terminal AC10: the terminal shows [Process ended])', async () => {
    const { page } = session;
    // The terminal page is open, with a running shell (not in the launchd mode,
    // which keeps the developer's shell out of the tests).
    if (inIsolatedShell) {
      await openTerminal(page);
      await typeLine(page, 'echo up-$((1+1))');
      await waitForRow(page, 'up-2');
    }

    const id = await spawnShell(page);
    await ptyWrite(page, id, 'echo ppid-$PPID\n');
    await waitForOutput(page, id, /ppid-\d+/);
    const hostPid = Number(/ppid-(\d+)/.exec(await outputOf(page, id))![1]);

    // The host is a process of its own, not the main process.
    expect(hostPid).not.toBe(session.pid);

    process.kill(hostPid, 'SIGKILL');

    await waitForExit(page, id);
    expect(await exitsOf(page, id)).toEqual([{ exitCode: null, signal: null }]);
    if (inIsolatedShell) {
      await waitForRow(page, '[Process ended]');
      await page.getByRole('heading', { name: 'Terminal' }).waitFor();
    }
    await page.getByText(versionLabel).waitFor();
    expect(session.isRunning()).toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(await page.pageErrors()).toEqual([]);
    expect(await consoleErrorsOf(page)).toEqual([]);
  });

  test('AC5 — spawn rejects once the pty host is dead, and the host is not restarted', async () => {
    const { page } = session;
    const attempt = () =>
      page.evaluate(async (options) => {
        try {
          await (window as unknown as PtyWindow).api.pty.spawn(options);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }, shellOptions);

    expect(await attempt()).toContain('pty host is not running');
    // Still rejected after a while: nothing restarted the host.
    await sleep(2_000);
    expect(await attempt()).toContain('pty host is not running');
    expect(session.isRunning()).toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(await consoleErrorsOf(page)).toEqual([]);
  });
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
