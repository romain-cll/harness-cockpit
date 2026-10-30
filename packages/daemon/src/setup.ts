import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { harnesses } from '@cockpit/harnesses';
import { readWorkspaceConfig, shellInvocation } from '@cockpit/workspaces';
import type { SetupEventName } from './protocol';

/** What `cockpit setup` tells the daemon: a setup event, then the agent's exit (`null` for a signal). */
export type SetupReport = { event: SetupEventName } | { event: 'exited'; exitCode: number | null };

export interface SetupIo {
  /** The folder the command was typed in: it must be a linked worktree. */
  cwd: string;
  stdout: { write(text: string): unknown };
  /** Resolves once the daemon answered or whatever went wrong did; never rejects. */
  report(report: SetupReport): Promise<void>;
}

export interface SetupArguments {
  /** The login shell is started in the worktree once everything else is done. Passed by the app only. */
  shell: boolean;
  /** The agent to start after a successful setup: its command and arguments. */
  agent: string[];
}

/** The arguments after `setup`, or `undefined` for a usage error. */
export function parseSetupArguments(argv: readonly string[]): SetupArguments | undefined {
  const parsed: SetupArguments = { shell: false, agent: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--shell') parsed.shell = true;
    else if (argument === '--then' && index + 1 < argv.length) return { ...parsed, agent: argv.slice(index + 1) };
    else return undefined;
  }
  return parsed;
}

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The spawn error, when the process could not start. */
  error?: string;
}

/** Runs a process attached to this terminal and waits for it. Never rejects. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', (error) => resolve({ code: null, signal: null, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

const describe = ({ code, signal, error }: Outcome) =>
  error !== undefined ? `could not start: ${error}` : signal !== null ? `was killed by ${signal}` : `exited with code ${code}`;

/**
 * A terminal's Ctrl+C reaches every process of its foreground group, this one included: the child
 * decides what it does with it, this process must outlive it to report and go on.
 */
async function ignoringInterrupts<T>(work: () => Promise<T>): Promise<T> {
  const ignore = () => {};
  process.on('SIGINT', ignore);
  process.on('SIGQUIT', ignore);
  try {
    return await work();
  } finally {
    process.off('SIGINT', ignore);
    process.off('SIGQUIT', ignore);
  }
}

type Kind = 'setup' | 'teardown';
const title = (kind: Kind) => (kind === 'setup' ? 'Setup' : 'Teardown');

interface CommandsResult {
  /** Whether there were commands to run. */
  ran: boolean;
  failure?: { reason: string; code: number };
}

/** Reads the commands of `kind` and runs them one by one; the first failure stops them. */
async function runCommands(kind: Kind, io: SetupIo, env: NodeJS.ProcessEnv, onStart: () => void): Promise<CommandsResult> {
  let config;
  try {
    config = await readWorkspaceConfig({ repo: io.cwd, path: io.cwd, env });
  } catch (error) {
    return { ran: true, failure: { reason: error instanceof Error ? error.message : String(error), code: 1 } };
  }
  const commands = config[kind];
  if (commands.length === 0) return { ran: false };

  onStart();
  io.stdout.write(`cockpit ${kind} · ${config.env.COCKPIT_WORKSPACE_NAME} · .cockpit/config.json\n`);
  const commandEnv = { ...env, ...config.env };
  for (const command of commands) {
    io.stdout.write(`$ ${command}\n`);
    const { command: shell, args } = shellInvocation(command);
    const outcome = await run(shell, args, io.cwd, commandEnv);
    if (outcome.code !== 0) return { ran: true, failure: { reason: `${command} ${describe(outcome)}`, code: outcome.code ?? 1 } };
  }
  io.stdout.write(`✓ ${title(kind)} done\n`);
  return { ran: true };
}

const harnessName = (binary: string) => harnesses.find((harness) => harness.binary === binary)?.name ?? binary;

/** Runs the agent and reports how it ended; resolves to the code `cockpit` exits with. */
async function runAgent(agent: string[], io: SetupIo, env: NodeJS.ProcessEnv, send: (report: SetupReport) => void): Promise<number> {
  const outcome = await run(agent[0]!, agent.slice(1), io.cwd, env);
  io.stdout.write(`[${harnessName(basename(agent[0]!))} ${describe(outcome)}]\n`);
  send({ event: 'exited', exitCode: outcome.code });
  return outcome.code ?? 1;
}

async function runShell(io: SetupIo, env: NodeJS.ProcessEnv): Promise<number> {
  const outcome = await run(env.SHELL || '/bin/zsh', ['-l'], io.cwd, env);
  return outcome.code ?? 1;
}

/**
 * `cockpit setup`: the repository's setup commands in the current linked worktree, reported to the
 * daemon as `setup-running` then `setup-done` or `setup-failed`; on success the agent after `--then`,
 * whose exit is reported as `exited`; with `--shell` the user's login shell last, so a failure (or
 * the agent's end) leaves a usable prompt. Resolves to the exit code.
 */
export function runSetup({ shell, agent }: SetupArguments, io: SetupIo, env: NodeJS.ProcessEnv): Promise<number> {
  return ignoringInterrupts(async () => {
    // Reports go out in order, without holding the run back.
    let sent = Promise.resolve();
    const send = (report: SetupReport) => void (sent = sent.then(() => io.report(report)));

    let status = 0;
    const { ran, failure } = await runCommands('setup', io, env, () => send({ event: 'setup-running' }));
    if (failure) {
      io.stdout.write(`✗ Setup failed: ${failure.reason}\n`);
      send({ event: 'setup-failed' });
      status = failure.code;
      if (agent.length > 0) {
        const binary = basename(agent[0]!);
        io.stdout.write(`${harnessName(binary)} was not started. Run \`cockpit setup --then ${binary}\` to try again.\n`);
      }
    } else {
      if (ran) send({ event: 'setup-done' });
      if (agent.length > 0) status = await runAgent(agent, io, env, send);
    }

    if (shell) status = await runShell(io, env);
    await sent;
    return status;
  });
}

/** `cockpit teardown`: the teardown commands in the current linked worktree. Resolves to the exit code: 0, or that of the command that failed. */
export function runTeardown(io: SetupIo, env: NodeJS.ProcessEnv): Promise<number> {
  return ignoringInterrupts(async () => {
    const { failure } = await runCommands('teardown', io, env, () => {});
    if (!failure) return 0;
    io.stdout.write(`✗ Teardown failed: ${failure.reason}\n`);
    return failure.code;
  });
}
