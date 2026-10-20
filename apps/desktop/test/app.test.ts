import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// Launches the app the three ways it runs: the dev server, the built app and
// the packaged app, and checks each one starts, renders, logs no error, stays
// in the background and writes its data in its own folder. In CI only, it also
// launches the packaged app without the background switch.

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

interface ElectronSession extends Session {
  app: ElectronApplication;
}

// Every launch gets a fresh data folder, so no launch touches the data of
// another one or of the Cockpit the developer has open. The background switch
// keeps the app out of the Dock and out of the way: it never shows a window nor
// takes the focus. Playwright's `env` replaces the environment, hence the spread.
function launchEnv(background: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cockpit-test-'));
  const env = { ...process.env, COCKPIT_USER_DATA_DIR: dataDir } as Record<string, string>;
  if (background) env.COCKPIT_TEST_BACKGROUND = '1';
  else delete env.COCKPIT_TEST_BACKGROUND;
  return { dataDir, env };
}

async function fromElectronApp(app: ElectronApplication, dataDir: string): Promise<ElectronSession> {
  let output = '';
  app.process().stdout?.on('data', (chunk) => (output += chunk));
  app.process().stderr?.on('data', (chunk) => (output += chunk));
  const page = await app.firstWindow();
  return {
    app,
    page,
    pid: app.process().pid!,
    dataDir,
    output: () => output,
    isRunning: () => app.process().exitCode === null,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function launchElectron(
  options: Parameters<typeof _electron.launch>[0],
  background: boolean,
): Promise<ElectronSession> {
  const { dataDir, env } = launchEnv(background);
  try {
    return await fromElectronApp(await _electron.launch({ ...options, env }), dataDir);
  } catch (error) {
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

function launchBuilt(): Promise<Session> {
  // The `electron` package exports the path to its binary, downloading it if
  // missing. Resolved here, not at import, so the dev test runs first without it.
  const executablePath: string = createRequire(import.meta.url)('electron');
  return launchElectron({ executablePath, args: ['.'], cwd: appDir }, true);
}

function packagedAppDir(): string {
  if (process.platform !== 'darwin') throw new Error(`No packaged app path for ${process.platform}`);
  const releaseDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  return join(appDir, 'release', releaseDir, 'Cockpit.app');
}

function launchPackaged({ background = true } = {}): Promise<ElectronSession> {
  const executablePath = join(packagedAppDir(), 'Contents/MacOS/Cockpit');
  return launchElectron({ executablePath }, background);
}

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
  const stop = async () => {
    if (dev.exitCode !== null) return;
    process.kill(-dev.pid!, 'SIGTERM');
    await new Promise((resolve) => dev.once('exit', resolve));
  };
  const removeDataDir = () => rmSync(dataDir, { recursive: true, force: true });

  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    while (!(await fetch(`${endpoint}/json/version`).then((r) => r.ok, () => false))) {
      if (dev.exitCode !== null) throw new Error(`dev exited with code ${dev.exitCode}:\n${output}`);
      if (Date.now() > deadline) throw new Error(`dev did not open a window:\n${output}`);
      await sleep(250);
    }
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0]!;
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    // Reload so the page's console output is captured from the start.
    await page.reload();
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

describe.each([
  ['dev server', launchDev],
  ['built app', launchBuilt],
  ['packaged app', launchPackaged],
])('%s', (mode, launch) => {
  let session: Session;
  let front: ReturnType<typeof watchFrontmost>;

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

  test('logs no error and keeps running', async () => {
    const { page } = session;
    expect(await consoleErrorsOf(page)).toEqual([]);
    expect(await page.pageErrors()).toEqual([]);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(session.isRunning()).toBe(true);
    // Still never the frontmost app, after every check above.
    expect(front.pids.has(session.pid)).toBe(false);
  });

  // Kills the pty host, so it stays the last test that needs a working one.
  test('AC4 — survives the pty host being killed, and reports the open session as exited', async () => {
    const { page } = session;
    const id = await spawnShell(page);
    await ptyWrite(page, id, 'echo ppid-$PPID\n');
    await waitForOutput(page, id, /ppid-\d+/);
    const hostPid = Number(/ppid-(\d+)/.exec(await outputOf(page, id))![1]);

    // The host is a process of its own, not the main process.
    expect(hostPid).not.toBe(session.pid);

    process.kill(hostPid, 'SIGKILL');

    await waitForExit(page, id);
    expect(await exitsOf(page, id)).toEqual([{ exitCode: null, signal: null }]);
    await page.getByText(versionLabel).waitFor();
    await page.getByRole('heading', { name: 'Home' }).waitFor();
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

// The real launch, as a user starts the app. It opens a visible window, so it
// runs in CI only, never on a developer's machine.
describe.runIf(process.env.CI)('packaged app without the background switch', () => {
  let session: ElectronSession;

  beforeAll(async () => {
    session = await launchPackaged({ background: false });
  });

  afterAll(async () => {
    await session?.close();
    if (session) expect(existsSync(session.dataDir)).toBe(false);
  });

  test('opens a visible window as a regular app', async () => {
    const visible = await poll(
      () => session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false),
      Boolean,
      5_000,
    );
    expect(visible).toBe(true);
    expect(await applicationType(session.pid)).toContain('"Foreground"');
  });
});
