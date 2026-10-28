import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// COCKPIT-55: a test that fails before its launch's `close()` leaves its daemon running (it is
// detached, so stopping the app's process group does not reach it). Vitest runs this as a global
// setup, and its teardown kills every daemon whose `.pid` sits under the folders the tests make
// in the temporary directory (`cockpit-*` and `ck-*`, with the `h`, `.cockpit` and `.cockpit-dev`
// folders inside them). A pid whose command line lacks the marker the daemon entry is spawned
// with is not a Cockpit daemon (the pid may have been reused) and is left alone.

const MARKER = '--cockpit-daemon';

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const isDaemonPidFile = (name: string) => /^daemon-.*\.pid$/.test(name);

function pidFilesUnder(root: string): string[] {
  return [root, ...entries(root).map((name) => join(root, name))].flatMap((dir) =>
    entries(dir).filter(isDaemonPidFile).map((name) => join(dir, name)),
  );
}

function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

export function teardown(): void {
  const temporary = tmpdir();
  const roots = entries(temporary)
    .filter((name) => name.startsWith('cockpit-') || name.startsWith('ck-'))
    .map((name) => join(temporary, name));
  for (const file of roots.flatMap(pidFilesUnder)) {
    let pid: number;
    try {
      pid = Number(readFileSync(file, 'utf8').trim());
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 1 || !commandOf(pid).includes(MARKER)) continue;
    // A stopped process only gets the kill once it is resumed.
    for (const signal of ['SIGCONT', 'SIGKILL'] as const) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }
}
