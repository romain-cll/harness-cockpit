import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPtyClient, type PtySpawnOptions } from '@cockpit/pty';
import { loadState, NewerStateError } from '@cockpit/state';
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
  type WebContents,
} from 'electron';
import type { PtySpawnRequest } from '../shared/api';
import ptyHostPath from './pty-host?modulePath';
import { shellEnv } from './shell-env';

// The built renderer is served from a custom protocol rather than `file://`,
// as the Electron security checklist recommends. It also gives the router
// real URLs, as on the web.
const RENDERER_ORIGIN = 'app://renderer';
const rendererDir = join(import.meta.dirname, '../renderer');

// Set by `electron-vite dev`. Ignored once packaged, so the environment cannot
// point the app at another page.
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

// Test switches, read before `ready`. Unlike `ELECTRON_RENDERER_URL`, which is
// ignored once packaged because it would change the code the app runs, they are
// honoured in the packaged app too: the packaged-app test needs them, and they
// only change where the data lives and whether windows are shown.
// - COCKPIT_USER_DATA_DIR: the app keeps its data in that folder.
// - COCKPIT_TEST_BACKGROUND=1: no Dock icon, windows never shown, so a test
//   launch does not take the user's focus.
const background = process.env.COCKPIT_TEST_BACKGROUND === '1';
const userDataDir = process.env.COCKPIT_USER_DATA_DIR;
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

// Only the app's own page may drive terminals or read the shell PATH.
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

// Terminals live in a utility process, so a pty crash does not take the app down.
function startPty(): void {
  const pty = createPtyClient(utilityProcess.fork(ptyHostPath, [], { serviceName: 'Cockpit Pty Host' }));
  // The window that spawned a session is the one that receives its output.
  const owners = new Map<number, WebContents>();

  ipcMain.handle('pty:spawn', async (event, request: PtySpawnRequest) => {
    if (!isFromApp(event)) throw new Error('pty:spawn refused: unexpected origin');
    const id = await pty.spawn(await withSpawnDefaults(request));
    owners.set(id, event.sender);
    return id;
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
  // and route changes inside the app (same-document), kill nothing.
  const killSessionsOf = (contents: WebContents) => {
    for (const [id, owner] of owners) if (owner === contents) pty.kill(id);
  };
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-navigate', () => killSessionsOf(contents));
    contents.on('destroyed', () => killSessionsOf(contents));
  });
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
    loadState(userData);
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
  startPty();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
