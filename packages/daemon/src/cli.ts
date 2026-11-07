import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { harnesses } from '@cockpit/harnesses';
import { ensureDaemon, type DaemonClient } from './client';
import { readLaunch, startDaemonProcess } from './launch';
import { tokenPathOf } from './paths';
import type { RemoveOptions, SessionEventName, SessionReport } from './protocol';
import { parseSetupArguments, runSetup, runTeardown } from './setup';
import { SESSION_EVENTS } from './status';

export interface CliIo {
  stdin: AsyncIterable<Buffer | string>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  exit(code: number): unknown;
}

export const USAGE = [
  'usage: cockpit status <working|waiting|finished>',
  '       cockpit session-id <harness>',
  '       cockpit setup [--then <command> [args…]]',
  '       cockpit teardown',
  '       cockpit project add <folder>',
  '       cockpit project list',
  '       cockpit ws list --project <path>',
  '       cockpit ws create --project <path> --task <text>',
  '       cockpit ws delete --project <path> --workspace <path> [--force] [--delete-branch] [--force-branch <name>]',
  '       cockpit session start --project <path> --workspace <path> --harness <id> [--prompt <text>] [--setup]',
].join('\n');

const OPEN_COCKPIT = 'Open Cockpit once so the cockpit command can start its background service.';
const SESSION_SIZE = { cols: 80, rows: 24 };

// A report without its session id, which the CLI takes from its environment.
type Report<Each = SessionReport> = Each extends unknown ? Omit<Each, 'sessionId'> : never;

// As `curl -m 2` did: a hook has 5 s (Claude Code) or 3 s (Codex).
const TIMEOUT_MS = 2_000;

/**
 * The logic of the `cockpit` CLI (`apps/cli`). `status <event>` reports `event` for the session
 * named by `COCKPIT_SESSION_ID` to the daemon at `COCKPIT_SOCKET`, with the token of the `.token`
 * next to it, and always exits 0 without writing anything: a failing hook shows an error in the
 * harness and the stdout of some hooks reaches the model. `session-id <harness>` does the same with
 * the conversation id its adapter finds in stdin. `setup` and `teardown` run the
 * repository's commands in the current worktree (see `setup.ts`) and report the same way. `project`, `ws` and
 * `session start` ask the daemon of the Cockpit home (started from the launch file the app wrote when none runs)
 * and print its answer as one JSON line: exit 0, or 1 when it is a refusal. Any other usage writes the usage to
 * stderr and exits 2.
 */
export async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv, { stdin, stdout, stderr, exit }: CliIo): Promise<void> {
  const [command, ...rest] = argv;
  const socketPath = env.COCKPIT_SOCKET;
  const sessionId = env.COCKPIT_SESSION_ID;
  const send = (body: Report) =>
    socketPath && sessionId ? report(socketPath, { ...body, sessionId } as SessionReport) : Promise.resolve();

  if (command === 'status' && rest.length === 1 && isEvent(rest[0])) {
    await send({ event: rest[0] });
    return void exit(0);
  }
  if (command === 'session-id' && rest.length === 1) {
    const harnessSessionId = await sessionIdOf(rest[0]!, stdin);
    if (harnessSessionId !== null) await send({ event: 'harness-session', harnessSessionId });
    return void exit(0);
  }
  const io = { cwd: process.cwd(), stdout, report: send };
  const setup = command === 'setup' ? parseSetupArguments(rest) : undefined;
  if (setup) return void exit(await runSetup(setup, io, env));
  if (command === 'teardown' && rest.length === 0) return void exit(await runTeardown(io, env));

  const ask = stateCommand(command, rest);
  if (ask) {
    try {
      const client = await connectToDaemon(env);
      const { value, ok } = await ask(client).finally(() => client.close());
      stdout.write(`${JSON.stringify(value)}\n`);
      return void exit(ok ? 0 : 1);
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return void exit(1);
    }
  }

  stderr.write(`${USAGE}\n`);
  exit(2);
}

/** What a command prints and whether it succeeded. */
type Outcome = { value: unknown; ok: boolean };

/** The home the daemon's files are in: `COCKPIT_HOME`, else the folder of the socket a Cockpit terminal gives, else the packaged app's. */
const homeOf = (env: NodeJS.ProcessEnv) => env.COCKPIT_HOME || (env.COCKPIT_SOCKET ? dirname(env.COCKPIT_SOCKET) : join(homedir(), '.cockpit'));

/** A client of the daemon of the build the app wrote in its launch file, started when none runs. */
async function connectToDaemon(env: NodeJS.ProcessEnv): Promise<DaemonClient> {
  const home = homeOf(env);
  const launch = readLaunch(home);
  if (!launch) throw new Error(OPEN_COCKPIT);
  return ensureDaemon({ home, build: launch.build, spawn: () => startDaemonProcess(home, launch) });
}

/**
 * `--name value` and `--flag` options. `undefined` when one is unknown, repeated or lacks its value, or when an
 * argument is left that is no option.
 */
function parseOptions(args: readonly string[], valued: readonly string[], flags: readonly string[]): Map<string, string | true> | undefined {
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!.startsWith('--') ? args[index]!.slice(2) : undefined;
    if (name === undefined || options.has(name)) return undefined;
    if (flags.includes(name)) options.set(name, true);
    else if (valued.includes(name) && index + 1 < args.length) options.set(name, args[++index]!);
    else return undefined;
  }
  return options;
}

/** The request a `project`, `ws` or `session start` command makes, or `undefined` when it is not one or its usage is wrong. */
function stateCommand(command: string | undefined, args: readonly string[]): ((client: DaemonClient) => Promise<Outcome>) | undefined {
  const [subcommand, ...rest] = args;
  if (command === 'project' && subcommand === 'add' && rest.length === 1) {
    return async (client) => {
      const result = await client.call('project-add', { folder: resolve(rest[0]!) });
      return { value: result, ok: result.status === 'added' };
    };
  }
  if (command === 'project' && subcommand === 'list' && rest.length === 0) {
    return async (client) => ({ value: await client.call('project-list', {}), ok: true });
  }
  if (command === 'ws') {
    const options = parseOptions(rest, ['project', 'task', 'workspace', 'force-branch'], ['force', 'delete-branch']);
    const project = options?.get('project');
    if (typeof project !== 'string') return undefined;
    const text = (name: string) => {
      const value = options!.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    const only = (...names: string[]) => [...options!.keys()].every((name) => names.includes(name));
    if (subcommand === 'list' && only('project')) {
      return async (client) => {
        const found = (await client.call('project-list', {})).find(({ path }) => path === project);
        return found ? { value: found.workspaces, ok: true } : { value: { status: 'refused', message: `${project} is not a project in Cockpit.` }, ok: false };
      };
    }
    const task = text('task');
    if (subcommand === 'create' && task !== undefined && only('project', 'task')) {
      return async (client) => {
        const result = await client.call('workspace-create', { project, task });
        return { value: result, ok: result.status === 'created' };
      };
    }
    const workspace = text('workspace');
    if (subcommand === 'delete' && workspace !== undefined && only('project', 'workspace', 'force', 'delete-branch', 'force-branch')) {
      const forceBranch = text('force-branch');
      // Forcing a branch's deletion is deleting it.
      const removal: RemoveOptions = { force: options!.has('force'), deleteBranch: options!.has('delete-branch') || forceBranch !== undefined, forceBranch };
      return async (client) => {
        const result = await client.call('workspace-remove', { project, path: workspace, options: removal });
        return { value: result, ok: result.status === 'removed' };
      };
    }
  }
  if (command === 'session' && subcommand === 'start') {
    const options = parseOptions(rest, ['project', 'workspace', 'harness', 'prompt'], ['setup']);
    const [project, workspace, harness, prompt] = ['project', 'workspace', 'harness', 'prompt'].map((name) => options?.get(name));
    if (typeof project !== 'string' || typeof workspace !== 'string' || typeof harness !== 'string') return undefined;
    return async (client) => {
      const result = await client.call('session-start', {
        harness,
        size: SESSION_SIZE,
        options: { workspace: { project, path: workspace }, ...(typeof prompt === 'string' && { prompt }), setup: options!.has('setup') },
      });
      return result.status === 'started'
        ? { value: { status: 'started', session: { id: result.session.id, name: result.session.name } }, ok: true }
        : { value: result, ok: false };
    };
  }
  return undefined;
}

const isEvent = (value: string | undefined): value is SessionEventName =>
  (SESSION_EVENTS as readonly string[]).includes(value as string);

/** The id the harness's adapter finds in stdin; `null` for an unknown harness, an unreadable stdin or no id. */
async function sessionIdOf(harnessId: string, stdin: CliIo['stdin']): Promise<string | null> {
  const harness = harnesses.find(({ id }) => id === harnessId);
  if (!harness) return null;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return harness.sessionIdFrom(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

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
