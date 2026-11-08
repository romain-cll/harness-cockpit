import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, uptime } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  connectDaemon,
  DaemonNotAnsweringError,
  daemonFiles,
  describeFailure,
  ensureDaemon,
  findWorkspace as findWorkspaceIn,
  hasMainWorkspace as hasMainWorkspaceIn,
  isMainWorkspace as isMainWorkspaceIn,
  listDaemonFiles,
  PROTOCOL_VERSION,
  readTerminals,
  shutdownDaemon,
  startDaemonProcess,
  terminalEnv,
  toProject,
  withSpawnDefaults,
  workspaceName,
  writeLaunch,
  type CallMethod,
  type Calls,
  type DaemonClient,
  type FailedSetup as DaemonFailedSetup,
  type Launch,
  type SessionReport,
  type AvailableHarness,
  type Setup,
  type SetupState,
  type StateSnapshot,
  type TerminalExit,
  type TerminalInfo,
  type TerminalKind,
} from '@cockpit/daemon';
import { createPullRequest, findPullRequest, GitHubError, mergePullRequest, pullRequestStates } from '@cockpit/github';
import { detectHarnesses, harnesses } from '@cockpit/harnesses';
import { apps, defaultApplicationDirs, detectApps, LaunchError, openIn, reveal, type App } from '@cockpit/launchers';
import { NewerStateError, readState, type State } from '@cockpit/state';
import {
  branchStatus,
  checkGit,
  cloneRepository,
  commitAll,
  commitsAfter,
  fileDiff,
  hasRemote,
  headSubject,
  initRepository,
  listBranches,
  listChanges,
  listWorktrees,
  pushBranch,
  readWorkspaceConfig,
  removalState,
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
  OpenWorkspaceResult,
  OutdatedTerminal,
  PtySpawnRequest,
  PullRequestResult,
  PullRequestStatesResult,
  PushResult,
  Refused,
  RemovalResult,
  RemoveWorkspaceResult,
  SessionStatus,
  TeardownResult,
  StartSessionOptions,
  StartSessionResult,
  UpdatePathResult,
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

// What the daemon of this build last said of the app's state: `state.json` (read from the file at launch), the
// workspaces it is setting up and the sends that failed, replaced by each `state` event. The main process only reads
// it: every change goes to the daemon, the only writer of `state.json`.
let state: State;
let setups: Setup[] = [];
let failedSetups: DaemonFailedSetup[] = [];

// The last status each session reported, as the sidebar shows it.
const sessionStatuses = new Map<string, SessionStatus>();

// A session reported to a daemon: a harness hook (a status or the conversation's id), or `cockpit setup` (a setup state, the
// agent's exit). The window that holds the session's terminal is told of a change; a macOS
// notification is raised for `waiting` and `finished` when no Cockpit window is focused, and
// clicking it shows a window (a new one when none is open) on the session's page.
function reportSessionStatus(report: SessionReport, daemon: Daemon): void {
  const { sessionId, event } = report;
  // A daemon of an earlier build stores nothing: the daemon of this build does.
  if (report.event === 'harness-session') {
    if (!daemon.own) forwardToOwn('harness-session', { sessionId, harnessSessionId: report.harnessSessionId });
    return;
  }
  const session = state.sessions.find(({ id }) => id === sessionId);
  if (!session) return;
  const terminal = [...terminals.values()].find((each) => each.sessionId === sessionId);
  const owner = terminal?.owner && !terminal.owner.isDestroyed() ? terminal.owner : undefined;

  if (report.event === 'exited') {
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

// What a terminal's environment is made of besides the login shell's.
const terminalContext = async () => ({ env: await shellEnv, socket: ownFiles.socket, cli: cliPath, home: cockpitHome });

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
  /** The daemon of this app's build, the only one that writes `state.json`. */
  own: boolean;
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
  // A terminal that ended on its own is not lost: only a daemon that died (`exitCode: null`) leaves the mark. One the
  // page asked to kill (a deleted workspace) is left as it is. The daemon of this build closes the mark of its own
  // sessions; one of an earlier build writes nothing, so the daemon of this build is told.
  if (!daemon.own && terminal.sessionId !== undefined && exit.exitCode !== null && !terminal.closing) {
    forwardToOwn('session-dismiss', { sessionId: terminal.sessionId });
  }
  // One nobody attached to yet (a workspace's, started by the main process) tells every window.
  const hearers = terminal.owner ? [terminal.owner] : BrowserWindow.getAllWindows().map(({ webContents }) => webContents);
  for (const contents of hearers) if (!contents.isDestroyed()) contents.send('pty:exit', terminal.appId, exit);
}

// The reports of the sessions of daemons of earlier builds, until the daemon of this build is connected.
let heldBack: Array<() => void> = [];

// Takes a connected client into use: its output goes to the window that owns each terminal, its
// status reports to the sidebar, and its loss ends every terminal it held, as a crash does. The
// terminals it already runs are listed (the `commands` ones belong to another app's connection).
// The daemon of this build is also where the state comes from.
async function adopt(client: DaemonClient, own: boolean): Promise<Daemon> {
  const daemon: Daemon = { client, alive: true, own, terminals: new Map() };
  client.onData(({ id, seq, data }) => {
    const terminal = daemon.terminals.get(id);
    if (terminal?.owner && !terminal.owner.isDestroyed()) terminal.owner.send('pty:data', terminal.appId, data, seq);
  });
  client.onResize(({ id, seq, cols, rows }) => {
    const terminal = daemon.terminals.get(id);
    if (!terminal) return;
    terminal.cols = cols;
    terminal.rows = rows;
    if (terminal.owner && !terminal.owner.isDestroyed()) terminal.owner.send('pty:resized', terminal.appId, cols, rows, seq);
  });
  client.onExit(({ id, exitCode, signal }) => end(daemon, id, { exitCode, signal }));
  client.onStatus((report) => reportSessionStatus(report, daemon));
  // A terminal another client (the CLI), or the daemon itself, started: listed, and shown by the page of its workspace
  // unless the workspace is still being set up (the daemon says when it is done).
  client.onSpawned((info) => {
    if (daemon.terminals.has(info.id)) return;
    register(daemon, info);
    if (own && info.workspace !== undefined && !setups.some(({ path }) => path === info.workspace)) settle({ path: info.workspace });
  });
  if (own) {
    client.onState(applySnapshot);
    client.onSettled(settle);
  }
  client.onClose(() => {
    daemon.alive = false;
    lostTerminals += [...daemon.terminals.values()].filter(({ kind, closing }) => kind !== 'commands' && !closing).length;
    for (const remote of daemon.terminals.keys()) end(daemon, remote, { exitCode: null, signal: null });
    if (ownDaemon === daemon) ownDaemon = undefined;
    // The file is the truth: a daemon killed after it saved, before its `state` event was sent, left the replica behind.
    if (own) {
      try {
        applySnapshot({ state: readState(app.getPath('userData')), setups, failedSetups });
      } catch {
        // Unreadable: the replica stays as it was.
      }
    }
    announceDaemonChange();
  });
  if (own) {
    applySnapshot(await client.call('state', {}).catch(() => ({ state, setups, failedSetups })));
    if (detectedList) await client.call('harnesses', { known: detectedList }).catch(() => {});
  }
  for (const info of await client.list().catch(() => [])) {
    if (info.kind === 'commands' || daemon.terminals.has(info.id)) continue;
    register(daemon, info);
    if (info.sessionId !== undefined && info.status !== undefined) sessionStatuses.set(info.sessionId, info.status);
    // An id reported to a daemon of an earlier build while no app was connected.
    if (!own && info.sessionId !== undefined && info.harnessSessionId !== undefined) {
      const { sessionId, harnessSessionId } = info;
      heldBack.push(() => forwardToOwn('harness-session', { sessionId, harnessSessionId }));
    }
  }
  return daemon;
}

// Makes the daemon's snapshot the replica; the windows list again.
function applySnapshot(snapshot: StateSnapshot): void {
  ({ state, setups, failedSetups } = snapshot);
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('projects:changed');
}

// Tells every window that a workspace stopped setting up.
function settle(settled: { path: string; message?: string }): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('workspaces:settled', settled);
}

// Writes go to the daemon of this build, which cannot be reached when it cannot start: the app then only reads.
class DaemonUnavailableError extends Error {
  constructor(reason: string) {
    super(`Cockpit could not save its data: ${reason}`);
  }
}

// The daemon of this build, started when it is not running; throws `DaemonUnavailableError` with why it cannot.
async function writable(): Promise<Daemon> {
  try {
    return await ensureOwnDaemon();
  } catch (error) {
    throw new DaemonUnavailableError(error instanceof Error ? error.message : String(error));
  }
}

// The harnesses, detected here once per launch (the composer and the "+" menu list them with no daemon): given to the
// daemon, which starts the sessions, when they are detected and when one is adopted. Never at startup: detecting runs each
// CLI's `--version`. `again` replaces the result every later caller shares.
let detection: Promise<AvailableHarness[]> | undefined;
let detectedList: AvailableHarness[] | undefined;
function detected(again = false): Promise<AvailableHarness[]> {
  if (again) detectedList = detection = undefined;
  const current = (detection ??= shellEnv
    .then((env) => detectHarnesses(env))
    .then((list) => list.map(({ id, version, path }) => ({ id, name: harnesses.find((harness) => harness.id === id)!.name, version, path }))));
  void current.then((list) => {
    if (detection !== current) return;
    detectedList = list;
    if (ownDaemon?.alive) void ownDaemon.client.call('harnesses', { known: list }).catch(() => {});
  });
  return current;
}

// What the daemons of earlier builds learn and cannot store, told to the daemon of this build; lost if it is down.
function forwardToOwn<Method extends CallMethod>(method: Method, params: Calls[Method]['params']): void {
  void writable().then((daemon) => daemon.client.call(method, params)).catch(() => {});
}

// How to start the daemon of this build: what the app leaves in the launch file for the `cockpit` command.
const launchOf = (): Launch => ({ executable: process.execPath, bundle: daemonPath, build: daemonBuild, stateDir: app.getPath('userData'), cli: cliPath });

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
      ownDaemon = await adopt(await ensureDaemon({ home: cockpitHome, build: daemonBuild, spawn: () => startDaemonProcess(cockpitHome, launchOf()) }), true);
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
      await adopt(client, false);
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
    for (const forward of heldBack.splice(0)) forward();
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
    { kind, sessionId, workspace, before = contents && endingsOf(contents) }: { kind: TerminalKind; sessionId?: string; workspace?: string; before?: number },
  ) => {
    const daemon = await ensureOwnDaemon();
    const options = withSpawnDefaults(request, await terminalContext());
    const { command, cwd, cols, rows } = options;
    const remote = await daemon.client.spawn({
      kind,
      ...options,
      ...(sessionId !== undefined && { sessionId }),
      ...(workspace !== undefined && { workspace }),
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
    if (terminal) terminal.daemon.client.resize(terminal.id, cols, rows);
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

// Whether the project has its main workspace, the one with no worktree.
const hasMainWorkspace = (project: string) => hasMainWorkspaceIn(state, project);
// The main workspace's path is its project's.
const isMainWorkspace = (project: string, path: string) => isMainWorkspaceIn(state, project, path);

// Whether the main workspace's `branch` is the base the changes are compared with: it has no pull request of its own,
// and `gh pr list --head` would match a fork's of that name.
async function onBaseBranch(project: string, branch: string | null): Promise<boolean> {
  if (branch === null) return false;
  const { defaultBase } = await listBranches(project, { env: await shellEnv });
  return defaultBase?.replace(/^origin\//, '') === branch;
}

// git is checked on the first `projects:git` call and the answer kept for the launch.
let gitCheck: Promise<'ok' | 'missing'> | undefined;

// The projects the user added, kept in `state.json`: read from the replica, changed through the daemon.
function startProjects({ spawnFor, endingsOf }: ReturnType<typeof startTerminals>): void {
  ipcMain.handle('projects:list', async (event) => {
    if (!isFromApp(event)) throw new Error('projects:list refused: unexpected origin');
    const env = await shellEnv;
    return Promise.all(state.projects.map((project) => toProject(project, setups, env)));
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

  // What a refusal is made of, for the failures the user is told: git's, and the daemon's that cannot start.
  const refusal = (error: unknown): Refused | undefined =>
    error instanceof WorkspaceError || error instanceof DaemonUnavailableError ? { status: 'refused', message: error.message } : undefined;

  // Runs `action`, turning those failures into a refusal.
  async function refusing<Result>(action: () => Promise<Result>): Promise<Result | Refused> {
    try {
      return await action();
    } catch (error) {
      const refused = refusal(error);
      if (refused) return refused;
      throw error;
    }
  }

  // The one way a repository becomes a project: the daemon finds its root and adds it.
  const addAt = async (folder: string) => (await writable()).client.call('project-add', { folder });

  // After a clone, an init or a create: the folder is a repository, whatever the daemon says.
  async function addMade(folder: string): Promise<AddProjectResult> {
    const added = await addAt(folder);
    return added.status === 'not-a-repository' ? { status: 'refused', message: `${folder} is not a git repository.` } : added;
  }

  ipcMain.handle('projects:add', async (event): Promise<AddProjectResult> => {
    if (!isFromApp(event)) throw new Error('projects:add refused: unexpected origin');
    const folder = await pickFolder(event);
    if (folder === undefined) return { status: 'cancelled' };
    return refusing(() => addAt(folder));
  });

  ipcMain.handle('projects:init', (event, folder: string): Promise<AddProjectResult> => {
    if (!isFromApp(event)) throw new Error('projects:init refused: unexpected origin');
    return refusing(async () => {
      await writable();
      await initRepository({ path: folder, env: await shellEnv });
      return addMade(folder);
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
      // Refused before any git work when the daemon that will add the project is down.
      await writable();
      const env = await shellEnv;
      await cloneRepository({ url: request.url, path, env, signal: controller.signal });
      return await addMade(path);
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled' };
      const refused = refusal(error);
      if (refused) return refused;
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
      await writable();
      try {
        await mkdir(request.location, { recursive: true });
        await mkdir(path);
      } catch (error) {
        return { status: 'refused', message: `Cockpit could not create ${path}: ${(error as NodeJS.ErrnoException).code ?? error}` };
      }
      try {
        await initRepository({ path, env: await shellEnv });
        return await addMade(path);
      } catch (error) {
        await rm(path, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  });

  ipcMain.handle('projects:remove', async (event, path: string): Promise<Refused | undefined> => {
    if (!isFromApp(event)) throw new Error('projects:remove refused: unexpected origin');
    return refusing(async () => {
      await (await writable()).client.call('project-remove', { path });
      return undefined;
    });
  });

  // The project at `from` moved: the user picks its repository again.
  ipcMain.handle('projects:update-path', async (event, from: string): Promise<UpdatePathResult> => {
    if (!isFromApp(event)) throw new Error('projects:update-path refused: unexpected origin');
    // The sidebar's list can be stale (the project was removed from another window).
    if (!state.projects.some((project) => project.path === from)) return { status: 'refused', message: `${from} is not a project in Cockpit.` };
    const folder = await pickFolder(event);
    if (folder === undefined) return { status: 'cancelled' };
    return refusing(async () => (await writable()).client.call('project-update-path', { from, folder }));
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

  // A write that is the daemon's: the workspaces it creates, makes and removes.
  async function forward<Method extends CallMethod>(
    event: IpcMainInvokeEvent,
    channel: string,
    method: Method,
    params: Calls[Method]['params'],
  ): Promise<Calls[Method]['result'] | Refused> {
    if (!isFromApp(event)) throw new Error(`${channel} refused: unexpected origin`);
    return refusing(async () => (await writable()).client.call(method, params));
  }

  ipcMain.handle('workspaces:create', (event, project: string, task: string, base: string): Promise<CreateWorkspaceResult | Refused> =>
    forward(event, 'workspaces:create', 'workspace-create', { project, task, base }),
  );

  // Reserves the branch and the worktree's path, answers, and the daemon sets the workspace up in the background
  // (`workspaces:settled` tells the end). A `null` base is the main workspace.
  ipcMain.handle('workspaces:compose', (event, project: string, task: string, base: string | null, harness: string) =>
    forward(event, 'workspaces:compose', 'workspace-compose', { project, task, base, harness }),
  );

  ipcMain.handle('workspaces:failed-setups', (event): FailedSetup[] => {
    if (!isFromApp(event)) throw new Error('workspaces:failed-setups refused: unexpected origin');
    return failedSetups;
  });
  ipcMain.handle('workspaces:dismiss-setup', async (event, id: string): Promise<void> => {
    if (!isFromApp(event)) throw new Error('workspaces:dismiss-setup refused: unexpected origin');
    await (await writable()).client.call('dismiss-setup', { id });
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
    (event, project: string, path: string, options: { force?: boolean; deleteBranch?: boolean; forceBranch?: string }): Promise<RemoveWorkspaceResult> =>
      forward(event, 'workspaces:remove', 'workspace-remove', { project, path, options }),
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
    // Remembering the app is a write: with the daemon down it is refused before the app is opened.
    const daemon = state[entry.kind] === entry.id ? undefined : await refusing(writable);
    if (daemon && 'status' in daemon) return daemon;
    try {
      await openIn(bundle.path, path, { env: await shellEnv });
    } catch (error) {
      if (!(error instanceof LaunchError)) throw error;
      return { status: 'refused', message: `Could not open ${path} in ${entry.name}: ${error.message}` };
    }
    if (!daemon) return { status: 'opened' };
    try {
      await daemon.client.call('remember-app', { kind: entry.kind, id: entry.id });
    } catch (error) {
      return { status: 'refused', message: error instanceof Error ? error.message : String(error) };
    }
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
            { ...size, command: cliPath, args: ['teardown'], cwd: path, env: terminalEnv(await terminalContext()) },
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

// Sessions: an agent CLI run in a pty of the daemon, in a folder of its own outside any project or in a workspace.
// The daemon starts them and keeps them in `state.json`; the pty runs on when the page or the app goes (and ends with
// the daemon: a start after it died starts a new one), the folder stays.
function startSessions({ endingsOf, kill }: ReturnType<typeof startTerminals>) {
  ipcMain.handle('sessions:harnesses', async (event, options?: { again?: boolean }) => {
    if (!isFromApp(event)) throw new Error('sessions:harnesses refused: unexpected origin');
    return (await detected(options?.again)).map(({ id, name, version }) => ({ id, name, version }));
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
  ipcMain.handle('sessions:dismiss', async (event, sessionId: string) => {
    if (!isFromApp(event)) throw new Error('sessions:dismiss refused: unexpected origin');
    await (await writable()).client.call('session-dismiss', { sessionId });
  });

  // The sessions whose resume is under way: a daemon holds none of them yet.
  const resuming = new Set<string>();

  // The ids of the sessions a connected daemon holds.
  const heldSessionIds = () =>
    new Set([...terminals.values(), ...otherDaemons.flatMap((daemon) => daemon.terminals)].flatMap(({ sessionId }) => (sessionId === undefined ? [] : [sessionId])));

  // The daemon starts the harness; `contents`, the window that owns the terminal, receives its output. A page that
  // ends while the harnesses are detected starts nothing; one that ends later gets no session: its terminal is
  // killed and its session closed.
  async function startSession(
    contents: WebContents,
    harnessId: string | undefined,
    start: (daemon: Daemon) => Promise<Calls['session-start']['result']>,
  ): Promise<StartSessionResult> {
    const endings = endingsOf(contents);
    const gone = () => contents.isDestroyed() || endingsOf(contents) !== endings;
    const pageGone = (name: string): Refused => ({ status: 'refused', message: `Could not start ${name}: the page that asked for it is gone` });
    const name = harnessId === 'terminal' ? 'Terminal' : (harnesses.find(({ id }) => id === harnessId)?.name ?? harnessId ?? 'the agent');
    let daemon: Daemon;
    let started;
    try {
      daemon = await writable();
      // `terminal` is no agent CLI: the login shell, never detected.
      const found = harnessId === undefined || harnessId === 'terminal' ? undefined : (await detected()).find(({ id }) => id === harnessId);
      if (harnessId !== undefined && harnessId !== 'terminal' && !found) return { status: 'refused', message: `${name} is not installed.` };
      if (gone()) return pageGone(name);
      started = await start(daemon);
    } catch (error) {
      if (error instanceof DaemonUnavailableError) return { status: 'refused', message: error.message };
      throw error;
    }
    if (started.status === 'refused') {
      // A terminal killed after its spawn: its exit follows, and the page that owned it hears of it.
      const { terminal, ...refused } = started;
      if (terminal) register(daemon, terminal, contents).closing = true;
      return refused;
    }
    const terminal = register(daemon, started.terminal, contents);
    if (gone()) {
      kill(terminal.appId);
      void daemon.client.call('session-dismiss', { sessionId: started.session.id }).catch(() => {});
      return pageGone(name);
    }
    return { status: 'started', session: started.session, ptyId: terminal.appId };
  }

  ipcMain.handle('sessions:resume', async (event, sessionId: string, size: { cols: number; rows: number }): Promise<StartSessionResult> => {
    if (!isFromApp(event)) throw new Error('sessions:resume refused: unexpected origin');
    const session = state.sessions.find(({ id }) => id === sessionId);
    // A session a daemon holds runs, and one whose start is under way is about to: either would run two agents.
    if (session && (heldSessionIds().has(sessionId) || resuming.has(sessionId))) return { status: 'refused', message: `${session.name} is already running.` };
    resuming.add(sessionId);
    // A resumed session's last status is not the new agent's.
    sessionStatuses.delete(sessionId);
    try {
      return await startSession(event.sender, session?.harness, (daemon) => daemon.client.call('session-resume', { sessionId, size, subscribe: true }));
    } finally {
      resuming.delete(sessionId);
    }
  });
  ipcMain.handle('sessions:start', (event, harness: string, size: { cols: number; rows: number }, options?: StartSessionOptions) => {
    if (!isFromApp(event)) throw new Error('sessions:start refused: unexpected origin');
    return startSession(event.sender, harness, (daemon) => daemon.client.call('session-start', { harness, size, options, subscribe: true }));
  });
}

// Why `gh` could not read a pull request, as shown in the Changes sidebar.
function describeReadFailure(error: GitHubError): string {
  if (error.code === 'GH_MISSING') return 'The GitHub CLI (gh) is not installed.';
  if (error.code === 'GH_UNAUTHENTICATED') return 'gh is not logged in. Run gh auth login in a terminal.';
  return `Could not read the pull request: ${error.message}`;
}

// A workspace is a project of the state and one of its linked worktrees (git tells), or its main working tree when it has its main workspace.
async function findWorkspace(workspace: { project: string; path: string }): Promise<Worktree | Refused> {
  return findWorkspaceIn(state, workspace, await shellEnv);
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
    // Read only: the daemon is the only writer of `state.json`.
    state = readState(userData);
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
  // How the `cockpit` command finds or starts the daemon when the app is closed. A home the daemon cannot use is the
  // daemon's failure to report, not this one's.
  try {
    writeLaunch(cockpitHome, launchOf());
  } catch {
    // Nothing to write it in.
  }
  await connectDaemons();
  const pty = startTerminals();
  startProjects(pty);
  startSessions(pty);

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
