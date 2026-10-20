import type { HostReply, HostRequest, PtyExit, PtySpawnOptions } from './protocol';

export type { PtyExit, PtySpawnOptions } from './protocol';

/** The shape of Electron's `UtilityProcess`. */
export interface HostChild {
  postMessage(message: HostRequest): void;
  on(event: 'message', listener: (message: HostReply) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

export interface PtyClient {
  /** Resolves to the session id once the pty is running. */
  spawn(options: PtySpawnOptions): Promise<number>;
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  kill(id: number): void;
  onData(listener: (id: number, data: string) => void): void;
  onExit(listener: (id: number, exit: PtyExit) => void): void;
}

/** Runs in the main process: numbers the sessions and talks to the pty host. */
export function createPtyClient(child: HostChild): PtyClient {
  let nextId = 1;
  let hostRunning = true;
  const pending = new Map<number, { resolve(id: number): void; reject(error: Error): void }>();
  const open = new Set<number>();
  const dataListeners: Array<(id: number, data: string) => void> = [];
  const exitListeners: Array<(id: number, exit: PtyExit) => void> = [];

  const notifyExit = (id: number, exit: PtyExit) => exitListeners.forEach((listener) => listener(id, exit));

  child.on('message', (message) => {
    switch (message.type) {
      case 'spawned':
        open.add(message.id);
        pending.get(message.id)?.resolve(message.id);
        pending.delete(message.id);
        break;
      case 'spawn-error':
        pending.get(message.id)?.reject(new Error(message.message));
        pending.delete(message.id);
        break;
      case 'data':
        dataListeners.forEach((listener) => listener(message.id, message.data));
        break;
      case 'exit':
        open.delete(message.id);
        notifyExit(message.id, { exitCode: message.exitCode, signal: message.signal });
        break;
    }
  });

  child.on('exit', () => {
    hostRunning = false;
    for (const request of pending.values()) request.reject(new Error('pty host is not running'));
    pending.clear();
    for (const id of open) notifyExit(id, { exitCode: null, signal: null });
    open.clear();
  });

  const send = (request: HostRequest) => {
    if (hostRunning) child.postMessage(request);
  };

  return {
    spawn(options) {
      if (!hostRunning) return Promise.reject(new Error('pty host is not running'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ type: 'spawn', id, options });
      });
    },
    write: (id, data) => send({ type: 'write', id, data }),
    resize: (id, cols, rows) => send({ type: 'resize', id, cols, rows }),
    kill: (id) => send({ type: 'kill', id }),
    onData: (listener) => void dataListeners.push(listener),
    onExit: (listener) => void exitListeners.push(listener),
  };
}
