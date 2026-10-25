import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { apps, type AppId } from './catalogue';

export { apps } from './catalogue';
export type { App, AppId, AppKind } from './catalogue';

/** An app found in an applications folder. Serializable, so it can cross IPC. */
export interface DetectedApp {
  id: AppId;
  /** Absolute path of the app's bundle. */
  path: string;
}

/** The `open` run failed; the message is the reason shown to the user. */
export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchError';
  }
}

/** The folders the apps are looked up in, first folder first. */
export function defaultApplicationDirs(home: string): string[] {
  return ['/Applications', join(home, 'Applications'), '/System/Applications/Utilities'];
}

/**
 * Tells which catalogue apps are installed: for each one, the first of `dirs` that holds its
 * bundle (a directory, symlinks followed). Only looks; in catalogue order.
 */
export async function detectApps(dirs: readonly string[]): Promise<DetectedApp[]> {
  const found = await Promise.all(
    apps.map(async (app): Promise<DetectedApp | null> => {
      for (const dir of dirs) {
        const path = join(dir, app.bundle);
        try {
          if ((await stat(path)).isDirectory()) return { id: app.id, path };
        } catch {
          // Missing folder or bundle.
        }
      }
      return null;
    }),
  );
  return found.filter((app) => app !== null);
}

/** Shows `path` in the Finder: `open -R <path>`. */
export function reveal(path: string, { env }: { env: NodeJS.ProcessEnv }): Promise<void> {
  return run(['-R', path], env);
}

/** Opens `path` in the app whose bundle is at `bundlePath`: `open -a <bundlePath> <path>`. */
export function openIn(bundlePath: string, path: string, { env }: { env: NodeJS.ProcessEnv }): Promise<void> {
  return run(['-a', bundlePath, path], env);
}

// Never through a shell: every path is one argument.
function run(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', args, { env }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === 'number') reject(new LaunchError(stderr.trim() || `open exited with code ${code}`));
      else reject(new LaunchError(error.message));
    });
  });
}
