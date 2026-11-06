import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync, writeSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { statusLaunch } from '@cockpit/harnesses';
import { type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sendFromComposer } from '../composer';
import { appDir, daemonSocketIn, fifo, heldProcess, launchDev, launchPackaged, launchSpawned, MAIN_PROCESS_ERROR, packagedAppDir, type Session, startClock, untilRead, versionLabel } from '../launch';
import { makeTestDir } from '../run-root';
import { killDaemon } from './daemon';
import { addRepository, countIpcCalls, dispatchFocus, entryTitles, gitIn, ipcAnswered, ipcCalls, makeRepo, openMenu, type TempRepo, untilFewerOverlays, waitForEntry, worktreePath } from './projects';
import { allConsoleErrorsOf, allPageErrorsOf, escapeRegExp, focusTerminal, terminalRows, typeLine, waitForRow } from './terminal';

// --- Sessions (COCKPIT-25) ---------------------------------------------------

// A harness that is not a harness: prints what the tests check (working
// directory, arguments, pid, `$TERM`, `$PATH`), then echoes every line it reads and
// exits with code 3 on `exit`. `pwd -P` because macOS temporary folders sit
// behind a symlink (`/var` is `/private/var`). Its `--version` waits for a line on `<stub>.slow` while that
// FIFO exists (see `slowVersion` in `makeSessionsFixture`).
export const STUB_HARNESS = `#!/bin/sh
#VERSION_LOG#
if [ "$1" = "--version" ]; then [ -e "$0.slow" ] && read _ < "$0.slow"; echo 9.9.9; exit 0; fi
# With a "<stub>.early" file, the shell text in it runs first, and with a "<stub>.late" one it runs after the stub's
# loop: a test makes the stub ignore SIGHUP, hold a pipe and outlive its terminal that way (COCKPIT-57 AC14).
[ -f "$0.early" ] && . "$0.early"
# The launch as it reached the process: its arguments, one per line, then the OpenCode config variable.
printf '%s\\n' "$@" "OPENCODE_CONFIG_CONTENT=\${OPENCODE_CONFIG_CONTENT-unset}" > "$0.launch.$$"
# What the session status feature adds before the other arguments (session status, COCKPIT-36) is
# set aside, so everything below sees only the arguments the user's choices produce.
SETTINGS=""
case "$1" in
  --settings) SETTINGS="$2"; shift 2 ;;
  --no-daemon) shift; if [ "$1" = -c ]; then shift 2; fi ;;
  --standalone) shift ;;
esac
#START_LOG#
echo "session:\${COCKPIT_SESSION_ID-unset}"
echo "workspace:\${COCKPIT_WORKSPACE_PATH-unset}"
echo "socket:\${COCKPIT_SOCKET-unset}"
echo "cwd:$(pwd -P)"
echo "args:$#:$*"
echo "pid:$$"
echo "term:$TERM"
echo "path:$PATH"
echo "ready"
while IFS= read -r line; do
  case "$line" in
    exit) exit 3 ;;
    quit) exit 0 ;;
    "hook "*)
      # Runs the command the --settings the stub got holds for that event, as Claude Code does.
      event="\${line#hook }"
      command=$(printf '%s' "$SETTINGS" | /usr/bin/plutil -extract "hooks.$event.0.hooks.0.command" raw -o - - 2>/dev/null)
      [ -n "$command" ] && /bin/sh -c "$command"
      echo "hooked:$event" ;;
    "session-hook "*)
      # Runs the second hook of UserPromptSubmit (the one that reports the conversation id) with the hook JSON a
      # harness gives it on stdin, {"session_id":"<id>"}: the stub's hook line above runs index 0, with the pty as
      # stdin (COCKPIT-30).
      id="\${line#session-hook }"
      command=$(printf '%s' "$SETTINGS" | /usr/bin/plutil -extract "hooks.UserPromptSubmit.0.hooks.1.command" raw -o - - 2>/dev/null)
      [ -n "$command" ] && printf '{"session_id":"%s"}' "$id" | /bin/sh -c "$command"
      echo "session-hooked:$id" ;;
    *) echo "got:$line" ;;
  esac
done

[ -f "$0.late" ] && . "$0.late"
`;

export interface SessionsFixture {
  /** The temporary folder that holds everything below, removed by the test. */
  root: string;
  /** The folder of the stubs: the first entry of the login shell's `PATH`. */
  bin: string;
  /** The fake login shell. */
  shell: string;
  /**
   * Lets the `--version` runs the fixture's `slowVersion` holds go on: one line to the FIFO of each stub. The
   * fixture holds each FIFO open for reading and writing, so the line is written at once whether a stub is
   * reading, has not opened it yet or was killed by the detection's own guard: no write waits for a reader.
   */
  releaseVersions(): void;
  /** Closes the FIFOs `releaseVersions` writes to. */
  endVersionHolds(): void;
  /** The file the fake login shell appends its arguments to on every run (but its warm-up). */
  shellLog: string;
  /** The environment to launch the app with. */
  env(): NodeJS.ProcessEnv;
  /** The file the stubs append a line to on every run, when the fixture was made with `log`. */
  runLog: string;
  /**
   * The file the `git` wrapper appends `<working directory> <arguments>` to on every run, when the
   * fixture was made with `gitLog`.
   */
  gitLog: string;
}

// Stubs named after the given catalogue binaries in a folder of their own, and
// a login shell, like `makeShellWithoutGit`, whose printed environment has
// `PATH=<that folder>:/usr/bin:/bin`: a real CLI installed on the developer's
// machine never shows up.
//
// With `log`, every stub first appends `<binary> <arguments>` to `runLog`, which
// is empty once the fixture is ready (its own warm-up runs are not counted).
// With `slowVersion`, the stubs' `--version` waits, once the fixture is ready, for the test to call
// `releaseVersions()` (one call per detection: each stub reads one line).
// With `gitLog`, `bin` also holds a `git` that appends `<physical working directory> <arguments>`
// to `gitLog` and runs the real git, so a test sees every git command the app runs.
export function makeSessionsFixture(
  binaries: string[],
  { log = false, slowVersion = false, gitLog = false }: { log?: boolean; slowVersion?: boolean; gitLog?: boolean } = {},
): SessionsFixture {
  const root = realpathSync(makeTestDir('s-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const runLog = join(root, 'runs.log');
  const logLine = `echo "$(basename "$0") $*" >> '${runLog}'`;
  const script = STUB_HARNESS.replace('#VERSION_LOG#', log ? `[ "$1" = --version ] && ${logLine}` : '').replace('#START_LOG#', log ? logLine : '');
  for (const name of binaries) {
    const stub = join(bin, name);
    writeFileSync(stub, script);
    chmodSync(stub, 0o755);
    // macOS scans a new executable the first time it runs.
    expect(execFileSync(stub, ['--version'], { encoding: 'utf8' }).trim()).toBe('9.9.9');
  }
  const gitLogFile = join(root, 'git-runs.log');
  if (gitLog) {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapper = join(bin, 'git');
    writeFileSync(wrapper, `#!/bin/sh\necho "$(pwd -P) $*" >> '${gitLogFile}'\nexec '${realGit}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    // macOS scans a new executable the first time it runs.
    execFileSync(wrapper, ['--version']);
    writeFileSync(gitLogFile, '');
  }
  const shell = join(root, 'login-shell');
  const shellLog = join(root, 'shell-args.log');
  writeFileSync(
    shell,
    // Started as a login shell with no command (`-l`) it returns at once, unless the test made the file
    // `interactive` in `root`: it is then an interactive /bin/sh with a prompt of its own, which is
    // where `cockpit setup` leaves the user (COCKPIT-57).
    `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\necho "$*" >> '${shellLog}'\n[ -f '${root}/early' ] && . '${root}/early'\n[ "$*" = -l ] && [ -e '${root}/interactive' ] && { PS1='login-shell> '; export PS1; exec /bin/sh -i; }\nPATH='${bin}:/usr/bin:/bin' /bin/sh -c "$2"\n`,
  );
  chmodSync(shell, 0o755);
  execFileSync(shell, ['--warmup']);
  const printed = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  expect(printed).toBe(`${bin}:/usr/bin:/bin`);
  if (log) writeFileSync(runLog, '');
  const holds: number[] = [];
  if (slowVersion) {
    for (const name of binaries) {
      const slow = join(bin, `${name}.slow`);
      execFileSync('mkfifo', [slow]);
      holds.push(openSync(slow, constants.O_RDWR));
    }
  }
  // Its own checks above ran the shell: only what the app makes it run is counted.
  writeFileSync(shellLog, '');

  const releaseVersions = () => {
    for (const fd of holds) writeSync(fd, 'go\n');
  };
  const endVersionHolds = () => {
    for (const fd of holds.splice(0)) closeSync(fd);
  };

  return { root, bin, shell, shellLog, env: () => ({ ...process.env, SHELL: shell }), runLog, gitLog: gitLogFile, releaseVersions, endVersionHolds };
}

export const launchBuiltWith = (env: NodeJS.ProcessEnv, dataDir?: string | null, cockpitHome?: string | null) =>
  launchSpawned(createRequire(import.meta.url)('electron') as string, ['.'], true, dataDir, env, cockpitHome);

export const launchPackagedWith = (env: NodeJS.ProcessEnv, dataDir?: string) => launchPackaged({ env, dataDir });

export const launchDevWith = (env: NodeJS.ProcessEnv, dataDir?: string | null, cockpitHome?: string | null) => launchDev(env, dataDir, cockpitHome);

export interface StoredSession {
  id: string;
  name: string;
  harness: string;
  directory: string;
  createdAt: string;
  /** The repository root, for a session started in a workspace. */
  project?: string;
  /** Set while a workspace session's tab is open (COCKPIT-69). */
  open?: boolean;
  /** The harness's own id for the conversation, reported at the user's prompt (COCKPIT-30). */
  harnessSessionId?: string;
}

export const sessionsInState = (dataDir: string): StoredSession[] =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { sessions?: StoredSession[] }).sessions ?? [];

// The id in the page URL (`/sessions/<id>`), if the page is a session page.
export const sessionIdOf = (page: Page) => /^\/sessions\/([^/]+)$/.exec(new URL(page.url()).pathname)?.[1];

export interface SessionEntry {
  id: string;
  name: string;
  /** The row's end dot: "Ended" or "Exited N". */
  ended: boolean;
  /** The accessible name of the row's status dot (session status, COCKPIT-36), `null` when it has none. */
  status: string | null;
}

// The session links of the Sessions section (the sessions outside any project) or
// of the workspace at `workspace` (a path), whose sessions are nested under its
// row in the Projects section: the name is the first text of the entry, the status
// is the accessible name of its dot (`role="img"`).
// Self-contained: it also runs in `untilRead`.
export interface SessionLinksArg {
  scope: 'sessions' | { workspace: string };
  expected?: Array<[name: string, ended: boolean]>;
  count?: number;
}
export const readSessionLinks = ({ scope }: SessionLinksArg): SessionEntry[] => {
    const root =
      scope === 'sessions'
        ? [...document.querySelectorAll('aside section')].find((section) => section.querySelector('h2, button[aria-expanded]')?.textContent?.trim() === 'Sessions')
        : [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === scope.workspace)?.closest('li');
    if (!root) return [];
    return [...root.querySelectorAll('a[href*="/sessions/"]')].map((link) => {
      const entry = link.closest('li') ?? link;
      const texts: string[] = [];
      const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node.textContent ?? '').trim();
        if (text) texts.push(text);
      }
      const status = entry.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') ?? null;
      return {
        id: link.getAttribute('href')!.split('/').pop()!,
        name: texts[0] ?? '',
        ended: status === 'Ended' || /^Exited \d+$/.test(status ?? ''),
        status,
      };
    });
  };

export const sessionLinks = (page: Page, scope: 'sessions' | { workspace: string }): Promise<SessionEntry[]> => page.evaluate(readSessionLinks, { scope });

export const sessionEntries = (page: Page) => sessionLinks(page, 'sessions');

export const allSessionLinkIds = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('aside a[href*="/sessions/"]')].map((link) => link.getAttribute('href')!.split('/').pop()!));

export const waitForSessionEntries = async (page: Page, expected: Array<[name: string, ended: boolean]>) =>
  (
    await untilRead(
      page,
      readSessionLinks,
      (entries, arg: SessionLinksArg) =>
        JSON.stringify(entries.map((entry) => [entry.name, entry.ended])) === JSON.stringify(arg.expected),
      { scope: 'sessions', expected },
    )
  ).map((entry) => [entry.name, entry.ended]);

export const LOADING_ITEM = 'Detecting agent CLIs…';

// The prompt the sessions the tests start outside any project are given: the composer needs one.
export const STARTED_PROMPT = 'start';

// The sessions the app stores, read through the page.
export const storedSessions = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { api: { sessions: { list(): Promise<StoredSession[]> } } }).api.sessions.list(),
  );

// Resolves once the router has nothing left to load (`onResolved` when a load is under way). A test that holds the
// sidebar's start flow in its `await router.invalidate()` (COCKPIT-86) waits for it before reading where the page is.
export const routerSettled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const router = (window as unknown as { __TSR_ROUTER__: { state: { status: string }; subscribe: (type: 'onResolved', fn: () => void) => () => void } })
          .__TSR_ROUTER__;
        if (router.state.status === 'idle') {
          resolve();
          return;
        }
        const stop = router.subscribe('onResolved', () => {
          stop();
          resolve();
        });
      }),
  );

type RouterInPage = {
  state: { matches: Array<{ routeId: string; loaderData?: { sessions?: Array<{ id: string }> } }> };
  history: { subscribe: (fn: (event: { location: { href: string } }) => void) => () => void };
  subscribe: (type: 'onResolved', fn: () => void) => () => void;
};

// COCKPIT-86: the hrefs the page's history goes through from now on, read by `locationsSeen`. A late navigation
// of a start flow shows there even if the user's own page is back by the time the test reads `location.href`.
export const recordLocations = (page: Page) =>
  page.evaluate(() => {
    const router = (window as unknown as { __TSR_ROUTER__: RouterInPage }).__TSR_ROUTER__;
    const seen: string[] = [];
    (window as unknown as { __locationsSeen?: string[] }).__locationsSeen = seen;
    router.history.subscribe(({ location }) => void seen.push(location.href));
  });
export const locationsSeen = (page: Page) => page.evaluate(() => (window as unknown as { __locationsSeen: string[] }).__locationsSeen);

// Resolves once the root loader's data (the sidebar's) lists session `id`: the last load of a start flow has ended,
// and what the flow does next (its navigation, if it may) is issued in the same microtask chain, so by the time this
// answer reaches the test it is done.
export const untilSessionListed = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      new Promise<void>((resolve) => {
        const router = (window as unknown as { __TSR_ROUTER__: RouterInPage }).__TSR_ROUTER__;
        const listed = () => router.state.matches.find((match) => match.routeId === '__root__')?.loaderData?.sessions?.some((each) => each.id === id) === true;
        if (listed()) {
          resolve();
          return;
        }
        const stop = router.subscribe('onResolved', () => {
          if (!listed()) return;
          stop();
          resolve();
        });
      }),
    id,
  );

// The number of `sessions:start` calls the main process has seen, counted from the first call of this on.
export const watchStarts = async (session: Session) => {
  await countIpcCalls(session, ['sessions:start']);
  return ipcCalls(session, 'sessions:start');
};

// Waits for the end of a start (COCKPIT-86): the main process answered the `startsBefore + 1`th `sessions:start`
// (the session is stored), then the sidebar's data lists it. Gives the new stored session (not in `known`).
export async function untilStartListed(session: Session, known: Set<string>, startsBefore: number): Promise<StoredSession> {
  await ipcAnswered(session, 'sessions:start', startsBefore + 1);
  const stored = (await storedSessions(session.page)).find((each) => !known.has(each.id));
  expect(stored, 'the start stored a session').toBeTruthy();
  await untilSessionListed(session.page, stored!.id);
  return stored!;
}

// Waits for the page of a new session called `pageName`. Outside any project that is its page
// (`/sessions/<id>`, `previous` being the id of the session page that was open before, if any). In a workspace
// (COCKPIT-70, `known` being the ids of the sessions stored before the start) it is the workspace page, the
// session being a tab with that label. Returns the session's id.
export async function waitForSessionPage(page: Page, previous: string | undefined, pageName: string, known?: Set<string>, workspacePath?: string): Promise<string> {
  if (known) {
    // The tab shows from the answer of the start, which saved the session first. The page of the workspace comes
    // first: the tab of another workspace's page may bear the same name.
    if (workspacePath) await page.waitForURL((url) => url.pathname === '/workspace' && url.searchParams.get('path') === workspacePath);
    await page.getByRole('tab', { name: pageName, exact: true }).waitFor();
    const fresh = (await storedSessions(page)).find((stored) => stored.name === pageName && stored.project !== undefined && !known.has(stored.id));
    expect(fresh, `${pageName} is stored for a workspace`).toBeTruthy();
    await page.waitForURL((url) => url.searchParams.get('path') === fresh!.directory);
    return fresh!.id;
  }
  await page.getByRole('heading', { name: pageName, exact: true }).waitFor();
  await page.waitForURL((url) => {
    const id = /^\/sessions\/([^/]+)$/.exec(url.pathname)?.[1];
    return id !== undefined && id !== previous;
  });
  const id = sessionIdOf(page);
  expect(id, `the URL ${page.url()} is /sessions/<id> of a new session`).toBeTruthy();
  return id!;
}

export const storedSessionIds = async (page: Page) => new Set((await storedSessions(page)).map((stored) => stored.id));

// Starts a session outside any project through the composer ("No project", `harnessName` as the agent,
// `STARTED_PROMPT` as the prompt) and waits for its page.
export async function startSession(page: Page, harnessName: string, pageName: string): Promise<string> {
  const { id } = await sendFromComposer(page, 'none', { prompt: STARTED_PROMPT, agent: harnessName });
  await page.getByRole('heading', { name: pageName, exact: true }).waitFor();
  return id!;
}

export async function openSessionEntry(page: Page, name: string) {
  // The Sessions section's links only: a workspace's sessions can bear the same name.
  const section = page.locator('aside section').filter({ has: page.locator('h2, button[aria-expanded]').filter({ hasText: /^\s*Sessions\s*$/ }) });
  const entry = section.locator('a[href*="/sessions/"]', { hasText: new RegExp(`^\\s*${escapeRegExp(name)}(\\s|$)`) });
  await entry.first().click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
}

export interface StubFacts {
  cwd: string;
  argCount: number;
  args: string;
  pid: number;
  term: string;
  path: string;
}

// What the stub printed, read from the terminal once it printed its last line.
// A long line wraps onto the next row, so the rows are joined before parsing.
export async function readStub(page: Page): Promise<StubFacts> {
  await waitForRow(page, 'ready');
  const text = (await terminalRows(page)).join('');
  const found = /cwd:(.+?)args:(\d+):(.*?)pid:(\d+)term:(.+?)path:(.+?)ready/.exec(text);
  if (!found) throw new Error(`The terminal does not show the stub's output:\n${text}`);
  return { cwd: found[1]!, argCount: Number(found[2]), args: found[3]!, pid: Number(found[4]), term: found[5]!, path: found[6]! };
}

export interface StubEnv {
  session: string;
  workspace: string;
  socket: string;
}

// The control variables the stub printed (`unset` when the variable is not in its environment).
export async function readStubEnv(page: Page): Promise<StubEnv> {
  await waitForRow(page, 'ready');
  const text = (await terminalRows(page)).join('');
  const found = /session:(.*?)workspace:(.*?)socket:(.*?)cwd:/.exec(text);
  if (!found) throw new Error(`The terminal does not show the stub's control variables:\n${text}`);
  return { session: found[1]!, workspace: found[2]!, socket: found[3]! };
}

// --- Control endpoint (COCKPIT-31) -------------------------------------------

// Values the app is launched with to prove that neither a terminal nor a session inherits them.
export const INHERITED_CONTROL_ENV = {
  COCKPIT_SESSION_ID: 'sentinel-session-id',
  COCKPIT_WORKSPACE_PATH: '/sentinel/workspace',
  COCKPIT_SOCKET: '/sentinel/control.sock',
};

// What a client (a hook) sees of `POST /session-events` on the app's socket.
export function postSessionEvent(socketPath: string, { authorization, body }: { authorization?: string; body: unknown }) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (authorization !== undefined) headers.authorization = authorization;
    const req = httpRequest({ socketPath, method: 'POST', path: '/session-events', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

export const controlTokenIn = (cockpitHome: string) => readFileSync(daemonSocketIn(cockpitHome).replace(/\.sock$/, '.token'), 'utf8');

// The status dot of a session's row (`role="img"`, wherever the row is in the sidebar): its accessible name
// and its `title`, or `null` when the row has none. A session of a workspace has no row of its own
// (COCKPIT-70): the row of its workspace shows the icon of its most urgent session, which is its own when it is
// the only one.
// `directory` is the workspace path of a session of a workspace, else null. Self-contained: it also runs in `untilRead`.
export const readDot = ({ id, directory }: { id: string; directory: string | null; label?: string | null }) => {
  const own = document.querySelector(`aside a[href$="/sessions/${id}"]`)?.closest('li') ?? null;
  const row = own ?? (directory ? ([...document.querySelectorAll('aside a[title]')].find((link) => link.getAttribute('title') === directory) ?? null) : null);
  const dot = row?.querySelector('[role="img"][aria-label]');
  return dot ? { label: dot.getAttribute('aria-label'), title: dot.getAttribute('title') } : null;
};

export const dotTarget = async (page: Page, id: string) => {
  const stored = (await storedSessions(page)).find((each) => each.id === id);
  return { id, directory: stored?.project ? stored.directory : null };
};

// Waits until the row of session `id` shows the dot `label`, `null` being no dot at all, and checks that the
// dot's `title` says the same. The dot shows within `bound` ms of the call, 2 s as "within 2 s of each report"
// says (`null`: no bound, for a page that loads first). With `'now'` it reads the row once (a session that must
// show no dot).
export async function expectDot(page: Page, id: string, label: string | null, bound: number | null | 'now' = 2_000) {
  const within = startClock();
  const target = { ...(await dotTarget(page, id)), label };
  const dot =
    bound === 'now'
      ? await page.evaluate(readDot, target)
      : await untilRead(page, readDot, (found, arg: typeof target) => (found?.label ?? null) === arg.label, target);
  if (typeof bound === 'number') within(`the dot of session ${id}`, bound);
  expect(dot?.label ?? null, `the dot of session ${id}`).toBe(label);
  if (label !== null) expect(dot?.title).toBe(label);
}

// The `cockpit` CLI the hooks run (COCKPIT-56): `apps/cli/dist/cockpit` when the app runs from the
// repository (the dev server, the built app), `Contents/Resources/bin/cockpit` in the packaged app.
export const REPOSITORY_CLI = resolve(appDir, '..', 'cli', 'dist', 'cockpit');
export const PACKAGED_CLI = () => join(packagedAppDir(), 'Contents/Resources/bin/cockpit');

// The command of a hook in the `--settings` the stub got, which names `cli` as its program.
export const hookCommandsOf = (fx: SessionsFixture, binary: string, pid: number) => {
  const settings = JSON.parse(readLaunch(fx, binary, pid).args[1]!) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  return Object.fromEntries(Object.entries(settings.hooks).map(([name, groups]) => [name, groups[0]!.hooks[0]!.command]));
};

export const singleQuoted = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

// The smoke path of the control endpoint and of the status reporting, on the session page that is
// open: the stub got its session id and the socket, and a `hook UserPromptSubmit` line (the stub runs
// the command its --settings hold for that event) turns the row's dot to "Working". It reports
// `working` only, which raises no notification.
export async function expectControlEndpoint(session: Session, fx: SessionsFixture, cli: string): Promise<void> {
  const { page } = session;
  const socketPath = daemonSocketIn(session.cockpitHome);
  const env = await readStubEnv(page);
  expect(env.session).toBe(sessionIdOf(page));
  expect(env.socket).toBe(socketPath);

  // COCKPIT-56: the CLI exists and runs, and the hooks the stub got name it (and no curl).
  accessSync(cli, constants.X_OK);
  const hooks = hookCommandsOf(fx, 'claude', (await readStub(page)).pid);
  expect(hooks.UserPromptSubmit).toBe(`${singleQuoted(cli)} status working`);
  expect(hooks.Stop).toBe(`${singleQuoted(cli)} status finished`);
  expect(Object.values(hooks).join('\n')).not.toContain('curl');

  await expectDot(page, env.session, null);
  await focusTerminal(page);
  await typeLine(page, 'hook UserPromptSubmit');
  await waitForRow(page, 'hooked:UserPromptSubmit');
  await expectDot(page, env.session, 'Working');
}

// COCKPIT-57 smoke path: the terminal of the session page that is open shows the setup `cockpit setup`
// ran before the agent, then the stub with its prompt.
export async function expectSetupThenAgent(page: Page, name: string, command: string, output: string) {
  await waitForRow(page, '✓ Setup done');
  const rows = (await terminalRows(page)).filter(Boolean);
  const header = rows.indexOf(`cockpit setup · ${name} · .cockpit/config.json`);
  expect(header).toBeGreaterThanOrEqual(0);
  expect(rows.slice(header + 1, header + 4)).toEqual([`$ ${command}`, output, '✓ Setup done']);
}

// COCKPIT-81 AC2: a process that is not this session's, with a command line like the app's own
// `cockpit setup`: it starts with `<cli> setup ` and passes `--then <another folder>/claude`. It runs for
// the whole describe that checks the detected path, and the checks must neither count it nor stop it.
export async function startForeignSetup(cli: string): Promise<{ pid: number; stop(): Promise<void> }> {
  const up = fifo();
  const held = heldProcess();
  const child = spawn('/bin/sh', ['-c', `echo up > '${up.path}'; ${held.snippet}`], {
    argv0: `${cli} setup --then /foreign-session/bin/claude`,
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  await up.line();
  return {
    pid: child.pid!,
    stop: async () => {
      await held.release();
      await exited;
    },
  };
}

// COCKPIT-57: the app's own `cockpit setup` (the CLI parent of the agent, alive while it runs) was
// given the absolute path harness detection found after `--then`, so the binary detection found is
// the one that runs, not the first `claude` of a `PATH` the CLI would search itself.
// The command line read is the one of this session's own CLI: the parent of the agent the session's terminal
// shows (`agentPid`, the pid its stub printed), which the daemon started for that terminal. No other `cockpit
// setup` of the machine is looked at.
export function expectSetupSpawnedWithDetectedPath(fx: SessionsFixture, cli: string, agentPid: number, binary = 'claude') {
  const parent = execFileSync('ps', ['-p', String(agentPid), '-o', 'ppid='], { encoding: 'utf8' }).trim();
  const line = execFileSync('ps', ['-p', parent, '-o', 'command='], { encoding: 'utf8' }).trim();
  expect(line.startsWith(`${cli} setup `), `the agent's parent is the session's \`cockpit setup\`: ${line}`).toBe(true);
  expect(line).toContain(` --then ${join(fx.bin, binary)} `);
  expect(line).not.toMatch(new RegExp(` --then ${binary}( |$)`));
}

// The processes whose parent is `pid`.
export const childPidsOf = (pid: number): number[] =>
  execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === pid)
    .map(([child]) => child!);

export const sessionFoldersIn = (home: string) => {
  const folder = join(home, 'sessions');
  return existsSync(folder) ? readdirSync(folder).sort() : [];
};

export async function expectNoErrors(session: Session) {
  expect(session.isRunning()).toBe(true);
  expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  expect(await allPageErrorsOf(session.page)).toEqual([]);
  expect(await allConsoleErrorsOf(session.page)).toEqual([]);
}

// --- Sessions in a workspace (COCKPIT-28) ------------------------------------

// Creates a workspace through the composer with `agent` and `prompt` (the branch is the prompt's slug, which
// the caller knows) and waits for the workspace page with the new session as its selected tab.
export async function createWorkspaceWithAgent(
  page: Page,
  repo: TempRepo,
  options: { agent: string; prompt: string },
  pageName: string,
): Promise<string> {
  const { id } = await sendFromComposer(page, repo, options);
  await page.getByRole('tab', { name: pageName, exact: true }).waitFor();
  return id!;
}

// Puts the pointer over the page's bottom right corner, away from the sidebar's rows.
export async function moveMouseAway(page: Page) {
  const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight] as const);
  await page.mouse.move(width - 2, height - 2);
}

export const startPlusLabel = (workspaceName: string) => `Start session in ${workspaceName}`;

// Hovers the workspace row and opens its "Start session in <name>" menu.
export async function openWorkspaceStartMenu(page: Page, workspacePath: string, workspaceName: string) {
  await page.getByTitle(workspacePath, { exact: true }).first().hover();
  await page.getByRole('button', { name: startPlusLabel(workspaceName), exact: true }).click();
  await page.getByRole('menuitem').filter({ hasNotText: LOADING_ITEM }).first().waitFor();
}

export async function startInWorkspace(page: Page, workspacePath: string, workspaceName: string, harnessName: string, pageName: string) {
  const known = await storedSessionIds(page);
  await openWorkspaceStartMenu(page, workspacePath, workspaceName);
  await page.getByRole('menuitem', { name: harnessName, exact: true }).click();
  return waitForSessionPage(page, undefined, pageName, known, workspacePath);
}

// The labels of the tabs of the workspace page that is open, in order (COCKPIT-70: a workspace's sessions are the
// tabs of its page, not rows of the sidebar).
export const workspaceTabs = (page: Page) =>
  page.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => (tab.getAttribute('title') ?? tab.textContent ?? '').trim()));

// Self-contained: it also runs in `untilRead`. The tabs that are not hidden, as `getByRole` sees them.
export const readWorkspaceTabs = (): string[] =>
  [...document.querySelectorAll('[role="tab"]')]
    .filter((tab) => tab.checkVisibility({ checkVisibilityCSS: true }))
    .map((tab) => (tab.getAttribute('title') ?? tab.textContent ?? '').trim());

export const waitForWorkspaceTabs = (page: Page, expected: string[]) =>
  untilRead(page, readWorkspaceTabs, (tabs, expected: string[]) => JSON.stringify(tabs) === JSON.stringify(expected), expected);

// The pids of the stubs running as sessions (`pgrep -f` on their own command: the stub script, run by
// its interpreter or not). A pattern that is not anchored would also match the command line of
// `cockpit setup … --then <abs path>`, the CLI parent of the stub, which holds the stub's path.
export function stubPids(fx: SessionsFixture): number[] {
  try {
    return execFileSync('pgrep', ['-f', `^(/bin/sh |sh )?${escapeRegExp(fx.bin)}/(claude|codex)( |$)`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .sort();
  } catch {
    // `pgrep` exits with 1 when nothing matches.
    return [];
  }
}

// The lines of the stubs' run log: `<binary> <arguments>`.
export const stubRuns = (fx: SessionsFixture) => readFileSync(fx.runLog, 'utf8').split('\n').filter(Boolean);
export const versionRuns = (fx: SessionsFixture) => stubRuns(fx).filter((line) => line.endsWith(' --version')).sort();
export const startRuns = (fx: SessionsFixture) => stubRuns(fx).filter((line) => !line.endsWith(' --version'));

export const startApi = (page: Page, options: unknown) =>
  page.evaluate(
    (options) =>
      (
        window as unknown as {
          api: { sessions: { start(harness: string, size: { cols: number; rows: number }, options: unknown): Promise<unknown> } };
        }
      ).api.sessions.start('claude-code', { cols: 80, rows: 24 }, options),
    options,
  );

// --- Open a workspace in an editor, a terminal or the Finder (COCKPIT-33) -----

export interface OpenFixture {
  /** The folder `COCKPIT_TEST_APPLICATIONS_DIR` points at: it holds the fake bundles. */
  apps: string;
  /** The file the stub `open` appends one line to per run: its arguments, tab-separated. */
  log: string;
  /** The folder whose `code` and `stderr` files set how the stub `open` ends. */
  control: string;
  /** Counts the runs of the stub: `reached(n)` resolves once the stub ran n times (and logged the run). */
  runs: RunCounter;
  /** The launch environment: the fixture's, plus the applications folder. */
  env(): NodeJS.ProcessEnv;
}

// A FIFO a stub writes a line to after each run it logged: the test is told of the run, it does not look for it.
// Opened for reading and writing, so a stub never blocks on it and no line is lost.
export interface RunCounter {
  /** The path the stub writes to. */
  path: string;
  /** Resolves once at least `count` lines came. */
  reached(count: number): Promise<void>;
}

export function runCounter(): RunCounter {
  const path = join(makeTestDir('f-'), 'p');
  execFileSync('mkfifo', [path]);
  const reader = new Socket({ fd: openSync(path, constants.O_RDWR), readable: true, writable: false });
  reader.unref();
  let count = 0;
  let waiting: Array<{ wanted: number; resolve(): void }> = [];
  reader.on('data', (chunk: Buffer) => {
    count += chunk.toString().split('\n').length - 1;
    for (const each of waiting) if (count >= each.wanted) each.resolve();
    waiting = waiting.filter((each) => count < each.wanted);
  });
  return { path, reached: (wanted) => (count >= wanted ? Promise.resolve() : new Promise<void>((resolve) => waiting.push({ wanted, resolve }))) };
}

export const OPEN_BUNDLES = ['Visual Studio Code.app', 'Cursor.app', 'Terminal.app', 'Ghostty.app'];

// A stub `open` first on the fake login shell's `PATH` (the real one would open real apps on
// the developer's screen) and an applications folder of empty fake bundles: Zed, iTerm2 and
// Warp are not detected.
export function addOpenFixture(fx: SessionsFixture): OpenFixture {
  const apps = join(fx.root, 'Applications');
  mkdirSync(apps);
  for (const bundle of OPEN_BUNDLES) mkdirSync(join(apps, bundle));
  const log = join(fx.root, 'open.log');
  const control = join(fx.root, 'open-control');
  mkdirSync(control);
  const stub = join(fx.bin, 'open');
  const runs = runCounter();
  writeFileSync(
    stub,
    `#!/bin/sh
[ "$1" = --warmup ] && exit 0
printf '%s\\t' "$@" >> '${log}'
echo >> '${log}'
echo run > '${runs.path}'
[ -s '${control}/stderr' ] && cat '${control}/stderr' >&2
[ -e '${control}/code' ] && exit "$(cat '${control}/code')"
exit 0
`,
  );
  chmodSync(stub, 0o755);
  // macOS scans a new executable the first time it runs; the run is not counted.
  execFileSync(stub, ['--warmup']);
  writeFileSync(log, '');
  return { apps, log, control, runs, env: () => ({ ...fx.env(), COCKPIT_TEST_APPLICATIONS_DIR: apps }) };
}

// The runs of the stub `open`, one array of arguments each.
export const openRuns = (open: OpenFixture): string[][] =>
  readFileSync(open.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t').slice(0, -1));

export const waitForOpenRuns = async (open: OpenFixture, count: number) => {
  await open.runs.reached(count);
  return openRuns(open);
};

// How the next runs of the stub `open` end: exit code and stderr (none for a success).
export function setOpenOutcome(open: OpenFixture, { code, stderr }: { code?: number; stderr?: string } = {}) {
  rmSync(join(open.control, 'code'), { force: true });
  rmSync(join(open.control, 'stderr'), { force: true });
  if (code !== undefined) writeFileSync(join(open.control, 'code'), String(code));
  if (stderr !== undefined) writeFileSync(join(open.control, 'stderr'), stderr);
}

export const rememberedApps = (dataDir: string) => {
  const { editor, terminal } = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { editor?: unknown; terminal?: unknown };
  return { editor, terminal };
};

// The text of the items of a menu, trimmed. Menus are found by their accessible name (their trigger's): a menu
// that was just closed stays in the DOM until its exit animation ends, and an unnamed lookup would see it.
// The "…" menu of a workspace is named "Actions for <workspace>", a submenu opened from it by its sub-trigger.
export const trimmed = (texts: string[]) => texts.map((text) => text.trim());
export const topLevelItems = async (menu: ReturnType<Page['locator']>) => trimmed(await menu.getByRole('menuitem').allInnerTexts());
export const workspaceMenu = (page: Page, path: string) => page.getByRole('menu', { name: `Actions for ${basename(path)}`, exact: true });
export const submenuNamed = (page: Page, trigger: 'Open in editor' | 'Open in terminal') => page.getByRole('menu', { name: trigger, exact: true });

// Opens the "…" menu of the workspace at `path` and waits until the items above "Copy path" and "Delete workspace…"
// are exactly `expected` (in any order), "Copy path" and "Delete workspace…" being the last two (COCKPIT-88: items
// always there). The apps arrive after the menu opens, and a menu opened again shows the earlier ones until they
// do: each item `expected` is awaited, then the absence of any other.
export async function openWorkspaceMenu(page: Page, path: string, expected: string[]) {
  await openMenu(page, path);
  const wanted = [...expected].sort();
  const menu = workspaceMenu(page, path);
  const always = ['Copy path', 'Delete workspace…'];
  const exactly = (names: string[]) => new RegExp(`^\\s*(?:${names.map(escapeRegExp).join('|')})\\s*$`);
  for (const name of [...expected, ...always]) await menu.getByRole('menuitem').filter({ hasText: exactly([name]) }).waitFor();
  await menu.getByRole('menuitem').filter({ hasNotText: exactly([...expected, ...always]) }).first().waitFor({ state: 'detached' });
  const items = await topLevelItems(menu);
  expect(items.slice(-2), 'the app items sit above "Copy path" and "Delete workspace…"').toEqual(always);
  expect(items.slice(0, -2).sort()).toEqual(wanted);
}

// Opens a submenu of the "…" menu with one hover and returns its items. Base UI opens a submenu on hover
// once the pointer has rested on its trigger for 100 ms (`delay`, a rest timer started by the mouse move)
// and the parent popup has seen a mouse move (`allowMouseEnter`, which the hover's own move sets): the
// submenu is not there when `hover()` returns, so the state to wait on is the named submenu itself.
// A submenu still open from before is closed first (one Escape closes only the submenu): with hover
// opening, Base UI leaves the parent popup at `pointer-events: none` until the next real mouse move,
// and a stale submenu would pass for the requested one.
export async function openSubmenu(page: Page, trigger: 'Open in editor' | 'Open in terminal') {
  const submenu = submenuNamed(page, trigger);
  const open = page.getByRole('menu', { name: /^Open in (editor|terminal)$/ });
  if ((await open.count()) > 0) {
    await page.keyboard.press('Escape');
    await open.first().waitFor({ state: 'detached' });
  }
  await page.getByRole('menuitem', { name: trigger, exact: true }).hover();
  await submenu.waitFor();
  return submenu.getByRole('menuitem');
}

// An app's item of a submenu holds a letter badge (COCKPIT-68) before its name; tests of the apps read the name,
// the last text of the item, whatever the layout puts between the two.
export const submenuTexts = async (page: Page, trigger: 'Open in editor' | 'Open in terminal') =>
  (await openSubmenu(page, trigger)).evaluateAll((items) =>
    items.map((item) => {
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
      let last = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) last = (node.textContent ?? '').trim() || last;
      return last;
    }),
  );

export async function pickInSubmenu(page: Page, trigger: 'Open in editor' | 'Open in terminal', app: string) {
  const items = await openSubmenu(page, trigger);
  await items.filter({ hasText: new RegExp(`^\\s*(?:\\S\\s*)?${escapeRegExp(app)}\\s*$`) }).first().click();
}

// Escape until no menu is open (a submenu takes one Escape of its own).
export async function closeMenus(page: Page) {
  const menus = page.getByRole('menu');
  for (let attempt = 0; attempt < 4 && (await menus.count()) > 0; attempt++) {
    const open = await menus.count();
    await page.keyboard.press('Escape');
    await untilRead(page, () => document.querySelectorAll('[role="menu"]').length, (count, open: number) => count < open, open);
  }
  expect(await menus.count()).toBe(0);
}

export const pickTopItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true }).click();

// The whole menu of a workspace when every fake bundle is there and nothing is remembered.
export const FIRST_MENU = ['Open in Visual Studio Code', 'Open in Terminal', 'Reveal in Finder', 'Open in editor', 'Open in terminal'];

export const workspacesApi = (page: Page, call: 'branches' | 'create' | 'remove' | 'reveal' | 'open', args: unknown[]) =>
  page.evaluate(
    ([call, args]) =>
      (window as unknown as { api: { workspaces: Record<string, (...args: unknown[]) => Promise<unknown>> } }).api.workspaces[call]!(...args),
    [call, args] as const,
  );

// Makes a workspace with git itself (branch `name`, from main, in the folder the app would use) and waits
// until the sidebar lists it: the tests that use it are about what is done to a workspace, not its creation.
export async function createPlainWorkspace(session: Session, repo: TempRepo, name: string): Promise<string> {
  const { page } = session;
  const path = worktreePath(session, repo, name);
  gitIn(repo.root, 'worktree', 'add', '--quiet', '-b', name, path, 'main');
  await dispatchFocus(page);
  await waitForEntry(page, path);
  expect(await entryTitles(page)).toContain(path);
  return path;
}


// COCKPIT-61: an unpackaged build keeps its data in `~/.cockpit-dev/<folder>` (its Cockpit home) and
// its `userData` in `~/.cockpit-dev/<folder>/user-data`, `<folder>` being `devFolderName` of the
// worktree root (`app.getAppPath()` is `<root>/apps/desktop`). Only the running app shows which
// path `app.getAppPath()` gives and that `userData` is set before the daemon and the lock.
// Imported when a test runs, so the rest of this file loads whether or not the module exists.
export const devFolderOfThisWorktree = async () => (await import('../../src/main/dev-folder')).devFolderName(resolve(appDir, '../..'));
export const devHomeIn = (userHome: string, folder: string) => join(userHome, '.cockpit-dev', folder);

// --- Session status (COCKPIT-36) ---------------------------------------------

// What a stub was started with: its arguments as the harness got them (the status flags included),
// and the OpenCode config variable (`unset` when the variable was not in its environment).
export function readLaunch(fx: SessionsFixture, binary: string, pid: number) {
  const lines = readFileSync(join(fx.bin, `${binary}.launch.${pid}`), 'utf8').split('\n').slice(0, -1);
  const config = lines.pop()!.slice('OPENCODE_CONFIG_CONTENT='.length);
  return { args: lines, openCodeConfig: config };
}

export const launchFiles = (fx: SessionsFixture) => readdirSync(fx.bin).filter((name) => name.includes('.launch.')).sort();

// Reports a status the way a hook does, straight to the endpoint with the token.
export async function reportStatus(session: Session, id: string, event: 'working' | 'waiting' | 'finished') {
  const answer = await postSessionEvent(daemonSocketIn(session.cockpitHome), {
    authorization: `Bearer ${controlTokenIn(session.cockpitHome)}`,
    body: { sessionId: id, event },
  });
  expect(answer.status, `${event} for ${id}`).toBe(204);
}

// Tests never show a real notification: `Notification.prototype.show` records what would be shown, and
// `BrowserWindow.getFocusedWindow` answers `null` until a test says a window is focused.
export const stubNotifications = (session: Session) =>
  session.evaluateInMain(`(() => {
    const { Notification, BrowserWindow } = require('electron');
    globalThis.__notified = [];
    globalThis.__focused = false;
    Notification.prototype.show = function () {
      globalThis.__notified.push({ title: this.title, body: this.body, notification: this });
    };
    BrowserWindow.getFocusedWindow = () => (globalThis.__focused ? BrowserWindow.getAllWindows()[0] ?? null : null);
  })()`);

export const notifications = (session: Session) =>
  session.evaluateInMain<Array<{ title: string; body: string }>>('globalThis.__notified.map(({ title, body }) => ({ title, body }))');

export const clearNotifications = (session: Session) => session.evaluateInMain('globalThis.__notified.length = 0');

export const setWindowFocused = (session: Session, focused: boolean) => session.evaluateInMain(`globalThis.__focused = ${focused}`);

// Closes a menu or dialog a failed test left open (never while the keyboard is in a terminal).
export async function closeOverlays(page: Page) {
  const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
  for (let attempt = 0; attempt < 4; attempt++) {
    const open = await overlays.count();
    if (open === 0 || (await page.evaluate(() => !!document.activeElement?.closest('.xterm')))) break;
    await page.keyboard.press('Escape');
    await untilFewerOverlays(page, open);
  }
}

// --- Resume sessions (COCKPIT-30) --------------------------------------------

// A conversation id no harness would make: it must reach the harness byte for byte.
export const ODD_HARNESS_ID = 'not/a:uuid é';

// Resolves, in the main process, once `channel` has been called `count` times in all (`countIpcCalls`), whether
// or not the calls have answered: the closing event of "the main process holds this call", for a handler that is
// parked. Woken by the same watchers as `ipcAnswered`; no timer.
export const ipcReceived = (session: Session, channel: string, count: number) =>
  session.evaluateInMain(`new Promise((resolve) => {
    const calls = globalThis.__ipcCalls[${JSON.stringify(channel)}];
    const watchers = globalThis.__ipcWatchers;
    const check = () => {
      const at = watchers.indexOf(check);
      if (calls.length < ${count} || at < 0) return;
      watchers.splice(at, 1);
      resolve(true);
    };
    watchers.push(check);
    check();
  })`);

export const resumeButton = (page: Page) => page.getByRole('button', { name: 'Resume last session', exact: true });
export const newTerminalButton = (page: Page) => page.getByRole('button', { name: 'New terminal here', exact: true });

export const harnessIdOf = (state: { sessions?: StoredSession[] }, sessionId: string) => state.sessions?.find((stored) => stored.id === sessionId)?.harnessSessionId;

// Resolves once `holds` is true of the state `state.json` holds: read at once and after every change of the data
// folder (the state is written to a temporary file and renamed over `state.json`). `action` runs after the watcher is
// in place, so a write it causes is never missed; its rejection rejects. No timer.
export function untilState(dataDir: string, holds: (state: { sessions?: StoredSession[] }) => boolean, action?: () => Promise<unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      let state: { sessions?: StoredSession[] };
      try {
        state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as typeof state;
      } catch {
        return;
      }
      if (!holds(state)) return;
      watcher.close();
      resolve();
    };
    const watcher = watch(dataDir, check);
    (action?.() ?? Promise.resolve()).then(check, (error: unknown) => {
      watcher.close();
      reject(error);
    });
  });
}

// The one smoke path of resuming, in a mode that does not run the feature's full block: a session of a workspace
// reports its conversation id (the stub's `session-hook` line runs the hook the `--settings` it got hold), the daemon
// is lost, the page reloads, the ended tab's "Resume last session" starts the harness again with `statusLaunch`'s
// arguments followed by `--resume <id>`. `cli` is the compiled CLI the hooks name in this mode.
export async function expectResumeSmoke(session: Session, fx: SessionsFixture, repo: TempRepo, cli: string): Promise<void> {
  const { page, dataDir } = session;
  const id = 'smoke-conversation';
  await addRepository(session, repo);
  const path = await createPlainWorkspace(session, repo, 'resume-smoke');
  const sessionId = await startInWorkspace(page, path, 'resume-smoke', 'Claude Code', 'Claude Code 1');
  await readStub(page);
  await focusTerminal(page);
  await untilState(dataDir, (state) => harnessIdOf(state, sessionId) === id, () => typeLine(page, `session-hook ${id}`));

  await killDaemon(session.cockpitHome);
  await page.reload();
  await page.getByRole('tablist').first().waitFor();
  const launches = launchFiles(fx);
  await resumeButton(page).click();

  const resumed = await readStub(page);
  expect(launchFiles(fx)).toHaveLength(launches.length + 1);
  const expected = await statusLaunch('claude-code', { cli, pluginsDir: join(fx.root, 'expected-plugins'), env: {} });
  expect(readLaunch(fx, 'claude', resumed.pid).args).toEqual([...expected.args, '--resume', id]);
  expect(resumed.cwd).toBe(realpathSync(path));
  expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
}

// The smoke path in a mode of its own (the packaged app, the packaged app with launchd's environment): its own launch
// with the fake login shell that holds the stub `claude`, and a repository of its own.
export const describeResumeSmoke = (mode: string, launch: (fx: SessionsFixture) => Promise<Session>, cli: () => string) =>
  describe(`resume sessions: ${mode} smoke path`, () => {
    let fx: SessionsFixture;
    let repo: TempRepo;
    let session: Session | undefined;

    beforeAll(async () => {
      fx = makeSessionsFixture(['claude']);
      repo = makeRepo('resume-smoke-repo');
      session = await launch(fx);
      await session.page.getByText(versionLabel).waitFor();
    });

    afterAll(async () => {
      await session?.close().catch(() => {});
      if (fx) rmSync(fx.root, { recursive: true, force: true });
      if (repo) rmSync(repo.parent, { recursive: true, force: true });
    });

    test('COCKPIT-30 smoke path — a session reports its conversation id, its daemon is lost, the page reloads and "Resume last session" starts the harness with the status arguments then `--resume <id>`', async () => {
      await expectResumeSmoke(session!, fx, repo, cli());
    });
  });
