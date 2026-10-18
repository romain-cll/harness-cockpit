import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/api';

const api: Api = {
  getVersion: () => ipcRenderer.invoke('get-version'),
};

contextBridge.exposeInMainWorld('api', api);
