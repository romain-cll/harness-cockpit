import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, uptime } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  connectDaemon,
  DaemonNotAnsweringError,
  daemonFiles,
  ensureDaemon,
  listDaemonFiles,
  PROTOCOL_VERSION,
  readTerminals,
  shutdownDaemon,
  type DaemonClient,
  type SessionReport,
  type SetupState,
  type SpawnOptions,
  type TerminalExit,
  type TerminalInfo,
  type TerminalKind,
} from '@cockpit/daemon';
import { createPullRequest, findPullRequest, GitHubError, mergePullRequest, pullRequestStates } from '@cockpit/github';
import { detectHarnesses, harnesses, statusLaunch, type DetectedHarness, type Harness } from '@cockpit/harnesses';
import { apps, defaultApplicationDirs, detectApps, LaunchError, openIn, reveal, type App } from '@cockpit/launchers';
import {
  addProject,
  addSession,
  closeSession,
  loadState,
  NewerStateError,
  ProjectExistsError,
  rememberApp,
  removeProject,
  saveState,
  sessionName,
  setHarnessSessionId,
  setMainWorkspace,
  type Session,
  updateProjectPath,
  type State,
} from '@cockpit/state';
import {
  availableBranch,
  branchStatus,
  checkGit,
  cloneRepository,
  commitAll,
  commitsAfter,
  createWorktree,
  fileDiff,
  findRepositoryRoot,
  hasRemote,
  headSubject,
  initRepository,
  listBranches,
  listChanges,
  listWorktrees,
  nameWorkspace,
  pushBranch,
  readWorkspaceConfig,
  removalState,
  reservedPath,
  removeWorktree,
  repairWorktrees,
  watchWorktree,
  WorkspaceError,
  type Worktree,
} from '@cockpit/workspaces';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  protocol,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import type {
  AddProjectResult,
  AppsResult,
  BranchesResult,
  BranchStatusResult,
  ChangedFile,
  ChangesResult,
  CloneRequest,
  CommitResult,
  CommitsAfterResult,
  ComposeResult,
  CreatePullRequestResult,
  CreateRequest,
  CreateWorkspaceResult,
  DaemonStatus,
  DiffResult,
  EndedSession,
  FailedSetup,
  ListedTerminal,
  MergeMethod,
  MergePullRequestResult,
  Project,
  OpenWorkspaceResult,
  OutdatedTerminal,
  PtySpawnOptions,
  PtySpawnRequest,
  PullRequestResult,
  PullRequestStatesResult,
  PushResult,
  Refused,
  RemovalResult,
  RemoveWorkspaceResult,
  SessionStatus,
  SettledSetup,
  TeardownResult,
  StartSessionOptions,
  StartSessionResult,
  UpdatePathResult,
  Workspace,
} from '../shared/api';
import daemonPath from './daemon?modulePath';
import { devFolderName } from './dev-folder';
import { nameProblem } from '../renderer/components/project-form';
import { shellEnv } from './shell-env';

// The built renderer is served from a custom protocol rather than `file://`,
// as the Electron security checklist recommends. It also gives the router
// real URLs, as on the web.
const RENDERER_ORIGIN = 'app://renderer';
const ERR_ABORTED = -3;
const rendererDir = join(import.meta.dirname, '../renderer');

// Set by `electron-vite dev`. Ignored once packaged, so the environment cannot
// point the app at another page.
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

// Test switches, read before `ready`. Unlike `ELECTRON_RENDERER_URL`, which is
// ignored once packaged because it would change the code the app runs, they are
// honoured in the packaged app too: the packaged-app test needs them, and they
// only change where the data lives and whether windows are shown.
// - COCKPIT_USER_DATA_DIR: the app keeps its data in that folder (Electron's default when packaged,
//   `~/.cockpit-dev/<folder>/user-data` when not, see COCKPIT_HOME).
// - COCKPIT_HOME: where worktrees and session folders live, in `worktrees` and `sessions` under it,
//   and the daemon's files (`~/.cockpit` when unset and packaged; `~/.cockpit-dev/<folder>` when not,
//   `<folder>` being `devFolderName` of the worktree root, so a development build never shares the
//   installed app's daemon, nor another worktree's). They are the user's work, not app data, so they
//   stay out of `userData`.
// - COCKPIT_TEST_DAEMON_BUILD: replaces the daemon's build when non-empty, so a test can play an update.
// - COCKPIT_TEST_APPLICATIONS_DIR: the one folder the editors and terminals are looked up in,
//   instead of the three applications folders (ignored when empty).
// - COCKPIT_TEST_BACKGROUND=1: no Dock icon, windows never shown, so a test
//   launch does not take the user's focus.
const background = process.env.COCKPIT_TEST_BACKGROUND === '1';
// What an unpackaged build defaults both folders to, whichever variable is set.
const devHome = app.isPackaged ? undefined : join(homedir(), '.cockpit-dev', devFolderName(resolve(app.getAppPath(), '../..')));
const userDataDir = process.env.COCKPIT_USER_DATA_DIR || (devHome && join(devHome, 'user-data'));
const cockpitHome = resolve(process.env.COCKPIT_HOME || devHome || join(homedir(), '.cockpit'));
// The `cockpit` CLI the harness hooks run: copied into the bundle when packaged, built in
// `apps/cli` otherwise (`app.getAppPath()` is `apps/desktop`).
const cliPath = app.isPackaged ? join(process.resourcesPath, 'bin', 'cockpit') : resolve(app.getAppPath(), '../cli/dist/cockpit');
const worktreesRoot = join(cockpitHome, 'worktrees');
const applicationDirs = process.env.COCKPIT_TEST_APPLICATIONS_DIR
  ? [process.env.COCKPIT_TEST_APPLICATIONS_DIR]
  : defaultApplicationDirs(homedir());
if (userDataDir) app.setPath('userData', userDataDir);
// After `setPath`: Electron ties the lock to the userData folder. A second launch on the same folder
// exits at once; the running app gets `second-instance`.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.exit(0);
if (background && process.platform === 'darwin') app.setActivationPolicy('accessory');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function serveRenderer(request: Request): Promise<Response> | Response {
  const path = join(rendererDir, decodeURIComponent(new URL(request.url).pathname));
  const fromRoot = relative(rendererDir, path);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    return new Response(null, { status: 404 });
  }
  if (isFile(path)) return net.fetch(pathToFileURL(path).href);
  // A path without an extension is a client-side route: serve the app shell.
  if (!extname(path)) return net.fetch(pathToFileURL(join(rendererDir, 'index.html')).href);
  return new Response(null, { status: 404 });
}

function createWindow(path = '/'): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    // On macOS the page extends under the title bar and the window controls sit
    // in the sidebar's top strip. Other platforms keep the native frame.
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 16 },
    }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A dropped file must not navigate the window; drops are a no-op until a feature handles them.
      navigateOnDragDrop: false,
      // A window that is never shown would otherwise count as hidden: the page
      // would report `hidden` and throttle its timers and animation frames.
      ...(background && { backgroundThrottling: false }),
    },
  });

  if (!background) window.once('ready-to-show', () => window.show());

  // Links that open a new window go to the system browser, never to a new app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  void window.loadURL(new URL(path, devServerUrl ?? RENDERER_ORIGIN).href);
}

// `URL.origin` is "null" for a scheme Node does not know, such as `app:`, so the
// origin is rebuilt from the protocol and host. An unparsable URL (empty while a
// frame navigates) has none.
function originOf(url: string): string | undefined {
  try {
    const { protocol, host } = new URL(url);
    return `${protocol}//${host}`;
  } catch {
    return undefined;
  }
}

// Only the app's own page may drive terminals, manage projects, start sessions or read the shell PATH.
function isFromApp({ senderFrame }: Pick<IpcMainEvent, 'senderFrame'>): boolean {
  const appOrigin = devServerUrl ? originOf(devServerUrl) : RENDERER_ORIGIN;
  return senderFrame !== null && originOf(senderFrame.url) === appOrigin;
}

// The loaded state, replaced by a new one (and saved) on every change.
let state: State;

// The last status each session reported, as the sidebar shows it.
const sessionStatuses = new Map<string, SessionStatus>();

// The sessions the composer started in a new workspace, waiting for the title their agent derives from
// the prompt (session id to worktree and harness). In memory only: a title that arrives while the app
// is not running names nothing. The first accepted title, the agent's exit or the end of the terminal
// clears the entry.
const pendingNames = new Map<string, { worktree: string; harness: Harness }>();

// The workspaces the composer sent and the main process is still making (by worktree path): the branch and
// the path are reserved, the worktree is created, then the agent or the setup shell starts. `projects:list`
// shows them as rows being set up. In memory only: an app quit during the setup forgets them.
interface Setup {
  project: string;
  path: string;
  branch: string;
  /** `null`: no worktree, the workspace opens the project's folder (the main workspace). */
  base: string | null;
  /** A harness id, or `terminal` for the setup shell. */
  harness: string;
  task: string;
}
const setups = new Map<string, Setup>();

// The sends whose worktree could not be created, kept until the user dismisses them ("Back to composer").
let failedSetups: FailedSetup[] = [];

// A session's program set a terminal title. The daemon forwards only those between the markers
// `cockpit setup` writes around the agent, so the setup's and the login shell's never get here. The
// first one its harness derives from the prompt names the workspace: the branch follows it (`nameWorkspace`) and the windows list again.
async function nameFromTitle({ sessionId, title }: { sessionId: string; title: string }): Promise<void> {
  const pending = pendingNames.get(sessionId);
  if (!pending) return;
  const name = pending.harness.promptTitle(title);
  if (name === null) return;
  pendingNames.delete(sessionId);
  try {
    await nameWorkspace({ worktree: pending.worktree, name, env: await shellEnv });
  } catch {
    // The workspace keeps the name it has.
    return;
  }
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('projects:changed');
}

// Keeps the harness's id for a session's conversation, an opaque string: the last one reported wins, and
// nothing is written when it is the one stored.
function storeHarnessSessionId(sessionId: string, harnessSessionId: string): void {
  const session = state.sessions.find(({ id }) => id === sessionId);
  if (!session || session.harnessSessionId === harnessSessionId) return;
  const next = setHarnessSessionId(state, sessionId, harnessSessionId);
  saveState(app.getPath('userData'), next);
  state = next;
}

// A session reported to a daemon: a harness hook (a status or the conversation's id), or `cockpit setup` (a setup state, the
// agent's exit). The window that holds the session's terminal is told of a change; a macOS
// notification is raised for `waiting` and `finished` when no Cockpit window is focused, and
// clicking it shows a window (a new one when none is open) on the session's page.
function reportSessionStatus(report: SessionReport): void {
  const { sessionId, event } = report;
  const session = state.sessions.find(({ id }) => id === sessionId);
  if (!session) return;
  const terminal = [...terminals.values()].find((each) => each.sessionId === sessionId);
  const owner = terminal?.owner && !terminal.owner.isDestroyed() ? terminal.owner : undefined;

  if (report.event === 'harness-session') {
    storeHarnessSessionId(sessionId, report.harnessSessionId);
    return;
  }
  if (report.event === 'exited') {
    pendingNames.delete(sessionId);
    if (terminal) terminal.exitCode = report.exitCode;
    owner?.send('sessions:status', sessionId, event, report.exitCode);
    return;
  }
  if (report.event.startsWith('setup-')) {
    if (terminal) terminal.setup = report.event.slice('setup-'.length) as SetupState;
    owner?.send('sessions:status', sessionId, event);
    return;
  }

  if (sessionStatuses.get(sessionId) === event) return;
  sessionStatuses.set(sessionId, event as SessionStatus);
  owner?.send('sessions:status', sessionId, event);
  // A status read from the title (an interrupted turn) is no news to push a notification for.
  if (event === 'working' || report.fromTitle || BrowserWindow.getFocusedWindow()) return;

  const notification = new Notification({ title: session.name, body: event === 'waiting' ? 'Needs input' : 'Ready' });
  notification.on('click', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) {
      createWindow(`/sessions/${sessionId}`);
      return;
    }
    window.show();
    window.focus();
    window.webContents.send('sessions:open', sessionId);
  });
  notification.show();
}

// The environment of a terminal or a session: the login shell's, without the session variables
// the app itself may have inherited (launched from a Cockpit session) and the daemon's
// `ELECTRON_RUN_AS_NODE`, with `COCKPIT_SOCKET` (the daemon's socket), the `cockpit` CLI's folder
// first on `PATH` and `extra` on top (a session's own variables).
async function terminalEnv(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const env = { ...(await shellEnv) };
  for (const name of ['COCKPIT_SESSION_ID', 'COCKPIT_WORKSPACE_PATH', 'COCKPIT_SOCKET', 'ELECTRON_RUN_AS_NODE']) delete env[name];
  env.COCKPIT_SOCKET = ownFiles.socket;
  env.PATH = [dirname(cliPath), env.PATH].filter(Boolean).join(':');
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extra };
}

// Fills in what a spawn request leaves out: the user's login-shell environment
// and the shell it names, run as a login shell as Terminal.app does, in the home
// directory. Options the renderer passes win. `-l` belongs to the default shell
// only: a request with its own `command` and no `args` runs it with no argument.
async function withSpawnDefaults(request: PtySpawnRequest): Promise<PtySpawnOptions> {
  const env = await terminalEnv();
  return {
    command: env.SHELL ?? '/bin/zsh',
    args: request.command === undefined ? ['-l'] : [],
    cwd: homedir(),
    env,
    ...request,
  };
}

// A shell was spawned for a page that navigated or was destroyed meanwhile.
class PageGoneError extends Error {
  constructor() {
    super('the page that asked for the shell is gone');
  }
}

// --- The daemon ---------------------------------------------------------------

// The build of this app's daemon: the first 12 hex characters of the SHA-256 of the daemon bundle's
// bytes, Electron's version and node-pty's version, so an update that changes none of them keeps the
// daemon it left running.
function computeBuild(): string {
  if (process.env.COCKPIT_TEST_DAEMON_BUILD) return process.env.COCKPIT_TEST_DAEMON_BUILD;
  const nodePty = createRequire(import.meta.url)('node-pty/package.json') as { version: string };
  return createHash('sha256').update(readFileSync(daemonPath)).update(process.versions.electron).update(nodePty.version).digest('hex').slice(0, 12);
}

const daemonBuild = computeBuild();
const ownFiles = daemonFiles(cockpitHome, PROTOCOL_VERSION, daemonBuild);

interface Daemon {
  client: DaemonClient;
  alive: boolean;
  /** The terminals of this daemon the app knows, by the daemon's id for them. */
  terminals: Map<number, Terminal>;
}

// A terminal of a daemon, under the id the renderer knows it by. Ids count for the app's lifetime,
// across daemons, so the id of a dead daemon's terminal is never reused. The terminals are known
// from what each daemon listed when the app connected, from the spawns and from the exit events: the
// page's list is answered from here, without a round trip, so it does not wait for a busy daemon.
interface Terminal extends TerminalInfo {
  /** The renderer's id for it; `id` is the daemon's. */
  appId: number;
  daemon: Daemon;
  /** The window that receives its output: the one that spawned or last attached it. */
  owner?: WebContents;
  /** The page asked to kill it: it is not listed any more, though its exit has not come yet. */
  closing?: boolean;
}

const terminals = new Map<number, Terminal>();
let lastTerminalId = 0;
let ownDaemon: Daemon | undefined;
let startingOwn: Promise<Daemon> | undefined;
// Why this app's daemon could not start; unset while it can.
let daemonFailure: string | undefined;
// The shells and sessions lost with a daemon that died, until a daemon starts again.
let lostTerminals = 0;
// The daemons of another protocol that hold a shell or a session, by what they listed at launch. They are
// not connected to: `GET /terminals` and `POST /shutdown` are all the app says to them.
let otherDaemons: Array<{ socket: string; terminals: TerminalInfo[] }> = [];
// The user chose "Later" for them: the dialog is not offered again until the next launch.
let outdatedDeferred = false;

function daemonStatus(): DaemonStatus {
  if (daemonFailure !== undefined) return { status: 'down', reason: daemonFailure, log: existsSync(ownFiles.log) };
  return lostTerminals > 0 ? { status: 'stopped', terminals: lostTerminals } : { status: 'running' };
}

// Tells every page that the daemon's status may have changed.
function announceDaemonChange(): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('daemon:changed');
}

function register(daemon: Daemon, info: TerminalInfo, owner?: WebContents): Terminal {
  const terminal: Terminal = { ...info, appId: ++lastTerminalId, daemon, ...(owner && { owner }) };
  daemon.terminals.set(info.id, terminal);
  terminals.set(terminal.appId, terminal);
  return terminal;
}

function end(daemon: Daemon, remote: number, exit: TerminalExit): void {
  const terminal = daemon.terminals.get(remote);
  if (!terminal) return;
  daemon.terminals.delete(remote);
  terminals.delete(terminal.appId);
  if (terminal.sessionId !== undefined) {
    pendingNames.delete(terminal.sessionId);
    // A terminal that ended on its own is not lost: only a daemon that died (`exitCode: null`) leaves the mark.
    // One the page asked to kill (a deleted workspace) is left as it is.
    if (exit.exitCode !== null && !terminal.closing) markClosed(({ id }) => id === terminal.sessionId);
  }
  // One nobody attached to yet (a workspace's, started by the main process) tells every window.
  const hearers = terminal.owner ? [terminal.owner] : BrowserWindow.getAllWindows().map(({ webContents }) => webContents);
  for (const contents of hearers) if (!contents.isDestroyed()) contents.send('pty:exit', terminal.appId, exit);
}

// A workspace session is marked open in `state.json` from its start until its tab closes (`sessions:dismiss`),
// its terminal exits by itself, or its workspace or project goes (the session stays stored): one still marked that
// no daemon holds lost its terminal with a daemon.
function markClosed(match: (session: Session) => boolean): void {
  const open = state.sessions.filter((session) => session.open && match(session));
  if (open.length === 0) return;
  const next = open.reduce((current, { id }) => closeSession(current, id), state);
  saveState(app.getPath('userData'), next);
  state = next;
}

// Takes a connected client into use: its output goes to the window that owns each terminal, its
// status reports to the sidebar, and its loss ends every terminal it held, as a crash does. The
// terminals it already runs are listed (the `commands` ones belong to another app's connection).
async function adopt(client: DaemonClient): Promise<Daemon> {
  const daemon: Daemon = { client, alive: true, terminals: new Map() };
  client.onData(({ id, seq, data }) => {
    const terminal = daemon.terminals.get(id);
    if (terminal?.owner && !terminal.owner.isDestroyed()) terminal.owner.send('pty:data', terminal.appId, data, seq);
  });
  client.onExit(({ id, exitCode, signal }) => end(daemon, id, { exitCode, signal }));
  client.onStatus(reportSessionStatus);
  client.onTitle((event) => void nameFromTitle(event));
  client.onClose(() => {
    daemon.alive = false;
    lostTerminals += [...daemon.terminals.values()].filter(({ kind, closing }) => kind !== 'commands' && !closing).length;
    for (const remote of daemon.terminals.keys()) end(daemon, remote, { exitCode: null, signal: null });
    if (ownDaemon === daemon) ownDaemon = undefined;
    announceDaemonChange();
  });
  for (const info of await client.list().catch(() => [])) {
    if (info.kind === 'commands') continue;
    register(daemon, info);
    if (info.sessionId !== undefined && info.status !== undefined) sessionStatuses.set(info.sessionId, info.status);
    // An id reported while no app was connected.
    if (info.sessionId !== undefined && info.harnessSessionId !== undefined) storeHarnessSessionId(info.sessionId, info.harnessSessionId);
  }
  return daemon;
}

// Starts the daemon of this build: the app's own Electron binary as Node, detached into its own
// session so it outlives the app, with its output in the log.
function spawnDaemon(): ChildProcess {
  mkdirSync(cockpitHome, { recursive: true });
  const log = openSync(ownFiles.log, 'a');
  try {
    const child = spawn(process.execPath, [daemonPath, '--cockpit-daemon', daemonBuild], {
      detached: true,
      stdio: ['ignore', log, log, 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', COCKPIT_HOME: cockpitHome },
    });
    child.on('error', (error) => {
      appendFileSync(ownFiles.log, `${error.message}\n`);
      child.emit('exit', 1, null);
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

// This app's daemon, started when it is not running. Rejects with the reason it cannot start.
function ensureOwnDaemon(): Promise<Daemon> {
  if (ownDaemon?.alive) {
    // Terminals lost with another build's daemon are over: nothing stopped is left to restart.
    if (lostTerminals > 0) {
      lostTerminals = 0;
      announceDaemonChange();
    }
    return Promise.resolve(ownDaemon);
  }
  startingOwn ??= (async () => {
    const before = JSON.stringify(daemonStatus());
    try {
      ownDaemon = await adopt(await ensureDaemon({ home: cockpitHome, build: daemonBuild, spawn: spawnDaemon }));
      daemonFailure = undefined;
      lostTerminals = 0;
      return ownDaemon;
    } catch (error) {
      daemonFailure = error instanceof Error ? error.message : String(error);
      throw new Error(daemonFailure);
    } finally {
      startingOwn = undefined;
      if (JSON.stringify(daemonStatus()) !== before) announceDaemonChange();
    }
  })();
  return startingOwn;
}

// Connects to this app's daemon, starting it when needed, and to the daemons of other builds that
// still hold terminals (their app was updated): the older ones first, so the terminals list in
// creation order. Saying hello with this build supersedes them: one with no terminal exits.
// A daemon that cannot start is reported, never thrown: the app opens its window all the same.
async function connectDaemons(): Promise<void> {
  const others = listDaemonFiles(cockpitHome)
    .filter(({ protocol, build }) => protocol === PROTOCOL_VERSION && build !== daemonBuild)
    .map((found) => ({ found, since: statSync(found.pid, { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => a.since - b.since);
  for (const { found } of others) {
    try {
      const client = await connectDaemon(found.socket);
      await client.hello(daemonBuild);
      await adopt(client);
    } catch (error) {
      // Stale files of a daemon that is gone say nothing; one that is there and silent is noted.
      if (error instanceof DaemonNotAnsweringError) console.error(`Cockpit skipped a background service of another build: ${error.message}`);
    }
  }
  // The daemons of other protocols are listed, never connected to: their terminals are the dialog's.
  for (const { socket } of listDaemonFiles(cockpitHome).filter(({ protocol }) => protocol !== PROTOCOL_VERSION)) {
    try {
      const held = (await readTerminals(socket)).filter(({ kind }) => kind !== 'commands');
      if (held.length > 0) otherDaemons.push({ socket, terminals: held });
    } catch (error) {
      // Stale files of a daemon that is gone say nothing; one that is there and silent is noted.
      if (error instanceof DaemonNotAnsweringError) console.error(`Cockpit skipped a background service of another protocol: ${error.message}`);
    }
  }
  try {
    await ensureOwnDaemon();
  } catch {
    console.error(`Cockpit's background service could not start: ${daemonFailure}`);
  }
}

// Terminals live in the daemon, which outlives the page and the app. Returns what the main process
// needs to run a terminal of its own.
function startTerminals() {
  // How many times each page's setup and teardown runs were ended (a navigation, a destroyed page).
  const endings = new WeakMap<WebContents, number>();
  const endingsOf = (contents: WebContents) => endings.get(contents) ?? 0;

  const kill = (appId: number) => {
    const terminal = terminals.get(appId);
    if (!terminal) return;
    terminal.closing = true;
    terminal.daemon.client.kill(terminal.id);
  };

  // Spawns with the defaults, for the window that will receive the output (none: the main process starts
  // it for a workspace being set up, and the page that shows it attaches later). A spawn that resolves
  // after its page navigated or was destroyed (the daemon was busy) is killed at once: no page is
  // left to own it, and it throws `PageGoneError`. `before` is the page's ending count the caller
  // read when it started waiting.
  const spawnFor = async (
    contents: WebContents | undefined,
    request: PtySpawnRequest,
    { kind, sessionId, workspace, agentTitles, before = contents && endingsOf(contents) }: { kind: TerminalKind; sessionId?: string; workspace?: string; agentTitles?: SpawnOptions['agentTitles']; before?: number },
  ) => {
    const daemon = await ensureOwnDaemon();
    const options = await withSpawnDefaults(request);
    const { command, cwd, cols, rows } = options;
    const remote = await daemon.client.spawn({
      kind,
      ...options,
      ...(sessionId !== undefined && { sessionId }),
      ...(workspace !== undefined && { workspace }),
      ...(agentTitles && { agentTitles }),
    });
    const terminal = register(
      daemon,
      { id: remote, kind, command, cwd, cols, rows, ...(sessionId !== undefined && { sessionId }), ...(workspace !== undefined && { workspace }) },
      contents,
    );
    if (contents && (contents.isDestroyed() || endingsOf(contents) !== before)) {
      kill(terminal.appId);
      throw new PageGoneError();
    }
    return terminal.appId;
  };

  ipcMain.handle('pty:spawn', (event, request: PtySpawnRequest) => {
    if (!isFromApp(event)) throw new Error('pty:spawn refused: unexpected origin');
    // A shell of a workspace runs in its worktree.
    const { workspace, ...options } = request;
    const spawning: PtySpawnRequest = workspace === undefined ? options : { cwd: workspace, ...options };
    // The reply of a page that is gone reaches no one: the handler does not reject for it.
    return spawnFor(event.sender, spawning, { kind: 'shell', workspace }).catch((error: unknown) => {
      if (error instanceof PageGoneError) return -1;
      throw error;
    });
  });
  ipcMain.on('pty:write', (event, id: number, data: string) => {
    const terminal = isFromApp(event) ? terminals.get(id) : undefined;
    terminal?.daemon.client.write(terminal.id, data);
  });
  ipcMain.on('pty:resize', (event, id: number, cols: number, rows: number) => {
    const terminal = isFromApp(event) ? terminals.get(id) : undefined;
    if (!terminal) return;
    terminal.cols = cols;
    terminal.rows = rows;
    terminal.daemon.client.resize(terminal.id, cols, rows);
  });
  ipcMain.on('pty:kill', (event, id: number) => {
    if (isFromApp(event)) kill(id);
  });

  // The shells and sessions the connected daemons run, for a page that starts and shows them again.
  // Setup and teardown runs end with their page and are not listed.
  ipcMain.handle('pty:list', (event): ListedTerminal[] => {
    if (!isFromApp(event)) throw new Error('pty:list refused: unexpected origin');
    return [...terminals.values()].flatMap(({ appId, kind, cwd, cols, rows, sessionId, workspace, setup, exitCode, closing }) => {
      if (kind === 'commands' || closing) return [];
      const status = sessionId === undefined ? undefined : sessionStatuses.get(sessionId);
      return [{ id: appId, kind, cwd, cols, rows, ...(sessionId !== undefined && { sessionId }), ...(workspace !== undefined && { workspace }), ...(status && { status }), ...(setup && { setup }), ...(exitCode !== undefined && { exitCode }) }];
    });
  });

  ipcMain.handle('pty:attach', async (event, id: number) => {
    if (!isFromApp(event)) throw new Error('pty:attach refused: unexpected origin');
    const terminal = terminals.get(id);
    if (!terminal) throw new Error(`no terminal ${id}`);
    // The output that follows reaches this window, with a sequence number above the screen's.
    terminal.owner = event.sender;
    return terminal.daemon.client.attach(terminal.id);
  });

  // A page's setup and teardown runs end with it: when its main frame commits another document (a
  // reload included) or the page is destroyed. Its shells and sessions run on, in the daemon.
  // `did-navigate` fires only for a committed main-frame document, so a navigation that
  // `will-navigate` cancels, and route changes inside the app (same-document), end nothing. A main
  // frame that commits an error page fires `did-fail-load` instead (an aborted navigation,
  // `ERR_ABORTED`, commits nothing and ends nothing).
  const endRunsOf = (contents: WebContents) => {
    endings.set(contents, endingsOf(contents) + 1);
    for (const terminal of terminals.values()) if (terminal.owner === contents && terminal.kind === 'commands') kill(terminal.appId);
  };
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-navigate', () => endRunsOf(contents));
    contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== ERR_ABORTED) endRunsOf(contents);
    });
    contents.on('destroyed', () => endRunsOf(contents));
  });

  ipcMain.handle('daemon:status', (event) => {
    if (!isFromApp(event)) throw new Error('daemon:status refused: unexpected origin');
    return daemonStatus();
  });
  ipcMain.handle('daemon:retry', async (event) => {
    if (!isFromApp(event)) throw new Error('daemon:retry refused: unexpected origin');
    await ensureOwnDaemon().catch(() => {});
    return daemonStatus();
  });
  ipcMain.handle('daemon:show-log', async (event) => {
    if (!isFromApp(event)) throw new Error('daemon:show-log refused: unexpected origin');
    await shell.openPath(ownFiles.log);
  });

  // The terminals of daemons of another protocol, for the dialog that offers to end them.
  ipcMain.handle('daemon:outdated', (event): OutdatedTerminal[] => {
    if (!isFromApp(event)) throw new Error('daemon:outdated refused: unexpected origin');
    if (outdatedDeferred) return [];
    return otherDaemons.flatMap(({ terminals: held }) =>
      held.map(({ kind, command, sessionId, status }) => {
        const session = sessionId === undefined ? undefined : state.sessions.find(({ id }) => id === sessionId);
        return {
          kind: kind === 'session' ? 'session' : 'shell',
          name: session?.name ?? (kind === 'session' ? 'Session' : 'Terminal'),
          program: harnesses.find(({ id }) => id === session?.harness)?.name ?? basename(command),
          ...(status && { status }),
        };
      }),
    );
  });
  ipcMain.handle('daemon:restart', async (event): Promise<{ status: 'restarted' } | Refused> => {
    if (!isFromApp(event)) throw new Error('daemon:restart refused: unexpected origin');
    const remaining: typeof otherDaemons = [];
    let failure: string | undefined;
    for (const daemon of otherDaemons) {
      try {
        await shutdownDaemon(daemon.socket);
      } catch (error) {
        remaining.push(daemon);
        failure ??= error instanceof Error ? error.message : String(error);
      }
    }
    otherDaemons = remaining;
    return failure === undefined ? { status: 'restarted' } : { status: 'refused', message: failure };
  });
  ipcMain.handle('daemon:later', (event) => {
    if (!isFromApp(event)) throw new Error('daemon:later refused: unexpected origin');
    outdatedDeferred = true;
  });

  return { spawnFor, endingsOf, kill };
}

// Why git could not do what was asked of `path`, in words for the user.
function describeFailure(error: WorkspaceError, path: string): string {
  return error.code === 'NOT_A_REPOSITORY' ? `${path} is not a git repository.` : error.message;
}

// Whether the project has its main workspace, the one with no worktree.
const hasMainWorkspace = (project: string) => state.projects.some((entry) => entry.path === project && entry.mainWorkspace === true);
// The main workspace's path is its project's.
const isMainWorkspace = (project: string, path: string) => path === project && hasMainWorkspace(project);

// Whether the main workspace's `branch` is the base the changes are compared with: it has no pull request of its own,
// and `gh pr list --head` would match a fork's of that name.
async function onBaseBranch(project: string, branch: string | null): Promise<boolean> {
  if (branch === null) return false;
  const { defaultBase } = await listBranches(project, { env: await shellEnv });
  return defaultBase?.replace(/^origin\//, '') === branch;
}

// A project with its workspaces, which git tells: the linked worktrees, and the main working tree when the project has its main workspace.
async function toProject({ path, mainWorkspace }: { path: string; mainWorkspace?: boolean }): Promise<Project> {
  const project = { path, name: basename(path) };
  // An absent folder, or a path that is not a folder (a file took its place), is "not found"; any other failure
  // (EACCES, EIO…) goes on to git, as before.
  const gone = await stat(path).then(
    (found) => !found.isDirectory(),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR',
  );
  if (gone) return { ...project, workspaces: [], missing: true };
  try {
    const worktrees = await listWorktrees(path, { env: await shellEnv });
    const workspaces: Workspace[] = worktrees
      .filter((worktree) => mainWorkspace || !worktree.main)
      .map(({ path, branch, name, main }): Workspace =>
        main ? { path, name: branch ?? basename(path), branch, main: true } : { path, name: name ?? branch ?? basename(path), branch },
      );
    // A workspace being set up is a row from the reservation on, whether git lists its worktree yet or not.
    for (const setup of setups.values()) {
      if (setup.project !== path) continue;
      const listed = workspaces.find((workspace) => workspace.path === setup.path);
      if (listed) listed.settingUp = true;
      else workspaces.push({ path: setup.path, name: setup.branch, branch: setup.branch, settingUp: true });
    }
    return { ...project, workspaces };
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return { ...project, workspaces: [], error: describeFailure(error, path) };
  }
}

// What a refused worktree creation says, for the errors that name the branch or the worktrees folder.
function creationRefusal(error: WorkspaceError, name: string): string | undefined {
  if (error.code === 'BRANCH_EXISTS') return `A branch named ${name} already exists.`;
  if (error.code === 'INVALID_BRANCH_NAME') return `${name} is not a valid branch name.`;
  if (error.code === 'FS_FAILED') {
    const errno = (error.cause as NodeJS.ErrnoException | undefined)?.code ?? error.message;
    return `Cockpit could not create its worktrees folder ${worktreesRoot}: ${errno}.`;
  }
  return undefined;
}

// The terminal size a workspace's first terminal starts at; the page that shows it resizes it.
const SETUP_SIZE = { cols: 80, rows: 24 };

// Tells every window that a workspace stopped setting up.
function settle(settled: SettledSetup): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('workspaces:settled', settled);
}

// git is checked on the first `projects:git` call and the answer kept for the launch.
let gitCheck: Promise<'ok' | 'missing'> | undefined;

// The projects the user added, kept in `state.json`.
function startProjects(
  userData: string,
  { spawnFor, endingsOf }: ReturnType<typeof startTerminals>,
  startSession: ReturnType<typeof startSessions>,
): void {
  ipcMain.handle('projects:list', (event) => {
    if (!isFromApp(event)) throw new Error('projects:list refused: unexpected origin');
    return Promise.all(state.projects.map(toProject));
  });

  ipcMain.handle('projects:git', (event) => {
    if (!isFromApp(event)) throw new Error('projects:git refused: unexpected origin');
    gitCheck ??= shellEnv
      .then((env) => checkGit(env))
      .then(
        () => 'ok' as const,
        (error) => (error instanceof WorkspaceError && error.code === 'GIT_MISSING' ? ('missing' as const) : ('ok' as const)),
      );
    return gitCheck;
  });

  // The folder the user picks in the system dialog, `undefined` when cancelled.
  async function pickFolder(event: IpcMainInvokeEvent): Promise<string | undefined> {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory' as const] };
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    return picked.canceled ? undefined : picked.filePaths[0];
  }

  // Saves `next` and makes it the state; a refusal when the save fails leaves the state as it was.
  function commit(next: State): Refused | undefined {
    try {
      saveState(userData, next);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'refused', message: `Cockpit could not save its data: ${reason}` };
    }
    state = next;
    return undefined;
  }

  // The one way a repository becomes a project: add its root to the state, save, list it. A refusal
  // changes nothing.
  async function addRoot(root: string): Promise<AddProjectResult> {
    try {
      const refused = commit(addProject(state, root));
      if (refused) return refused;
      return { status: 'added', project: await toProject({ path: root }) };
    } catch (error) {
      if (error instanceof ProjectExistsError) {
        return { status: 'refused', message: `${basename(error.path)} is already in Cockpit.` };
      }
      throw error;
    }
  }

  // Runs `action`, turning a git failure into a refusal that carries git's message.
  async function refusing(action: () => Promise<AddProjectResult>): Promise<AddProjectResult> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof WorkspaceError) return { status: 'refused', message: error.message };
      throw error;
    }
  }

  const addAt = async (folder: string) => addRoot(await findRepositoryRoot(folder, { env: await shellEnv }));

  ipcMain.handle('projects:add', async (event): Promise<AddProjectResult> => {
    if (!isFromApp(event)) throw new Error('projects:add refused: unexpected origin');
    const folder = await pickFolder(event);
    if (folder === undefined) return { status: 'cancelled' };
    try {
      return await addAt(folder);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'NOT_A_REPOSITORY') return { status: 'not-a-repository', folder };
      if (error instanceof WorkspaceError) return { status: 'refused', message: error.message };
      throw error;
    }
  });

  ipcMain.handle('projects:init', (event, folder: string): Promise<AddProjectResult> => {
    if (!isFromApp(event)) throw new Error('projects:init refused: unexpected origin');
    return refusing(async () => {
      await initRepository({ path: folder, env: await shellEnv });
      return addAt(folder);
    });
  });

  ipcMain.handle('projects:pick-folder', async (event): Promise<string | null> => {
    if (!isFromApp(event)) throw new Error('projects:pick-folder refused: unexpected origin');
    return (await pickFolder(event)) ?? null;
  });

  ipcMain.handle('projects:home', (event) => {
    if (!isFromApp(event)) throw new Error('projects:home refused: unexpected origin');
    return homedir();
  });

  const badName = (name: string): Refused | undefined => {
    const message = name === '' ? 'A project name is required.' : nameProblem(name);
    return message ? { status: 'refused', message } : undefined;
  };

  // The running clone: ended by the Cancel button, by the page that asked for it navigating away or closing.
  let cloning: AbortController | undefined;

  ipcMain.handle('projects:clone', async (event, request: CloneRequest): Promise<AddProjectResult> => {
    if (!isFromApp(event)) throw new Error('projects:clone refused: unexpected origin');
    const invalid = badName(request.name);
    if (invalid) return invalid;
    const path = join(request.location, request.name);
    const controller = new AbortController();
    const abort = () => controller.abort();
    cloning = controller;
    event.sender.once('did-navigate', abort);
    event.sender.once('destroyed', abort);
    try {
      const env = await shellEnv;
      await cloneRepository({ url: request.url, path, env, signal: controller.signal });
      return await addAt(path);
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled' };
      if (error instanceof WorkspaceError) return { status: 'refused', message: error.message };
      throw error;
    } finally {
      if (cloning === controller) cloning = undefined;
      event.sender.removeListener('did-navigate', abort);
      event.sender.removeListener('destroyed', abort);
    }
  });

  ipcMain.handle('projects:cancel-clone', (event) => {
    if (!isFromApp(event)) throw new Error('projects:cancel-clone refused: unexpected origin');
    cloning?.abort();
  });

  ipcMain.handle('projects:create', async (event, request: CreateRequest): Promise<AddProjectResult> => {
    if (!isFromApp(event)) throw new Error('projects:create refused: unexpected origin');
    const invalid = badName(request.name);
    if (invalid) return invalid;
    const path = join(request.location, request.name);
    if (existsSync(path)) return { status: 'refused', message: `${path} already exists.` };
    return refusing(async () => {
      try {
        await mkdir(request.location, { recursive: true });
        await mkdir(path);
      } catch (error) {
        return { status: 'refused', message: `Cockpit could not create ${path}: ${(error as NodeJS.ErrnoException).code ?? error}` };
      }
      try {
        await initRepository({ path, env: await shellEnv });
        return await addAt(path);
      } catch (error) {
        await rm(path, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  });

  ipcMain.handle('projects:remove', (event, path: string) => {
    if (!isFromApp(event)) throw new Error('projects:remove refused: unexpected origin');
    const next = removeProject(state, path);
    if (next.projects.length === state.projects.length) return;
    saveState(userData, next);
    state = next;
    markClosed(({ project }) => project === path);
  });

  // The project at `from` moved: the user picks its repository again. Its worktrees are reconnected after the
  // state is saved, and a repair that fails (the workspaces then show git's error) does not undo the update.
  ipcMain.handle('projects:update-path', async (event, from: string): Promise<UpdatePathResult> => {
    if (!isFromApp(event)) throw new Error('projects:update-path refused: unexpected origin');
    // The sidebar's list can be stale (the project was removed from another window).
    if (!state.projects.some((project) => project.path === from)) {
      return { status: 'refused', message: `${from} is not a project in Cockpit.` };
    }
    const folder = await pickFolder(event);
    if (folder === undefined) return { status: 'cancelled' };
    try {
      const env = await shellEnv;
      const root = await findRepositoryRoot(folder, { env });
      const refused = commit(updateProjectPath(state, from, root));
      if (refused) return refused;
      await repairWorktrees(root, { env }).catch(() => {});
      return { status: 'updated' };
    } catch (error) {
      if (error instanceof ProjectExistsError) return { status: 'refused', message: `${basename(error.path)} is already in Cockpit.` };
      if (error instanceof WorkspaceError) {
        return { status: 'refused', message: error.code === 'NOT_A_REPOSITORY' ? `${folder} is not in a git repository.` : error.message };
      }
      throw error;
    }
  });

  // Runs `action` for a project of the state, turning a git failure into a refusal (or into what
  // `handle` makes of it). `Result` is one of the `Refused` unions of the API.
  async function forProject<Result extends { status: string }>(
    event: IpcMainInvokeEvent,
    channel: string,
    path: string,
    action: () => Promise<Result>,
    handle: (error: WorkspaceError) => Result | undefined = () => undefined,
  ): Promise<Result | Refused> {
    if (!isFromApp(event)) throw new Error(`${channel} refused: unexpected origin`);
    if (!state.projects.some((project) => project.path === path)) {
      return { status: 'refused', message: `${path} is not a project in Cockpit.` };
    }
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      return handle(error) ?? { status: 'refused', message: describeFailure(error, path) };
    }
  }

  ipcMain.handle('workspaces:branches', (event, project: string): Promise<BranchesResult> =>
    forProject<BranchesResult>(event, 'workspaces:branches', project, async () => {
      const branches = await listBranches(project, { env: await shellEnv });
      return { status: 'listed', ...branches };
    }),
  );

  // The branch is named after the task, with a free name: not a local branch, not an existing worktree folder.
  ipcMain.handle('workspaces:create', (event, project: string, task: string, base: string): Promise<CreateWorkspaceResult> => {
    let name = task;
    return forProject<CreateWorkspaceResult>(
      event,
      'workspaces:create',
      project,
      async () => {
        const env = await shellEnv;
        name = await availableBranch(project, task, { env, root: worktreesRoot });
        const { path, branch } = await createWorktree({ repo: project, root: worktreesRoot, branch: name, base, env });
        return { status: 'created', workspace: { path, name: branch ?? basename(path), branch } };
      },
      (error) => {
        const message = creationRefusal(error, name);
        return message === undefined ? undefined : { status: 'refused', message };
      },
    );
  });

  // Makes the worktree (none for the main workspace, which opens the project's folder), then starts the agent (or
  // the setup shell) in it, with no page: the workspace page may be gone, reloaded or elsewhere meanwhile. The row
  // is a "setting up" one until this ends.
  async function runSetup({ project, path, branch, base, harness, task }: Setup): Promise<void> {
    if (base !== null) {
      try {
        await createWorktree({ repo: project, root: worktreesRoot, branch, base, env: await shellEnv });
      } catch (error) {
        const message =
          error instanceof WorkspaceError ? (creationRefusal(error, branch) ?? describeFailure(error, project)) : error instanceof Error ? error.message : String(error);
        failedSetups.push({ id: randomUUID(), project, path, name: branch, message, prompt: task, agent: harness, base });
        setups.delete(path);
        settle({ path });
        return;
      }
    }
    let message: string | undefined;
    try {
      if (harness === 'terminal') {
        // As the agent's start does: no shell for a project that is gone.
        const found = await findWorkspace({ project, path });
        if ('status' in found) message = found.message;
        // The repository's setup, then the login shell (the main workspace runs no setup).
        else {
          const command = base === null ? {} : { command: cliPath, args: ['setup', '--shell'] };
          await spawnFor(undefined, { ...SETUP_SIZE, cwd: path, ...command }, { kind: 'shell', workspace: path });
        }
      } else {
        const started = await startSession(undefined, harness, SETUP_SIZE, {
          workspace: { project, path },
          setup: base !== null,
          prompt: task,
          nameFromTitle: base !== null,
        });
        if (started.status === 'refused') message = started.message;
      }
    } catch (error) {
      message = `Could not start Terminal: ${error instanceof Error ? error.message : String(error)}`;
    }
    setups.delete(path);
    settle({ path, ...(message !== undefined && { message }) });
  }

  // Reserves the branch and the worktree's path, answers, and sets the workspace up in the background. A `null`
  // base is the main workspace: the project is marked and its path is the workspace's, named after its branch.
  ipcMain.handle('workspaces:compose', (event, project: string, task: string, base: string | null, harness: string): Promise<ComposeResult> => {
    let name = task;
    return forProject<ComposeResult>(
      event,
      'workspaces:compose',
      project,
      async () => {
        const env = await shellEnv;
        let path = project;
        if (base === null) {
          name = workspaceName((await listWorktrees(project, { env })).find((worktree) => worktree.main)!);
          if (!hasMainWorkspace(project)) {
            const refused = commit(setMainWorkspace(state, project, true));
            if (refused) return refused;
          }
        } else {
          const taken = [...setups.values()].filter((setup) => setup.project === project).map((setup) => setup.branch);
          name = await availableBranch(project, task, { env, root: worktreesRoot, reserved: taken });
          path = await reservedPath({ repo: project, root: worktreesRoot, branch: name, env });
        }
        const setup: Setup = { project, path, branch: name, base, harness, task };
        setups.set(path, setup);
        void runSetup(setup);
        return { status: 'reserved', path, name };
      },
      (error) => {
        const message = creationRefusal(error, name);
        return message === undefined ? undefined : { status: 'refused', message };
      },
    );
  });

  ipcMain.handle('workspaces:failed-setups', (event): FailedSetup[] => {
    if (!isFromApp(event)) throw new Error('workspaces:failed-setups refused: unexpected origin');
    return failedSetups;
  });
  ipcMain.handle('workspaces:dismiss-setup', (event, id: string): void => {
    if (!isFromApp(event)) throw new Error('workspaces:dismiss-setup refused: unexpected origin');
    failedSetups = failedSetups.filter((failed) => failed.id !== id);
  });

  ipcMain.handle('workspaces:removal', (event, project: string, path: string): Promise<RemovalResult> =>
    forProject<RemovalResult>(event, 'workspaces:removal', project, async () => {
      // Nothing is removed from the disk: the dialog has nothing to warn of.
      if (isMainWorkspace(project, path)) return { status: 'read', uncommitted: false, merged: null };
      const { uncommitted, merged } = await removalState({ repo: project, path, env: await shellEnv });
      return { status: 'read', uncommitted, merged };
    }),
  );

  ipcMain.handle(
    'workspaces:remove',
    (
      event,
      project: string,
      path: string,
      options: { force?: boolean; deleteBranch?: boolean; forceBranch?: string },
    ): Promise<RemoveWorkspaceResult> =>
      forProject<RemoveWorkspaceResult>(
        event,
        'workspaces:remove',
        project,
        async () => {
          // The folder is the user's: only the mark goes, and the sessions close.
          if (isMainWorkspace(project, path)) {
            const refused = commit(setMainWorkspace(state, project, false));
            if (refused) return refused;
            markClosed(({ directory }) => directory === path);
            return { status: 'removed', branchKept: false };
          }
          await removeWorktree({
            repo: project,
            path,
            force: options.force,
            deleteBranch: options.deleteBranch,
            forceBranch: options.forceBranch,
            env: await shellEnv,
          });
          markClosed(({ directory }) => directory === path);
          return { status: 'removed', branchKept: false };
        },
        (error) => {
          if (error.code === 'BRANCH_NOT_MERGED') {
            markClosed(({ directory }) => directory === path);
            return { status: 'removed', branchKept: true };
          }
          if (error.code === 'DIRTY_WORKTREE') return { status: 'dirty' };
          return undefined;
        },
      ),
  );

  // The editors and terminals of the catalogue found on this machine, looked up at each call.
  // The app shown for a kind is the remembered one when detected, else the first detected.
  ipcMain.handle('workspaces:apps', async (event): Promise<AppsResult> => {
    if (!isFromApp(event)) throw new Error('workspaces:apps refused: unexpected origin');
    const detected = await detectApps(applicationDirs);
    const available = (kind: App['kind']) =>
      apps.filter((entry) => entry.kind === kind && detected.some(({ id }) => id === entry.id)).map(({ id, name }) => ({ id, name }));
    const shown = (kind: App['kind']) => {
      const list = available(kind);
      return (list.find(({ id }) => id === state[kind]) ?? list[0])?.id ?? null;
    };
    return { editors: available('editor'), terminals: available('terminal'), editor: shown('editor'), terminal: shown('terminal') };
  });

  async function revealFolder(path: string): Promise<OpenWorkspaceResult> {
    try {
      await reveal(path, { env: await shellEnv });
      return { status: 'opened' };
    } catch (error) {
      if (!(error instanceof LaunchError)) throw error;
      return { status: 'refused', message: `Could not reveal ${path} in the Finder: ${error.message}` };
    }
  }

  // Opens the folder in a detected app by its bundle's path, then remembers the app.
  async function openFolder(path: string, appId: string): Promise<OpenWorkspaceResult> {
    const entry = apps.find(({ id }) => id === appId);
    const bundle = entry && (await detectApps(applicationDirs)).find(({ id }) => id === entry.id);
    if (!entry || !bundle) return { status: 'refused', message: `${entry?.name ?? appId} is not installed.` };
    try {
      await openIn(bundle.path, path, { env: await shellEnv });
    } catch (error) {
      if (!(error instanceof LaunchError)) throw error;
      return { status: 'refused', message: `Could not open ${path} in ${entry.name}: ${error.message}` };
    }
    if (state[entry.kind] === entry.id) return { status: 'opened' };
    const next = rememberApp(state, entry.kind, entry.id);
    try {
      saveState(userData, next);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'refused', message: `Cockpit could not save its data: ${reason}` };
    }
    state = next;
    return { status: 'opened' };
  }

  ipcMain.handle('workspaces:reveal', async (event, project: string, path: string): Promise<OpenWorkspaceResult> => {
    if (!isFromApp(event)) throw new Error('workspaces:reveal refused: unexpected origin');
    const workspace = await findWorkspace({ project, path });
    if ('status' in workspace) return workspace;
    return revealFolder(path);
  });

  ipcMain.handle('workspaces:open', async (event, project: string, path: string, appId: string): Promise<OpenWorkspaceResult> => {
    if (!isFromApp(event)) throw new Error('workspaces:open refused: unexpected origin');
    const workspace = await findWorkspace({ project, path });
    if ('status' in workspace) return workspace;
    return openFolder(path, appId);
  });

  ipcMain.handle('projects:reveal', (event, path: string): Promise<OpenWorkspaceResult> =>
    forProject<OpenWorkspaceResult>(event, 'projects:reveal', path, () => revealFolder(path)),
  );

  ipcMain.handle('projects:open', (event, path: string, appId: string): Promise<OpenWorkspaceResult> =>
    forProject<OpenWorkspaceResult>(event, 'projects:open', path, () => openFolder(path, appId)),
  );

  ipcMain.handle('workspaces:changes', (event, project: string, path: string): Promise<ChangesResult> =>
    forProject<ChangesResult>(event, 'workspaces:changes', project, async () => {
      const workspace = await findWorkspace({ project, path });
      if ('status' in workspace) return workspace;
      try {
        return { status: 'listed', ...(await listChanges(path, { env: await shellEnv })) };
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'NO_BASE') {
          return { status: 'refused', message: `No base branch to compare ${workspaceName(workspace)} with.` };
        }
        throw error;
      }
    }),
  );

  ipcMain.handle('workspaces:diff', (event, project: string, path: string, file: ChangedFile): Promise<DiffResult> =>
    forProject<DiffResult>(event, 'workspaces:diff', project, async () => {
      const workspace = await findWorkspace({ project, path });
      if ('status' in workspace) return workspace;
      return { status: 'shown', diff: await fileDiff(path, file, { env: await shellEnv }) };
    }),
  );

  ipcMain.handle('workspaces:status', (event, project: string, path: string): Promise<BranchStatusResult> =>
    forProject<BranchStatusResult>(event, 'workspaces:status', project, async () => {
      const workspace = await findWorkspace({ project, path });
      if ('status' in workspace) return workspace;
      const env = await shellEnv;
      return { status: 'read', ...(await branchStatus(path, { env })), subject: await headSubject(path, { env }) };
    }),
  );

  ipcMain.handle('workspaces:commit', (event, project: string, path: string, message: string): Promise<CommitResult> =>
    forProject<CommitResult>(
      event,
      'workspaces:commit',
      project,
      async () => {
        const workspace = await findWorkspace({ project, path });
        if ('status' in workspace) return workspace;
        if (message.trim() === '') return { status: 'refused', message: 'Write a commit message.' };
        const env = await shellEnv;
        if (!(await branchStatus(path, { env })).uncommitted) return { status: 'refused', message: 'Nothing to commit.' };
        await commitAll(path, message.trim(), { env });
        return { status: 'committed' };
      },
      (error) => (error.code === 'GIT_FAILED' ? { status: 'refused', message: `Could not commit: ${error.message}` } : undefined),
    ),
  );

  ipcMain.handle('workspaces:push', (event, project: string, path: string): Promise<PushResult> =>
    forProject<PushResult>(event, 'workspaces:push', project, async () => {
      const workspace = await findWorkspace({ project, path });
      if ('status' in workspace) return workspace;
      if (workspace.branch === null) return { status: 'refused', message: `${workspaceName(workspace)} has no branch.` };
      try {
        await pushBranch(path, { env: await shellEnv });
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== 'GIT_FAILED') throw error;
        return { status: 'refused', message: `Could not push ${workspace.branch}: ${error.message}` };
      }
      return { status: 'pushed' };
    }),
  );

  ipcMain.handle('workspaces:pull-request', (event, project: string, path: string): Promise<PullRequestResult> =>
    forProject<PullRequestResult>(event, 'workspaces:pull-request', project, async () => {
      const workspace = await findWorkspace({ project, path });
      if ('status' in workspace) return workspace;
      if (workspace.branch === null || (isMainWorkspace(project, path) && (await onBaseBranch(project, workspace.branch)))) {
        return { status: 'read', pullRequest: null };
      }
      try {
        return { status: 'read', pullRequest: await findPullRequest(path, workspace.branch, { env: await shellEnv }) };
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        return { status: 'refused', message: describeReadFailure(error) };
      }
    }),
  );

  ipcMain.handle(
    'workspaces:create-pull-request',
    (event, project: string, path: string, title: string, body: string): Promise<CreatePullRequestResult> =>
      forProject<CreatePullRequestResult>(event, 'workspaces:create-pull-request', project, async () => {
        const workspace = await findWorkspace({ project, path });
        if ('status' in workspace) return workspace;
        if (title.trim() === '') return { status: 'refused', message: 'Write a title.' };
        if (workspace.branch === null) return { status: 'refused', message: `${workspaceName(workspace)} has no branch.` };
        const env = await shellEnv;
        const { base } = await listChanges(path, { env });
        try {
          const pullRequest = await createPullRequest(
            path,
            { base: base.replace(/^origin\//, ''), head: workspace.branch, title: title.trim(), body },
            { env },
          );
          return { status: 'created', pullRequest };
        } catch (error) {
          if (!(error instanceof GitHubError)) throw error;
          return { status: 'refused', message: `Could not create the pull request: ${error.message}` };
        }
      }),
  );

  const MERGE_METHODS = ['squash', 'merge', 'rebase'];

  ipcMain.handle(
    'workspaces:merge-pull-request',
    (event, project: string, path: string, number: number, method: string, headOid: string): Promise<MergePullRequestResult> =>
      forProject<MergePullRequestResult>(event, 'workspaces:merge-pull-request', project, async () => {
        if (!MERGE_METHODS.includes(method)) return { status: 'refused', message: `${String(method)} is not a merge method.` };
        if (!Number.isInteger(number) || number < 1 || !/^[0-9a-f]{7,64}$/i.test(String(headOid))) {
          return { status: 'refused', message: 'The pull request to merge is unknown.' };
        }
        const workspace = await findWorkspace({ project, path });
        if ('status' in workspace) return workspace;
        if (workspace.branch === null) return { status: 'refused', message: `${workspaceName(workspace)} has no branch.` };
        try {
          await mergePullRequest(path, { number, method: method as MergeMethod, headOid }, { env: await shellEnv });
          return { status: 'merged' };
        } catch (error) {
          if (!(error instanceof GitHubError)) throw error;
          return { status: 'refused', message: `Could not merge the pull request: ${error.message}` };
        }
      }),
  );

  ipcMain.handle('workspaces:commits-after', (event, project: string, path: string, headOid: string): Promise<CommitsAfterResult> =>
    forProject<CommitsAfterResult>(event, 'workspaces:commits-after', project, async () => {
      if (!/^[0-9a-f]{40}$/i.test(String(headOid))) return { status: 'refused', message: 'The pull request head is unknown.' };
      const workspace = await findWorkspace({ project, path });
      if ('status' in workspace) return workspace;
      return { status: 'read', count: await commitsAfter(path, headOid, { env: await shellEnv }) };
    }),
  );

  // One `gh` run for the project's workspaces; none when no workspace has a branch or the repository has no remote.
  ipcMain.handle('workspaces:pull-request-states', (event, project: string): Promise<PullRequestStatesResult> =>
    forProject<PullRequestStatesResult>(event, 'workspaces:pull-request-states', project, async () => {
      const env = await shellEnv;
      const worktrees = await listWorktrees(project, { env });
      // The main working tree counts for a marked project, unless it is on the base branch.
      const withMain = hasMainWorkspace(project) && !(await onBaseBranch(project, worktrees.find((worktree) => worktree.main)?.branch ?? null));
      const branches = worktrees.flatMap((worktree) => ((worktree.main && !withMain) || worktree.branch === null ? [] : [worktree.branch]));
      if (branches.length === 0 || !(await hasRemote(project, { env }))) return { status: 'read', states: {} };
      try {
        return { status: 'read', states: await pullRequestStates(project, branches, { env }) };
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        return { status: 'refused', message: describeReadFailure(error) };
      }
    }),
  );

  // The worktree each window's page watches, at most one per window. A request is checked against
  // the state and git before its watcher starts: `requests` counts what the window asked, so that a
  // check that returns after an unwatch, a newer watch or a navigation starts nothing.
  const watchers = new Map<WebContents, { close(): void }>();
  const requests = new WeakMap<WebContents, number>();
  const unwatch = (contents: WebContents): number => {
    const request = (requests.get(contents) ?? 0) + 1;
    requests.set(contents, request);
    watchers.get(contents)?.close();
    watchers.delete(contents);
    return request;
  };
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-navigate', () => unwatch(contents));
    // An error page commits no `did-navigate`; an aborted navigation changes nothing (see `endRunsOf`).
    contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== ERR_ABORTED) unwatch(contents);
    });
    contents.on('destroyed', () => unwatch(contents));
  });

  // Resolves once the folder is watched, or at once when there is nothing to watch.
  ipcMain.handle('workspaces:watch', async (event, project: string, path: string): Promise<void> => {
    if (!isFromApp(event)) throw new Error('workspaces:watch refused: unexpected origin');
    const contents = event.sender;
    const request = unwatch(contents);
    try {
      const workspace = await findWorkspace({ project, path });
      if ('status' in workspace || requests.get(contents) !== request || contents.isDestroyed()) return;
      const watcher = await watchWorktree(
        path,
        () => {
          if (!contents.isDestroyed()) contents.send('workspaces:changed');
        },
        () => void unwatch(contents),
        { env: await shellEnv },
      );
      // The watcher takes a moment to start: the window may have asked for something else since.
      if (requests.get(contents) === request && !contents.isDestroyed()) watchers.set(contents, watcher);
      else watcher.close();
    } catch {
      // Nothing to watch (git failed, the folder is gone): the page keeps the list it has.
    }
  });
  ipcMain.on('workspaces:unwatch', (event) => {
    if (isFromApp(event)) unwatch(event.sender);
  });

  // Runs `cockpit teardown` for a workspace in a pty owned by the calling window, in the worktree.
  // The CLI reads the config again and adds the variables it holds; `none` and an invalid config
  // are answered here, so the dialog shows them as before.
  ipcMain.handle(
    'workspaces:teardown',
    (event, project: string, path: string, size: { cols: number; rows: number }): Promise<TeardownResult> =>
      forProject<TeardownResult>(event, 'workspaces:teardown', project, async () => {
        const endings = endingsOf(event.sender);
        const workspace = await findWorkspace({ project, path });
        if ('status' in workspace) return workspace;
        if (isMainWorkspace(project, path)) return { status: 'none' };
        const config = await readWorkspaceConfig({ repo: project, path, env: await shellEnv });
        if (config.teardown.length === 0) return { status: 'none' };
        try {
          const ptyId = await spawnFor(
            event.sender,
            { ...size, command: cliPath, args: ['teardown'], cwd: path, env: await terminalEnv() },
            { kind: 'commands', before: endings },
          );
          return { status: 'started', ptyId };
        } catch (error) {
          if (error instanceof PageGoneError) return { status: 'refused', message: error.message };
          throw error;
        }
      }),
  );
}

// Sessions outside any project: an agent CLI run in a folder of its own under
// the Cockpit home, in a pty of the daemon. The sessions are kept in `state.json`; the pty runs on
// when the page or the app goes (and ends with the daemon: a start after it died starts a new one),
// the folder stays. Returns the start, which the main process also runs itself, for no page.
function startSessions(userData: string, { spawnFor, endingsOf, kill }: ReturnType<typeof startTerminals>) {
  // Detected on the first call that needs it, never at startup: detecting runs
  // each CLI's `--version`, and an app that never starts a session should not.
  let detection: Promise<DetectedHarness[]> | undefined;
  const detected = () => (detection ??= shellEnv.then((env) => detectHarnesses(env)));

  // `again` runs the detection again and replaces the result every later caller shares.
  ipcMain.handle('sessions:harnesses', async (event, options?: { again?: boolean }) => {
    if (!isFromApp(event)) throw new Error('sessions:harnesses refused: unexpected origin');
    if (options?.again) detection = undefined;
    return (await detected()).map(({ id, version }) => {
      const { name } = harnesses.find((harness) => harness.id === id)!;
      return { id, name, version };
    });
  });

  // Newest first.
  ipcMain.handle('sessions:list', (event) => {
    if (!isFromApp(event)) throw new Error('sessions:list refused: unexpected origin');
    return [...state.sessions].reverse();
  });

  // The workspace sessions still marked open that no daemon holds, in creation order: their terminal was lost
  // with a daemon. One that began before the Mac started proves a restart.
  ipcMain.handle('sessions:ended', (event): EndedSession[] => {
    if (!isFromApp(event)) throw new Error('sessions:ended refused: unexpected origin');
    const held = heldSessionIds();
    const bootedAt = Date.now() - uptime() * 1000;
    return state.sessions
      .filter(({ id, open, project }) => open && project !== undefined && !held.has(id))
      .map(({ id, createdAt, harness, harnessSessionId }) => {
        const catalogued = harnesses.find((each) => each.id === harness);
        // What "Resume last session" runs: offered only for a session with an id.
        const resumeCommand = catalogued && harnessSessionId !== undefined ? [catalogued.binary, ...catalogued.resume(harnessSessionId)].join(' ') : undefined;
        return { sessionId: id, reboot: Date.parse(createdAt) < bootedAt, ...(resumeCommand !== undefined && { resumeCommand }) };
      });
  });
  ipcMain.handle('sessions:dismiss', (event, sessionId: string) => {
    if (!isFromApp(event)) throw new Error('sessions:dismiss refused: unexpected origin');
    markClosed(({ id }) => id === sessionId);
  });

  // The sessions whose resume is under way: a daemon holds none of them yet.
  const resuming = new Set<string>();

  // The ids of the sessions a connected daemon holds.
  const heldSessionIds = () =>
    new Set([...terminals.values(), ...otherDaemons.flatMap((daemon) => daemon.terminals)].flatMap(({ sessionId }) => (sessionId === undefined ? [] : [sessionId])));

  // Starts the harness for `contents`, the window that owns the terminal, or for none. With `resume`, a stored
  // session that lost its terminal: the same record and id, the harness resuming its conversation.
  async function startSession(
    contents: WebContents | undefined,
    harnessId: string,
    size: { cols: number; rows: number },
    options?: StartSessionOptions,
    resume?: Session & { harnessSessionId: string },
  ): Promise<StartSessionResult> {
    // A page that ends while detection or the worktree check runs starts nothing.
    const endings = contents && endingsOf(contents);
    // `terminal` is no agent CLI: the login shell, always available, never detected.
    const login = harnessId === 'terminal';
    const catalogued = harnesses.find(({ id }) => id === harnessId);
    const found = login ? undefined : (await detected()).find(({ id }) => id === harnessId);
    const harness = login ? { id: 'terminal', name: 'Terminal' } : catalogued;
    if (!harness || (!login && !found)) return { status: 'refused', message: `${harness?.name ?? harnessId} is not installed.` };
    // Detected at launch, removed since: nothing is created or spawned.
    if (found && !isFile(found.path)) return { status: 'refused', message: `Could not start ${harness.name}: ${found.path} not found.` };
    // The agent runs in the daemon: without it nothing is created, spawned or stored.
    try {
      await ensureOwnDaemon();
    } catch (error) {
      return { status: 'refused', message: `Could not start ${harness.name}: ${error instanceof Error ? error.message : String(error)}` };
    }

    // In a workspace the session runs in the worktree, which is the user's: nothing is created
    // or removed there. Otherwise it gets a folder of its own, removed if the start fails.
    const workspace = options?.workspace;
    if (workspace) {
      const found = await findWorkspace(workspace);
      if ('status' in found) return found;
    }
    if (contents && endingsOf(contents) !== endings) {
      return { status: 'refused', message: `Could not start ${harness.name}: the page that asked for it is gone` };
    }
    const id = resume?.id ?? randomUUID();
    // A resumed session's last status is not the new agent's.
    if (resume) sessionStatuses.delete(id);
    const directory = workspace?.path ?? join(cockpitHome, 'sessions', id);
    const prompt = options?.prompt?.trim() || undefined;
    let ptyId: number | undefined;
    try {
      if (!workspace) mkdirSync(directory, { recursive: true });
      let env = await terminalEnv({
        COCKPIT_SESSION_ID: id,
        ...(workspace && { COCKPIT_WORKSPACE_PATH: workspace.path }),
      });
      const viaSetup = workspace && options?.setup;
      let command: { command?: string; args?: string[] };
      if (catalogued && found) {
        // The harness is told, through its arguments and environment, to report its status to the daemon.
        const status = await statusLaunch(catalogued.id, { cli: cliPath, pluginsDir: join(cockpitHome, 'plugins'), env });
        env = status.env as Record<string, string>;
        // From the composer the terminal runs `cockpit setup`, which runs the repository's setup, then
        // the agent, then the login shell. The agent follows `--then` by the path detection found, so
        // that binary is the one that runs.
        const agentArgs = [...status.args, ...(resume ? catalogued.resume(resume.harnessSessionId) : catalogued.start(prompt))];
        command = viaSetup
          ? { command: cliPath, args: ['setup', '--shell', '--then', found.path, ...agentArgs] }
          : { command: found.path, args: agentArgs };
      } else {
        // The login shell: the spawn defaults run `$SHELL -l`.
        command = {};
      }
      // The composer names the workspace after the first title the agent derives from the prompt. The
      // entry exists before the spawn, so no title can arrive ahead of it.
      if (workspace && options?.nameFromTitle && catalogued) {
        pendingNames.set(id, { worktree: workspace.path, harness: catalogued });
      }
      ptyId = await spawnFor(
        contents,
        { ...size, ...command, cwd: directory, env },
        {
          kind: 'session',
          sessionId: id,
          workspace: workspace?.path,
          // A harness with no hook on an interrupt: the daemon reads the end of a turn from the title.
          ...(catalogued?.turnTitles && { agentTitles: { ...catalogued.turnTitles, marked: Boolean(viaSetup) } }),
          before: endings,
        },
      );
      if (resume) return { status: 'started', session: resume, ptyId };
      const session = {
        id,
        name: sessionName(state, harness, workspace?.path),
        harness: harness.id,
        directory,
        createdAt: new Date().toISOString(),
        ...(workspace && { project: workspace.project, open: true }),
      };
      const next = addSession(state, session);
      saveState(userData, next);
      state = next;
      return { status: 'started', session, ptyId };
    } catch (error) {
      pendingNames.delete(id);
      if (ptyId !== undefined) kill(ptyId);
      if (!workspace) rmSync(directory, { recursive: true, force: true });
      return {
        status: 'refused',
        message: `Could not start ${harness.name}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  ipcMain.handle('sessions:resume', async (event, sessionId: string, size: { cols: number; rows: number }): Promise<StartSessionResult> => {
    if (!isFromApp(event)) throw new Error('sessions:resume refused: unexpected origin');
    const session = state.sessions.find(({ id }) => id === sessionId);
    const { project, harnessSessionId } = session ?? {};
    if (!session || project === undefined || harnessSessionId === undefined) return { status: 'refused', message: 'This session has no conversation to resume.' };
    // A session a daemon holds runs, and one whose start is under way is about to: either would run two agents.
    if (heldSessionIds().has(sessionId) || resuming.has(sessionId)) return { status: 'refused', message: `${session.name} is already running.` };
    resuming.add(sessionId);
    try {
      return await startSession(event.sender, session.harness, size, { workspace: { project, path: session.directory } }, { ...session, harnessSessionId });
    } finally {
      resuming.delete(sessionId);
    }
  });
  ipcMain.handle('sessions:start', (event, harnessId: string, size: { cols: number; rows: number }, options?: StartSessionOptions) => {
    if (!isFromApp(event)) throw new Error('sessions:start refused: unexpected origin');
    return startSession(event.sender, harnessId, size, options);
  });
  return startSession;
}

// Why `gh` could not read a pull request, as shown in the Changes sidebar.
function describeReadFailure(error: GitHubError): string {
  if (error.code === 'GH_MISSING') return 'The GitHub CLI (gh) is not installed.';
  if (error.code === 'GH_UNAUTHENTICATED') return 'gh is not logged in. Run gh auth login in a terminal.';
  return `Could not read the pull request: ${error.message}`;
}

// What the user calls a workspace: its branch, or its folder name when detached.
const workspaceName = ({ branch, path }: Worktree) => branch ?? basename(path);

// A workspace is a project of the state and one of its linked worktrees (git tells), or its main working tree when it has its main workspace.
async function findWorkspace({ project, path }: { project: string; path: string }): Promise<Worktree | Refused> {
  if (!state.projects.some((entry) => entry.path === project)) {
    return { status: 'refused', message: `${project} is not a project in Cockpit.` };
  }
  try {
    const worktrees = await listWorktrees(project, { env: await shellEnv });
    const found = worktrees.find((worktree) => (!worktree.main || hasMainWorkspace(project)) && worktree.path === path);
    if (found) return found;
    return { status: 'refused', message: `${path} is not a workspace of ${basename(project)}.` };
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return { status: 'refused', message: describeFailure(error, project) };
  }
}

// The app never navigates away from its own page.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (originOf(url) !== originOf(contents.getURL())) event.preventDefault();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Never `await` this at the top level: Electron emits `ready` only once this
// ES module has finished evaluating, so the app would wait forever.
void app.whenReady().then(async () => {
  if (!hasLock) return;
  const userData = app.getPath('userData');
  try {
    state = loadState(userData);
  } catch (error) {
    // The file is left as it is: quit without opening a window. A file that
    // cannot be read (a folder, no permission) quits the same way.
    const message =
      error instanceof NewerStateError
        ? error.message
        : `Cockpit cannot read its data (${join(userData, 'state.json')}): ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    if (!background) dialog.showErrorBox('Cockpit cannot start', message);
    app.exit(1);
    return;
  }

  protocol.handle('app', serveRenderer);
  ipcMain.handle('get-version', () => app.getVersion());
  // The renderer gets the PATH only: the environment may hold tokens.
  ipcMain.handle('get-shell-path', async (event) => {
    if (!isFromApp(event)) throw new Error('get-shell-path refused: unexpected origin');
    return (await shellEnv).PATH ?? '';
  });
  await connectDaemons();
  const pty = startTerminals();
  startProjects(userData, pty, startSessions(userData, pty));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // A second launch on this userData folder brings the app to the front, or opens a window as `activate` does.
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) {
      createWindow();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
  });
});
