import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  MAIN_PROCESS_ERROR,
  UI_TIMEOUT,
  isAlive,
  killDaemonsIn,
  launchDev,
  launchSpawned,
  poll,
  signalGroup,
  versionLabel,
  waitForGroupGone,
  type Session,
} from './launch';
import { makeTestDir } from './run-root';

// COCKPIT-55: terminals and sessions live in a daemon that outlives the app. The built app runs the
// full block (a launch per scenario, the app quit or killed and launched again on the same folders,
// builds played through COCKPIT_TEST_DAEMON_BUILD); the packaged app and the dev server run one
// smoke path each. A fake login shell puts a stub `claude` on the PATH, so no real CLI runs, and
// hands the `/terminal` page a real /bin/sh.

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
  // `require` only exists during the evaluation: `app` is taken before the timer.
  await session.evaluateInMain(`(() => { const { app } = require('electron'); setTimeout(() => app.quit(), 300); })()`);
  await session.disconnectInspector();
  expect(await poll(() => session.isRunning(), (running) => !running, 10_000), 'the app exits').toBe(false);
  await waitForGroupGone(session.pid);
}

// SIGKILL to the app's whole process group.
async function killApp(session: Session): Promise<void> {
  await session.disconnectInspector();
  signalGroup(session.pid, 'SIGKILL');
  await waitForGroupGone(session.pid);
}

const stillAlive = async (pids: number[], ms = 5_000) => {
  await sleep(ms);
  return pids.map(isAlive);
};

// --- The page ----------------------------------------------------------------

// The text of the terminals the page shows (the ones of other tabs are `invisible`).
const screenText = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.xterm')]
      .filter((element) => (element as HTMLElement).offsetParent !== null && getComputedStyle(element).visibility !== 'hidden')
      .map((element) => [...element.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/ /g, ' ').trimEnd()).join('\n'))
      .join('\n'),
  );

async function expectScreen(page: Page, pattern: RegExp, timeout = 15_000) {
  const text = await poll(() => screenText(page), (screen) => pattern.test(screen), timeout);
  expect(text).toMatch(pattern);
  return text;
}

// `nth` picks one of the visible terminals (a split tab shows several); the first by default.
async function typeLine(page: Page, text: string, nth = 0) {
  const terminal = page.locator('.xterm:visible').nth(nth);
  await terminal.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  await terminal.click({ timeout: UI_TIMEOUT });
  await page.locator('.xterm:visible .xterm-helper-textarea').nth(nth).focus({ timeout: UI_TIMEOUT });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

const goToTerminalPage = async (page: Page) => {
  await page.getByRole('link', { name: 'Terminal', exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
};

const tabNames = (page: Page) => page.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => (tab.textContent ?? '').trim()));

const selectTab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click({ timeout: UI_TIMEOUT });

// The pid a shell prints (`echo pid-$$`), typed in the terminal that is shown.
async function shellPid(page: Page, nth = 0): Promise<number> {
  const marker = Math.random().toString(36).slice(2, 6);
  await typeLine(page, `echo pid${marker}-$$`, nth);
  const screen = await expectScreen(page, new RegExp(`^pid${marker}-\\d+$`, 'm'));
  return Number(new RegExp(`^pid${marker}-(\\d+)$`, 'm').exec(screen)![1]);
}

async function startSession(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Start session', exact: true }).click({ timeout: UI_TIMEOUT });
  await page.getByRole('menuitem', { name: 'Claude Code', exact: true }).click({ timeout: UI_TIMEOUT });
  const id = await poll(() => /^\/sessions\/([^/]+)$/.exec(new URL(page.url()).pathname)?.[1], Boolean, UI_TIMEOUT);
  expect(id).toBeTruthy();
  await expectScreen(page, /^ready$/m);
  return id!;
}

// The row of a session in the sidebar: whether it shows a dot, and the dot's accessible name.
const dotOf = (page: Page, id: string) =>
  page.evaluate((id) => {
    const dot = document.querySelector(`aside a[href$="/sessions/${id}"]`)?.closest('li')?.querySelector('[role="img"][aria-label]');
    return dot ? dot.getAttribute('aria-label') : null;
  }, id);

const expectDot = async (page: Page, id: string, label: string | null, timeout = UI_TIMEOUT) =>
  expect(await poll(() => dotOf(page, id), (found) => found === label, timeout), `the dot of session ${id}`).toBe(label);

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
async function pagesOf(session: Session): Promise<Page[]> {
  const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(session.output())![1];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return browser.contexts().flatMap((context) => context.pages());
}

const windowUrls = (session: Session) =>
  session.evaluateInMain<string[]>(`require('electron').BrowserWindow.getAllWindows().map((window) => window.webContents.getURL())`);

// A git repository with a teardown command that stays running, for the `commands` terminals (COCKPIT-57:
// only the teardown runs as one; the setup is `cockpit setup`, in the session's own terminal), or with
// the given `.cockpit/config.json`.
function makeRepoWithSetup(config: unknown = { teardown: ['echo setup-running; exec sleep 300'] }): { parent: string; root: string } {
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

const stubPicker = (session: Session, pick: string) =>
  session.evaluateInMain(`(() => { require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(pick)}] }); })()`);

type ApiWindow = { api: Record<string, Record<string, (...args: unknown[]) => Promise<any>>> };

// Adds the repository, creates a workspace and starts its setup (a `commands` terminal) through
// `window.api`; resolves with the pid of the setup's `sleep`.
async function startSetup(session: Session, repo: { root: string }, name: string): Promise<number> {
  const { page } = session;
  await stubPicker(session, repo.root);
  await page.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!());
  const created = await page.evaluate(([root, name]) => (window as unknown as ApiWindow).api.workspaces!.create!(root, name, 'main'), [repo.root, name] as const);
  expect(created.status).toBe('created');
  const path = await poll(
    () =>
      page.evaluate(
        async ([root, name]) =>
          ((await (window as unknown as ApiWindow).api.projects!.list!()) as Array<{ path: string; workspaces: Array<{ path: string; name: string }> }>)
            .find((project) => project.path === root)
            ?.workspaces.find((workspace) => workspace.name === name)?.path,
        [repo.root, name] as const,
      ),
    Boolean,
    UI_TIMEOUT,
  );
  const started = await page.evaluate(([root, path]) => (window as unknown as ApiWindow).api.workspaces!.runCommands!(root, path, 'teardown', { cols: 80, rows: 24 }), [repo.root, path!] as const);
  expect(started.status).toBe('started');
  const sleeper = await poll(
    () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').find((line) => line.trim().endsWith('sleep 300')),
    Boolean,
    UI_TIMEOUT,
  );
  expect(sleeper, 'the setup is running').toBeTruthy();
  return Number(sleeper!.trim().split(/\s+/)[0]);
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
  const known = { daemon: 0, session: '', sessionPid: 0, shells: [] as number[] };

  beforeAll(() => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    build = uniqueBuild();
    env = fx.env({ COCKPIT_TEST_DAEMON_BUILD: build });
  });

  afterAll(async () => {
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

  test('AC13 — a shell of /terminal gets COCKPIT_SOCKET (the daemon\'s .sock) and no session id; a session gets its own id and the socket; no pty environment holds ELECTRON_RUN_AS_NODE; the hook reaches the daemon (dot) and an unknown id gets 404', async () => {
    const { page } = session!;
    await goToTerminalPage(page);
    // The socket is long: its name and whether it sits in COCKPIT_HOME are printed, not the whole path.
    await typeLine(
      page,
      `printf 'sock=<%s> home=<%s> sid=<%s> ras=<%s>\\n' "$(basename "$COCKPIT_SOCKET")" "$([ "$(dirname "$COCKPIT_SOCKET")" = '${home}' ] && echo ok)" "\${COCKPIT_SESSION_ID-unset}" "\${ELECTRON_RUN_AS_NODE-unset}"`,
    );
    const socket = must(daemonFile(home, 'sock', build), 'the daemon sock');
    await expectScreen(page, new RegExp(`^sock=<daemon-1-${build}\\.sock> home=<ok> sid=<unset> ras=<unset>$`, 'm'));
    known.shells.push(await shellPid(page));

    // A second tab, a second shell.
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click({ timeout: UI_TIMEOUT });
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

  test('AC2 — when the app quits (app.quit()) the daemon, the session and the two shells are still alive 5 s later', async () => {
    await quitApp(session!);

    const alive = await stillAlive([known.daemon, known.sessionPid, ...known.shells]);
    expect(alive).toEqual([true, true, true, true]);
  });

  test('AC1, AC3, AC5 — the app launched again reuses the daemon (same pid, no second one); the session shows no "Ended" dot and its last status, its page shows the marker and takes a line; /terminal shows one tab per shell in creation order, each with its marker and running a new command', async () => {
    session = await launchBuiltOn(env, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    expect(daemonPid(home, build)).toBe(known.daemon);
    expect(daemonProcessesOf(build)).toEqual([known.daemon]);

    await expectDot(page, known.session, 'Working');
    await page.locator(`aside a[href$="/sessions/${known.session}"]`).click({ timeout: UI_TIMEOUT });
    await expectScreen(page, /^marker-before-quit$/m);
    await typeLine(page, 'after-quit');
    await expectScreen(page, /^got:after-quit$/m);

    await goToTerminalPage(page);
    await poll(() => tabNames(page), (names) => names.length === 2, UI_TIMEOUT);
    expect(await tabNames(page)).toEqual(['Terminal 1', 'Terminal 2']);
    await selectTab(page, 'Terminal 1');
    await expectScreen(page, /^sock=<daemon-1-.+\.sock> home=<ok> sid=<unset> ras=<unset>$/m);
    expect(await shellPid(page)).toBe(known.shells[0]);
    await selectTab(page, 'Terminal 2');
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
    await goToTerminalPage(page);
    await selectTab(page, 'Terminal 1');
    await page.locator('.xterm:visible').first().hover({ timeout: UI_TIMEOUT });
    await page.locator('button[aria-label="Split right"]:visible').first().click({ force: true, timeout: UI_TIMEOUT });
    await poll(() => page.locator('.xterm:visible').count(), (count) => count === 2, UI_TIMEOUT);
    // The pane that owns the split shell is the second visible terminal.
    const splitPid = await shellPid(page, 1);
    expect(splitPid).not.toBe(known.shells[0]);

    await page.reload();
    await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });

    for (const pid of [...known.shells, splitPid, known.sessionPid]) expect(isAlive(pid), `process ${pid}`).toBe(true);
    await poll(() => tabNames(page), (names) => names.length === 3, UI_TIMEOUT);
    expect(await tabNames(page)).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3']);
    expect(await page.locator('.xterm:visible').count()).toBe(1);

    // Closing the last tab ends its shell; after a reload only two are left.
    await page.getByRole('button', { name: 'Close Terminal 3', exact: true }).click({ timeout: UI_TIMEOUT });
    await poll(() => isAlive(splitPid), (alive) => !alive, 5_000);
    expect(isAlive(splitPid)).toBe(false);
    await page.reload();
    await page.getByRole('heading', { name: 'Terminal' }).waitFor({ timeout: UI_TIMEOUT });
    await poll(() => tabNames(page), (names) => names.length === 2, UI_TIMEOUT);
    expect(await tabNames(page)).toEqual(['Terminal 1', 'Terminal 2']);
    expect(isAlive(known.shells[0]!) && isAlive(known.sessionPid)).toBe(true);
  });

  test('AC4 — closing the window and opening one again (activate) shows the running shells and session as before', async () => {
    await session!.evaluateInMain(`(() => {
      for (const window of require('electron').BrowserWindow.getAllWindows()) window.destroy();
    })()`);
    await poll(() => windowUrls(session!), (urls) => urls.length === 0, UI_TIMEOUT);
    for (const pid of [...known.shells, known.sessionPid]) expect(isAlive(pid)).toBe(true);

    await session!.evaluateInMain(`require('electron').app.emit('activate')`);
    await poll(() => windowUrls(session!), (urls) => urls.length === 1, UI_TIMEOUT);
    const [reopened] = (await poll(() => pagesOf(session!), (pages) => pages.length > 0, UI_TIMEOUT)).slice(-1);
    await reopened!.getByText(versionLabel).waitFor({ timeout: UI_TIMEOUT });
    await goToTerminalPage(reopened!);
    await poll(() => tabNames(reopened!), (names) => names.length === 2, UI_TIMEOUT);
    expect(await shellPid(reopened!)).toBe(known.shells[0]);
    await expectDot(reopened!, known.session, 'Working');
  });

  test('AC7 — a setup (commands terminal) ends when its page reloads, and is not shown again; when the app is killed with SIGKILL the daemon, the shells and the session still run 5 s later and the setup is gone', async () => {
    repo = makeRepoWithSetup();
    const livePage = (await pagesOf(session!)).at(-1)!;
    const live = { ...session!, page: livePage } as Session;

    const first = await startSetup(live, repo, 'setup-reload');
    await livePage.reload();
    await livePage.getByText(versionLabel).waitFor({ timeout: UI_TIMEOUT });
    await poll(() => isAlive(first), (alive) => !alive, 5_000);
    expect(isAlive(first), 'the setup ends with its page').toBe(false);
    await goToTerminalPage(livePage);
    await poll(() => tabNames(livePage), (names) => names.length === 2, UI_TIMEOUT);
    expect(await tabNames(livePage)).toEqual(['Terminal 1', 'Terminal 2']);

    const second = await startSetup(live, repo, 'setup-kill');
    await killApp(session!);

    expect(isAlive(known.daemon)).toBe(true);
    await poll(() => isAlive(second), (alive) => !alive, 5_000);
    expect(isAlive(second), 'the daemon ends the commands terminal of the killed app').toBe(false);
    expect(await stillAlive([known.daemon, known.sessionPid, ...known.shells])).toEqual([true, true, true, true]);
  });

  test('AC8 — an app of another build shows the session and the shell of the older daemon and takes their input; new terminals run in a daemon of its own; the older daemon exits and removes .sock, .token and .pid, not .log, once its last terminal ends', async () => {
    const newer = uniqueBuild();
    session = await launchBuiltOn({ ...env, COCKPIT_TEST_DAEMON_BUILD: newer }, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    await expectDot(page, known.session, 'Working');
    await page.locator(`aside a[href$="/sessions/${known.session}"]`).click({ timeout: UI_TIMEOUT });
    await expectScreen(page, /^marker-before-quit$/m);
    await typeLine(page, 'from-newer');
    await expectScreen(page, /^got:from-newer$/m);
    await goToTerminalPage(page);
    await poll(() => tabNames(page), (names) => names.length === 2, UI_TIMEOUT);
    await selectTab(page, 'Terminal 2');
    await expectScreen(page, /^marker-two-42$/m);
    await typeLine(page, 'echo from-newer-$((6*7))');
    await expectScreen(page, /^from-newer-42$/m);

    // A new terminal runs in the new build's daemon.
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click({ timeout: UI_TIMEOUT });
    const fresh = await shellPid(page);
    const newerPid = must(daemonPid(home, newer), 'the daemon pid');
    expect(newerPid).not.toBe(known.daemon);
    expect(execFileSync('ps', ['-p', String(fresh), '-o', 'ppid='], { encoding: 'utf8' }).trim()).toBe(String(newerPid));
    expect(isAlive(known.daemon)).toBe(true);
    expect(daemonFile(home, 'sock', build)).toBeDefined();

    // End the older daemon's session (the stub exits on `exit`) and its two shells.
    await page.locator(`aside a[href$="/sessions/${known.session}"]`).click({ timeout: UI_TIMEOUT });
    await typeLine(page, 'exit');
    await expectDot(page, known.session, 'Exited 3');
    await goToTerminalPage(page);
    for (const name of ['Terminal 1', 'Terminal 2']) {
      await selectTab(page, name);
      await typeLine(page, 'exit');
    }

    await poll(() => isAlive(known.daemon), (alive) => !alive, 10_000);
    expect(isAlive(known.daemon), 'the older daemon exits with its last terminal').toBe(false);
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

  // The label the workspace's own row shows (`Setting up`, `Setup failed`), null when it shows none.
  const labelOf = (page: Page, path: string) =>
    page.evaluate((path) => {
      const item = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === path)?.closest('li');
      const leaf = [...(item?.querySelectorAll('*') ?? [])].find(
        (element) => element.children.length === 0 && !element.closest('a[href*="/sessions/"]') && /^(Setting up|Setup failed)$/.test((element.textContent ?? '').trim()),
      );
      return leaf ? (leaf.textContent ?? '').trim() : null;
    }, path);
  const expectLabel = async (page: Page, path: string, label: string | null) =>
    expect(await poll(() => labelOf(page, path), (found) => found === label, UI_TIMEOUT), `the label of ${path}`).toBe(label);

  test('AC6 — a workspace whose setup failed, then reported running again, and a session whose agent exited with code 3, show the same label and the same dot after the app quit and was launched again', async () => {
    repo = makeRepoWithSetup({ setup: ['exit 6'] });
    session = await launchBuiltOn(env, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    // A workspace and a session in it started as the New workspace dialog does: `cockpit setup`, which fails.
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

    await poll(() => isAlive(olderPid), (alive) => !alive, 5_000);
    expect(isAlive(olderPid)).toBe(false);
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

  test('AC10 — COCKPIT_HOME a regular file: the window opens; stderr names the path; /terminal and a session page show the failure view; the Sessions section says so; spawn and sessions.start are refused with the reason; projects can still be added and removed', async () => {
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

      // The failure view: title, subtitle, the reason in monospace and "Try again", on /terminal and on a session page.
      const expectFailureView = async () => {
        await failureView(page).waitFor({ timeout: UI_TIMEOUT });
        await page.getByText(SUBTITLE, { exact: true }).waitFor({ timeout: UI_TIMEOUT });
        await page.locator('code, pre, [class*="mono"]').filter({ hasText: reason }).first().waitFor({ timeout: UI_TIMEOUT });
        await page.getByRole('button', { name: 'Try again', exact: true }).waitFor({ timeout: UI_TIMEOUT });
        expect(await page.getByRole('button', { name: 'Show log', exact: true }).count(), 'no log file exists').toBe(0);
      };
      await goToTerminalPage(page);
      await expectFailureView();
      await page.locator('aside').getByRole('link', { name: seeded.name }).click({ timeout: UI_TIMEOUT });
      await page.waitForURL(new RegExp(`/sessions/${seeded.id}$`), { timeout: UI_TIMEOUT });
      await page.getByRole('heading', { name: seeded.name }).waitFor({ timeout: UI_TIMEOUT });
      await expectFailureView();
      expect(await page.getByText('This session has ended.').count(), 'the failure view replaces the ended page').toBe(0);

      await page.locator('aside').getByText(`Cockpit's background service could not start: ${reason}`, { exact: true }).waitFor({ timeout: UI_TIMEOUT });

      const spawned = await page.evaluate(() => (window as unknown as ApiWindow).api.pty!.spawn!({ cols: 80, rows: 24 }).then(() => 'spawned', (error: Error) => error.message));
      expect(spawned).toContain(reason);
      const started = await page.evaluate(() => (window as unknown as ApiWindow).api.sessions!.start!('claude-code', { cols: 80, rows: 24 }, {}));
      expect(started.status).toBe('refused');
      expect(started.message).toContain(reason);
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).sessions, 'only the seeded session').toEqual([seeded]);

      // Projects can still be added and removed (worktrees need the home folder, so no workspace is made).
      await stubPicker(session, repo.root);
      expect((await page.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!())).status).toBe('added');
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).projects.map((p: { path: string }) => p.path)).toEqual([repo.root]);
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
      await goToTerminalPage(page);
      await failureView(page).waitFor({ timeout: UI_TIMEOUT });

      // "Show log": the log file exists, shell.openPath receives it.
      await session.evaluateInMain(`(() => { globalThis.__opened = []; require('electron').shell.openPath = async (path) => { globalThis.__opened.push(path); return ''; }; })()`);
      await page.getByRole('button', { name: 'Show log', exact: true }).click({ timeout: UI_TIMEOUT });
      expect(await poll(() => session!.evaluateInMain<string[]>('globalThis.__opened'), (opened) => opened.length > 0, UI_TIMEOUT)).toEqual([join(home, `daemon-1-${build}.log`)]);

      // Projects and workspaces are untouched: the home folder exists, so a worktree can be made and deleted.
      repo ??= makeRepoWithSetup();
      const root = repo.root;
      await stubPicker(session, root);
      expect((await page.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!())).status).toBe('added');
      const created = await page.evaluate((root) => (window as unknown as ApiWindow).api.workspaces!.create!(root, 'still-works', 'main'), root);
      expect(created.status).toBe('created');
      const worktree = await poll(
        () =>
          page.evaluate(
            async (root) =>
              ((await (window as unknown as ApiWindow).api.projects!.list!()) as Array<{ path: string; workspaces: Array<{ path: string; name: string }> }>)
                .find((project) => project.path === root)
                ?.workspaces.find((workspace) => workspace.name === 'still-works')?.path,
            root,
          ),
        Boolean,
        UI_TIMEOUT,
      );
      expect(existsSync(worktree!)).toBe(true);
      const removed = await page.evaluate(([root, path]) => (window as unknown as ApiWindow).api.workspaces!.remove!(root, path, {}), [root, worktree!] as const);
      expect(removed.status).toBe('removed');
      expect(existsSync(worktree!)).toBe(false);

      // The cause remains: the view stays.
      await page.getByRole('button', { name: 'Try again', exact: true }).click({ timeout: UI_TIMEOUT });
      await failureView(page).waitFor({ timeout: UI_TIMEOUT });
      expect(daemonProcessesOf(build)).toEqual([]);

      // The cause is removed.
      rmSync(socket, { recursive: true, force: true });
      await page.getByRole('button', { name: 'Try again', exact: true }).click({ timeout: UI_TIMEOUT });
      await failureView(page).waitFor({ state: 'detached', timeout: UI_TIMEOUT });
      expect(await page.locator('aside').getByText("Cockpit's background service could not start", { exact: false }).count()).toBe(0);
      await page.getByRole('button', { name: 'New terminal', exact: true }).first().click({ timeout: UI_TIMEOUT });
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
    await quitApp(first);
    process.kill(pid, 'SIGSTOP');

    session = await launchBuiltOn(baseEnv(build), dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    const socket = join(home, `daemon-1-${build}.sock`);
    const reason = `Cockpit's background service did not answer within 5 s: ${socket}`;

    await goToTerminalPage(page);
    await failureView(page).waitFor({ timeout: 10_000 });
    await page.locator('code, pre, [class*="mono"]').filter({ hasText: reason }).first().waitFor({ timeout: UI_TIMEOUT });
    await page.locator('aside').getByText(`Cockpit's background service could not start: ${reason}`, { exact: true }).waitFor({ timeout: UI_TIMEOUT });
    expect(session.output()).toContain(`Cockpit's background service could not start: ${reason}`);
    const spawned = await page.evaluate(() => (window as unknown as ApiWindow).api.pty!.spawn!({ cols: 80, rows: 24 }).then(() => 'spawned', (error: Error) => error.message));
    expect(spawned).toContain(reason);
    const started = await page.evaluate(() => (window as unknown as ApiWindow).api.sessions!.start!('claude-code', { cols: 80, rows: 24 }, {}));
    expect(started.status).toBe('refused');

    process.kill(pid, 'SIGCONT');
    await page.getByRole('button', { name: 'Try again', exact: true }).click({ timeout: UI_TIMEOUT });
    await failureView(page).waitFor({ state: 'detached', timeout: UI_TIMEOUT });
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click({ timeout: UI_TIMEOUT });
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
    await quitApp(first);
    process.kill(pid, 'SIGSTOP');

    session = await launchBuiltOn(baseEnv(newer), dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    await goToTerminalPage(page);
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click({ timeout: 15_000 });
    await typeLine(page, 'echo cockpit-$((6*7))');
    await expectScreen(page, /^cockpit-42$/m);

    expect(await page.getByText("Cockpit's background service could not start").count(), 'no failure state').toBe(0);
    const olderSocket = join(home, `daemon-1-${older}.sock`);
    expect(await poll(() => session!.output(), (output) => output.includes(olderSocket) && output.includes('did not answer'), 10_000)).toContain(olderSocket);
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
    await poll(() => existsSync(join(home, `daemon-1-${build}.log`)), Boolean, UI_TIMEOUT);
    await session.evaluateInMain(`(() => { globalThis.__opened = []; require('electron').shell.openPath = async (path) => { globalThis.__opened.push(path); return ''; }; })()`);
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

    // The app's own "Try again" does start it.
    await goToTerminalPage(page);
    await page.getByRole('button', { name: 'Try again', exact: true }).click({ timeout: UI_TIMEOUT });
    await poll(() => daemonPid(home, build), Boolean, UI_TIMEOUT);
    expect(daemonProcessesOf(build)).toHaveLength(1);

    // A terminal that exists: the app's page spawns a shell and listens to its output.
    const id = await page.evaluate(async () => {
      const api = (window as unknown as { api: { pty: { spawn(o: { cols: number; rows: number }): Promise<number>; onData(l: (id: number, data: string) => void): () => void } } }).api;
      const w = window as unknown as { __ptyData: Record<number, string> };
      w.__ptyData = {};
      api.pty.onData((terminalId, data) => {
        w.__ptyData[terminalId] = (w.__ptyData[terminalId] ?? '') + data;
      });
      return api.pty.spawn({ cols: 80, rows: 24 });
    });
    const output = () => page.evaluate((id) => (window as unknown as { __ptyData: Record<number, string> }).__ptyData[id] ?? '', id);
    const type = (text: string) => page.evaluate(([id, text]) => (window as unknown as ApiWindow).api.pty!.write!(id, text), [id, text] as const);
    await type('echo before-$((6*7))\n');
    await poll(output, (data) => data.includes('before-42'), UI_TIMEOUT);

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
    expect(await poll(output, (data) => data.includes('after-42'), UI_TIMEOUT), 'the terminal still reaches the app\'s page').toContain('after-42');
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
      Notification.prototype.show = function () { globalThis.__notified.push(this); };
      BrowserWindow.getFocusedWindow = () => null;
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    })()`);
    await poll(() => windowUrls(session!), (urls) => urls.length === 0, UI_TIMEOUT);

    const socket = must(daemonFile(home, 'sock'), 'the daemon sock');
    expect(await postEvent(socket, tokenFor(socket), { sessionId: id, event: 'waiting' })).toBe(204);
    await poll(() => session!.evaluateInMain<number>('globalThis.__notified.length'), (count) => count > 0, UI_TIMEOUT);
    expect(await session!.evaluateInMain<string>('globalThis.__notified.at(-1).body')).toBe('Needs input');

    await session!.evaluateInMain(`globalThis.__notified.at(-1).emit('click')`);
    const urls = await poll(() => windowUrls(session!), (found) => found.length === 1, UI_TIMEOUT);
    expect(urls).toHaveLength(1);
    expect(await poll(async () => (await windowUrls(session!))[0]?.endsWith(`/sessions/${id}`), Boolean, UI_TIMEOUT)).toBe(true);
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

    await goToTerminalPage(page);
    await typeLine(page, 'echo marker-shell-$((6*7))');
    await expectScreen(page, /^marker-shell-42$/m);
    const shell = await shellPid(page);
    const id = await startSession(page);
    const sessionPid = factsOf(fx)[0]!.pid;
    await quitApp(session);

    expect(await stillAlive([daemon, shell, sessionPid])).toEqual([true, true, true]);

    session = await launch();
    page = session.page;
    await page.getByText(versionLabel).waitFor();
    expect(daemonPid(home)).toBe(daemon);
    await page.locator(`aside a[href$="/sessions/${id}"]`).click({ timeout: UI_TIMEOUT });
    await expectScreen(page, /^marker-before-quit$/m);
    expect(await dotOf(page, id)).not.toBe('Ended');
    await goToTerminalPage(page);
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

    await goToTerminalPage(page);
    await typeLine(page, 'echo cockpit-$((6*7))');
    await expectScreen(page, /^cockpit-42$/m);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});
