import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Api } from '../shared/api';

// Subscribes to a main-process channel and returns the unsubscribe function.
function subscribe<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as Args));
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.removeListener(channel, handler);
}

// The newest `workspaces.watch`: the main process keeps one watcher per window.
let latestWatch = 0;

const api: Api = {
  getVersion: () => ipcRenderer.invoke('get-version'),
  pty: {
    spawn: (options) => ipcRenderer.invoke('pty:spawn', options),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (listener) => subscribe('pty:data', listener),
    onExit: (listener) => subscribe('pty:exit', listener),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    add: () => ipcRenderer.invoke('projects:add'),
    remove: (path) => ipcRenderer.invoke('projects:remove', path),
  },
  workspaces: {
    branches: (project) => ipcRenderer.invoke('workspaces:branches', project),
    create: (project, name, base) => ipcRenderer.invoke('workspaces:create', project, name, base),
    remove: (project, path, options) => ipcRenderer.invoke('workspaces:remove', project, path, options),
    apps: () => ipcRenderer.invoke('workspaces:apps'),
    reveal: (project, path) => ipcRenderer.invoke('workspaces:reveal', project, path),
    open: (project, path, app) => ipcRenderer.invoke('workspaces:open', project, path, app),
    changes: (project, path) => ipcRenderer.invoke('workspaces:changes', project, path),
    diff: (project, path, file) => ipcRenderer.invoke('workspaces:diff', project, path, file),
    watch: async (project, path, listener) => {
      const watch = ++latestWatch;
      const unsubscribe = subscribe('workspaces:changed', listener);
      await ipcRenderer.invoke('workspaces:watch', project, path);
      return () => {
        unsubscribe();
        // A stop that comes after a newer watch began must not end that one.
        if (watch === latestWatch) ipcRenderer.send('workspaces:unwatch');
      };
    },
    runCommands: (project, path, which, size) => ipcRenderer.invoke('workspaces:run-commands', project, path, which, size),
  },
  sessions: {
    harnesses: () => ipcRenderer.invoke('sessions:harnesses'),
    list: () => ipcRenderer.invoke('sessions:list'),
    start: (harness, size, options) => ipcRenderer.invoke('sessions:start', harness, size, options),
  },
  getShellPath: () => ipcRenderer.invoke('get-shell-path'),
};

contextBridge.exposeInMainWorld('api', api);
