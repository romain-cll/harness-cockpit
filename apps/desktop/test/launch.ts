import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright-core';

// Launching the app the ways it runs (the dev server, the built app, the packaged app) and
// stopping it, shared by the test files of this folder. See `app.test.ts` for what each launch is for.

export const UI_TIMEOUT = 10_000;

export const appDir = join(import.meta.dirname, '..');
export const { version } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version: string };
// Shown in the sidebar from `window.api.getVersion()`, so it proves the
// renderer reaches the main process.
export const versionLabel = `Cockpit ${version}`;

// Signs of an uncaught error in the main process.
export const MAIN_PROCESS_ERROR = /\bUncaught\b|\bUnhandled\b|App threw an error/;

export interface Session {
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
export function launchEnv(
  background: boolean,
  dataDir = mkdtempSync(join(tmpdir(), 'ck-')),
  base: NodeJS.ProcessEnv = { ...process.env, SHELL: '/bin/sh' },
  cockpitHome: string | null = join(dataDir, 'h'),
) {
  const env = { ...base, COCKPIT_USER_DATA_DIR: dataDir } as Record<string, string>;
  if (cockpitHome === null) delete env.COCKPIT_HOME;
  else env.COCKPIT_HOME = cockpitHome;
  if (background) env.COCKPIT_TEST_BACKGROUND = '1';
  else delete env.COCKPIT_TEST_BACKGROUND;
  return { dataDir, cockpitHome: cockpitHome ?? '', env };
}

// The daemon (COCKPIT-55) outlives the app: it is detached into its own session, so stopping
// the app's process group leaves it running. Every launch's `close()` kills the daemons of its
// home through their `.pid` files (a stopped one is resumed first), and the folders HOME names when
// COCKPIT_HOME is unset or empty and HOME is a temporary folder of the test.
export function daemonPidFilesIn(home: string): string[] {
  try {
    return readdirSync(home)
      .filter((name) => /^daemon-.*\.pid$/.test(name))
      .map((name) => join(home, name));
  } catch {
    return [];
  }
}

export async function killDaemonsIn(...homes: Array<string | undefined>): Promise<void> {
  const pids: number[] = [];
  for (const home of homes) {
    if (!home) continue;
    for (const file of daemonPidFilesIn(home)) {
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 1) continue;
      pids.push(pid);
      for (const signal of ['SIGCONT', 'SIGKILL'] as const) {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
    }
  }
  for (const pid of pids) await poll(() => isAlive(pid), (alive) => !alive, 5_000);
}

// The folders a launch's daemons live in: its COCKPIT_HOME, or, when that is unset or empty, the
// `.cockpit` and `.cockpit-dev` of a temporary HOME.
export function daemonHomesOf(env: Record<string, string>, cockpitHome: string): string[] {
  if (cockpitHome) return [cockpitHome];
  const home = env.HOME;
  return home && (home.startsWith(tmpdir()) || home.startsWith(realpathSync(tmpdir()))) ? [join(home, '.cockpit'), join(home, '.cockpit-dev')] : [];
}

// The daemon's socket in a Cockpit home (`daemon-1-<build>.sock`), and the token next to it.
export function daemonSocketIn(home: string): string {
  const name = readdirSync(home).find((entry) => /^daemon-1-.+\.sock$/.test(entry));
  if (!name) throw new Error(`no daemon socket in ${home}: ${readdirSync(home).join(', ')}`);
  return join(home, name);
}

// Attaches to a running Electron over the Chrome DevTools Protocol and returns
// its first window. Reloads it so the page's console output is captured from the
// start.
export async function attach(endpoint: string): Promise<{ browser: Browser; page: Page }> {
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
export function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

// `kill(-pid, 0)` throws ESRCH once the group is gone.
export function groupAlive(pid: number): boolean {
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
export async function waitForGroupGone(pid: number, started = Date.now()): Promise<void> {
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
export async function stopGroup(child: ChildProcess): Promise<void> {
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
export function mainInspector(output: () => string) {
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
export async function launchSpawned(
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
        await killDaemonsIn(...daemonHomesOf(env, cockpitHome));
        removeDataDir();
      },
    };
  } catch (error) {
    await stopGroup(child);
    await killDaemonsIn(...daemonHomesOf(env, cockpitHome));
    removeDataDir();
    throw error;
  }
}

export function launchBuilt(): Promise<Session> {
  // The `electron` package exports the path to its binary, downloading it if
  // missing. Resolved here, not at import, so the dev test runs first without it.
  const executablePath: string = createRequire(import.meta.url)('electron');
  return launchSpawned(executablePath, ['.'], true);
}

export function packagedAppDir(): string {
  if (process.platform !== 'darwin') throw new Error(`No packaged app path for ${process.platform}`);
  const releaseDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  return join(appDir, 'release', releaseDir, 'Cockpit.app');
}

export function launchPackaged({
  background = true,
  dataDir,
  env,
}: { background?: boolean; dataDir?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Session> {
  const executablePath = join(packagedAppDir(), 'Contents/MacOS/Cockpit');
  return launchSpawned(executablePath, [], background, dataDir, env);
}

export function freePort(): Promise<number> {
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
export async function launchDev(base?: NodeJS.ProcessEnv): Promise<Session> {
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
        await killDaemonsIn(...daemonHomesOf(env, cockpitHome));
        removeDataDir();
      },
    };
  } catch (error) {
    await stop();
    await killDaemonsIn(...daemonHomesOf(env, cockpitHome));
    removeDataDir();
    throw error;
  }
}

// Reads until `done` accepts the value or `timeout` ms pass, and returns the last value.
export async function poll<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeout: number): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(100);
  }
}

// `process.kill(pid, 0)` throws ESRCH once the process is gone.
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

