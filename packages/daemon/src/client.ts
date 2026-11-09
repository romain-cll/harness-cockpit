import { readFileSync, statSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import type { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { daemonFiles, tokenPathOf } from './paths';
import {
  encode,
  lineReader,
  PROTOCOL_VERSION,
  RESIZE_EVENTS_HEADER,
  UPGRADE,
  type Attached,
  type CallMethod,
  type Calls,
  type Hello,
  type Message,
  type Request,
  type SessionReport,
  type SettledSetup,
  type SpawnOptions,
  type StateSnapshot,
  type TerminalExit,
  type TerminalInfo,
} from './protocol';

/** A request that is answered, without its id. */
type Ask = Request extends infer Each ? (Each extends { id: number } ? Omit<Each, 'id'> : never) : never;

export interface DaemonClient {
  /** Says which build the client belongs to; answers the daemon's own protocol, build and pid. */
  hello(build: string): Promise<Hello>;
  /** Runs `method` in the daemon (see `Calls`); rejects with the daemon's reason when it refuses. */
  call<Method extends CallMethod>(method: Method, params: Calls[Method]['params']): Promise<Calls[Method]['result']>;
  /** Resolves to the terminal's id; rejects with the daemon's reason when it refuses. */
  spawn(options: SpawnOptions): Promise<number>;
  list(): Promise<TerminalInfo[]>;
  /** The ids below are the ones `spawn` answered, opaque to callers. */
  /** Subscribes to the terminal's output and answers its screen; later data events have a higher `seq`. */
  attach(id: unknown): Promise<Attached>;
  /** The terminal's active buffer as plain text (last `maxLines` lines when given); rejects `no terminal <id>`. */
  read(id: unknown, maxLines?: number): Promise<string>;
  /** Pastes `text` (bracketed when the program asked for it), then writes the bytes of `keys` (names of `KEYS`); answers the terminal's info. */
  send(id: unknown, input: { text?: string; keys?: string[] }): Promise<TerminalInfo>;
  write(id: unknown, data: string): void;
  /** Asks for a size; the terminal takes it, and a client hears of it, through `onResize`. */
  resize(id: unknown, cols: number, rows: number): void;
  kill(id: unknown): void;
  /** A client receives the events of the terminals it spawned or attached. */
  onData(listener: (event: { id: number; seq: number; data: string }) => void): void;
  /** A terminal's size changed; `seq` numbers it with the chunks of output. Absent from a daemon that sends no such event: the listeners then get the size at the `resize` call. */
  onResize(listener: (event: { id: number; seq?: number; cols: number; rows: number }) => void): void;
  /** Every terminal's end, whoever spawned or attached it. */
  onExit(listener: (event: { id: number } & TerminalExit) => void): void;
  /** Everything a session reported (a hook, `cockpit setup`), for any session of the daemon. */
  onStatus(listener: (report: SessionReport) => void): void;
  /** The title a session's program set (OSC 0 or 2), once per change, for any session of the daemon. */
  onTitle(listener: (event: { sessionId: string; title: string }) => void): void;
  /** The state after a change of `state.json`, the workspaces being set up or the failed sends. */
  onState(listener: (snapshot: StateSnapshot) => void): void;
  /** A terminal another connection, or the daemon, spawned. */
  onSpawned(listener: (terminal: TerminalInfo) => void): void;
  /** A workspace the daemon was setting up is done. */
  onSettled(listener: (settled: SettledSetup) => void): void;
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
      settle(() => reject(new Error(`the background service refused the connection (HTTP ${res.statusCode})`)));
    });
    req.once('upgrade', (res, socket: Socket, head) => {
      answered = true;
      if (settled) return socket.destroy();
      settle(() => resolve(createClient(socket, head, socketPath, timeoutMs, res.headers[RESIZE_EVENTS_HEADER] === '1')));
    });
    req.end();
  });
}

/** One authorized HTTP request to a daemon's socket, answered with the status and body; a daemon that does not answer in time rejects with `DaemonNotAnsweringError`. */
function callDaemon(socketPath: string, method: string, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let token: string;
    try {
      token = readFileSync(tokenPathOf(socketPath), 'utf8');
    } catch (error) {
      return reject(error);
    }
    const req = request({ socketPath, method, path, headers: { authorization: `Bearer ${token}` }, agent: false, timeout: DEFAULT_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => {
      reject(new DaemonNotAnsweringError(socketPath, DEFAULT_TIMEOUT_MS));
      req.destroy();
    });
    req.on('error', reject);
    req.end();
  });
}

/** The shells and sessions a daemon of any protocol runs (`GET /terminals`, frozen across protocols). Rejects when it refuses or does not answer. */
export async function readTerminals(socketPath: string): Promise<TerminalInfo[]> {
  const { status, text } = await callDaemon(socketPath, 'GET', '/terminals');
  if (status !== 200) throw new Error(`the background service refused to list its terminals (HTTP ${status})`);
  return JSON.parse(text) as TerminalInfo[];
}

/** Asks a daemon of any protocol to end its terminals and exit (`POST /shutdown`, frozen across protocols). Rejects when it refuses or does not answer. */
export async function shutdownDaemon(socketPath: string): Promise<void> {
  const { status } = await callDaemon(socketPath, 'POST', '/shutdown');
  if (status !== 202) throw new Error(`the background service refused to stop (HTTP ${status})`);
}

function createClient(socket: Socket, head: Buffer, socketPath: string, timeoutMs: number, resizeEvents: boolean): DaemonClient {
  let lastId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const dataListeners: Array<Parameters<DaemonClient['onData']>[0]> = [];
  const resizeListeners: Array<Parameters<DaemonClient['onResize']>[0]> = [];
  const exitListeners: Array<Parameters<DaemonClient['onExit']>[0]> = [];
  const statusListeners: Array<Parameters<DaemonClient['onStatus']>[0]> = [];
  const titleListeners: Array<Parameters<DaemonClient['onTitle']>[0]> = [];
  const stateListeners: Array<Parameters<DaemonClient['onState']>[0]> = [];
  const spawnedListeners: Array<Parameters<DaemonClient['onSpawned']>[0]> = [];
  const settledListeners: Array<Parameters<DaemonClient['onSettled']>[0]> = [];
  const closeListeners: Array<() => void> = [];

  const send = (message: Request) => {
    if (!socket.destroyed) socket.write(encode(message));
  };
  const ask = <T>(message: Ask): Promise<T> =>
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
      case 'resize':
        resizeListeners.forEach((listener) => listener({ id: message.terminal, seq: message.seq, cols: message.cols, rows: message.rows }));
        break;
      case 'exit':
        exitListeners.forEach((listener) => listener({ id: message.terminal, exitCode: message.exitCode, signal: message.signal }));
        break;
      case 'status': {
        const { sessionId } = message;
        const report: SessionReport =
          message.event === 'exited'
            ? { sessionId, event: 'exited', exitCode: message.exitCode }
            : message.event === 'harness-session'
              ? { sessionId, event: 'harness-session', harnessSessionId: message.harnessSessionId }
              : { sessionId, event: message.event, ...(message.fromTitle && { fromTitle: true as const }) };
        statusListeners.forEach((listener) => listener(report));
        break;
      }
      case 'title':
        titleListeners.forEach((listener) => listener({ sessionId: message.sessionId, title: message.title }));
        break;
      case 'state':
        stateListeners.forEach((listener) => listener({ state: message.state, setups: message.setups, failedSetups: message.failedSetups }));
        break;
      case 'spawned':
        spawnedListeners.forEach((listener) => listener(message.terminal));
        break;
      case 'settled':
        settledListeners.forEach((listener) => listener({ path: message.path, ...(message.message !== undefined && { message: message.message }) }));
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
    hello: (build) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new DaemonNotAnsweringError(socketPath, timeoutMs)), timeoutMs);
        ask<Hello>({ type: 'hello', build }).then(
          (value) => (clearTimeout(timer), resolve(value)),
          (error: unknown) => (clearTimeout(timer), reject(error)),
        );
      }),
    call: (method, params) => ask({ type: 'call', method, params }),
    spawn: (options) => ask({ type: 'spawn', options }),
    list: () => ask({ type: 'list' }),
    attach: (terminal) => ask({ type: 'attach', terminal }),
    read: (terminal, maxLines) => ask({ type: 'read', terminal, maxLines }),
    send: (terminal, { text, keys }) => ask({ type: 'send', terminal, text, keys }),
    write: (terminal, data) => send({ type: 'write', terminal, data }),
    resize: (terminal, cols, rows) => {
      send({ type: 'resize', terminal, cols, rows });
      if (!resizeEvents) resizeListeners.forEach((listener) => listener({ id: terminal as number, cols, rows }));
    },
    kill: (terminal) => send({ type: 'kill', terminal }),
    onData: (listener) => void dataListeners.push(listener),
    onResize: (listener) => void resizeListeners.push(listener),
    onExit: (listener) => void exitListeners.push(listener),
    onStatus: (listener) => void statusListeners.push(listener),
    onTitle: (listener) => void titleListeners.push(listener),
    onState: (listener) => void stateListeners.push(listener),
    onSpawned: (listener) => void spawnedListeners.push(listener),
    onSettled: (listener) => void settledListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    close: () => void socket.destroy(),
  };
}

/** The shape of the child `ensureDaemon` waits on: a Node `ChildProcess` fits. */
export interface DaemonChild {
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  /** Index 3 is the readiness pipe (`READY_FD`): the daemon writes one line on it once it is ready. */
  readonly stdio: ArrayLike<unknown>;
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
  const pipe = child.stdio[3] as Readable | null | undefined;
  pipe?.on('error', () => {});
  let timer: NodeJS.Timeout | undefined;
  const outcome = await new Promise<{ ready: true } | { code: number | null; signal: string | null } | { capped: true }>((resolve) => {
    // The cap stays: a daemon that is alive and never says it is ready cannot notify.
    timer = setTimeout(() => resolve({ capped: true }), START_TIMEOUT_MS);
    pipe?.once('data', () => resolve({ ready: true }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  pipe?.destroy();

  if ('ready' in outcome) return connect();
  if ('capped' in outcome) throw new Error(lastLine(log, logStart) ?? `the background service did not start within ${START_TIMEOUT_MS / 1000} s`);
  // Exited without the line: a daemon of this build may still answer (another starter's).
  try {
    return await connect();
  } catch (error) {
    if (error instanceof DaemonNotAnsweringError) throw error;
    throw new Error(
      lastLine(log, logStart) ??
        (outcome.signal
          ? `the background service was killed by ${outcome.signal} before listening`
          : `the background service exited with code ${outcome.code} before listening`),
    );
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
