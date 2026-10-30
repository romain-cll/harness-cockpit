import { readFileSync, statSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
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
  type SessionReport,
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
  /** Everything a session reported (a hook, `cockpit setup`), for any session of the daemon. */
  onStatus(listener: (report: SessionReport) => void): void;
  /** The connection ended: the daemon went away, or `close` was called. */
  onClose(listener: () => void): void;
  close(): void;
}

/** The daemon accepted the connection and never answered: it is stopped, or stuck. */
export class DaemonNotAnsweringError extends Error {
  constructor(socketPath: string, timeoutMs: number) {
    super(`Cockpit's background service did not answer within ${timeoutMs / 1000} s: ${socketPath}`);
    this.name = 'DaemonNotAnsweringError';
  }
}

export interface TimeoutOptions {
  /** How long the connect, and `hello`, wait for an answer. Default 5000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
// A daemon writes its token just after it listens: a client that connects in between reads the
// token of an earlier daemon, is answered 401, and reads it again.
const TOKEN_ATTEMPTS = 3;
const TOKEN_RETRY_MS = 50;

/**
 * Connects to a daemon's socket, authenticating with the `.token` next to it. Gives up with a
 * `DaemonNotAnsweringError` when the upgrade is not answered in time.
 */
export function connectDaemon(socketPath: string, { timeoutMs = DEFAULT_TIMEOUT_MS }: TimeoutOptions = {}): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let current: ClientRequest | undefined;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new DaemonNotAnsweringError(socketPath, timeoutMs)));
      current?.destroy();
    }, timeoutMs);

    const attempt = (left: number) => {
      if (settled) return;
      let token: string;
      try {
        token = readFileSync(tokenPathOf(socketPath), 'utf8');
      } catch (error) {
        return settle(() => reject(error));
      }
      let answered = false;
      const req = request({
        socketPath,
        path: '/attach',
        headers: { connection: 'Upgrade', upgrade: UPGRADE, authorization: `Bearer ${token}` },
      });
      current = req;
      // Stays registered: a server that answered 401 and closed makes the write fail (EPIPE,
      // ECONNRESET) after the answer, which is no news.
      req.on('error', (error) => {
        if (!answered) settle(() => reject(error));
      });
      req.once('response', (res) => {
        answered = true;
        res.on('error', () => {});
        res.resume();
        if (res.statusCode === 401 && left > 1) return void setTimeout(() => attempt(left - 1), TOKEN_RETRY_MS);
        settle(() => reject(new Error(`the background service refused the connection (HTTP ${res.statusCode})`)));
      });
      req.once('upgrade', (_res, socket: Socket, head) => {
        answered = true;
        if (settled) return socket.destroy();
        settle(() => resolve(createClient(socket, head, socketPath, timeoutMs)));
      });
      req.end();
    };
    attempt(TOKEN_ATTEMPTS);
  });
}

function createClient(socket: Socket, head: Buffer, socketPath: string, timeoutMs: number): DaemonClient {
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
      case 'status': {
        const { sessionId } = message;
        const report: SessionReport = message.event === 'exited' ? { sessionId, event: 'exited', exitCode: message.exitCode } : { sessionId, event: message.event };
        statusListeners.forEach((listener) => listener(report));
        break;
      }
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
    hello: (build) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new DaemonNotAnsweringError(socketPath, timeoutMs)), timeoutMs);
        call<Hello>({ type: 'hello', build }).then(
          (value) => (clearTimeout(timer), resolve(value)),
          (error: unknown) => (clearTimeout(timer), reject(error)),
        );
      }),
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

export interface EnsureDaemonOptions extends TimeoutOptions {
  home: string;
  build: string;
  /** Starts a daemon of this build, detached; its output goes to `daemon-<protocol>-<build>.log`. */
  spawn: () => DaemonChild;
}

const START_TIMEOUT_MS = 15_000;

/**
 * A client connected to the daemon of this build, said hello to. When none listens it starts one
 * and waits for it; a daemon that exits before it listens fails the call with the last line it
 * wrote to its log, which says why. A daemon that listens and does not answer fails the call with
 * a `DaemonNotAnsweringError`: no second daemon is started over it.
 */
export async function ensureDaemon({ home, build, spawn, timeoutMs }: EnsureDaemonOptions): Promise<DaemonClient> {
  const { socket, log } = daemonFiles(home, PROTOCOL_VERSION, build);
  const connect = async () => {
    const client = await connectDaemon(socket, { timeoutMs });
    await client.hello(build).catch((error: unknown) => {
      client.close();
      throw error;
    });
    return client;
  };

  try {
    return await connect();
  } catch (error) {
    if (error instanceof DaemonNotAnsweringError) throw error;
    // Not running: start one.
  }

  // The log is appended to: what the daemon says is what comes after this.
  const logStart = statSync(log, { throwIfNoEntry: false })?.size ?? 0;
  const child = spawn();
  let exit: { code: number | null; signal: string | null } | undefined;
  child.on('exit', (code, signal) => (exit = { code, signal }));
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      return await connect();
    } catch (error) {
      if (error instanceof DaemonNotAnsweringError) throw error;
      // Not listening yet.
    }
    if (exit) {
      throw new Error(
        lastLine(log, logStart) ??
          (exit.signal
            ? `the background service was killed by ${exit.signal} before listening`
            : `the background service exited with code ${exit.code} before listening`),
      );
    }
    if (Date.now() > deadline) throw new Error(lastLine(log, logStart) ?? `the background service did not start within ${START_TIMEOUT_MS / 1000} s`);
    await sleep(25);
  }
}

/** The last non-empty line the log got after `start` bytes, which is where a daemon that failed to start says why. */
function lastLine(path: string, start: number): string | undefined {
  try {
    return readFileSync(path).subarray(start).toString('utf8').split('\n').findLast((line) => line.trim() !== '');
  } catch {
    return undefined;
  }
}
