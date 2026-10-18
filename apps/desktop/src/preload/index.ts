import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/api';

const api: Api = {
  ping: () => ipcRenderer.invoke('ping'),
};

contextBridge.exposeInMainWorld('api', api);
