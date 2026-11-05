import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { connectDaemon, type DaemonClient } from '@cockpit/daemon';
import { chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sendFromComposer } from '../composer';
import { heldProcess, isAlive, killDaemonsIn, launchDev, launchSpawned, MAIN_PROCESS_ERROR, quitApp, type Session, signalGroup, untilRead, versionLabel, waitForGroupGone } from '../launch';
import { makeTestDir } from '../run-root';


// COCKPIT-55: terminals and sessions live in a daemon that outlives the app. The built app runs the
// full block (a launch per scenario, the app quit or killed and launched again on the same folders,
// builds played through COCKPIT_TEST_DAEMON_BUILD); the packaged app and the dev server run one
// smoke path each. A fake login shell puts a stub `claude` on the PATH, so no real CLI runs, and
// hands the shell tabs of a workspace page a real /bin/sh.

// --- Fixture -----------------------------------------------------------------

// What the stub does: prints its facts into a file next to it (pid, session id, socket, whether
// ELECTRON_RUN_AS_NODE leaked), prints a marker and `ready`, echoes the lines it reads and exits
// with code 3 on `exit`. `hook <Event>` runs the command its --settings hold for that event.
export const STUB_CLAUDE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi
SETTINGS=""
case "$1" in --settings) SETTINGS="$2"; shift 2 ;; esac
{
  echo "pid:$$"
  echo "session:\${COCKPIT_SESSION_ID-unset}"
  echo "socket:\${COCKPIT_SOCKET-unset}"
  echo "runasnode:\${ELECTRON_RUN_AS_NODE-unset}"
} > "$(dirname "$0")/facts.$$"
echo "marker-before-quit"
echo "ready"
while IFS= read -r line; do
  case "$line" in
    exit) exit 3 ;;
    "hook "*)
      event="\${line#hook }"
      command=$(printf '%s' "$SETTINGS" | /usr/bin/plutil -extract "hooks.$event.0.hooks.0.command" raw -o - - 2>/dev/null)
      [ -n "$command" ] && /bin/sh -c "$command"
      echo "hooked:$event" ;;
    *) echo "got:$line" ;;
  esac
done
`;

export interface Fixture {
  root: string;
  bin: string;
  shell: string;
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
}

export function makeFixture(): Fixture {
  const root = realpathSync(makeTestDir('x-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const claude = join(bin, 'claude');
  writeFileSync(claude, STUB_CLAUDE);
  chmodSync(claude, 0o755);
  // macOS scans a new executable the first time it runs.
  expect(execFileSync(claude, ['--version'], { encoding: 'utf8' }).trim()).toBe('9.9.9');
  // The login shell: asked for the environment (`-ilc <command>`) it runs the command with the stub on
  // the PATH; started as a login shell for the terminal page (`-l`, no command) it is a plain /bin/sh.
  const shell = join(root, 'login-shell');
  writeFileSync(shell, `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\nif [ "$1" = -l ] && [ $# -eq 1 ]; then exec /bin/sh; fi\nPATH='${bin}:/usr/bin:/bin' /bin/sh -c "$2"\n`);
  chmodSync(shell, 0o755);
  execFileSync(shell, ['--warmup']);
  return { root, bin, shell, env: (extra = {}) => ({ ...process.env, SHELL: shell, ...extra }) };
}

export const factsOf = (fx: Fixture) =>
  readdirSync(fx.bin)
    .filter((name) => name.startsWith('facts.'))
    .sort()
    .map((name) => {
      const lines = Object.fromEntries(
        readFileSync(join(fx.bin, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]),
      ) as Record<'pid' | 'session' | 'socket' | 'runasnode', string>;
      return { pid: Number(lines.pid), session: lines.session, socket: lines.socket, runasnode: lines.runasnode };
    });

// --- The app and the daemon --------------------------------------------------

export const electron = () => createRequire(import.meta.url)('electron') as string;

// A short folder name (`ck-`): the socket path is limited to 103 bytes on macOS.
export const makeDataDir = () => makeTestDir('d-');
export const uniqueBuild = () => `b${randomUUID().slice(0, 6)}`;

export const launchBuiltOn = (env: NodeJS.ProcessEnv, dataDir: string, home: string) => launchSpawned(electron(), ['.'], true, dataDir, env, home);

export const daemonFile = (home: string, extension: 'sock' | 'token' | 'pid' | 'log', build?: string) => {
  const names = existsSync(home) && statSync(home).isDirectory() ? readdirSync(home) : [];
  const name = names.find((entry) => (build ? entry === `daemon-1-${build}.${extension}` : new RegExp(`^daemon-1-.+\\.${extension}$`).test(entry)));
  return name ? join(home, name) : undefined;
};

export const daemonPid = (home: string, build?: string) => {
  const file = daemonFile(home, 'pid', build);
  return file ? Number(readFileSync(file, 'utf8').trim()) : undefined;
};

// A value the test needs, failing as an assertion when it is missing.
export function must<T>(value: T | undefined, what: string): T {
  expect(value, what).toBeDefined();
  return value as T;
}

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const commandOf = (pid: number) => {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

export const environmentOf = (pid: number) => execFileSync('ps', ['-Eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });

// The daemon processes of a build, as `ps` shows them.
export const daemonProcessesOf = (build: string) =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes('--cockpit-daemon') && line.includes(build))
    .map((line) => Number(line.trim().split(/\s+/)[0]));

// `app.quit()` as Cmd+Q does, then waits for the app to be gone. The daemon is left running: no `close()`.
// SIGKILL to the app's whole process group.
export async function killApp(session: Session): Promise<void> {
  await session.disconnectInspector();
  signalGroup(session.pid, 'SIGKILL');
  await waitForGroupGone(session.pid);
}

// The daemon has handled what the app's end left it: a request of a new connection, made after the app is gone, is
// answered after the daemon's loop has seen the app's connection close. Asks `list()`, what the app's end must not change.
export async function daemonSettled(home: string, build?: string): Promise<void> {
  const daemon = await connectDaemon(must(daemonFile(home, 'sock', build), 'the daemon sock'));
  try {
    await daemon.list();
  } finally {
    daemon.close();
  }
}

export const aliveOf = (pids: number[]) => pids.map(isAlive);

// Resolves once a daemon, which is no child of the test, has exited: `caffeinate -w <pid>` (macOS) waits for any
// process to exit, a child or not, and returns at once for a pid already gone. It fires on the exit itself, before
// the parent has reaped the process, so a zombie (state `Z`) counts as gone.
export async function daemonEnded(pid: number): Promise<void> {
  const [code] = await once(spawn('/usr/bin/caffeinate', ['-w', String(pid)], { stdio: 'ignore' }), 'exit');
  expect(code, `caffeinate -w ${pid}`).toBe(0);
  const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  expect(state === '' || state.startsWith('Z'), `process ${pid} state "${state}" after caffeinate -w`).toBe(true);
}

// --- The page ----------------------------------------------------------------

// The text of the terminals the page shows (the ones of other tabs are `invisible`). Self-contained: it runs in `untilRead`.
export const readScreen = () =>
  [...document.querySelectorAll('.xterm')]
    .filter((element) => (element as HTMLElement).offsetParent !== null && getComputedStyle(element).visibility !== 'hidden')
    .map((element) => [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()).join('\n'))
    .join('\n');

// Waits until the screen of the visible terminals matches, read at once and after each DOM mutation.
export async function expectScreen(page: Page, pattern: RegExp) {
  const text = await untilRead(page, readScreen, (screen, wanted: { source: string; flags: string }) => new RegExp(wanted.source, wanted.flags).test(screen), {
    source: pattern.source,
    flags: pattern.flags,
  });
  expect(text).toMatch(pattern);
  return text;
}

// `nth` picks one of the visible terminals (a split tab shows several); the first by default.
export async function typeLine(page: Page, text: string, nth = 0) {
  const terminal = page.locator('.xterm:visible').nth(nth);
  await terminal.waitFor({ state: 'visible' });
  await terminal.click();
  await page.locator('.xterm:visible .xterm-helper-textarea').nth(nth).focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

// COCKPIT-70: shells live in the tabs of a workspace page. A workspace of a repository the session adds is made through
// `window.api` (no daemon is needed), and its page is opened through its sidebar row.
export async function makeWorkspace(session: Session, name: string, repoRoot?: string): Promise<{ path: string; root: string }> {
  const { page } = session;
  const root = repoRoot ?? makeRepoWithSetup({}).root;
  await stubPicker(session, root);
  await page.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!());
  const created = await page.evaluate(([root, name]) => (window as unknown as ApiWindow).api.workspaces!.create!(root, name, 'main'), [root, name] as const);
  expect(created.status).toBe('created');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const path = (created as { workspace: { path: string } }).workspace.path;
  await page.getByTitle(path, { exact: true }).first().waitFor();
  return { path, root };
}

export const goToWorkspacePage = async (page: Page, path: string) => {
  await page.getByTitle(path, { exact: true }).first().click();
  await page.getByRole('tablist').first().waitFor();
};

// Starts a "Terminal" tab in the first pane of the workspace page.
export const newShellTab = async (page: Page) => {
  await page.getByRole('button', { name: 'New tab', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
};

export const tabNames = (page: Page) => page.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => (tab.textContent ?? '').trim()));

// Waits until the page shows exactly `count` tabs.
export async function expectTabCount(page: Page, count: number) {
  const tabs = page.getByRole('tab');
  if (count > 0) await tabs.nth(count - 1).waitFor();
  await tabs.nth(count).waitFor({ state: 'detached' });
}

export const selectTab = (page: Page, index: number) => page.getByRole('tab').nth(index).click();

// The pid a shell prints (`echo pid-$$`), typed in the terminal that is shown.
export async function shellPid(page: Page, nth = 0): Promise<number> {
  const marker = Math.random().toString(36).slice(2, 6);
  await typeLine(page, `echo pid${marker}-$$`, nth);
  const screen = await expectScreen(page, new RegExp(`^pid${marker}-\\d+$`, 'm'));
  return Number(new RegExp(`^pid${marker}-(\\d+)$`, 'm').exec(screen)![1]);
}

// Starts a session outside any project through the composer (COCKPIT-66): "No project", Claude Code and a prompt.
export async function startSession(page: Page): Promise<string> {
  const { id } = await sendFromComposer(page, 'none', { prompt: 'start', agent: 'Claude Code' });
  await expectScreen(page, /^ready$/m);
  return id!;
}

// The row of a session in the sidebar: whether it shows a dot, and the dot's accessible name. Self-contained: it runs in `untilRead`.
export const readDot = ({ id }: { id: string; label?: string | null }) => {
  const dot = document.querySelector(`aside a[href$="/sessions/${id}"]`)?.closest('li')?.querySelector('[role="img"][aria-label]');
  return dot ? dot.getAttribute('aria-label') : null;
};

export const dotOf = (page: Page, id: string) => page.evaluate(readDot, { id });

export const expectDot = async (page: Page, id: string, label: string | null) =>
  expect(await untilRead(page, readDot, (found, arg: { id: string; label: string | null }) => found === arg.label, { id, label }), `the dot of session ${id}`).toBe(label);

export function postEvent(socketPath: string, token: string, body: unknown) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ socketPath, method: 'POST', path: '/session-events', headers: { authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

export const tokenFor = (socketPath: string) => readFileSync(socketPath.replace(/\.sock$/, '.token'), 'utf8');

// Every page of the app, through a second CDP connection (a window the app opened itself has no handle).
// A window the app has just opened has no page for the connection until Chromium reports its target: the connection
// hears of it.
export async function pagesOf(session: Session): Promise<Page[]> {
  const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(session.output())![1];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0]!;
  if (context.pages().length === 0) await context.waitForEvent('page');
  return browser.contexts().flatMap((each) => each.pages());
}

// Resolves with the URLs of the app's windows once `done(urls, arg)` accepts them, checked at once and on each window's
// creation, closing and navigation; every listener it added is removed when it resolves. `done` must be
// self-contained: it runs in the main process.
export const untilWindows = (session: Session, done: (urls: string[], arg: any) => boolean, arg?: unknown) =>
  session.evaluateInMain<string[]>(`new Promise((resolve) => {
    const { app, BrowserWindow } = require('electron');
    const done = ${done.toString()};
    const arg = ${JSON.stringify(arg)};
    const watched = new WeakSet();
    const removals = [];
    const listen = (emitter, name, listener) => {
      emitter.on(name, listener);
      removals.push(() => emitter.removeListener(name, listener));
    };
    let settled = false;
    const check = () => {
      if (settled) return;
      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) {
        if (watched.has(window)) continue;
        watched.add(window);
        listen(window, 'closed', check);
        for (const name of ['did-navigate', 'did-navigate-in-page', 'did-finish-load']) listen(window.webContents, name, check);
      }
      const urls = windows.map((window) => window.webContents.getURL());
      if (!done(urls, arg)) return;
      settled = true;
      for (const remove of removals) remove();
      resolve(urls);
    };
    const created = () => setImmediate(check);
    listen(app, 'browser-window-created', created);
    check();
  })`);

// Resolves once the stubbed `Notification.prototype.show` has been called (it tells `globalThis.__onShown`), at once if it has.
export const notificationShown = (session: Session) =>
  session.evaluateInMain<void>(`new Promise((resolve) => { if (globalThis.__notified.length > 0) resolve(); else globalThis.__onShown.push(resolve); })`);

// Destroys every window and tells when the app has none.
export const destroyWindows = (session: Session) =>
  session.evaluateInMain<string[]>(`(async () => {
    const { BrowserWindow } = require('electron');
    const windows = BrowserWindow.getAllWindows();
    const closed = windows.map((window) => new Promise((resolve) => window.once('closed', resolve)));
    for (const window of windows) window.destroy();
    await Promise.all(closed);
    return BrowserWindow.getAllWindows().map((window) => window.webContents.getURL());
  })()`);

// A git repository with a teardown command that stays running, for the `commands` terminals (COCKPIT-57:
// only the teardown runs as one; the setup is `cockpit setup`, in the session's own terminal), or with
// the given `.cockpit/config.json`. The command prints its pid and holds (`heldProcess`, never released: it ends
// with its terminal).
export function makeRepoWithSetup(config: unknown = { teardown: [`echo setup-pid-$$-ready; ${heldProcess().snippet}`] }): { parent: string; root: string } {
  const parent = realpathSync(makeTestDir('r-'));
  const root = join(parent, 'proj');
  mkdirSync(join(root, '.cockpit'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'hello\n');
  writeFileSync(join(root, '.cockpit', 'config.json'), JSON.stringify(config));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-b', 'main');
  git('add', '.');
  git('commit', '-m', 'initial');
  return { parent, root };
}

// A linked worktree made with git itself (the app lists it like one it made).
export function addWorktree(root: string, branch: string, path: string) {
  execFileSync('git', ['worktree', 'add', '-b', branch, path], {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

export const stubPicker = (session: Session, pick: string) =>
  session.evaluateInMain(`(() => { require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(pick)}] }); })()`);

export type ApiWindow = { api: Record<string, Record<string, (...args: unknown[]) => Promise<any>>> };

// What a test's own connection to the daemon sees of one terminal: its output (the screen at the
// attach, then the chunks after it) and its exit. Listeners come before the attach, so nothing the
// daemon sends in between is lost.
export async function watchTerminal(daemon: DaemonClient, id: number) {
  const chunks = new Map<number, string>();
  const changed = new Set<() => void>();
  daemon.onData((event) => {
    if (event.id !== id) return;
    chunks.set(event.seq, event.data);
    changed.forEach((check) => check());
  });
  const exited = new Promise<void>((resolve) => daemon.onExit((event) => event.id === id && resolve()));
  const { screen, seq } = await daemon.attach(id);
  const text = () =>
    screen +
    [...chunks]
      .filter(([each]) => each > seq)
      .sort(([a], [b]) => a - b)
      .map(([, data]) => data)
      .join('');
  const find = (pattern: RegExp) =>
    new Promise<RegExpExecArray>((resolve) => {
      const check = () => {
        const found = pattern.exec(text());
        if (!found) return;
        changed.delete(check);
        resolve(found);
      };
      changed.add(check);
      check();
    });
  return { exited, find };
}

// The process is gone, or a zombie: a killed process stays one until its parent (or init, once the parent is gone) waits for it.
export const hasEnded = (pid: number) => {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch {
    return true;
  }
};

// The line the setup command prints with its pid, and how a test finds the pid in a terminal's text.
export const SETUP_PID = /setup-pid-(\d+)-ready/;

// Adds the repository, creates a workspace and starts its teardown (a `commands` terminal, like a
// setup) through `window.api`. The terminal is found through the test's own connection to the daemon:
// the main process numbers its terminals itself (`ptyId`), the daemon numbers its own and the two are
// not mapped, so it is the daemon's `commands` terminal that runs in this workspace's folder. Its
// command prints its pid and holds; the id returned is the daemon's.
export async function beginSetup(session: Session, daemon: DaemonClient, repo: { root: string }, name: string): Promise<number> {
  const { page } = session;
  await stubPicker(session, repo.root);
  await page.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!());
  const created = await page.evaluate(([root, name]) => (window as unknown as ApiWindow).api.workspaces!.create!(root, name, 'main'), [repo.root, name] as const);
  expect(created.status).toBe('created');
  const { path } = (created as { workspace: { path: string } }).workspace;
  const started = await page.evaluate(([root, path]) => (window as unknown as ApiWindow).api.workspaces!.teardown!(root, path, { cols: 80, rows: 24 }), [repo.root, path] as const);
  expect(started.status).toBe('started');
  const info = (await daemon.list()).find((terminal) => terminal.kind === 'commands' && terminal.cwd === path);
  return must(info, 'the setup terminal in the daemon').id;
}

// `beginSetup`, then the pid the setup prints; `exited` resolves when the daemon says the terminal ended.
export async function startSetup(session: Session, daemon: DaemonClient, repo: { root: string }, name: string): Promise<{ pid: number; exited: Promise<void> }> {
  const terminal = await watchTerminal(daemon, await beginSetup(session, daemon, repo, name));
  const [, pid] = await terminal.find(SETUP_PID);
  return { pid: Number(pid), exited: terminal.exited };
}

// --- Packaged app: smoke path -------------------------------------------------


function packagedExecutable(): string {
  const releaseDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  return join(import.meta.dirname, '..', '..', 'release', releaseDir, 'Cockpit.app', 'Contents/MacOS/Cockpit');
}

export const describeDaemonPackagedSmoke = () => describe('daemon: packaged app smoke path', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let session: Session | undefined;

  beforeAll(() => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  });

  test('AC2, AC3 — a shell and a session survive app.quit() and are shown again with their marker on relaunch (the daemon runs from inside app.asar, with node-pty unpacked)', async () => {
    const launch = () => launchSpawned(packagedExecutable(), [], true, dataDir, fx.env(), home);
    session = await launch();
    let { page } = session;
    await page.getByText(versionLabel).waitFor();
    const daemon = must(daemonPid(home), 'the daemon pid');
    expect(commandOf(daemon)).toContain('--cockpit-daemon');

    const workspace = await makeWorkspace(session, 'smoke-ws');
    await goToWorkspacePage(page, workspace.path);
    await newShellTab(page);
    await typeLine(page, 'echo marker-shell-$((6*7))');
    await expectScreen(page, /^marker-shell-42$/m);
    const shell = await shellPid(page);
    const id = await startSession(page);
    const sessionPid = factsOf(fx)[0]!.pid;
    await quitApp(session);

    // A snapshot after the daemon has seen the close (as in AC2): the relaunch below, which shows the marker of the
    // shell and the session again, carries the claim that they were not killed.
    await daemonSettled(home);
    expect(aliveOf([daemon, shell, sessionPid])).toEqual([true, true, true]);

    session = await launch();
    page = session.page;
    await page.getByText(versionLabel).waitFor();
    expect(daemonPid(home)).toBe(daemon);
    await page.locator(`aside a[href$="/sessions/${id}"]`).click();
    await expectScreen(page, /^marker-before-quit$/m);
    expect(await dotOf(page, id)).not.toBe('Ended');
    await goToWorkspacePage(page, workspace.path);
    await expectScreen(page, /^marker-shell-42$/m);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});

export const describeDaemonDevServerSmoke = () => describe('daemon: dev server smoke path', () => {
  let session: Session | undefined;

  afterAll(async () => {
    await session?.close().catch(() => {});
  });

  test('AC1 — the daemon starts and a terminal runs a command', async () => {
    session = await launchDev();
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    const pid = must(daemonPid(session.cockpitHome), 'the daemon pid');
    expect(isAlive(pid)).toBe(true);
    expect(commandOf(pid)).toContain('--cockpit-daemon');

    const workspace = await makeWorkspace(session, 'dev-ws');
    await goToWorkspacePage(page, workspace.path);
    await newShellTab(page);
    await typeLine(page, 'echo cockpit-$((6*7))');
    await expectScreen(page, /^cockpit-42$/m);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});
