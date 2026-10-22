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

/**
 * Runs in the main process: numbers the sessions and talks to the pty host.
 * `fork` starts a host. The first one starts at creation; once it has exited,
 * the next `spawn` starts another. Ids keep counting across hosts.
 */
export function createPtyClient(fork: () => HostChild): PtyClient {
  let nextId = 1;
  const dataListeners: Array<(id: number, data: string) => void> = [];
  const exitListeners: Array<(id: number, exit: PtyExit) => void> = [];

  const notifyExit = (id: number, exit: PtyExit) => exitListeners.forEach((listener) => listener(id, exit));

  // What a host started owns: its sessions, and the spawns it has not answered yet.
  const startHost = () => {
    const child = fork();
    const host = {
      child,
      running: true,
      pending: new Map<number, { resolve(id: number): void; reject(error: Error): void }>(),
      open: new Set<number>(),
    };

    child.on('message', (message) => {
      if (!host.running) return;
      switch (message.type) {
        case 'spawned':
          host.open.add(message.id);
          host.pending.get(message.id)?.resolve(message.id);
          host.pending.delete(message.id);
          break;
        case 'spawn-error':
          host.pending.get(message.id)?.reject(new Error(message.message));
          host.pending.delete(message.id);
          break;
        case 'data':
          dataListeners.forEach((listener) => listener(message.id, message.data));
          break;
        case 'exit':
          host.open.delete(message.id);
          notifyExit(message.id, { exitCode: message.exitCode, signal: message.signal });
          break;
      }
    });

    child.on('exit', () => {
      if (!host.running) return;
      host.running = false;
      for (const request of host.pending.values()) request.reject(new Error('pty host is not running'));
      host.pending.clear();
      for (const id of host.open) notifyExit(id, { exitCode: null, signal: null });
      host.open.clear();
    });

    return host;
  };

  let host = startHost();

  const send = (request: HostRequest) => {
    if (host.running) host.child.postMessage(request);
  };

  return {
    spawn(options) {
      if (!host.running) host = startHost();
      const { pending } = host;
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
