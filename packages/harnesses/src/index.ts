import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { harnesses, type Harness, type HarnessId } from './catalogue';

export { harnesses } from './catalogue';
export type { Harness, HarnessId, SessionStore } from './catalogue';

/** A harness found on `PATH`. Serializable, so it can cross IPC. */
export interface DetectedHarness {
  id: HarnessId;
  /** Absolute path of the binary. */
  path: string;
  /** The `x.y.z` version `--version` printed, or `null` when it printed none. */
  version: string | null;
}

export interface DetectHarnessesOptions {
  /** How long to wait for each `--version` before giving up. */
  timeoutMs?: number;
}

/**
 * Tells which harnesses are installed: the first executable regular file named
 * after each binary on `env.PATH`, whose `--version` exits 0. Never rejects.
 */
export async function detectHarnesses(
  env: NodeJS.ProcessEnv,
  { timeoutMs = 10_000 }: DetectHarnessesOptions = {},
): Promise<DetectedHarness[]> {
  const found = await Promise.all(harnesses.map((harness) => detect(harness, env, timeoutMs)));
  return found.filter((harness) => harness !== null);
}

async function detect(
  harness: Harness,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<DetectedHarness | null> {
  const path = await findOnPath(harness.binary, env.PATH);
  if (!path) return null;
  const output = await versionOutput(path, env, timeoutMs);
  if (output === null) return null;
  const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(output)?.[0] ?? null;
  return { id: harness.id, path, version };
}

// Empty and relative entries would resolve against the current directory: skipped.
async function findOnPath(binary: string, pathVariable: string | undefined): Promise<string | null> {
  for (const directory of (pathVariable ?? '').split(':')) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, binary);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Missing, not a regular file, or not executable.
    }
  }
  return null;
}

// The stdout of `<path> --version`, or null when it exits with anything but 0,
// cannot be spawned or does not answer in time.
function versionOutput(path: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // A process group of its own, so a timeout can kill the binary and its children.
      const child = spawn(path, ['--version'], {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      let settled = false;
      const settle = (output: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(output);
      };

      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // The group is already gone.
        }
        child.stdout.destroy();
        settle(null);
      }, timeoutMs);

      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', () => settle(null));
      child.on('close', (code) => settle(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
    } catch {
      resolve(null);
    }
  });
}
