import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// The state version this build reads and writes. It will drive migrations.
export const STATE_VERSION = 1;

export interface State {
  version: number;
}

// `state.json` was written by a newer version of the app: it is left untouched.
export class NewerStateError extends Error {
  constructor(
    readonly path: string,
    readonly version: number,
  ) {
    super(
      `${path} was written by a newer version of Cockpit (state version ${version}, this version reads ${STATE_VERSION}).`,
    );
    this.name = 'NewerStateError';
  }
}

function isState(value: unknown): value is State {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { version } = value as { version?: unknown };
  return typeof version === 'number' && Number.isInteger(version) && version > 0;
}

// Written to a temporary file first, then renamed over the target, so a crash
// never leaves a half-written `state.json`.
function writeState(dir: string, state: State): void {
  const tmp = join(dir, 'state.json.tmp');
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, 'state.json'));
}

function readState(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseState(content: string): State | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return isState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Reads `<dir>/state.json`, creating the folder and the file when missing. A
// file that is not valid state is set aside as `state.json.corrupt-<timestamp>`
// and replaced; one from a newer version throws and is left alone.
export function loadState(dir: string): State {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.json');
  const content = readState(file);

  if (content !== undefined) {
    const state = parseState(content);
    if (state) {
      if (state.version > STATE_VERSION) throw new NewerStateError(file, state.version);
      return state;
    }
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(file, backup);
    console.warn(`${file} is not a valid state file, kept as ${backup} and replaced.`);
  }

  const fresh: State = { version: STATE_VERSION };
  writeState(dir, fresh);
  return fresh;
}
