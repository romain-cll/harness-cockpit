import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Api } from '../shared/api';

// Subscribes to a main-process channel and returns the unsubscribe function.
function subscribe<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as Args));
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.removeListener(channel, handler);
}

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
  getShellPath: () => ipcRenderer.invoke('get-shell-path'),
};

contextBridge.exposeInMainWorld('api', api);
