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
    list: () => ipcRenderer.invoke('pty:list'),
    attach: (id) => ipcRenderer.invoke('pty:attach', id),
    onData: (listener) => subscribe('pty:data', listener),
    onExit: (listener) => subscribe('pty:exit', listener),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    git: () => ipcRenderer.invoke('projects:git'),
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
    teardown: (project, path, size) => ipcRenderer.invoke('workspaces:teardown', project, path, size),
    status: (project, path) => ipcRenderer.invoke('workspaces:status', project, path),
    commit: (project, path, message) => ipcRenderer.invoke('workspaces:commit', project, path, message),
    push: (project, path) => ipcRenderer.invoke('workspaces:push', project, path),
    pullRequest: (project, path) => ipcRenderer.invoke('workspaces:pull-request', project, path),
    createPullRequest: (project, path, title, body) =>
      ipcRenderer.invoke('workspaces:create-pull-request', project, path, title, body),
  },
  sessions: {
    harnesses: () => ipcRenderer.invoke('sessions:harnesses'),
    list: () => ipcRenderer.invoke('sessions:list'),
    start: (harness, size, options) => ipcRenderer.invoke('sessions:start', harness, size, options),
    onStatus: (listener) => subscribe('sessions:status', listener),
    onOpen: (listener) => subscribe('sessions:open', listener),
  },
  daemon: {
    status: () => ipcRenderer.invoke('daemon:status'),
    retry: () => ipcRenderer.invoke('daemon:retry'),
    showLog: () => ipcRenderer.invoke('daemon:show-log'),
  },
  getShellPath: () => ipcRenderer.invoke('get-shell-path'),
};

contextBridge.exposeInMainWorld('api', api);
