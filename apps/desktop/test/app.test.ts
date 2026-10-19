import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
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

function launchPackaged({ background = true } = {}): Promise<ElectronSession> {
  if (process.platform !== 'darwin') throw new Error(`No packaged app path for ${process.platform}`);
  const releaseDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  const executablePath = join(appDir, 'release', releaseDir, 'Cockpit.app/Contents/MacOS/Cockpit');
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

describe.each([
  ['dev server', launchDev],
  ['built app', launchBuilt],
  ['packaged app', launchPackaged],
])('%s', (_name, launch) => {
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

  test('logs no error and keeps running', async () => {
    const { page } = session;
    const consoleErrors = (await page.consoleMessages()).filter((m) => m.type() === 'error').map((m) => m.text());
    expect(consoleErrors).toEqual([]);
    expect(await page.pageErrors()).toEqual([]);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(session.isRunning()).toBe(true);
    // Still never the frontmost app, after every check above.
    expect(front.pids.has(session.pid)).toBe(false);
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
