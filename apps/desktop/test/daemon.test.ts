import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { connectDaemon, type DaemonClient } from '@cockpit/daemon';
import { chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  MAIN_PROCESS_ERROR,
  heldProcess,
  isAlive,
  killDaemonsIn,
  launchDev,
  launchSpawned,
  signalGroup,
  startClock,
  untilRead,
  versionLabel,
  waitForGroupGone,
  watchTerminalEnd,
  type Session,
} from './launch';
import { sendFromComposer } from './composer';
import { makeTestDir } from './run-root';

// COCKPIT-55: terminals and sessions live in a daemon that outlives the app. The built app runs the
// full block (a launch per scenario, the app quit or killed and launched again on the same folders,
// builds played through COCKPIT_TEST_DAEMON_BUILD); the packaged app and the dev server run one
// smoke path each. A fake login shell puts a stub `claude` on the PATH, so no real CLI runs, and
// hands the shell tabs of a workspace page a real /bin/sh.

// --- Fixture -----------------------------------------------------------------

// What the stub does: prints its facts into a file next to it (pid, session id, socket, whether
// ELECTRON_RUN_AS_NODE leaked), prints a marker and `ready`, echoes the lines it reads and exits
// with code 3 on `exit`. `hook <Event>` runs the command its --settings hold for that event.
const STUB_CLAUDE = `#!/bin/sh
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

interface Fixture {
  root: string;
  bin: string;
  shell: string;
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
}

function makeFixture(): Fixture {
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

const factsOf = (fx: Fixture) =>
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

const electron = () => createRequire(import.meta.url)('electron') as string;

// A short folder name (`ck-`): the socket path is limited to 103 bytes on macOS.
const makeDataDir = () => makeTestDir('d-');
const uniqueBuild = () => `b${randomUUID().slice(0, 6)}`;

const launchBuiltOn = (env: NodeJS.ProcessEnv, dataDir: string, home: string) => launchSpawned(electron(), ['.'], true, dataDir, env, home);

const daemonFile = (home: string, extension: 'sock' | 'token' | 'pid' | 'log', build?: string) => {
  const names = existsSync(home) && statSync(home).isDirectory() ? readdirSync(home) : [];
  const name = names.find((entry) => (build ? entry === `daemon-1-${build}.${extension}` : new RegExp(`^daemon-1-.+\\.${extension}$`).test(entry)));
  return name ? join(home, name) : undefined;
};

const daemonPid = (home: string, build?: string) => {
  const file = daemonFile(home, 'pid', build);
  return file ? Number(readFileSync(file, 'utf8').trim()) : undefined;
};

// A value the test needs, failing as an assertion when it is missing.
function must<T>(value: T | undefined, what: string): T {
  expect(value, what).toBeDefined();
  return value as T;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const commandOf = (pid: number) => {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const environmentOf = (pid: number) => execFileSync('ps', ['-Eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });

// The daemon processes of a build, as `ps` shows them.
const daemonProcessesOf = (build: string) =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes('--cockpit-daemon') && line.includes(build))
    .map((line) => Number(line.trim().split(/\s+/)[0]));

// `app.quit()` as Cmd+Q does, then waits for the app to be gone. The daemon is left running: no `close()`.
async function quitApp(session: Session): Promise<void> {
  // `require` only exists during the evaluation: `app` is taken before the next turn of the loop, which runs after
  // the evaluation has answered (a quit during it would end the app before the inspector answered).
  await session.evaluateInMain(`(() => { const { app } = require('electron'); setImmediate(() => app.quit()); })()`);
  await session.disconnectInspector();
  // The app's exit: its process group is gone once its `close` fires (the exit, and every holder of its stdio).
  await waitForGroupGone(session.pid);
}

// SIGKILL to the app's whole process group.
async function killApp(session: Session): Promise<void> {
  await session.disconnectInspector();
  signalGroup(session.pid, 'SIGKILL');
  await waitForGroupGone(session.pid);
}

// The daemon has handled what the app's end left it: a request of a new connection, made after the app is gone, is
// answered after the daemon's loop has seen the app's connection close. Asks `list()`, what the app's end must not change.
async function daemonSettled(home: string, build?: string): Promise<void> {
  const daemon = await connectDaemon(must(daemonFile(home, 'sock', build), 'the daemon sock'));
  try {
    await daemon.list();
  } finally {
    daemon.close();
  }
}

const aliveOf = (pids: number[]) => pids.map(isAlive);

// Resolves once a daemon, which is no child of the test, has exited: `caffeinate -w <pid>` (macOS) waits for any
// process to exit, a child or not, and returns at once for a pid already gone. It fires on the exit itself, before
// the parent has reaped the process, so a zombie (state `Z`) counts as gone.
async function daemonEnded(pid: number): Promise<void> {
  const [code] = await once(spawn('/usr/bin/caffeinate', ['-w', String(pid)], { stdio: 'ignore' }), 'exit');
  expect(code, `caffeinate -w ${pid}`).toBe(0);
  const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  expect(state === '' || state.startsWith('Z'), `process ${pid} state "${state}" after caffeinate -w`).toBe(true);
}

// --- The page ----------------------------------------------------------------

// The text of the terminals the page shows (the ones of other tabs are `invisible`). Self-contained: it runs in `untilRead`.
const readScreen = () =>
  [...document.querySelectorAll('.xterm')]
    .filter((element) => (element as HTMLElement).offsetParent !== null && getComputedStyle(element).visibility !== 'hidden')
    .map((element) => [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()).join('\n'))
    .join('\n');

// Waits until the screen of the visible terminals matches, read at once and after each DOM mutation.
async function expectScreen(page: Page, pattern: RegExp) {
  const text = await untilRead(page, readScreen, (screen, wanted: { source: string; flags: string }) => new RegExp(wanted.source, wanted.flags).test(screen), {
    source: pattern.source,
    flags: pattern.flags,
  });
  expect(text).toMatch(pattern);
  return text;
}

// `nth` picks one of the visible terminals (a split tab shows several); the first by default.
async function typeLine(page: Page, text: string, nth = 0) {
  const terminal = page.locator('.xterm:visible').nth(nth);
  await terminal.waitFor({ state: 'visible' });
  await terminal.click();
  await page.locator('.xterm:visible .xterm-helper-textarea').nth(nth).focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

// COCKPIT-70: shells live in the tabs of a workspace page. A workspace of a repository the session adds is made through
// `window.api` (no daemon is needed), and its page is opened through its sidebar row.
async function makeWorkspace(session: Session, name: string, repoRoot?: string): Promise<{ path: string; root: string }> {
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

const goToWorkspacePage = async (page: Page, path: string) => {
  await page.getByTitle(path, { exact: true }).first().click();
  await page.getByRole('tablist').first().waitFor();
};

// Starts a "Terminal" tab in the first pane of the workspace page.
const newShellTab = async (page: Page) => {
  await page.getByRole('button', { name: 'New tab', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
};

const tabNames = (page: Page) => page.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => (tab.textContent ?? '').trim()));

// Waits until the page shows exactly `count` tabs.
async function expectTabCount(page: Page, count: number) {
  const tabs = page.getByRole('tab');
  if (count > 0) await tabs.nth(count - 1).waitFor();
  await tabs.nth(count).waitFor({ state: 'detached' });
}

const selectTab = (page: Page, index: number) => page.getByRole('tab').nth(index).click();

// The pid a shell prints (`echo pid-$$`), typed in the terminal that is shown.
async function shellPid(page: Page, nth = 0): Promise<number> {
  const marker = Math.random().toString(36).slice(2, 6);
  await typeLine(page, `echo pid${marker}-$$`, nth);
  const screen = await expectScreen(page, new RegExp(`^pid${marker}-\\d+$`, 'm'));
  return Number(new RegExp(`^pid${marker}-(\\d+)$`, 'm').exec(screen)![1]);
}

// Starts a session outside any project through the composer (COCKPIT-66): "No project", Claude Code and a prompt.
async function startSession(page: Page): Promise<string> {
  const { id } = await sendFromComposer(page, 'none', { prompt: 'start', agent: 'Claude Code' });
  await expectScreen(page, /^ready$/m);
  return id!;
}

// The row of a session in the sidebar: whether it shows a dot, and the dot's accessible name. Self-contained: it runs in `untilRead`.
const readDot = ({ id }: { id: string; label?: string | null }) => {
  const dot = document.querySelector(`aside a[href$="/sessions/${id}"]`)?.closest('li')?.querySelector('[role="img"][aria-label]');
  return dot ? dot.getAttribute('aria-label') : null;
};

const dotOf = (page: Page, id: string) => page.evaluate(readDot, { id });

const expectDot = async (page: Page, id: string, label: string | null) =>
  expect(await untilRead(page, readDot, (found, arg: { id: string; label: string | null }) => found === arg.label, { id, label }), `the dot of session ${id}`).toBe(label);

function postEvent(socketPath: string, token: string, body: unknown) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ socketPath, method: 'POST', path: '/session-events', headers: { authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const tokenFor = (socketPath: string) => readFileSync(socketPath.replace(/\.sock$/, '.token'), 'utf8');

// Every page of the app, through a second CDP connection (a window the app opened itself has no handle).
// A window the app has just opened has no page for the connection until Chromium reports its target: the connection
// hears of it.
async function pagesOf(session: Session): Promise<Page[]> {
  const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(session.output())![1];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0]!;
  if (context.pages().length === 0) await context.waitForEvent('page');
  return browser.contexts().flatMap((each) => each.pages());
}

// Resolves with the URLs of the app's windows once `done(urls, arg)` accepts them, checked at once and on each window's
// creation, closing and navigation. `done` must be self-contained: it runs in the main process.
const untilWindows = (session: Session, done: (urls: string[], arg: any) => boolean, arg?: unknown) =>
  session.evaluateInMain<string[]>(`new Promise((resolve) => {
    const { app, BrowserWindow } = require('electron');
    const done = ${done.toString()};
    const arg = ${JSON.stringify(arg)};
    const watched = new WeakSet();
    const check = () => {
      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) {
        if (watched.has(window)) continue;
        watched.add(window);
        window.once('closed', check);
        for (const name of ['did-navigate', 'did-navigate-in-page', 'did-finish-load']) window.webContents.on(name, check);
      }
      const urls = windows.map((window) => window.webContents.getURL());
      if (done(urls, arg)) resolve(urls);
    };
    app.on('browser-window-created', () => setImmediate(check));
    check();
  })`);

// Resolves once the stubbed `Notification.prototype.show` has been called (it tells `globalThis.__onShown`), at once if it has.
const notificationShown = (session: Session) =>
  session.evaluateInMain<void>(`new Promise((resolve) => { if (globalThis.__notified.length > 0) resolve(); else globalThis.__onShown.push(resolve); })`);

// Destroys every window and tells when the app has none.
const destroyWindows = (session: Session) =>
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
function makeRepoWithSetup(config: unknown = { teardown: [`echo setup-pid-$$-ready; ${heldProcess().snippet}`] }): { parent: string; root: string } {
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
function addWorktree(root: string, branch: string, path: string) {
  execFileSync('git', ['worktree', 'add', '-b', branch, path], {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

const stubPicker = (session: Session, pick: string) =>
  session.evaluateInMain(`(() => { require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(pick)}] }); })()`);

type ApiWindow = { api: Record<string, Record<string, (...args: unknown[]) => Promise<any>>> };

// What a test's own connection to the daemon sees of one terminal: its output (the screen at the
// attach, then the chunks after it) and its exit. Listeners come before the attach, so nothing the
// daemon sends in between is lost.
async function watchTerminal(daemon: DaemonClient, id: number) {
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
const hasEnded = (pid: number) => {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch {
    return true;
  }
};

// The line the setup command prints with its pid, and how a test finds the pid in a terminal's text.
const SETUP_PID = /setup-pid-(\d+)-ready/;

// Adds the repository, creates a workspace and starts its teardown (a `commands` terminal, like a
// setup) through `window.api`. The terminal is found through the test's own connection to the daemon:
// the main process numbers its terminals itself (`ptyId`), the daemon numbers its own and the two are
// not mapped, so it is the daemon's `commands` terminal that runs in this workspace's folder. Its
// command prints its pid and holds; the id returned is the daemon's.
async function beginSetup(session: Session, daemon: DaemonClient, repo: { root: string }, name: string): Promise<number> {
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
async function startSetup(session: Session, daemon: DaemonClient, repo: { root: string }, name: string): Promise<{ pid: number; exited: Promise<void> }> {
  const terminal = await watchTerminal(daemon, await beginSetup(session, daemon, repo, name));
  const [, pid] = await terminal.find(SETUP_PID);
  return { pid: Number(pid), exited: terminal.exited };
}

// --- Built app: terminals and sessions survive --------------------------------

describe('daemon: built app', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let build: string;
  let env: NodeJS.ProcessEnv;
  let session: Session | undefined;
  let repo: { parent: string; root: string } | undefined;
  const known = { daemon: 0, session: '', sessionPid: 0, shells: [] as number[], workspace: '' };
  // COCKPIT-80 AC10: a process that is none of the test's, whose command ends with `sleep 300` and
  // whose pid is lower than any setup's, runs for the whole describe: a setup picked out by a
  // machine-wide `ps` pattern would be this one, every run.
  let foreign: ChildProcess;

  beforeAll(async () => {
    foreign = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
    foreign.unref();
    await once(foreign, 'spawn');
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    build = uniqueBuild();
    env = fx.env({ COCKPIT_TEST_DAEMON_BUILD: build });
  });

  afterAll(async () => {
    foreign.kill('SIGKILL');
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  test('AC1 — with no daemon running the app spawns one before its window: detached into its own session, on the app\'s Electron as Node, with .sock and .token (0600), .pid and .log, and no Cockpit Pty Host process', async () => {
    session = await launchBuiltOn(env, dataDir, home);
    await session.page.getByText(versionLabel).waitFor();

    expect(readdirSync(home).filter((name) => name.startsWith('daemon-1-')).sort()).toEqual([`daemon-1-${build}.log`, `daemon-1-${build}.pid`, `daemon-1-${build}.sock`, `daemon-1-${build}.token`]);
    const socket = must(daemonFile(home, 'sock', build), 'the daemon sock');
    const token = must(daemonFile(home, 'token', build), 'the daemon token');
    const pid = must(daemonPid(home, build), 'the daemon pid');
    expect(statSync(socket).isSocket()).toBe(true);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(token).mode & 0o777).toBe(0o600);
    expect(readFileSync(token, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(must(daemonFile(home, 'log', build), 'the daemon log'))).toBe(true);
    expect(isAlive(pid)).toBe(true);
    expect(daemonProcessesOf(build)).toEqual([pid]);
    expect(commandOf(pid)).toContain('--cockpit-daemon');
    expect(environmentOf(pid)).toContain('ELECTRON_RUN_AS_NODE=1');
    // Its own session: it leads its process group, which is not the app's.
    expect(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim()).toBe(String(pid));
    expect(await session.evaluateInMain<string[]>(`require('electron').app.getAppMetrics().map((metric) => metric.name ?? '')`)).not.toContain('Cockpit Pty Host');
    known.daemon = pid;
  });

  test('AC13 — a shell of a workspace page gets COCKPIT_SOCKET (the daemon\'s .sock) and no session id; a session gets its own id and the socket; no pty environment holds ELECTRON_RUN_AS_NODE; the hook reaches the daemon (dot) and an unknown id gets 404', async () => {
    const { page } = session!;
    known.workspace = (await makeWorkspace(session!, 'daemon-ws')).path;
    await goToWorkspacePage(page, known.workspace);
    await newShellTab(page);
    // The socket is long: its name and whether it sits in COCKPIT_HOME are printed, not the whole path.
    await typeLine(
      page,
      `printf 'sock=<%s> home=<%s> sid=<%s> ras=<%s>\\n' "$(basename "$COCKPIT_SOCKET")" "$([ "$(dirname "$COCKPIT_SOCKET")" = '${home}' ] && echo ok)" "\${COCKPIT_SESSION_ID-unset}" "\${ELECTRON_RUN_AS_NODE-unset}"`,
    );
    const socket = must(daemonFile(home, 'sock', build), 'the daemon sock');
    await expectScreen(page, new RegExp(`^sock=<daemon-1-${build}\\.sock> home=<ok> sid=<unset> ras=<unset>$`, 'm'));
    known.shells.push(await shellPid(page));

    // A second tab, a second shell.
    await newShellTab(page);
    await expectScreen(page, /^sh-[\d.]+\$$/m);
    await typeLine(page, 'echo marker-two-$((6*7))');
    await expectScreen(page, /^marker-two-42$/m);
    known.shells.push(await shellPid(page));

    // The session, its status through the hook, and the endpoint's 404.
    known.session = await startSession(page);
    const [facts] = factsOf(fx);
    known.sessionPid = facts!.pid;
    expect(facts).toMatchObject({ session: known.session, socket, runasnode: 'unset' });
    await typeLine(page, 'hook UserPromptSubmit');
    await expectScreen(page, /^hooked:UserPromptSubmit$/m);
    await expectDot(page, known.session, 'Working');
    expect(await postEvent(socket, tokenFor(socket), { sessionId: randomUUID(), event: 'working' })).toBe(404);
  });

  test('AC2 — when the app quits (app.quit()) the daemon, the session and the two shells are still alive', async () => {
    await quitApp(session!);
    // The daemon has seen the app's connection close by the time it answers a new connection.
    await daemonSettled(home, build);

    expect(aliveOf([known.daemon, known.sessionPid, ...known.shells])).toEqual([true, true, true, true]);
  });

  test('AC1, AC3, AC5 — the app launched again reuses the daemon (same pid, no second one); the session shows no "Ended" dot and its last status, its page shows the marker and takes a line; the workspace page shows one tab per shell in creation order, each with its marker and running a new command', async () => {
    session = await launchBuiltOn(env, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    expect(daemonPid(home, build)).toBe(known.daemon);
    expect(daemonProcessesOf(build)).toEqual([known.daemon]);

    await expectDot(page, known.session, 'Working');
    await page.locator(`aside a[href$="/sessions/${known.session}"]`).click();
    await expectScreen(page, /^marker-before-quit$/m);
    await typeLine(page, 'after-quit');
    await expectScreen(page, /^got:after-quit$/m);

    await goToWorkspacePage(page, known.workspace);
    await expectTabCount(page, 2);
    expect(await tabNames(page)).toEqual(['Terminal', 'Terminal']);
    await selectTab(page, 0);
    await expectScreen(page, /^sock=<daemon-1-.+\.sock> home=<ok> sid=<unset> ras=<unset>$/m);
    expect(await shellPid(page)).toBe(known.shells[0]);
    await selectTab(page, 1);
    await expectScreen(page, /^marker-two-42$/m);
    expect(await shellPid(page)).toBe(known.shells[1]);
    // One terminal per tab: no split came back.
    expect(await page.locator('.xterm:visible').count()).toBe(1);

    // The view starts at the pty's size: the rows it shows are the rows `stty size` reports.
    await typeLine(page, 'stty size');
    const screen = await expectScreen(page, /^\d+ \d+$/m);
    const rows = Number(/^(\d+) \d+$/m.exec(screen)![1]);
    expect(await page.locator('.xterm:visible .xterm-rows > div').count()).toBe(rows);
  });

  test('AC1 — an app on another data folder running at the same time shares the daemon: same pid, still one daemon process', async () => {
    const otherDir = makeDataDir();
    const other = await launchBuiltOn(env, otherDir, home);
    try {
      await other.page.getByText(versionLabel).waitFor();
      expect(daemonPid(home, build)).toBe(known.daemon);
      expect(daemonProcessesOf(build)).toEqual([known.daemon]);
      await quitApp(other);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('AC4, AC6 — a reload keeps every process and shows one tab per shell without the split; a closed tab ends its shell and is not shown again', async () => {
    const { page } = session!;
    await goToWorkspacePage(page, known.workspace);
    await selectTab(page, 0);
    await page.getByRole('tab').nth(0).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Split right', exact: true }).click();
    await page.locator('.xterm:visible').nth(1).waitFor();
    await page.locator('.xterm:visible').nth(2).waitFor({ state: 'detached' });
    // The pane that owns the split shell is the second visible terminal.
    const splitPid = await shellPid(page, 1);
    expect(splitPid).not.toBe(known.shells[0]);
    // The daemon will say when it ends: this connection attaches its terminal now.
    const watcher = await connectDaemon(must(daemonFile(home, 'sock', build), 'the daemon sock'));
    const split = await watchTerminalEnd(watcher, splitPid);

    await page.reload();
    await page.getByRole('tablist').first().waitFor();

    for (const pid of [...known.shells, splitPid, known.sessionPid]) expect(isAlive(pid), `process ${pid}`).toBe(true);
    await expectTabCount(page, 3);
    expect(await tabNames(page)).toEqual(['Terminal', 'Terminal', 'Terminal']);
    expect(await page.locator('.xterm:visible').count()).toBe(1);

    // Closing the last tab ends its shell; after a reload only two are left.
    await selectTab(page, 2);
    await page.getByRole('button', { name: 'Close Terminal', exact: true }).nth(2).click();
    try {
      await split.ended;
    } finally {
      watcher.close();
    }
    expect(isAlive(splitPid)).toBe(false);
    await page.reload();
    await page.getByRole('tablist').first().waitFor();
    await expectTabCount(page, 2);
    expect(await tabNames(page)).toEqual(['Terminal', 'Terminal']);
    expect(isAlive(known.shells[0]!) && isAlive(known.sessionPid)).toBe(true);
  });

  test('AC4 — closing the window and opening one again (activate) shows the running shells and session as before', async () => {
    expect(await destroyWindows(session!)).toEqual([]);
    for (const pid of [...known.shells, known.sessionPid]) expect(isAlive(pid)).toBe(true);

    const opened = untilWindows(session!, (urls) => urls.length === 1);
    await session!.evaluateInMain(`require('electron').app.emit('activate')`);
    expect(await opened).toHaveLength(1);
    const [reopened] = (await pagesOf(session!)).slice(-1);
    await reopened!.getByText(versionLabel).waitFor();
    await goToWorkspacePage(reopened!, known.workspace);
    await expectTabCount(reopened!, 2);
    expect(await shellPid(reopened!)).toBe(known.shells[0]);
    await expectDot(reopened!, known.session, 'Working');
  });

  test('COCKPIT-81 part 2 AC2 — a setup whose pid line is already on the screen when the test attaches still gives its pid (the attach serializes the screen: no newline after the last row)', async () => {
    repo = makeRepoWithSetup();
    const livePage = (await pagesOf(session!)).at(-1)!;
    const live = { ...session!, page: livePage } as Session;
    const socket = must(daemonFile(home, 'sock', build), 'the daemon sock');
    const early = await connectDaemon(socket);
    const late = await connectDaemon(socket);

    try {
      const id = await beginSetup(live, early, repo, 'setup-late');
      // The setup has printed its line once a first attach has seen it, so the next attach only gets the screen.
      const watched = await watchTerminal(early, id);
      const seen = await watched.find(/setup-pid-\d+/);
      const { screen } = await late.attach(id);

      expect(screen, 'the line is on the serialized screen').toContain(seen[0]);
      expect(screen, 'no newline follows the last row').not.toMatch(/setup-pid-\d+[^\r\n]*\r?\n/);
      const found = SETUP_PID.exec(screen);
      expect(found, 'the pattern the tests find a setup pid with matches the late screen').not.toBeNull();
      expect(Number(found![1])).toBeGreaterThan(0);

      // The setup ends with its page.
      await livePage.reload();
      await livePage.getByText(versionLabel).waitFor();
      await watched.exited;
    } finally {
      early.close();
      late.close();
    }
  });

  test('AC7, AC10 — a setup (commands terminal) ends when its page reloads, and is not shown again; when the app is killed with SIGKILL the daemon, the shells and the session still run once the daemon has dealt with its disconnection, and the setup is gone', async () => {
    repo = makeRepoWithSetup();
    const livePage = (await pagesOf(session!)).at(-1)!;
    const live = { ...session!, page: livePage } as Session;
    const daemon = await connectDaemon(must(daemonFile(home, 'sock', build), 'the daemon sock'));

    try {
      const first = await startSetup(live, daemon, repo, 'setup-reload');
      await livePage.reload();
      await livePage.getByText(versionLabel).waitFor();
      await first.exited;
      expect(hasEnded(first.pid), 'the setup ends with its page').toBe(true);
      await goToWorkspacePage(livePage, known.workspace);
      await expectTabCount(livePage, 2);
      expect(await tabNames(livePage)).toEqual(['Terminal', 'Terminal']);

      const second = await startSetup(live, daemon, repo, 'setup-kill');
      await killApp(session!);

      // The daemon ends the commands terminal when the app's connection closes: its `exit` message is the proof
      // that it handled the disconnection, and nothing else of the app's end is left to happen.
      await second.exited;
      expect(isAlive(known.daemon)).toBe(true);
      expect(hasEnded(second.pid), 'the daemon ends the commands terminal of the killed app').toBe(true);
      expect(aliveOf([known.daemon, known.sessionPid, ...known.shells])).toEqual([true, true, true, true]);
      expect(isAlive(foreign.pid!), 'the foreign sleep is no setup: still running').toBe(true);
    } finally {
      daemon.close();
    }
  });

  test('AC8 — an app of another build shows the session and the shell of the older daemon and takes their input; new terminals run in a daemon of its own; the older daemon exits and removes .sock, .token and .pid, not .log, once its last terminal ends', async () => {
    const newer = uniqueBuild();
    session = await launchBuiltOn({ ...env, COCKPIT_TEST_DAEMON_BUILD: newer }, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    await expectDot(page, known.session, 'Working');
    await page.locator(`aside a[href$="/sessions/${known.session}"]`).click();
    await expectScreen(page, /^marker-before-quit$/m);
    await typeLine(page, 'from-newer');
    await expectScreen(page, /^got:from-newer$/m);
    await goToWorkspacePage(page, known.workspace);
    await expectTabCount(page, 2);
    await selectTab(page, 1);
    await expectScreen(page, /^marker-two-42$/m);
    await typeLine(page, 'echo from-newer-$((6*7))');
    await expectScreen(page, /^from-newer-42$/m);

    // A new terminal runs in the new build's daemon.
    await newShellTab(page);
    const fresh = await shellPid(page);
    const newerPid = must(daemonPid(home, newer), 'the daemon pid');
    expect(newerPid).not.toBe(known.daemon);
    expect(execFileSync('ps', ['-p', String(fresh), '-o', 'ppid='], { encoding: 'utf8' }).trim()).toBe(String(newerPid));
    expect(isAlive(known.daemon)).toBe(true);
    expect(daemonFile(home, 'sock', build)).toBeDefined();

    // End the older daemon's session (the stub exits on `exit`) and its two shells.
    await page.locator(`aside a[href$="/sessions/${known.session}"]`).click();
    await typeLine(page, 'exit');
    await expectDot(page, known.session, 'Exited 3');
    await goToWorkspacePage(page, known.workspace);
    for (const index of [0, 1]) {
      await selectTab(page, index);
      await typeLine(page, 'exit');
    }

    await daemonEnded(known.daemon);
    expect([daemonFile(home, 'sock', build), daemonFile(home, 'token', build), daemonFile(home, 'pid', build)]).toEqual([undefined, undefined, undefined]);
    expect(daemonFile(home, 'log', build)).toBeDefined();
    expect(daemonFile(home, 'sock', newer)).toBeDefined();
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});

// --- Built app: the setup state and the agent's exit survive a relaunch (COCKPIT-57) ---------------

describe('daemon: built app, setup states and agent exits after a relaunch', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let session: Session | undefined;
  let repo: { parent: string; root: string } | undefined;

  beforeAll(() => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    env = fx.env({ COCKPIT_TEST_DAEMON_BUILD: uniqueBuild() });
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  // The label the workspace's own row shows (`Setting up`, `Setup failed`), null when it shows none. Self-contained: it runs in `untilRead`.
  const readLabel = ({ path }: { path: string; label?: string | null }) => {
    const item = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === path)?.closest('li');
    const leaf = [...(item?.querySelectorAll('*') ?? [])].find(
      (element) => element.children.length === 0 && !element.closest('a[href*="/sessions/"]') && /^(Setting up|Setup failed)$/.test((element.textContent ?? '').trim()),
    );
    return leaf ? (leaf.textContent ?? '').trim() : null;
  };
  const expectLabel = async (page: Page, path: string, label: string | null) =>
    expect(await untilRead(page, readLabel, (found, arg: { path: string; label: string | null }) => found === arg.label, { path, label }), `the label of ${path}`).toBe(label);

  test('AC6 — a workspace whose setup failed, then reported running again, and a session whose agent exited with code 3, show the same label and the same dot after the app quit and was launched again', async () => {
    repo = makeRepoWithSetup({ setup: ['exit 6'] });
    session = await launchBuiltOn(env, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    // A workspace and a session in it started as the composer does: `cockpit setup`, which fails.
    await stubPicker(session, repo.root);
    await page.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!());
    const created = await page.evaluate(([root, name]) => (window as unknown as ApiWindow).api.workspaces!.create!(root, name, 'main'), [repo.root, 'relaunch-ws'] as const);
    expect(created.status).toBe('created');
    const path = (created as { workspace: { path: string } }).workspace.path;
    const started = await page.evaluate(
      ([root, path]) =>
        (window as unknown as ApiWindow).api.sessions!.start!('claude-code', { cols: 80, rows: 24 }, { workspace: { project: root, path }, prompt: 'p', setup: true }),
      [repo.root, path] as const,
    );
    expect(started.status).toBe('started');
    await expectLabel(page, path, 'Setup failed');

    // The daemon is told the setup runs again (what `cockpit setup` typed in the shell reports).
    const socket = must(daemonFile(home, 'sock'), 'the daemon sock');
    expect(await postEvent(socket, tokenFor(socket), { sessionId: started.session.id, event: 'setup-running' })).toBe(204);
    await expectLabel(page, path, 'Setting up');

    // A plain session whose agent exits with code 3 while its shell goes on.
    const exiting = await startSession(page);
    expect(await postEvent(socket, tokenFor(socket), { sessionId: exiting, event: 'exited', exitCode: 3 })).toBe(204);
    await expectDot(page, exiting, 'Exited 3');

    await quitApp(session);
    session = await launchBuiltOn(env, dataDir, home);
    await session.page.getByText(versionLabel).waitFor();

    await expectLabel(session.page, path, 'Setting up');
    await expectDot(session.page, exiting, 'Exited 3');
    expect(await dotOf(session.page, started.session.id)).toBeNull();
  }, 90_000);
});

describe('daemon: an update with an idle daemon', () => {
  let dataDir: string;
  let home: string;
  let session: Session | undefined;

  beforeAll(() => {
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC8 — a daemon holding no terminal exits as soon as an app of another build connects', async () => {
    const [older, newer] = [uniqueBuild(), uniqueBuild()];
    const first = await launchBuiltOn({ ...process.env, SHELL: '/bin/sh', COCKPIT_TEST_DAEMON_BUILD: older }, dataDir, home);
    await first.page.getByText(versionLabel).waitFor();
    const olderPid = must(daemonPid(home, older), 'the daemon pid');
    expect(isAlive(olderPid)).toBe(true);
    await quitApp(first);

    session = await launchBuiltOn({ ...process.env, SHELL: '/bin/sh', COCKPIT_TEST_DAEMON_BUILD: newer }, dataDir, home);
    await session.page.getByText(versionLabel).waitFor();

    await daemonEnded(olderPid);
    expect(daemonFile(home, 'sock', older)).toBeUndefined();
    expect(daemonFile(home, 'sock', newer)).toBeDefined();
  });
});

// --- Built app: the daemon cannot start ---------------------------------------

describe('daemon: built app, the daemon cannot start', () => {
  let dataDir: string;
  const build = uniqueBuild();
  let session: Session | undefined;
  let repo: { parent: string; root: string } | undefined;

  beforeAll(() => {
    dataDir = makeDataDir();
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  const reasonOf = (output: string) => {
    const lines = output.split('\n').filter((line) => line.startsWith("Cockpit's background service could not start: "));
    expect(lines.length, 'one stderr line').toBe(1);
    return lines[0]!.slice("Cockpit's background service could not start: ".length);
  };
  const failureView = (page: Page) => page.getByText("Cockpit's background service could not start", { exact: true });
  const SUBTITLE = 'Terminals and agents run in this service. Your projects and workspaces are untouched.';

  test('AC10 — COCKPIT_HOME a regular file: the window opens; stderr names the path; a workspace page and a session page show the failure view; the Sessions section says so; spawn and sessions.start are refused with the reason; projects can still be added and removed', async () => {
    const fx = makeFixture();
    const home = join(dataDir, 'h');
    writeFileSync(home, 'a file, not a folder');
    repo = makeRepoWithSetup();
    // A session of an earlier launch, so its page can be opened while the daemon is down.
    const seeded = { id: randomUUID(), name: 'Claude Code 1', harness: 'claude-code', directory: join(fx.root, 'earlier'), createdAt: new Date().toISOString() };
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, sessions: [seeded] }));
    try {
      session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: build }), dataDir, home);
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      const reason = reasonOf(session.output());
      expect(reason).toContain(home);

      // The failure view: title, subtitle, the reason in monospace and "Try again", on a workspace page and on a session page.
      const expectFailureView = async () => {
        await failureView(page).waitFor();
        await page.getByText(SUBTITLE, { exact: true }).waitFor();
        await page.locator('code, pre, [class*="mono"]').filter({ hasText: reason }).first().waitFor();
        await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
        expect(await page.getByRole('button', { name: 'Show log', exact: true }).count(), 'no log file exists').toBe(0);
      };
      // Projects can be added though the daemon is down (worktrees need the home folder: this one is made with git).
      await stubPicker(session, repo.root);
      expect((await page.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!())).status).toBe('added');
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).projects.map((p: { path: string }) => p.path)).toEqual([repo.root]);
      const worktree = join(fx.root, 'wt-view');
      addWorktree(repo.root, 'view', worktree);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.getByTitle(worktree, { exact: true }).first().click();
      await expectFailureView();
      expect(await page.locator('[role="tablist"]').count(), 'the view replaces the panes').toBe(0);
      await page.locator('aside').getByRole('link', { name: seeded.name }).click();
      await page.waitForURL(new RegExp(`/sessions/${seeded.id}$`));
      await page.getByRole('heading', { name: seeded.name }).waitFor();
      await expectFailureView();
      expect(await page.getByText('This session has ended.').count(), 'the failure view replaces the ended page').toBe(0);

      await page.locator('aside').getByText(`Cockpit's background service could not start: ${reason}`, { exact: true }).waitFor();

      const spawned = await page.evaluate(() => (window as unknown as ApiWindow).api.pty!.spawn!({ cols: 80, rows: 24 }).then(() => 'spawned', (error: Error) => error.message));
      expect(spawned).toContain(reason);
      const started = await page.evaluate(() => (window as unknown as ApiWindow).api.sessions!.start!('claude-code', { cols: 80, rows: 24 }, {}));
      expect(started.status).toBe('refused');
      expect(started.message).toContain(reason);
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).sessions, 'only the seeded session').toEqual([seeded]);

      // Projects can still be removed.
      await page.evaluate((root) => (window as unknown as ApiWindow).api.projects!.remove!(root), repo.root);
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).projects ?? []).toEqual([]);
      expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('AC10, AC11 — daemon-1-<build>.sock a folder: the view stays with the new reason while the cause remains, "Show log" opens the log with shell.openPath, and "Try again" after removing the cause starts the daemon and a terminal runs a command', async () => {
    await session!.close();
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir);
    const fx = makeFixture();
    const home = join(dataDir, 'h');
    const socket = join(home, `daemon-1-${build}.sock`);
    mkdirSync(socket, { recursive: true });
    try {
      session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: build }), dataDir, home);
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      const reason = reasonOf(session.output());
      expect(reason).toContain(socket);
      // The home folder exists, so a workspace can be made: its page shows the failure view.
      repo ??= makeRepoWithSetup();
      const root = repo.root;
      const view = await makeWorkspace(session, 'view-ws', root);
      await page.getByTitle(view.path, { exact: true }).first().click();
      await failureView(page).waitFor();

      // "Show log": the log file exists, shell.openPath receives it.
      await session.evaluateInMain(`(() => { globalThis.__opened = []; require('electron').shell.openPath = async (path) => { globalThis.__opened.push(path); globalThis.__onOpened?.(); return ''; }; })()`);
      await page.getByRole('button', { name: 'Show log', exact: true }).click();
      expect(await session.evaluateInMain<string[]>(`new Promise((resolve) => { globalThis.__onOpened = () => resolve(globalThis.__opened); if (globalThis.__opened.length > 0) resolve(globalThis.__opened); })`)).toEqual([join(home, `daemon-1-${build}.log`)]);

      // Projects and workspaces are untouched: the home folder exists, so a worktree can be made and deleted.
      const created = await page.evaluate((root) => (window as unknown as ApiWindow).api.workspaces!.create!(root, 'still-works', 'main'), root);
      expect(created.status).toBe('created');
      // The worktree is made when `create` answers: the list shows it at once.
      const worktree = await page.evaluate(
        async (root) =>
          ((await (window as unknown as ApiWindow).api.projects!.list!()) as Array<{ path: string; workspaces: Array<{ path: string; name: string }> }>)
            .find((project) => project.path === root)
            ?.workspaces.find((workspace) => workspace.name === 'still-works')?.path,
        root,
      );
      expect(worktree, 'the workspace is listed').toBeDefined();
      expect(existsSync(worktree!)).toBe(true);
      const removed = await page.evaluate(([root, path]) => (window as unknown as ApiWindow).api.workspaces!.remove!(root, path, {}), [root, worktree!] as const);
      expect(removed.status).toBe('removed');
      expect(existsSync(worktree!)).toBe(false);

      // The cause remains: the view stays.
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await failureView(page).waitFor();
      expect(daemonProcessesOf(build)).toEqual([]);

      // The cause is removed.
      rmSync(socket, { recursive: true, force: true });
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await failureView(page).waitFor({ state: 'detached' });
      expect(await page.locator('aside').getByText("Cockpit's background service could not start", { exact: false }).count()).toBe(0);
      await newShellTab(page);
      await typeLine(page, 'echo cockpit-$((6*7))');
      await expectScreen(page, /^cockpit-42$/m);
      expect(isAlive(must(daemonPid(home, build), 'the daemon pid'))).toBe(true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// --- Built app: a daemon that does not answer ---------------------------------

describe('daemon: built app, a daemon that does not answer', () => {
  let dataDir: string;
  let home: string;
  let session: Session | undefined;

  beforeAll(() => {
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    // A stopped daemon is resumed, then killed.
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
  });

  const failureView = (page: Page) => page.getByText("Cockpit's background service could not start", { exact: true });
  const baseEnv = (build: string) => ({ ...process.env, SHELL: '/bin/sh', COCKPIT_TEST_DAEMON_BUILD: build });

  test('AC18 — the daemon of the app\'s build is stopped (SIGSTOP): the window opens and, within 10 s, the failure state shows "did not answer within 5 s: <socket>" (view, sidebar line, stderr line, refusals); after SIGCONT "Try again" connects and a terminal runs a command', async () => {
    const build = uniqueBuild();
    const first = await launchBuiltOn(baseEnv(build), dataDir, home);
    await first.page.getByText(versionLabel).waitFor();
    const pid = must(daemonPid(home, build), 'the daemon pid');
    const workspace = await makeWorkspace(first, 'stopped-ws');
    await quitApp(first);
    process.kill(pid, 'SIGSTOP');

    session = await launchBuiltOn(baseEnv(build), dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    const socket = join(home, `daemon-1-${build}.sock`);
    const reason = `Cockpit's background service did not answer within 5 s: ${socket}`;

    // The criterion's bound: the failure state shows within 10 s of the window opening.
    const within = startClock();
    await page.getByTitle(workspace.path, { exact: true }).first().click();
    await failureView(page).waitFor();
    within('the failure state shows', 10_000);
    await page.locator('code, pre, [class*="mono"]').filter({ hasText: reason }).first().waitFor();
    await page.locator('aside').getByText(`Cockpit's background service could not start: ${reason}`, { exact: true }).waitFor();
    expect(session.output()).toContain(`Cockpit's background service could not start: ${reason}`);
    const spawned = await page.evaluate(() => (window as unknown as ApiWindow).api.pty!.spawn!({ cols: 80, rows: 24 }).then(() => 'spawned', (error: Error) => error.message));
    expect(spawned).toContain(reason);
    const started = await page.evaluate(() => (window as unknown as ApiWindow).api.sessions!.start!('claude-code', { cols: 80, rows: 24 }, {}));
    expect(started.status).toBe('refused');

    process.kill(pid, 'SIGCONT');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await failureView(page).waitFor({ state: 'detached' });
    await newShellTab(page);
    await typeLine(page, 'echo cockpit-$((6*7))');
    await expectScreen(page, /^cockpit-42$/m);
    expect(isAlive(pid), 'the same daemon').toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  }, 90_000);

  test('AC18 — a daemon of another build that does not answer is skipped, noted on stderr, and the app\'s own daemon works', async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir);
    const [older, newer] = [uniqueBuild(), uniqueBuild()];
    const first = await launchBuiltOn(baseEnv(older), dataDir, home);
    await first.page.getByText(versionLabel).waitFor();
    const pid = must(daemonPid(home, older), 'the older daemon pid');
    const workspace = await makeWorkspace(first, 'older-ws');
    await quitApp(first);
    process.kill(pid, 'SIGSTOP');

    session = await launchBuiltOn(baseEnv(newer), dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    await goToWorkspacePage(page, workspace.path);
    await page.getByRole('button', { name: 'New tab', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
    await typeLine(page, 'echo cockpit-$((6*7))');
    await expectScreen(page, /^cockpit-42$/m);

    expect(await page.getByText("Cockpit's background service could not start").count(), 'no failure state').toBe(0);
    const olderSocket = join(home, `daemon-1-${older}.sock`);
    // The app notes on stderr that it skipped the older daemon: it says so once its connection attempt gave up.
    await session.outputMatch(new RegExp(`did not answer[^\\n]*${escapeRegExp(olderSocket)}`));
    expect(daemonPid(home, newer), 'the app\'s own daemon').toBeDefined();
    expect(isAlive(pid)).toBe(true);
  }, 90_000);
});

// --- Built app: IPC from another origin ----------------------------------------

describe('daemon: built app, requests from another origin', () => {
  let dataDir: string;
  let session: Session | undefined;

  beforeAll(() => {
    dataDir = makeDataDir();
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(join(dataDir, 'h'));
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC22 — pty.list, pty.attach (of an existing terminal), daemon.status, daemon.retry and daemon.showLog reject from another origin: no daemon is started or contacted, shell.openPath is not called and the terminal\'s owner is unchanged', async () => {
    const build = uniqueBuild();
    const home = join(dataDir, 'h');
    // The daemon cannot start (its socket path is a folder), so its log exists and a retry would start it once the cause is gone.
    const socket = join(home, `daemon-1-${build}.sock`);
    mkdirSync(socket, { recursive: true });
    session = await launchBuiltOn({ ...process.env, SHELL: '/bin/sh', COCKPIT_TEST_DAEMON_BUILD: build }, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    // The app notes the failure on stderr after its attempt to start the daemon, which opened the log.
    await session.outputMatch(/Cockpit's background service could not start: /);
    expect(existsSync(join(home, `daemon-1-${build}.log`))).toBe(true);
    await session.evaluateInMain(`(() => { globalThis.__opened = []; require('electron').shell.openPath = async (path) => { globalThis.__opened.push(path); globalThis.__onOpened?.(); return ''; }; })()`);
    // The app's own page may ask: the handlers are there.
    expect(await page.evaluate(() => (window as unknown as ApiWindow).api.daemon!.status!().then(() => 'answered'))).toBe('answered');
    // The cause is gone: a retry that got through would start the daemon.
    rmSync(socket, { recursive: true, force: true });
    const outputBefore = session.output();

    const results = await session.evaluateInMain<Record<string, string>>(`(async () => {
      const handlers = require('electron').ipcMain._invokeHandlers;
      const calls = { 'pty:list': [], 'daemon:status': [], 'daemon:retry': [], 'daemon:show-log': [] };
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

    expect(results).toEqual({ 'pty:list': 'rejected', 'daemon:status': 'rejected', 'daemon:retry': 'rejected', 'daemon:show-log': 'rejected' });
    expect(await session.evaluateInMain<string[]>('globalThis.__opened'), 'shell.openPath is not called').toEqual([]);
    expect(daemonProcessesOf(build), 'no daemon is started').toEqual([]);
    expect(daemonFile(home, 'sock', build)).toBeUndefined();
    expect(daemonFile(home, 'pid', build)).toBeUndefined();
    expect(session.output().slice(outputBefore.length)).not.toMatch(MAIN_PROCESS_ERROR);

    // The app's own "Try again" does start it (on the page of a workspace, made now that the cause is gone).
    const workspace = await makeWorkspace(session, 'origin-ws');
    await page.getByTitle(workspace.path, { exact: true }).first().click();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    // The panes show once the daemon answers, and its files are written before it can.
    await page.getByRole('tablist').first().waitFor();
    expect(daemonPid(home, build)).toBeDefined();
    expect(daemonProcessesOf(build)).toHaveLength(1);

    // A terminal that exists: the app's page spawns a shell and listens to its output.
    type PtyWindow = { __ptyData: Record<number, string>; __ptyChecks: Array<() => void> };
    const id = await page.evaluate(async () => {
      const api = (window as unknown as { api: { pty: { spawn(o: { cols: number; rows: number }): Promise<number>; onData(l: (id: number, data: string) => void): () => void } } }).api;
      const w = window as unknown as PtyWindow;
      w.__ptyData = {};
      w.__ptyChecks = [];
      api.pty.onData((terminalId, data) => {
        w.__ptyData[terminalId] = (w.__ptyData[terminalId] ?? '') + data;
        for (const check of w.__ptyChecks.slice()) check();
      });
      return api.pty.spawn({ cols: 80, rows: 24 });
    });
    // Resolves with what the terminal has printed once it holds `text`, checked at once and on each chunk.
    const heard = (text: string) =>
      page.evaluate(
        ([id, text]) =>
          new Promise<string>((resolve) => {
            const w = window as unknown as PtyWindow;
            const check = () => {
              const data = w.__ptyData[id as number] ?? '';
              if (!data.includes(text as string)) return;
              w.__ptyChecks.splice(w.__ptyChecks.indexOf(check), 1);
              resolve(data);
            };
            w.__ptyChecks.push(check);
            check();
          }),
        [id, text] as const,
      );
    const type = (text: string) => page.evaluate(([id, text]) => (window as unknown as ApiWindow).api.pty!.write!(id, text), [id, text] as const);
    await type('echo before-$((6*7))\n');
    await heard('before-42');

    // Another origin attaches that id: it is refused, and the owner (the app's page) is unchanged.
    const attached = await session.evaluateInMain<string>(`(async () => {
      const handler = require('electron').ipcMain._invokeHandlers.get('pty:attach');
      try {
        await handler({ senderFrame: { url: 'https://example.com/' }, sender: null }, ${id});
        return 'resolved';
      } catch (error) {
        return 'rejected: ' + error.message;
      }
    })()`);
    expect(attached, 'pty:attach from another origin').toBe('rejected: pty:attach refused: unexpected origin');
    await type('echo after-$((6*7))\n');
    expect(await heard('after-42'), 'the terminal still reaches the app\'s page').toContain('after-42');
  });
});

// --- Built app: a notification with no window ----------------------------------

describe('daemon: built app, notification with no window', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let session: Session | undefined;

  beforeAll(async () => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: uniqueBuild() }), dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  });

  test('AC13 — with no window open a "waiting" report shows a notification, and clicking it opens a window on the session\'s page', async () => {
    const { page } = session!;
    const id = await startSession(page);
    await session!.evaluateInMain(`(() => {
      const { Notification, BrowserWindow } = require('electron');
      globalThis.__notified = [];
      globalThis.__onShown = [];
      Notification.prototype.show = function () {
        globalThis.__notified.push(this);
        for (const listener of globalThis.__onShown.splice(0)) listener();
      };
      BrowserWindow.getFocusedWindow = () => null;
    })()`);
    expect(await destroyWindows(session!)).toEqual([]);

    const socket = must(daemonFile(home, 'sock'), 'the daemon sock');
    expect(await postEvent(socket, tokenFor(socket), { sessionId: id, event: 'waiting' })).toBe(204);
    await notificationShown(session!);
    expect(await session!.evaluateInMain<string>('globalThis.__notified.at(-1).body')).toBe('Needs input');

    const opened = untilWindows(session!, (urls, wanted: string) => urls.length === 1 && urls[0]!.endsWith(wanted), `/sessions/${id}`);
    await session!.evaluateInMain(`globalThis.__notified.at(-1).emit('click')`);
    expect(await opened).toHaveLength(1);
  });

  test('AC24 — with no window open, clicking the notification of a workspace session opens a window on that workspace\'s page with the session\'s tab selected', async () => {
    // The window the previous test's click opened is the only page left; the first one was destroyed.
    const open = (await pagesOf(session!)).find((page) => page.url().startsWith('app://'));
    expect(open, 'a window is open').toBeDefined();
    const root = makeRepoWithSetup({}).root;
    await stubPicker(session!, root);
    await open!.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!());
    const created = await open!.evaluate(([root, name]) => (window as unknown as ApiWindow).api.workspaces!.create!(root, name, 'main'), [root, 'nowin-ws'] as const);
    expect(created.status).toBe('created');
    const path = (created as { workspace: { path: string } }).workspace.path;
    // An earlier terminal in the workspace (a shell), so that the tab a fresh window selects by itself
    // (the first) is not the notified session's.
    await open!.evaluate((path) => (window as unknown as ApiWindow).api.pty!.spawn!({ cols: 80, rows: 24, workspace: path }), path);
    const started = await open!.evaluate(
      ([root, path]) => (window as unknown as ApiWindow).api.sessions!.start!('claude-code', { cols: 80, rows: 24 }, { workspace: { project: root, path } }),
      [root, path] as const,
    );
    expect(started.status).toBe('started');
    const id = started.session.id as string;

    await session!.evaluateInMain(`globalThis.__notified.length = 0`);
    expect(await destroyWindows(session!)).toEqual([]);

    const socket = must(daemonFile(home, 'sock'), 'the daemon sock');
    expect(await postEvent(socket, tokenFor(socket), { sessionId: id, event: 'waiting' })).toBe(204);
    await notificationShown(session!);
    expect(await session!.evaluateInMain<string>('globalThis.__notified.at(-1).title')).toBe('Claude Code 1');

    const landed = (url: string) => {
      if (!url.startsWith('app://')) return false;
      const parsed = new URL(url);
      return parsed.pathname === '/workspace' && parsed.searchParams.get('path') === path;
    };
    // Self-contained: it runs in the main process.
    const onWorkspace = (urls: string[], wanted: string) => {
      if (urls.length !== 1 || !urls[0]!.startsWith('app://')) return false;
      const parsed = new URL(urls[0]!);
      return parsed.pathname === '/workspace' && parsed.searchParams.get('path') === wanted;
    };
    const opened = untilWindows(session!, onWorkspace, path);
    await session!.evaluateInMain(`globalThis.__notified.at(-1).emit('click')`);
    const urls = await opened;
    expect(urls).toHaveLength(1);
    expect(landed(urls[0]!), `the window is on the workspace page: ${urls[0]}`).toBe(true);

    const page = (await pagesOf(session!)).find((candidate) => landed(candidate.url()))!;
    expect(page, 'the new window\'s page').toBeDefined();
    const tabs = page.locator('[role="tab"]');
    await tabs.nth(1).waitFor();
    await tabs.nth(2).waitFor({ state: 'detached' });
    // The shell comes first, the notified session second; the session's tab is the selected one.
    expect((await tabs.last().textContent())?.trim()).toBe('Claude Code 1');
    await page.locator('[role="tab"][aria-selected="true"]', { hasText: 'Claude Code 1' }).waitFor();
    expect(await tabs.first().getAttribute('aria-selected'), 'the shell\'s tab is not selected').toBe('false');
  });
});

// --- Packaged app and dev server: one smoke path each ---------------------------

describe('daemon: packaged app smoke path', () => {
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

function packagedExecutable(): string {
  const releaseDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  return join(import.meta.dirname, '..', 'release', releaseDir, 'Cockpit.app', 'Contents/MacOS/Cockpit');
}

describe('daemon: dev server smoke path', () => {
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
