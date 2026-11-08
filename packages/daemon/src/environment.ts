import { homedir } from 'node:os';
import { dirname } from 'node:path';

/** What a terminal's environment is made of besides the login shell's. */
export interface TerminalContext {
  /** The login shell's environment. */
  env: NodeJS.ProcessEnv;
  /** The daemon's socket, for the `cockpit` commands the terminal runs. */
  socket: string;
  /** The `cockpit` binary: its folder goes first on `PATH`. */
  cli: string;
  /** The Cockpit home. */
  home: string;
}

/**
 * The environment of a terminal or a session: the login shell's, without the session variables the process may
 * have inherited (launched from a Cockpit session) and the daemon's `ELECTRON_RUN_AS_NODE`, with `COCKPIT_SOCKET`,
 * `COCKPIT_HOME`, the `cockpit` CLI's folder first on `PATH` and `extra` on top (a session's own variables).
 */
export function terminalEnv({ env, socket, cli, home }: TerminalContext, extra: Record<string, string> = {}): Record<string, string> {
  const result = { ...env } as Record<string, string>;
  for (const name of ['COCKPIT_SESSION_ID', 'COCKPIT_WORKSPACE_PATH', 'COCKPIT_SOCKET', 'COCKPIT_STATE_DIR', 'COCKPIT_CLI', 'ELECTRON_RUN_AS_NODE']) delete result[name];
  result.COCKPIT_SOCKET = socket;
  result.COCKPIT_HOME = home;
  result.PATH = [dirname(cli), result.PATH].filter(Boolean).join(':');
  return { ...result, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extra };
}

export interface SpawnRequest {
  cols: number;
  rows: number;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Fills in what a spawn request leaves out: the user's login-shell environment and the shell it names, run as a
 * login shell as Terminal.app does, in the home directory. Options the request has win. `-l` belongs to the
 * default shell only: a request with its own `command` and no `args` runs it with no argument.
 */
export function withSpawnDefaults(request: SpawnRequest, context: TerminalContext) {
  const env = terminalEnv(context);
  return {
    command: env.SHELL ?? '/bin/zsh',
    args: request.command === undefined ? ['-l'] : [],
    cwd: homedir(),
    env,
    ...request,
  };
}
