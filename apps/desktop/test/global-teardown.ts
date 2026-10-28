import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_ROOT_ENV } from './run-root';

// COCKPIT-55 (AC16): a test that fails before its launch's `close()` leaves its daemon running (it is
// detached, so stopping the app's process group does not reach it). Vitest runs this module as a
// global setup: `setup` makes the run's root (`ck-` in the temporary directory) and publishes it in
// `COCKPIT_TEST_RUN_ROOT`, every test folder is made inside it (`run-root.ts`), and `teardown` kills
// the daemons whose `.pid` sits under that root, then removes it. A daemon of another run (its
// `.pid` sits under that run's own root) is never looked at. A pid whose command line lacks the
// marker the daemon entry is spawned with is not a Cockpit daemon (the pid may have been reused)
// and is left alone.

const MARKER = '--cockpit-daemon';
// <root>/<test folder>/<home>/daemon-*.pid, and a little room for a deeper home.
const MAX_DEPTH = 4;

const isDaemonPidFile = (name: string) => /^daemon-.*\.pid$/.test(name);

function pidFilesUnder(dir: string, depth = 0): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return depth < MAX_DEPTH ? pidFilesUnder(path, depth + 1) : [];
    return isDaemonPidFile(entry.name) ? [path] : [];
  });
}

function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/** Kills (resuming first, a stopped process only gets the kill once resumed) every Cockpit daemon whose `.pid` sits under `root`. */
export function killDaemonsUnder(root: string): void {
  for (const file of pidFilesUnder(root)) {
    let pid: number;
    try {
      pid = Number(readFileSync(file, 'utf8').trim());
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 1 || !commandOf(pid).includes(MARKER)) continue;
    for (const signal of ['SIGCONT', 'SIGKILL'] as const) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }
}

export function setup(): void {
  process.env[RUN_ROOT_ENV] = mkdtempSync(join(tmpdir(), 'ck-'));
}

export function teardown(): void {
  const root = process.env[RUN_ROOT_ENV];
  if (!root) return;
  killDaemonsUnder(root);
  rmSync(root, { recursive: true, force: true });
  delete process.env[RUN_ROOT_ENV];
}
