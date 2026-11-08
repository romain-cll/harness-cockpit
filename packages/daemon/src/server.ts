import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createActions } from './actions';
import { clearStaleSocket, daemonFiles } from './paths';
import { encode, lineReader, PROTOCOL_VERSION, RESIZE_EVENTS_HEADER, UPGRADE, WRITES, WRONG_BUILD, type Hello, type Message, type Request, type SessionEventName, type SessionReport, type SetupEventName, type TerminalInfo } from './protocol';
import { SESSION_EVENTS, SETUP_EVENTS } from './status';
import { createTerminals, type Subscriber } from './terminals';

export interface DaemonOptions {
  /** The Cockpit home: the daemon's files are written in it. */
  home: string;
  /** The build of the app that started the daemon. */
  build: string;
  /** The folder holding `state.json` (the app's `userData`), which the daemon loads and writes. Without it the daemon holds no state: a `call` is refused. */
  stateDir?: string;
  /** The `cockpit` binary the sessions' hooks and `cockpit setup` run. */
  cli?: string;
}

export interface Daemon {
  socketPath: string;
  /** Ends every terminal, closes the connections and removes `.sock`, `.token` and `.pid`. */
  close: () => Promise<void>;
  /** Settles once the daemon is closed, by `close` or on its own (superseded and empty). */
  closed: Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

interface Connection extends Subscriber {
  socket: Socket;
  /** The build the client said it is, by `hello`. */
  build?: string;
}

/**
 * Listens on `daemon-<protocol>-<build>.sock` (HTTP over a Unix socket) with a fresh token in
 * the `.token` next to it, written once it listens: of two daemons started together the one that
 * does not get the socket gives up without touching a file. `POST /session-events` takes the harness hooks' reports; `GET /terminals` and `POST /shutdown` list and end the daemon; `GET /attach`
 * upgrades to a stream of JSON lines that a client drives the terminals and the state with (`call`). Rejects, touching
 * nothing, when another daemon holds the socket, the path is not a socket or `state.json` is from a newer version.
 */
export async function runDaemon({ home, build, stateDir, cli = '' }: DaemonOptions): Promise<Daemon> {
  const files = daemonFiles(home, PROTOCOL_VERSION, build);
  mkdirSync(home, { recursive: true });
  const connections = new Set<Connection>();
  // A daemon of another build asked for: it keeps its terminals and exits when the last one ends.
  let superseded = false;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const broadcast = (message: Message, except?: Connection) => {
    for (const connection of connections) if (connection !== except && !connection.socket.destroyed) connection.socket.write(encode(message));
  };

  const terminals = createTerminals({
    onExit: (info, exit, killed) => {
      broadcast({ type: 'exit', terminal: info.id, ...exit });
      actions?.terminalEnded(info, killed);
      if (superseded && terminals.size === 0) void close();
    },
    onTitle: (sessionId, title) => void actions?.title(sessionId, title),
    onTitleStatus: (report) => broadcast({ type: 'status', ...report }),
  });

  // Loads `state.json` before any file of the daemon is written: a newer version fails the start.
  const actions =
    stateDir === undefined
      ? undefined
      : createActions({
          home,
          stateDir,
          cli,
          socket: files.socket,
          terminals,
          superseded: () => superseded,
          announceState: (snapshot) => broadcast({ type: 'state', ...snapshot }),
          announceSettled: (settled) => broadcast({ type: 'settled', ...settled }),
          announceSpawned: (terminal, requester) => broadcast({ type: 'spawned', terminal }, requester as Connection | undefined),
        });
  await clearStaleSocket(files.socket);

  const token = randomBytes(32).toString('hex');

  const server = createServer((req, res) => handle(req, res, token, {
    onSessionEvent: (report) => {
      if (!terminals.report(report)) return false;
      actions?.report(report);
      broadcast({ type: 'status', ...report });
      return true;
    },
    list: () => terminals.list().filter(({ kind }) => kind !== 'commands'),
    shutdown: () => void close({ waitForTerminals: true }),
  }));

  server.on('upgrade', (req, socket: Socket) => {
    if (!authorized(req.headers.authorization, token)) return refuse(socket, 401);
    if (req.method !== 'GET' || req.url !== '/attach') return refuse(socket, 404);
    if (req.headers.upgrade !== UPGRADE) return refuse(socket, 400);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${UPGRADE}\r\n${RESIZE_EVENTS_HEADER}: 1\r\n\r\n`);
    serve(socket);
  });

  function serve(socket: Socket): void {
    const send = (message: Message) => {
      if (!socket.destroyed) socket.write(encode(message));
    };
    const connection: Connection = {
      socket,
      data: (terminal, seq, data) => send({ type: 'data', terminal, seq, data }),
      resize: (terminal, seq, cols, rows) => send({ type: 'resize', terminal, seq, cols, rows }),
      title: (sessionId, title) => send({ type: 'title', sessionId, title }),
    };
    connections.add(connection);
    socket.on('error', () => {});
    // The http server allows half-open sockets: the client going away does not close this side.
    socket.on('end', () => socket.end());
    socket.on('close', () => {
      connections.delete(connection);
      terminals.release(connection);
    });

    const answer = (id: number, work: () => unknown) => {
      try {
        const result = work();
        if (result instanceof Promise) {
          result.then(
            (value) => send({ id, result: value }),
            (error: unknown) => send({ id, error: errorMessage(error) }),
          );
        } else {
          send({ id, result });
        }
      } catch (error) {
        send({ id, error: errorMessage(error) });
      }
    };

    socket.on(
      'data',
      lineReader((message) => {
        const request = message as Request;
        switch (request.type) {
          case 'hello':
            answer(request.id, () => {
              connection.build = request.build;
              if (request.build !== build) {
                superseded = true;
                if (terminals.size === 0) setImmediate(() => void close());
              }
              return { protocol: PROTOCOL_VERSION, build, pid: process.pid } satisfies Hello;
            });
            break;
          case 'call':
            answer(request.id, () => {
              if (!actions) throw new Error('this background service holds no state');
              if (WRITES.has(request.method) && (superseded || connection.build !== build)) throw new Error(WRONG_BUILD);
              return actions.call(request.method, request.params as never, connection);
            });
            break;
          case 'spawn':
            answer(request.id, () => {
              if (connection.build !== build) throw new Error(WRONG_BUILD);
              const id = terminals.spawn(request.options, connection);
              broadcast({ type: 'spawned', terminal: terminals.info(id) }, connection);
              return id;
            });
            break;
          case 'list':
            answer(request.id, () => terminals.list());
            break;
          case 'attach':
            answer(request.id, () => terminals.attach(request.terminal, connection));
            break;
          case 'write':
            terminals.write(request.terminal, request.data);
            break;
          case 'resize':
            terminals.resize(request.terminal, request.cols, request.rows);
            break;
          case 'kill':
            terminals.kill(request.terminal);
            break;
        }
      }),
    );
  }

  await new Promise<void>((resolve, reject) => {
    const fail = (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new Error(`another daemon holds ${files.socket}`) : error);
    server.once('error', fail);
    server.listen(files.socket, () => {
      server.off('error', fail);
      resolve();
    });
  });
  chmodSync(files.socket, 0o600);
  // Between `listen` and this rename a client would read the token of an earlier daemon, or none: the
  // starter connects only after the daemon's ready line (`reportReady`, written once these files are
  // on disk), and no other client reaches a daemon it did not start.
  const temporaryPath = `${files.token}.tmp`;
  writeFileSync(temporaryPath, token, { mode: 0o600 });
  renameSync(temporaryPath, files.token);
  writeFileSync(files.pid, String(process.pid));

  // `waitForTerminals`: the files go and the daemon exits once every terminal has exited, SIGKILL after the
  // hang-up's grace included; otherwise as soon as the hang-ups are sent.
  function close({ waitForTerminals = false }: { waitForTerminals?: boolean } = {}): Promise<void> {
    return (closing ??= (async () => {
      terminals.killAll();
      if (waitForTerminals) await terminals.whenEmpty();
      // What was sent before the end (an exit event) reaches the client.
      await Promise.all([...connections].map(({ socket }) => new Promise<void>((resolve) => socket.end(resolve))));
      for (const { socket } of connections) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      for (const path of [files.socket, files.token, files.pid]) rmSync(path, { force: true });
      resolveClosed();
    })());
  }

  return { socketPath: files.socket, close, closed };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authorized(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (header === undefined || !header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const STATUS_LINES: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found' };

/** Answers an upgrade request that is not accepted, then closes. */
function refuse(socket: Socket, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${STATUS_LINES[status]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  { onSessionEvent, list, shutdown }: { onSessionEvent: (report: SessionReport) => boolean; list: () => TerminalInfo[]; shutdown: () => void },
): void {
  if (!authorized(req.headers.authorization, token)) {
    res.writeHead(401).end();
    req.resume();
    return;
  }
  // `GET /terminals` and `POST /shutdown` are frozen across protocols: a later app uses them to list and end
  // a daemon it cannot talk to.
  if (req.method === 'GET' && req.url === '/terminals') {
    reply(res, 200, list());
    req.resume();
    return;
  }
  if (req.method === 'POST' && req.url === '/shutdown') {
    res.writeHead(202).end(shutdown);
    req.resume();
    return;
  }
  if (req.method !== 'POST' || req.url !== '/session-events') {
    reply(res, 404, { error: 'not found' });
    req.resume();
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      chunks.length = 0;
      req.removeAllListeners('data');
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: 'body too large' }), () => req.destroy());
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    const parsed = parseEvent(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed === 'string') return reply(res, 400, { error: parsed });
    if (!onSessionEvent(parsed)) return reply(res, 404, { error: 'unknown session' });
    res.writeHead(204).end();
  });
}

/** The report, or the reason the body is refused. */
function parseEvent(text: string): SessionReport | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'body is not JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'body is not an object';
  const { sessionId, event, exitCode, harnessSessionId, ...others } = value as Record<string, unknown>;
  if (Object.keys(others).length > 0) return `unexpected field: ${Object.keys(others)[0]}`;
  if (typeof sessionId !== 'string') return 'sessionId must be a string';
  if (event === 'harness-session') {
    if (typeof harnessSessionId !== 'string' || harnessSessionId === '') return 'harnessSessionId must be a non-empty string';
    if ('exitCode' in (value as object)) return 'unexpected field: exitCode';
    return { sessionId, event, harnessSessionId };
  }
  if ('harnessSessionId' in (value as object)) return 'unexpected field: harnessSessionId';
  if (event === 'exited') {
    if (exitCode !== null && !Number.isInteger(exitCode)) return 'exitCode must be an integer or null';
    return { sessionId, event, exitCode: exitCode as number | null };
  }
  if ('exitCode' in (value as object)) return 'unexpected field: exitCode';
  const events: readonly unknown[] = [...SESSION_EVENTS, ...SETUP_EVENTS];
  if (!events.includes(event)) return `event must be one of ${[...SESSION_EVENTS, ...SETUP_EVENTS, 'exited', 'harness-session'].join(', ')}`;
  return { sessionId, event: event as SessionEventName | SetupEventName };
}

function reply(res: ServerResponse, status: number, body: { error: string } | TerminalInfo[]): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
