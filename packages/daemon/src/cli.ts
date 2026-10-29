import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tokenPathOf } from './paths';
import { SESSION_EVENTS } from './status';
import type { SessionEventName } from './protocol';

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  exit(code: number): unknown;
}

export const USAGE = 'usage: cockpit status <working|waiting|finished>';

// As `curl -m 2` did: a hook has 5 s (Claude Code) or 3 s (Codex).
const TIMEOUT_MS = 2_000;

/**
 * The logic of the `cockpit` CLI (`apps/cli`). `status <event>` reports `event` for the session
 * named by `COCKPIT_SESSION_ID` to the daemon at `COCKPIT_SOCKET`, with the token of the `.token`
 * next to it, and always exits 0 without writing anything: a failing hook shows an error in the
 * harness and the stdout of some hooks reaches the model. Any other usage writes the usage line
 * to stderr and exits 2.
 */
export async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv, { stderr, exit }: CliIo): Promise<void> {
  const [command, event, ...rest] = argv;
  if (command !== 'status' || !isEvent(event) || rest.length > 0) {
    stderr.write(`${USAGE}\n`);
    exit(2);
    return;
  }

  const socketPath = env.COCKPIT_SOCKET;
  const sessionId = env.COCKPIT_SESSION_ID;
  if (socketPath && sessionId) await report(socketPath, sessionId, event);
  exit(0);
}

const isEvent = (value: string | undefined): value is SessionEventName =>
  (SESSION_EVENTS as readonly string[]).includes(value as string);

/** Resolves once the daemon answered or whatever went wrong did; never rejects. */
function report(socketPath: string, sessionId: string, event: SessionEventName): Promise<void> {
  return new Promise((resolve) => {
    let token: string;
    try {
      token = readFileSync(tokenPathOf(socketPath), 'utf8');
    } catch {
      return resolve();
    }
    const body = JSON.stringify({ sessionId, event });
    const req = request(
      {
        socketPath,
        path: '/session-events',
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        agent: false,
      },
      (res) => {
        res.resume();
        res.on('error', () => {});
        res.on('end', resolve);
      },
    );
    const timer = setTimeout(() => req.destroy(), TIMEOUT_MS);
    req.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    req.on('error', () => {});
    req.end(body);
  });
}
