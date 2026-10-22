import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectHarnesses, harnesses, type DetectedHarness } from '@cockpit/harnesses';
import { createPtyClient, type PtySpawnOptions } from '@cockpit/pty';
import {
  addProject,
  addSession,
  loadState,
  NewerStateError,
  ProjectExistsError,
  removeProject,
  saveState,
  sessionName,
  type State,
} from '@cockpit/state';
import { createWorktree, findRepositoryRoot, listBranches, listWorktrees, removeWorktree, WorkspaceError } from '@cockpit/workspaces';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  utilityProcess,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import type {
  AddProjectResult,
  BranchesResult,
  CreateWorkspaceResult,
  Project,
  PtySpawnRequest,
  Refused,
  RemoveWorkspaceResult,
  StartSessionResult,
} from '../shared/api';
import ptyHostPath from './pty-host?modulePath';
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
// - COCKPIT_USER_DATA_DIR: the app keeps its data in that folder.
// - COCKPIT_HOME: where worktrees and session folders live, in `worktrees` and `sessions` under it
//   (`~/.cockpit` when unset). They are the user's work, not app data, so they stay out of `userData`.
// - COCKPIT_TEST_BACKGROUND=1: no Dock icon, windows never shown, so a test
//   launch does not take the user's focus.
const background = process.env.COCKPIT_TEST_BACKGROUND === '1';
const userDataDir = process.env.COCKPIT_USER_DATA_DIR;
const cockpitHome = resolve(process.env.COCKPIT_HOME || join(homedir(), '.cockpit'));
const worktreesRoot = join(cockpitHome, 'worktrees');
if (userDataDir) app.setPath('userData', userDataDir);
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

function createWindow(): void {
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
      trafficLightPosition: { x: 16, y: 16 },
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

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadURL(`${RENDERER_ORIGIN}/`);
  }
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

// Fills in what a spawn request leaves out: the user's login-shell environment
// and the shell it names, run as a login shell as Terminal.app does, in the home
// directory. Options the renderer passes win.
async function withSpawnDefaults(request: PtySpawnRequest): Promise<PtySpawnOptions> {
  const env = await shellEnv;
  return {
    command: env.SHELL ?? '/bin/zsh',
    args: ['-l'],
    cwd: homedir(),
    env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    ...request,
  };
}

// The loaded state, replaced by a new one (and saved) on every change.
let state: State;

// Terminals live in a utility process, so a pty crash does not take the app down.
// The client starts it again at the next spawn after it died.
// Returns what the main process needs to run a terminal of its own.
function startPty() {
  const pty = createPtyClient(() => utilityProcess.fork(ptyHostPath, [], { serviceName: 'Cockpit Pty Host' }));
  // The window that spawned a session is the one that receives its output.
  const owners = new Map<number, WebContents>();

  // Spawns with the defaults, for the window that will receive the output.
  const spawnFor = async (contents: WebContents, request: PtySpawnRequest) => {
    const id = await pty.spawn(await withSpawnDefaults(request));
    owners.set(id, contents);
    return id;
  };

  ipcMain.handle('pty:spawn', (event, request: PtySpawnRequest) => {
    if (!isFromApp(event)) throw new Error('pty:spawn refused: unexpected origin');
    return spawnFor(event.sender, request);
  });
  ipcMain.on('pty:write', (event, id: number, data: string) => {
    if (isFromApp(event)) pty.write(id, data);
  });
  ipcMain.on('pty:resize', (event, id: number, cols: number, rows: number) => {
    if (isFromApp(event)) pty.resize(id, cols, rows);
  });
  ipcMain.on('pty:kill', (event, id: number) => {
    if (isFromApp(event)) pty.kill(id);
  });

  pty.onData((id, data) => {
    const owner = owners.get(id);
    if (owner && !owner.isDestroyed()) owner.send('pty:data', id, data);
  });
  pty.onExit((id, exit) => {
    const owner = owners.get(id);
    owners.delete(id);
    if (owner && !owner.isDestroyed()) owner.send('pty:exit', id, exit);
  });

  // A page's shells end with it: when its main frame commits another document
  // (a reload included) or the page is destroyed. `did-navigate` fires only for a
  // committed main-frame document, so a navigation that `will-navigate` cancels,
  // and route changes inside the app (same-document), kill nothing. A main frame
  // that commits an error page fires `did-fail-load` instead (an aborted
  // navigation, `ERR_ABORTED`, commits nothing and kills nothing).
  const killSessionsOf = (contents: WebContents) => {
    for (const [id, owner] of owners) if (owner === contents) pty.kill(id);
  };
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-navigate', () => killSessionsOf(contents));
    contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== ERR_ABORTED) killSessionsOf(contents);
    });
    contents.on('destroyed', () => killSessionsOf(contents));
  });

  return { spawnFor, kill: (id: number) => pty.kill(id) };
}

// Why git could not do what was asked of `path`, in words for the user.
function describeFailure(error: WorkspaceError, path: string): string {
  return error.code === 'NOT_A_REPOSITORY' ? `${path} is not a git repository.` : error.message;
}

// A project with its workspaces, which git tells: the linked worktrees, the main one being the project.
async function toProject({ path }: { path: string }): Promise<Project> {
  const project = { path, name: basename(path) };
  try {
    const worktrees = await listWorktrees(path, { env: await shellEnv });
    const workspaces = worktrees
      .filter((worktree) => !worktree.main)
      .map(({ path, branch }) => ({ path, name: branch ?? basename(path), branch }));
    return { ...project, workspaces };
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return { ...project, workspaces: [], error: describeFailure(error, path) };
  }
}

// The projects the user added, kept in `state.json`.
function startProjects(userData: string): void {
  ipcMain.handle('projects:list', (event) => {
    if (!isFromApp(event)) throw new Error('projects:list refused: unexpected origin');
    return Promise.all(state.projects.map(toProject));
  });

  ipcMain.handle('projects:add', async (event): Promise<AddProjectResult> => {
    if (!isFromApp(event)) throw new Error('projects:add refused: unexpected origin');
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory' as const] };
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    const folder = picked.filePaths[0];
    if (picked.canceled || folder === undefined) return { status: 'cancelled' };

    try {
      const root = await findRepositoryRoot(folder, { env: await shellEnv });
      const next = addProject(state, root);
      try {
        saveState(userData, next);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { status: 'refused', message: `Cockpit could not save its data: ${reason}` };
      }
      state = next;
      return { status: 'added', project: await toProject({ path: root }) };
    } catch (error) {
      if (error instanceof ProjectExistsError) {
        return { status: 'refused', message: `${basename(error.path)} is already in Cockpit.` };
      }
      if (error instanceof WorkspaceError) {
        const message = error.code === 'NOT_A_REPOSITORY' ? `${folder} is not in a git repository.` : error.message;
        return { status: 'refused', message };
      }
      throw error;
    }
  });

  ipcMain.handle('projects:remove', (event, path: string) => {
    if (!isFromApp(event)) throw new Error('projects:remove refused: unexpected origin');
    const next = removeProject(state, path);
    if (next.projects.length === state.projects.length) return;
    saveState(userData, next);
    state = next;
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

  ipcMain.handle('workspaces:create', (event, project: string, name: string, base: string): Promise<CreateWorkspaceResult> =>
    forProject<CreateWorkspaceResult>(
      event,
      'workspaces:create',
      project,
      async () => {
        const { path, branch } = await createWorktree({
          repo: project,
          root: worktreesRoot,
          branch: name,
          base,
          env: await shellEnv,
        });
        return { status: 'created', workspace: { path, name: branch ?? basename(path), branch } };
      },
      (error) => {
        if (error.code === 'BRANCH_EXISTS') return { status: 'refused', message: `A branch named ${name} already exists.` };
        if (error.code === 'INVALID_BRANCH_NAME') return { status: 'refused', message: `${name} is not a valid branch name.` };
        return undefined;
      },
    ),
  );

  ipcMain.handle(
    'workspaces:remove',
    (event, project: string, path: string, options?: { force?: boolean }): Promise<RemoveWorkspaceResult> =>
      forProject<RemoveWorkspaceResult>(
        event,
        'workspaces:remove',
        project,
        async () => {
          await removeWorktree({ repo: project, path, deleteBranch: true, force: options?.force, env: await shellEnv });
          return { status: 'removed', branchKept: false };
        },
        (error) => {
          if (error.code === 'BRANCH_NOT_MERGED') return { status: 'removed', branchKept: true };
          if (error.code === 'DIRTY_WORKTREE') return { status: 'dirty' };
          return undefined;
        },
      ),
  );
}

// Sessions outside any project: an agent CLI run in a folder of its own under
// the Cockpit home, in a pty owned by the window that started it. The sessions
// are kept in `state.json`; the pty ends with its page or with the pty host (a start
// after the host died starts a new one), the folder stays.
function startSessions(userData: string, { spawnFor, kill }: ReturnType<typeof startPty>): void {
  // Detected on the first call that needs it, never at startup: detecting runs
  // each CLI's `--version`, and an app that never starts a session should not.
  let detection: Promise<DetectedHarness[]> | undefined;
  const detected = () => (detection ??= shellEnv.then((env) => detectHarnesses(env)));

  ipcMain.handle('sessions:harnesses', async (event) => {
    if (!isFromApp(event)) throw new Error('sessions:harnesses refused: unexpected origin');
    return (await detected()).map(({ id }) => {
      const { name } = harnesses.find((harness) => harness.id === id)!;
      return { id, name };
    });
  });

  // Newest first.
  ipcMain.handle('sessions:list', (event) => {
    if (!isFromApp(event)) throw new Error('sessions:list refused: unexpected origin');
    return [...state.sessions].reverse();
  });

  ipcMain.handle(
    'sessions:start',
    async (event, harnessId: string, size: { cols: number; rows: number }): Promise<StartSessionResult> => {
      if (!isFromApp(event)) throw new Error('sessions:start refused: unexpected origin');
      const harness = harnesses.find(({ id }) => id === harnessId);
      const found = (await detected()).find(({ id }) => id === harnessId);
      if (!harness || !found) return { status: 'refused', message: `${harness?.name ?? harnessId} is not installed.` };

      const id = randomUUID();
      const directory = join(cockpitHome, 'sessions', id);
      let ptyId: number | undefined;
      try {
        mkdirSync(directory, { recursive: true });
        ptyId = await spawnFor(event.sender, { ...size, command: found.path, args: harness.start(), cwd: directory });
        const session = { id, name: sessionName(state, harness), harness: harness.id, directory, createdAt: new Date().toISOString() };
        const next = addSession(state, session);
        saveState(userData, next);
        state = next;
        return { status: 'started', session, ptyId };
      } catch (error) {
        if (ptyId !== undefined) kill(ptyId);
        rmSync(directory, { recursive: true, force: true });
        return {
          status: 'refused',
          message: `Could not start ${harness.name}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  );
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
void app.whenReady().then(() => {
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
  startProjects(userData);
  startSessions(userData, startPty());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
