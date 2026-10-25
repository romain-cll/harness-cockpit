import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';

/** The values a session event can carry. */
export const SESSION_EVENTS = ['working', 'waiting', 'finished'] as const;

export type SessionEventName = (typeof SESSION_EVENTS)[number];

export interface SessionEvent {
  sessionId: string;
  event: SessionEventName;
}

export interface ControlServerOptions {
  /** The Cockpit home: `control.sock` and `control.token` are written in it. */
  dir: string;
  /** Called for each valid event; returns `false` when the session is unknown. */
  onSessionEvent: (event: SessionEvent) => boolean;
}

export interface ControlServer {
  socketPath: string;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * The shell line a harness hook runs (by `/bin/sh -c`) to report an event of the session it
 * belongs to, found through `COCKPIT_SOCKET` and `COCKPIT_SESSION_ID`. It always exits 0 and
 * prints nothing, as a failing hook shows an error in the harness and the stdout of some
 * hooks reaches the model.
 */
export function statusCommand(event: SessionEventName): string {
  return (
    '[ -n "$COCKPIT_SOCKET" ] && curl -s -m 2 --unix-socket "$COCKPIT_SOCKET" ' +
    '-H "Authorization: Bearer $(cat "${COCKPIT_SOCKET%/*}/control.token" 2>/dev/null)" ' +
    `-d "{\\"sessionId\\":\\"$COCKPIT_SESSION_ID\\",\\"event\\":\\"${event}\\"}" ` +
    'http://localhost/session-events >/dev/null 2>&1; exit 0'
  );
}

/**
 * Listens on `<dir>/control.sock` (HTTP over a Unix socket) with a fresh token in
 * `<dir>/control.token`. Rejects, touching nothing, when another Cockpit holds the
 * socket or the path is not a socket.
 */
export async function startControlServer({ dir, onSessionEvent }: ControlServerOptions): Promise<ControlServer> {
  const socketPath = join(dir, 'control.sock');
  mkdirSync(dir, { recursive: true });
  await clearStaleSocket(socketPath);

  const token = randomBytes(32).toString('hex');
  const tokenPath = join(dir, 'control.token');
  const temporaryPath = `${tokenPath}.tmp`;
  writeFileSync(temporaryPath, token, { mode: 0o600 });
  renameSync(temporaryPath, tokenPath);

  const server = createServer((req, res) => handle(req, res, token, onSessionEvent));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Unlinks a socket nobody listens on; throws when one is live or the path is not a socket. */
async function clearStaleSocket(socketPath: string): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(socketPath).isSocket();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!isSocket) throw new Error(`${socketPath} is not a socket`);

  await new Promise<void>((resolve, reject) => {
    const probe = connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error(`another Cockpit holds ${socketPath}`));
    });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNREFUSED') return reject(error);
      // A throw here would escape the promise and leave the start pending: it rejects instead.
      try {
        unlinkSync(socketPath);
      } catch (unlinkError) {
        // Already gone: another start removed it meanwhile.
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') return reject(unlinkError);
      }
      resolve();
    });
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  onSessionEvent: ControlServerOptions['onSessionEvent'],
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
    if (!onSessionEvent(parsed)) return reply(res, 404, { error: 'unknown session' });
    res.writeHead(204).end();
  });
}

function authorized(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (header === undefined || !header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The event, or the reason the body is refused. */
function parseEvent(text: string): SessionEvent | string {
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
