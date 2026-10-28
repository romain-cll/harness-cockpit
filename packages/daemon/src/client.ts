import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { daemonFiles, tokenPathOf } from './paths';
import {
  encode,
  lineReader,
  PROTOCOL_VERSION,
  UPGRADE,
  type Attached,
  type Hello,
  type Message,
  type Request,
  type SessionEventName,
  type SpawnOptions,
  type TerminalExit,
  type TerminalInfo,
} from './protocol';

/** A request that is answered, without its id. */
type Call = Request extends infer Each ? (Each extends { id: number } ? Omit<Each, 'id'> : never) : never;

export interface DaemonClient {
  /** Says which build the client belongs to; answers the daemon's own protocol, build and pid. */
  hello(build: string): Promise<Hello>;
  /** Resolves to the terminal's id; rejects with the daemon's reason when it refuses. */
  spawn(options: SpawnOptions): Promise<number>;
  list(): Promise<TerminalInfo[]>;
  /** The ids below are the ones `spawn` answered, opaque to callers. */
  /** Subscribes to the terminal's output and answers its screen; later data events have a higher `seq`. */
  attach(id: unknown): Promise<Attached>;
  write(id: unknown, data: string): void;
  resize(id: unknown, cols: number, rows: number): void;
  kill(id: unknown): void;
  /** A client receives the events of the terminals it spawned or attached. */
  onData(listener: (event: { id: number; seq: number; data: string }) => void): void;
  onExit(listener: (event: { id: number } & TerminalExit) => void): void;
  /** Every status a hook reported, for any session of the daemon. */
  onStatus(listener: (event: { sessionId: string; event: SessionEventName }) => void): void;
  /** The connection ended: the daemon went away, or `close` was called. */
  onClose(listener: () => void): void;
  close(): void;
}

/** Connects to a daemon's socket, authenticating with the `.token` next to it. */
export function connectDaemon(socketPath: string): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
    let token: string;
    try {
      token = readFileSync(tokenPathOf(socketPath), 'utf8');
    } catch (error) {
      return reject(error);
    }
    const req = request({
      socketPath,
      path: '/attach',
      headers: { connection: 'Upgrade', upgrade: UPGRADE, authorization: `Bearer ${token}` },
    });
    req.once('error', reject);
    req.once('response', (res) => {
      res.resume();
      reject(new Error(`the background service refused the connection (HTTP ${res.statusCode})`));
    });
    req.once('upgrade', (_res, socket: Socket, head) => {
      req.off('error', reject);
      resolve(createClient(socket, head));
    });
    req.end();
  });
}

function createClient(socket: Socket, head: Buffer): DaemonClient {
  let lastId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const dataListeners: Array<Parameters<DaemonClient['onData']>[0]> = [];
  const exitListeners: Array<Parameters<DaemonClient['onExit']>[0]> = [];
  const statusListeners: Array<Parameters<DaemonClient['onStatus']>[0]> = [];
  const closeListeners: Array<() => void> = [];

  const send = (message: Request) => {
    if (!socket.destroyed) socket.write(encode(message));
  };
  const call = <T>(message: Call): Promise<T> =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) return reject(new Error('the background service connection is closed'));
      const id = ++lastId;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      send({ ...message, id } as Request);
    });

  // The messages wait here and are handled in order. After an answer the queue yields to the
  // event loop, so that whoever awaited the answer (a spawn's id) has run before the events that
  // follow it in the same chunk (the terminal's first output) are handed out.
  const queue: Message[] = [];
  let draining = false;
  const dispatch = (message: Message) => {
    if ('id' in message) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if ('error' in message) waiting?.reject(new Error(message.error));
      else waiting?.resolve(message.result);
      return;
    }
    switch (message.type) {
      case 'data':
        dataListeners.forEach((listener) => listener({ id: message.terminal, seq: message.seq, data: message.data }));
        break;
      case 'exit':
        exitListeners.forEach((listener) => listener({ id: message.terminal, exitCode: message.exitCode, signal: message.signal }));
        break;
      case 'status':
        statusListeners.forEach((listener) => listener({ sessionId: message.sessionId, event: message.event }));
        break;
    }
  };
  const drain = async () => {
    if (draining) return;
    draining = true;
    for (let message = queue.shift(); message; message = queue.shift()) {
      dispatch(message);
      if ('id' in message) await new Promise((resolve) => setImmediate(resolve));
    }
    draining = false;
  };
  const read = lineReader((value) => {
    queue.push(value as Message);
    void drain();
  });
  socket.on('data', read);
  socket.on('error', () => {});
  socket.on('close', () => {
    for (const waiting of pending.values()) waiting.reject(new Error('the background service connection is closed'));
    pending.clear();
    closeListeners.forEach((listener) => listener());
  });
  if (head.length > 0) read(head);

  return {
    hello: (build) => call({ type: 'hello', build }),
    spawn: (options) => call({ type: 'spawn', options }),
    list: () => call({ type: 'list' }),
    attach: (terminal) => call({ type: 'attach', terminal }),
    write: (terminal, data) => send({ type: 'write', terminal, data }),
    resize: (terminal, cols, rows) => send({ type: 'resize', terminal, cols, rows }),
    kill: (terminal) => send({ type: 'kill', terminal }),
    onData: (listener) => void dataListeners.push(listener),
    onExit: (listener) => void exitListeners.push(listener),
    onStatus: (listener) => void statusListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    close: () => void socket.destroy(),
  };
}

/** The shape of the child `ensureDaemon` waits on: a Node `ChildProcess` fits. */
export interface DaemonChild {
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
}

export interface EnsureDaemonOptions {
  home: string;
  build: string;
  /** Starts a daemon of this build, detached; its output goes to `daemon-<protocol>-<build>.log`. */
  spawn: () => DaemonChild;
}

const START_TIMEOUT_MS = 15_000;

/**
 * A client connected to the daemon of this build, said hello to. When none listens it starts one
 * and waits for it; a daemon that exits before it listens fails the call with the last line of
 * its log, which says why.
 */
export async function ensureDaemon({ home, build, spawn }: EnsureDaemonOptions): Promise<DaemonClient> {
  const { socket, log } = daemonFiles(home, PROTOCOL_VERSION, build);
  const connect = async () => {
    const client = await connectDaemon(socket);
    await client.hello(build).catch((error: unknown) => {
      client.close();
      throw error;
    });
    return client;
  };

  try {
    return await connect();
  } catch {
    // Not running: start one.
  }

  const child = spawn();
  let exit: { code: number | null; signal: string | null } | undefined;
  child.on('exit', (code, signal) => (exit = { code, signal }));
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      return await connect();
    } catch {
      // Not listening yet.
    }
    if (exit) throw new Error(lastLine(log) ?? `the background service exited (${exit.signal ?? `code ${exit.code}`})`);
    if (Date.now() > deadline) throw new Error(lastLine(log) ?? `the background service did not start within ${START_TIMEOUT_MS / 1000} s`);
    await sleep(25);
  }
}

/** The last non-empty line of the log, which is where a daemon that failed to start says why. */
function lastLine(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').split('\n').findLast((line) => line.trim() !== '');
  } catch {
    return undefined;
  }
}
