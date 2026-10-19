import { statSync } from 'node:fs';
import { extname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';

// The built renderer is served from a custom protocol rather than `file://`,
// as the Electron security checklist recommends. It also gives the router
// real URLs, as on the web.
const RENDERER_ORIGIN = 'app://renderer';
const rendererDir = join(import.meta.dirname, '../renderer');

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

  // Set by `electron-vite dev`. Ignored once packaged, so the environment cannot
  // point the app at another page.
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadURL(`${RENDERER_ORIGIN}/`);
  }
}

// The app never navigates away from its own page.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(contents.getURL()).origin) event.preventDefault();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Never `await` this at the top level: Electron emits `ready` only once this
// ES module has finished evaluating, so the app would wait forever.
void app.whenReady().then(() => {
  protocol.handle('app', serveRenderer);
  ipcMain.handle('get-version', () => app.getVersion());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
