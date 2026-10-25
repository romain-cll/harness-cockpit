import { closeSync, constants, copyFileSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// The state version this build reads and writes. It will drive migrations.
export const STATE_VERSION = 1;

export interface Project {
  // The repository's root, as git reports it.
  path: string;
}

// A run of an agent CLI, in a folder of its own outside any project, or in a workspace of a project.
export interface Session {
  id: string;
  // `<harness name> <n>`, from `sessionName`.
  name: string;
  // The harness's id in `@cockpit/harnesses`.
  harness: string;
  // Absolute path of the session's folder, or of the workspace's worktree.
  directory: string;
  // ISO 8601.
  createdAt: string;
  // The root of the project whose workspace it runs in; absent outside any project.
  project?: string;
}

export interface State {
  version: number;
  projects: Project[];
  sessions: Session[];
  // The ids (in `@cockpit/launchers`) of the editor and the terminal opened last; absent until one is.
  editor?: string;
  terminal?: string;
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

// `state.projects` already holds this path.
export class ProjectExistsError extends Error {
  constructor(readonly path: string) {
    super(`${path} is already in Cockpit.`);
    this.name = 'ProjectExistsError';
  }
}

function isProject(value: unknown): value is Project {
  return typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string';
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name, harness, directory, createdAt, project } = value as Record<string, unknown>;
  return [id, name, harness, directory, createdAt].every((field) => typeof field === 'string') && (project === undefined || typeof project === 'string');
}

// A file written before projects or sessions existed lacks them: they read as empty.
function isState(value: unknown): value is Omit<State, 'projects' | 'sessions'> & { projects?: unknown; sessions?: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { version, projects, sessions, editor, terminal } = value as Record<string, unknown>;
  if (editor !== undefined && typeof editor !== 'string') return false;
  if (terminal !== undefined && typeof terminal !== 'string') return false;
  if (projects !== undefined && !(Array.isArray(projects) && projects.every(isProject))) return false;
  if (sessions !== undefined && !(Array.isArray(sessions) && sessions.every(isSession))) return false;
  return typeof version === 'number' && Number.isInteger(version) && version > 0;
}

// Written to a temporary file first, then renamed over the target, so a crash
// never leaves a half-written `state.json`. The folder is synced after the
// rename so the rename itself survives a power loss.
function writeFile(dir: string, content: unknown): void {
  const tmp = join(dir, 'state.json.tmp');
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(content, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, 'state.json'));
  const dirFd = openSync(dir, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export function saveState(dir: string, state: State): void {
  writeFile(dir, state);
}

export function addProject(state: State, path: string): State {
  if (state.projects.some((project) => project.path === path)) throw new ProjectExistsError(path);
  return { ...state, projects: [...state.projects, { path }] };
}

export function removeProject(state: State, path: string): State {
  return { ...state, projects: state.projects.filter((project) => project.path !== path) };
}

export function rememberApp(state: State, kind: 'editor' | 'terminal', id: string): State {
  return { ...state, [kind]: id };
}

export function addSession(state: State, session: Session): State {
  return { ...state, sessions: [...state.sessions, session] };
}

// `<harness name> <n>`, n being one more than the sessions of that harness so far
// in `directory` (a workspace), or outside any project when it is omitted.
export function sessionName(state: State, harness: { id: string; name: string }, directory?: string): string {
  const here = (session: Session) => (directory === undefined ? session.project === undefined : session.directory === directory);
  return `${harness.name} ${1 + state.sessions.filter((session) => session.harness === harness.id && here(session)).length}`;
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
    if (!isState(parsed)) return undefined;
    return {
      ...parsed,
      projects: (parsed.projects as Project[] | undefined) ?? [],
      sessions: (parsed.sessions as Session[] | undefined) ?? [],
    };
  } catch {
    return undefined;
  }
}

const isExisting = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST';

// Keeps the bytes of `file` under the first free `<file>.corrupt-<timestamp>`,
// then `-2`, `-3`… A hard link rather than a rename: the replacement written
// by the caller swaps `state.json` in one step, so a crash in between never
// leaves it missing. A copy when the volume cannot link. Neither overwrites
// an existing backup.
function keepBackup(file: string): string {
  const base = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (let n = 1; ; n++) {
    const backup = n === 1 ? base : `${base}-${n}`;
    try {
      linkSync(file, backup);
      return backup;
    } catch (error) {
      if (isExisting(error)) continue;
    }
    try {
      copyFileSync(file, backup, constants.COPYFILE_EXCL);
      return backup;
    } catch (error) {
      if (!isExisting(error)) throw error;
    }
  }
}

// Reads `<dir>/state.json`, creating the folder and the file when missing. A
// file that is not valid state is set aside as `state.json.corrupt-<timestamp>`
// (see `keepBackup`) and replaced; one from a newer version throws and is left alone.
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
    const backup = keepBackup(file);
    console.warn(`${file} is not a valid state file, kept as ${backup} and replaced.`);
  }

  // A fresh file holds the version only; `projects` and `sessions` are written with the first one.
  writeFile(dir, { version: STATE_VERSION });
  return { version: STATE_VERSION, projects: [], sessions: [] };
}
