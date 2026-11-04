import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { close, constants, open, openSync, read, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Socket, createConnection, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DaemonClient } from '@cockpit/daemon';
import { chromium, type Browser, type ElementHandle, type Frame, type Page } from 'playwright-core';
import { afterEach, expect } from 'vitest';
import { makeTestDir, runRoot } from './run-root';

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
  /** Resolves with the match once the app's output holds `pattern` (at once if it already does); rejects if the app exits first. */
  outputMatch(pattern: RegExp): Promise<RegExpExecArray>;
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
// COCKPIT-61: a `null` data dir leaves `COCKPIT_USER_DATA_DIR` unset and `''` sets it empty (an
// unpackaged app then keeps its `userData` in `<HOME>/.cockpit-dev/<folder>/user-data`, so the test
// needs a `HOME` of its own); the data folder is then made only so the session has a folder to
// report and to remove.
// Safety guard: a launch that leaves `COCKPIT_USER_DATA_DIR` unset or empty relies on the app's own
// default for `userData`, and a failing test (a regression in the app's default) would then write into
// the developer's real data. `HOME` alone does not prevent it: on macOS Electron's `appData` ignores
// it (a mutation run with `HOME=<tmp>` wrote into the real `~/Library/Application Support/@cockpit/desktop`).
// So such a launch must have a `HOME` inside the run root, and gets `CFFIXED_USER_HOME` set to it:
// Foundation's home override, which moves `appData`, `logs` and `cache` (all of `~/Library`) under it.
// Proven with a probe Electron (own app name): `app.getPath('appData')` and every file Chromium
// wrote were under the temporary HOME, nothing under the real `~/Library`.
function guardRealData(env: Record<string, string>) {
  const home = env.HOME;
  let realHome = '';
  try {
    realHome = home ? realpathSync(home) : '';
  } catch {
    // A HOME that does not exist is not under the run root.
  }
  if (!realHome || !(realHome + '/').startsWith(runRoot() + '/')) {
    throw new Error(
      `a launch with COCKPIT_USER_DATA_DIR unset or empty needs HOME inside the run root (${runRoot()}), got ${home}`,
    );
  }
  env.CFFIXED_USER_HOME = realHome;
}

// The terminal page runs whatever `$SHELL` says: by default `/bin/sh`, which keeps
// the developer's shell configuration from slowing or breaking the tests.
export function launchEnv(
  background: boolean,
  givenDataDir: string | null = makeTestDir('d-'),
  base: NodeJS.ProcessEnv = { ...process.env, SHELL: '/bin/sh' },
  givenCockpitHome?: string | null,
) {
  const dataDir = givenDataDir || makeTestDir('d-');
  const cockpitHome = givenCockpitHome === undefined ? join(dataDir, 'h') : givenCockpitHome;
  const env = { ...base, COCKPIT_USER_DATA_DIR: dataDir } as Record<string, string>;
  if (givenDataDir === null) delete env.COCKPIT_USER_DATA_DIR;
  else if (givenDataDir === '') env.COCKPIT_USER_DATA_DIR = '';
  if (!env.COCKPIT_USER_DATA_DIR) guardRealData(env);
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

// Connects to a daemon's socket; the kernel closes the connection when the daemon process ends,
// whoever its parent is, so the returned promise resolves once the daemon is gone. A daemon with no
// socket to connect to is taken as gone.
function connectToDaemon(socketPath: string): Promise<{ gone: Promise<void> }> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const gone = new Promise<void>((done) => socket.once('close', () => done()));
    socket.on('error', () => {});
    socket.once('connect', () => {
      socket.resume();
      resolve({ gone });
    });
    socket.once('error', () => resolve({ gone: Promise.resolve() }));
  });
}

export async function killDaemonsIn(...homes: Array<string | undefined>): Promise<void> {
  const gone: Promise<void>[] = [];
  for (const home of homes) {
    if (!home) continue;
    for (const file of daemonPidFilesIn(home)) {
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 1) continue;
      gone.push((await connectToDaemon(file.replace(/\.pid$/, '.sock'))).gone);
      for (const signal of ['SIGCONT', 'SIGKILL'] as const) {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
    }
  }
  await Promise.all(gone);
}

// The folders a launch's daemons live in: its COCKPIT_HOME, or, when that is unset or empty, the
// `.cockpit` and `.cockpit-dev` of a temporary HOME (a folder of the test run, or of the temporary
// directory), and the per-worktree folders of that `.cockpit-dev` (COCKPIT-61).
export function daemonHomesOf(env: Record<string, string>, cockpitHome: string): string[] {
  if (cockpitHome) return [cockpitHome];
  const home = env.HOME;
  if (!home || !(home.startsWith(runRoot()) || home.startsWith(tmpdir()) || home.startsWith(realpathSync(tmpdir())))) return [];
  const dev = join(home, '.cockpit-dev');
  let folders: string[] = [];
  try {
    folders = readdirSync(dev, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dev, entry.name));
  } catch {
    // No dev folder.
  }
  return [join(home, '.cockpit'), dev, ...folders];
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
  await page.waitForURL((url) => url.protocol !== 'about:');
  await page.reload();
  // The one action timeout of the tests: no call passes its own.
  context.setDefaultTimeout(UI_TIMEOUT);
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

// The `close` of each child a launch started, by pid: it fires once the child has ended and every
// process holding its stdio has too, which for the app and the dev server is its whole process group
// (the helpers inherit the pipes). `waitForGroupGone` has no event for a pid launched elsewhere.
const closedByPid = new Map<number, Promise<void>>();

function closedPromise(child: ChildProcess): Promise<void> {
  const ended = child.exitCode !== null || child.signalCode !== null;
  if (ended && [child.stdin, child.stdout, child.stderr].every((stream) => !stream || stream.destroyed)) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

function track(child: ChildProcess): void {
  closedByPid.set(child.pid!, closedPromise(child));
}

// Waits until the group of a child that a launch started is gone: the helpers of a child can outlive
// it and still write in the data folder. Rejects for a pid no launch started: nothing tells when its group is
// gone, and returning at once would claim it was.
export async function waitForGroupGone(pid: number): Promise<void> {
  const closed = closedByPid.get(pid);
  if (!closed) throw new Error(`no launch started ${pid}: nothing tells when its group is gone`);
  await closed;
}

// Stops a process started with `detached: true` and everything in its process group, and waits
// until the group is gone: SIGKILL to the group, then the child's `close` (every process holding its
// stdio has ended). Not SIGTERM first: an app with no window does not quit on it, and without a timer
// there is no moment to give up on it and escalate.
export async function stopGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid!;
  const closed = closedByPid.get(pid) ?? closedPromise(child);
  signalGroup(pid, 'SIGKILL');
  await closed;
}

// A FIFO in a folder of the run: a line written to it is an event the test awaits. Opened for
// reading and writing at once, so a writer never blocks on a missing reader and no line is lost.
function makeFifo(): string {
  const path = join(makeTestDir('f-'), 'p');
  execFileSync('mkfifo', [path]);
  return path;
}

/** A FIFO at `path`; `line()` resolves with the first line a process writes to it, `close()` closes its reader (a line that never came). */
export function fifo(): { path: string; line(): Promise<string>; close(): void } {
  const path = makeFifo();
  const reader = new Socket({ fd: openSync(path, constants.O_RDWR), readable: true, writable: false });
  reader.unref();
  const first = new Promise<string>((resolve, reject) => {
    let text = '';
    reader.on('error', reject);
    reader.on('data', (chunk) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end < 0) return;
      reader.destroy();
      resolve(text.slice(0, end));
    });
  });
  return { path, line: () => first, close: () => reader.destroy() };
}

/**
 * A process the test holds: `snippet` is shell text that blocks until `release()` writes to its FIFO,
 * then ends with status 0. For a stub or a `sh -c`, instead of a `sleep` or a wait on a file.
 */
export function heldProcess(): { snippet: string; release(): Promise<void> } {
  const path = makeFifo();
  return { snippet: `read _ < '${path}'`, release: () => writeFile(path, 'go\n') };
}

/**
 * Tells when a process, and every process it passed the descriptor to, is gone: `snippet` is shell
 * text that makes the running shell hold the write end of a FIFO on descriptor 9, which its children
 * inherit; `gone` resolves once no process holds it any more (the read end's end of file).
 */
export function gonePipe(): { snippet: string; gone: Promise<void> } {
  const path = makeFifo();
  const gone = new Promise<void>((resolve, reject) => {
    // The open returns once the first writer has opened the FIFO, so no end of file comes before it.
    // The read blocks a thread of libuv's pool until a byte or the end of file: kqueue does not report
    // a FIFO's end of file on macOS, so a stream over the descriptor would never end.
    open(path, constants.O_RDONLY, (error, fd) => {
      if (error) return reject(error);
      const next = () =>
        read(fd, Buffer.alloc(1), 0, 1, null, (failure, bytes) => {
          if (failure) reject(failure);
          else if (bytes > 0) next();
          else close(fd, () => resolve());
        });
      next();
    });
  });
  return { snippet: `exec 9> '${path}'`, gone };
}

const exitTables = new WeakMap<DaemonClient, Map<number, { ended: Promise<void>; end(): void }>>();

// The exit of terminal `id` as the client has heard it: the daemon sends it to a client that attached the terminal.
function exitOf(daemon: DaemonClient, id: number) {
  let table = exitTables.get(daemon);
  if (!table) {
    const mine = new Map<number, { ended: Promise<void>; end(): void }>();
    table = mine;
    exitTables.set(daemon, mine);
    daemon.onExit((event) => exitOf(daemon, event.id).end());
  }
  let each = table.get(id);
  if (!each) {
    let end!: () => void;
    each = { ended: new Promise<void>((resolve) => (end = resolve)), end: () => end() };
    table.set(id, each);
  }
  return each;
}

/**
 * Finds the terminal of the daemon whose screen shows the pid a program printed (`pid<marker>-<pid>` or
 * `pid:<pid>`, with `<marker>` letters and digits) and attaches it, so `ended` resolves when the daemon says that
 * terminal ended: its process is reaped. `daemon` is the test's own connection.
 */
export async function watchTerminalEnd(daemon: DaemonClient, pid: number): Promise<{ ended: Promise<void> }> {
  const printed = new RegExp(`pid[0-9a-z]*[-:]${pid}(?![0-9])`);
  for (const { id } of await daemon.list()) {
    const { ended } = exitOf(daemon, id);
    // A terminal that ended meanwhile is none of those listed.
    const attached = await daemon.attach(id).catch(() => undefined);
    if (attached && printed.test(attached.screen)) return { ended };
  }
  throw new Error(`no terminal of the daemon shows the pid ${pid}`);
}

/** Resolves once the daemon says terminal `id` ended: at once if it already has (the daemon refuses to attach it). */
export async function terminalEnd(daemon: DaemonClient, id: number): Promise<void> {
  const { ended } = exitOf(daemon, id);
  if (await daemon.attach(id).then(() => true, () => false)) await ended;
}

/**
 * Resolves once `predicate(arg)` holds in the page, checked at once and after each DOM mutation
 * (a `MutationObserver`), for a condition no locator state expresses. `predicate` must be
 * self-contained: it runs in the page, from its source text.
 */
export async function untilDom<A>(page: Page, predicate: (arg: A) => boolean, arg?: A): Promise<void> {
  await page.evaluate(`new Promise((resolve, reject) => {
    const predicate = ${predicate.toString()};
    const arg = ${JSON.stringify(arg)};
    const check = () => {
      try {
        if (!predicate(arg)) return;
      } catch (error) {
        observer.disconnect();
        reject(error);
        return;
      }
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    check();
  })`);
}

// COCKPIT-81: the waits of the tests are on the event that marks the step done. `untilRead` and `untilIn` are
// `untilDom` (launch.ts) with a value: `read` runs in the page (or on `element`) from its source text, at once
// and after each DOM mutation, and the promise resolves with the first value `done(value, arg)` accepts.
// `read` and `done` must be self-contained, and `read` synchronous.
export const truthy = (value: unknown) => Boolean(value);

// A criterion's time bound ("within 5 s") stays a check, as a measure: the test waits for the event with no
// timeout of its own, and `within` then fails when more than `boundMs` passed since `startClock()` ran, which is
// at the action the criterion starts its clock from.
export const startClock = () => {
  const start = performance.now();
  return (what: string, boundMs: number) => expect(performance.now() - start, `${what} took longer than ${boundMs} ms`).toBeLessThan(boundMs);
};

// The script both run: `call` reads the value, `root` is what the observer watches. It reads again on DOM
// mutations and on what changes geometry or style with none: a transition or animation ending, a resize of the
// window or of the root. `id` names its last read in the page (`__waitLast`) for `pendingWaits`.
export const untilScript = (read: object, done: object, arg: unknown, call: string, root: string, id: string, uses: Record<string, object> = {}) => `new Promise((resolve, reject) => {
    ${Object.entries(uses).map(([name, each]) => `const ${name} = ${each.toString()};`).join('\n    ')}
    const read = ${read.toString()};
    const done = ${done.toString()};
    const arg = ${JSON.stringify(arg)};
    const events = ['transitionend', 'transitioncancel', 'animationend'];
    const stop = () => {
      observer.disconnect();
      resize.disconnect();
      for (const name of events) document.removeEventListener(name, check, true);
      window.removeEventListener('resize', check);
      delete window.__waitLast?.[${JSON.stringify(id)}];
    };
    const check = () => {
      let value;
      try {
        value = ${call};
        (window.__waitLast ??= {})[${JSON.stringify(id)}] = String(JSON.stringify(value)).slice(0, 2000);
        if (!done(value, arg)) return;
      } catch (error) {
        stop();
        reject(error);
        return;
      }
      stop();
      resolve(value);
    };
    const observer = new MutationObserver(check);
    const resize = new ResizeObserver(check);
    observer.observe(${root}, { subtree: true, childList: true, attributes: true, characterData: true });
    resize.observe(${root} === document ? document.documentElement : ${root});
    for (const name of events) document.addEventListener(name, check, true);
    window.addEventListener('resize', check);
    check();
  })`;

// The waits running in a page, for the diagnostic below: a wait that never ends is ended by the test's own guard
// and says nothing, so the page keeps the last value each one read.
type PendingWait = { frame: Frame; id: string; label: string };
const pendingWaits = new Set<PendingWait>();

export async function evaluateUntil<R>(frame: Frame, read: object, arg: unknown, script: (id: string) => string): Promise<R> {
  const label = `${read.toString().replace(/\s+/g, ' ').slice(0, 100)} waiting for ${JSON.stringify(arg)?.slice(0, 200)}`;
  const pending: PendingWait = { frame, id: randomUUID(), label };
  pendingWaits.add(pending);
  try {
    return (await frame.evaluate(script(pending.id))) as R;
  } finally {
    pendingWaits.delete(pending);
  }
}

// A test the guard ended while a wait ran names what that wait last read, in the test's error.
afterEach(async ({ task }) => {
  const waiting = [...pendingWaits];
  pendingWaits.clear();
  const error = task.result?.errors?.[0];
  if (task.result?.state !== 'fail' || !error || waiting.length === 0) return;
  const lines = await Promise.all(
    waiting.map(async ({ frame, id, label }) => {
      const last = await frame.evaluate((id) => (window as unknown as { __waitLast?: Record<string, string> }).__waitLast?.[id], id).catch(() => '(the page is gone)');
      return `  ${label}\n    last read: ${last}`;
    }),
  );
  error.message += `\nWaits still running when the test ended:\n${lines.join('\n')}`;
});

export async function untilRead<A, R>(page: Page, read: (arg: A) => R, done: (value: R, arg: A) => boolean, arg?: A): Promise<R> {
  return evaluateUntil<R>(page.mainFrame(), read, arg, (id) => untilScript(read, done, arg, 'read(arg)', 'document', id));
}

// The script finds the element by a mark it carries meanwhile: a string handed to a handle's `evaluate` is an
// expression, not a function that gets the element.
export async function untilIn<A, R>(element: ElementHandle<HTMLElement>, read: (element: HTMLElement, arg: A) => R, done: (value: R, arg: A) => boolean, arg?: A): Promise<R> {
  const mark = randomUUID();
  const frame = (await element.ownerFrame())!;
  await element.evaluate((target, mark) => target.setAttribute('data-waiting', mark), mark);
  try {
    return await evaluateUntil<R>(
      frame,
      read,
      arg,
      (id) => `(() => { const element = document.querySelector('[data-waiting="${mark}"]'); return ${untilScript(read, done, arg, 'read(element, arg)', 'element', id)}; })()`,
    );
  } finally {
    await element.evaluate((target) => target.removeAttribute('data-waiting')).catch(() => {});
  }
}

// What a spawned app (or dev server) writes to stdout and stderr, and the lines tests wait for in it.
interface OutputWatch {
  output(): string;
  /** Resolves with the match once the output holds `pattern`; rejects if the process exits first. */
  match(pattern: RegExp): Promise<RegExpExecArray>;
}

function watchOutput(child: ChildProcess, label: string): OutputWatch {
  let output = '';
  let exit: Error | undefined;
  const waiting = new Set<{ pattern: RegExp; resolve(match: RegExpExecArray): void; reject(error: Error): void }>();
  const feed = (chunk: Buffer | string) => {
    output += chunk;
    for (const each of waiting) {
      const found = each.pattern.exec(output);
      if (!found) continue;
      waiting.delete(each);
      each.resolve(found);
    }
  };
  child.stdout!.on('data', feed);
  child.stderr!.on('data', feed);
  child.once('exit', (code, signal) => {
    exit = new Error(`${label} exited with code ${code ?? signal}:\n${output}`);
    for (const each of waiting) each.reject(exit);
    waiting.clear();
  });
  return {
    output: () => output,
    match: (pattern) =>
      new Promise((resolve, reject) => {
        const found = pattern.exec(output);
        if (found) resolve(found);
        else if (exit) reject(exit);
        else waiting.add({ pattern, resolve, reject });
      }),
  };
}

// Connects to the main process's Node inspector (`--inspect=0` prints
// `Debugger listening on ws://...` on stderr) with Node's own WebSocket, and
// evaluates expressions in it. The connection opens on the first evaluation.
// `Runtime.evaluate` with `includeCommandLineAPI` exposes `require`, which is
// what `electronApp.evaluate` of Playwright's Electron launcher does too.
export function mainInspector(watch: OutputWatch) {
  let socket: Promise<WebSocket> | undefined;
  let lastId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  const connect = async () => {
    const [, url] = await watch.match(/Debugger listening on (ws:\/\/\S+)/);
    const ws = new WebSocket(url!);
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
  givenDataDir?: string | null,
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
  track(child);
  const watch = watchOutput(child, 'the app');
  const removeDataDir = () => {
    if (!givenDataDir) rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    const [, port] = await watch.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
    const { browser, page } = await attach(`http://127.0.0.1:${port}`);
    const inspector = mainInspector(watch);
    return {
      page,
      pid: child.pid!,
      dataDir,
      cockpitHome,
      output: watch.output,
      outputMatch: watch.match,
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
// DevTools Protocol. `null` for the data folder or the home leaves `COCKPIT_USER_DATA_DIR` or
// `COCKPIT_HOME` unset (COCKPIT-61).
export async function launchDev(
  base?: NodeJS.ProcessEnv,
  givenDataDir?: string | null,
  givenCockpitHome?: string | null,
): Promise<Session> {
  const port = await freePort();
  const inspectPort = await freePort();
  const { dataDir, cockpitHome, env } = launchEnv(true, givenDataDir, base, givenCockpitHome);
  // Its own process group, so closing stops the dev server and Electron with it.
  // electron-vite ignores `--inspect 0` (0 is falsy for it): a free port instead.
  const dev = spawn('bun', ['run', 'dev', '--remoteDebuggingPort', String(port), '--inspect', String(inspectPort)], {
    cwd: appDir,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  track(dev);
  const watch = watchOutput(dev, 'dev');
  const stop = () => stopGroup(dev);
  const removeDataDir = () => rmSync(dataDir, { recursive: true, force: true });

  try {
    await watch.match(new RegExp(`DevTools listening on ws://127\\.0\\.0\\.1:${port}`));
    const { browser, page } = await attach(`http://127.0.0.1:${port}`);
    // The dev script runs Electron in the process group of `dev`; the helpers
    // are named `Electron Helper ...`, so `-x` matches the main process only.
    const pid = Number(execFileSync('pgrep', ['-g', String(dev.pid), '-x', 'Electron'], { encoding: 'utf8' }).split('\n')[0]);
    closedByPid.set(pid, closedByPid.get(dev.pid!)!);
    const inspector = mainInspector(watch);
    return {
      page,
      pid,
      dataDir,
      cockpitHome,
      output: watch.output,
      outputMatch: watch.match,
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

