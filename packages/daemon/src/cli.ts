import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tokenPathOf } from './paths';
import type { SessionEventName, SessionReport } from './protocol';
import { parseSetupArguments, runSetup, runTeardown } from './setup';
import { SESSION_EVENTS } from './status';

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  exit(code: number): unknown;
}

export const USAGE = [
  'usage: cockpit status <working|waiting|finished>',
  '       cockpit setup [--then <command> [args…]]',
  '       cockpit teardown',
].join('\n');

// As `curl -m 2` did: a hook has 5 s (Claude Code) or 3 s (Codex).
const TIMEOUT_MS = 2_000;

/**
 * The logic of the `cockpit` CLI (`apps/cli`). `status <event>` reports `event` for the session
 * named by `COCKPIT_SESSION_ID` to the daemon at `COCKPIT_SOCKET`, with the token of the `.token`
 * next to it, and always exits 0 without writing anything: a failing hook shows an error in the
 * harness and the stdout of some hooks reaches the model. `setup` and `teardown` run the
 * repository's commands in the current worktree (see `setup.ts`) and report the same way. Any other
 * usage writes the usage to stderr and exits 2.
 */
export async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv, { stdout, stderr, exit }: CliIo): Promise<void> {
  const [command, ...rest] = argv;
  const socketPath = env.COCKPIT_SOCKET;
  const sessionId = env.COCKPIT_SESSION_ID;
  const send = (body: Omit<SessionReport, 'sessionId'>) =>
    socketPath && sessionId ? report(socketPath, { ...body, sessionId } as SessionReport) : Promise.resolve();

  if (command === 'status' && rest.length === 1 && isEvent(rest[0])) {
    await send({ event: rest[0] });
    return void exit(0);
  }
  const io = { cwd: process.cwd(), stdout, report: send };
  const setup = command === 'setup' ? parseSetupArguments(rest) : undefined;
  if (setup) return void exit(await runSetup(setup, io, env));
  if (command === 'teardown' && rest.length === 0) return void exit(await runTeardown(io, env));

  stderr.write(`${USAGE}\n`);
  exit(2);
}

const isEvent = (value: string | undefined): value is SessionEventName =>
  (SESSION_EVENTS as readonly string[]).includes(value as string);

/** Resolves once the daemon answered or whatever went wrong did; never rejects. */
function report(socketPath: string, body: SessionReport): Promise<void> {
  return new Promise((resolve) => {
    let token: string;
    try {
      token = readFileSync(tokenPathOf(socketPath), 'utf8');
    } catch {
      return resolve();
    }
    const json = JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path: '/session-events',
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) },
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
    req.end(json);
  });
}
