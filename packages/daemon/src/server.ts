import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { clearStaleSocket, daemonFiles } from './paths';
import { encode, lineReader, PROTOCOL_VERSION, UPGRADE, type Hello, type Message, type Request, type SessionEventName } from './protocol';
import { SESSION_EVENTS } from './status';
import { createTerminals, type Subscriber } from './terminals';

export interface DaemonOptions {
  /** The Cockpit home: the daemon's files are written in it. */
  home: string;
  /** The build of the app that started the daemon. */
  build: string;
}

export interface Daemon {
  socketPath: string;
  /** Ends every terminal, closes the connections and removes `.sock`, `.token` and `.pid`. */
  close: () => Promise<void>;
  /** Settles once the daemon is closed, by `close` or on its own (superseded and empty). */
  closed: Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
const WRONG_BUILD = 'this background service belongs to another build of Cockpit';

interface Connection extends Subscriber {
  socket: Socket;
  /** The build the client said it is, by `hello`. */
  build?: string;
}

/**
 * Listens on `daemon-<protocol>-<build>.sock` (HTTP over a Unix socket) with a fresh token in
 * the `.token` next to it. `POST /session-events` takes the harness hooks' reports; `GET /attach`
 * upgrades to a stream of JSON lines that a client drives the terminals with. Rejects, touching
 * nothing, when another daemon holds the socket or the path is not a socket.
 */
export async function runDaemon({ home, build }: DaemonOptions): Promise<Daemon> {
  const files = daemonFiles(home, PROTOCOL_VERSION, build);
  mkdirSync(home, { recursive: true });
  await clearStaleSocket(files.socket);

  const token = randomBytes(32).toString('hex');
  const temporaryPath = `${files.token}.tmp`;
  writeFileSync(temporaryPath, token, { mode: 0o600 });
  renameSync(temporaryPath, files.token);

  const connections = new Set<Connection>();
  // A daemon of another build asked for: it keeps its terminals and exits when the last one ends.
  let superseded = false;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  function onTerminalEnd(): void {
    if (superseded && terminals.size === 0) void close();
  }
  const terminals = createTerminals(onTerminalEnd);

  const broadcast = (message: Message) => {
    for (const { socket } of connections) if (!socket.destroyed) socket.write(encode(message));
  };

  const server = createServer((req, res) => handle(req, res, token, (sessionId, event) => {
    if (!terminals.report(sessionId, event)) return false;
    broadcast({ type: 'status', sessionId, event });
    return true;
  }));

  server.on('upgrade', (req, socket: Socket) => {
    if (!authorized(req.headers.authorization, token)) return refuse(socket, 401);
    if (req.method !== 'GET' || req.url !== '/attach') return refuse(socket, 404);
    if (req.headers.upgrade !== UPGRADE) return refuse(socket, 400);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${UPGRADE}\r\n\r\n`);
    serve(socket);
  });

  function serve(socket: Socket): void {
    const send = (message: Message) => {
      if (!socket.destroyed) socket.write(encode(message));
    };
    const connection: Connection = {
      socket,
      data: (terminal, seq, data) => send({ type: 'data', terminal, seq, data }),
      exit: (terminal, exit) => send({ type: 'exit', terminal, ...exit }),
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
          case 'spawn':
            answer(request.id, () => {
              if (connection.build !== build) throw new Error(WRONG_BUILD);
              return terminals.spawn(request.options, connection);
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
    server.once('error', reject);
    server.listen(files.socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(files.socket, 0o600);
  writeFileSync(files.pid, String(process.pid));

  function close(): Promise<void> {
    return (closing ??= (async () => {
      terminals.killAll();
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
  onSessionEvent: (sessionId: string, event: SessionEventName) => boolean,
): void {
  if (!authorized(req.headers.authorization, token)) {
    res.writeHead(401).end();
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
    if (!onSessionEvent(parsed.sessionId, parsed.event)) return reply(res, 404, { error: 'unknown session' });
    res.writeHead(204).end();
  });
}

/** The event, or the reason the body is refused. */
function parseEvent(text: string): { sessionId: string; event: SessionEventName } | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'body is not JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'body is not an object';
  const { sessionId, event, ...others } = value as Record<string, unknown>;
  if (Object.keys(others).length > 0) return `unexpected field: ${Object.keys(others)[0]}`;
  if (typeof sessionId !== 'string') return 'sessionId must be a string';
  if (!SESSION_EVENTS.includes(event as SessionEventName)) return `event must be one of ${SESSION_EVENTS.join(', ')}`;
  return { sessionId, event: event as SessionEventName };
}

function reply(res: ServerResponse, status: number, body: { error: string }): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
