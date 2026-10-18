import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// Launches the app the three ways it runs: the dev server, the built app and
// the packaged app, and checks each one starts, renders and logs no error.

const appDir = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version: string };
// Shown in the sidebar from `window.api.getVersion()`, so it proves the
// renderer reaches the main process.
const versionLabel = `Cockpit ${version}`;

// Signs of an uncaught error in the main process.
const MAIN_PROCESS_ERROR = /\bUncaught\b|\bUnhandled\b|App threw an error/;

interface Session {
  page: Page;
  /** Everything the app wrote to stdout and stderr. */
  output(): string;
  isRunning(): boolean;
  close(): Promise<void>;
}

async function fromElectronApp(app: ElectronApplication): Promise<Session> {
  let output = '';
  app.process().stdout?.on('data', (chunk) => (output += chunk));
  app.process().stderr?.on('data', (chunk) => (output += chunk));
  const page = await app.firstWindow();
  return {
    page,
    output: () => output,
    isRunning: () => app.process().exitCode === null,
    close: () => app.close(),
  };
}

function launchBuilt(): Promise<Session> {
  // The `electron` package exports the path to its binary, downloading it if
  // missing. Resolved here, not at import, so the dev test runs first without it.
  const executablePath: string = createRequire(import.meta.url)('electron');
  return _electron.launch({ executablePath, args: ['.'], cwd: appDir }).then(fromElectronApp);
}

function launchPackaged(): Promise<Session> {
  if (process.platform !== 'darwin') throw new Error(`No packaged app path for ${process.platform}`);
  const releaseDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  const executablePath = join(appDir, 'release', releaseDir, 'Cockpit.app/Contents/MacOS/Cockpit');
  return _electron.launch({ executablePath }).then(fromElectronApp);
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
  // Its own process group, so closing stops the dev server and Electron with it.
  const dev = spawn('bun', ['run', 'dev', '--remoteDebuggingPort', String(port)], {
    cwd: appDir,
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
    return {
      page,
      output: () => output,
      isRunning: () => dev.exitCode === null,
      close: async () => {
        await browser.close();
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

describe.each([
  ['dev server', launchDev],
  ['built app', launchBuilt],
  ['packaged app', launchPackaged],
])('%s', (_name, launch) => {
  let session: Session;

  beforeAll(async () => {
    session = await launch();
  });

  afterAll(async () => {
    await session?.close();
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

  test('logs no error and keeps running', async () => {
    const { page } = session;
    const consoleErrors = (await page.consoleMessages()).filter((m) => m.type() === 'error').map((m) => m.text());
    expect(consoleErrors).toEqual([]);
    expect(await page.pageErrors()).toEqual([]);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(session.isRunning()).toBe(true);
  });
});
