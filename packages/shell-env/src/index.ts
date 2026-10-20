import { spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';

// Printed around the output of `env`, so the text the shell's startup files
// print before and after it can be dropped.
const MARK = '__COCKPIT_SHELL_ENV__';

// Set for the shell only, to keep its startup files from updating themselves or
// starting tmux. Removed from the result unless the base environment had them.
const INJECTED: Record<string, string> = {
  COCKPIT_RESOLVING_ENVIRONMENT: '1',
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTARTED: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
};

// Bookkeeping variables of the shell that ran `env`, not part of the user's environment.
const SHELL_ONLY = ['_', 'SHLVL', 'PWD', 'OLDPWD'];

export interface ResolveShellEnvOptions {
  /** The shell to run. Defaults to `$SHELL` of the base environment, then the user's login shell. */
  shell?: string;
  /** How long to wait for the shell before giving up. */
  timeoutMs?: number;
  /** The environment the shell starts with, and the fallback result. */
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Resolves the environment of the user's login shell, which an app started from
 * the Finder or the Dock does not inherit. Never rejects: when the shell cannot
 * be run, or does not answer in time, it warns and resolves to a copy of the
 * base environment.
 */
export function resolveShellEnv({
  shell,
  timeoutMs = 10_000,
  baseEnv = process.env,
}: ResolveShellEnvOptions = {}): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') return Promise.resolve({ ...baseEnv });
  shell ??= baseEnv.SHELL ?? loginShell();

  return new Promise((resolve) => {
    const fallback = (reason: string) => {
      console.warn(`Could not read the environment of ${shell}: ${reason}. Using the app's environment.`);
      resolve({ ...baseEnv });
    };
    if (!shell) {
      console.warn("Could not find a login shell. Using the app's environment.");
      resolve({ ...baseEnv });
      return;
    }

    // `spawn` and `homedir` can throw: the promise must still resolve.
    try {
      // A process group of its own, so a timeout can kill the shell and its children.
      const child = spawn(
        shell,
        ['-ilc', `printf '%s' "${MARK}"; command /usr/bin/env -0; printf '%s' "${MARK}"`],
        {
          cwd: homedir(),
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...baseEnv, ...INJECTED },
        },
      );

      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish();
      };

      const timer = setTimeout(() => {
        settle(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            // The group is already gone.
          }
          fallback(`no answer after ${timeoutMs} ms`);
        });
      }, timeoutMs);

      // A background process started by a startup file can hold stdout open long
      // after the shell is done, which delays `close`: settle once both markers
      // have arrived, and stop reading.
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        const output = Buffer.concat(chunks).toString('utf8').split(MARK);
        if (output.length < 3) return;
        settle(() => {
          child.stdout.destroy();
          resolve(parseEnv(output[1]!, baseEnv));
        });
      });
      child.on('error', (error) => settle(() => fallback(error.message)));
      child.on('close', (code) =>
        settle(() => fallback(`it printed no environment (exit code ${code})`)),
      );
    } catch (error) {
      fallback(error instanceof Error ? error.message : String(error));
    }
  });
}

// `userInfo()` throws when the user has no passwd entry.
function loginShell(): string | undefined {
  try {
    return userInfo().shell || undefined;
  } catch {
    return undefined;
  }
}

function parseEnv(text: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of text.split('\0')) {
    const separator = entry.indexOf('=');
    if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  for (const key of SHELL_ONLY) delete env[key];
  for (const key of Object.keys(INJECTED)) {
    if (baseEnv[key] === undefined) delete env[key];
    else env[key] = baseEnv[key];
  }
  return env;
}
