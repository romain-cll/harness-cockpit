import type { PtyExit, PtySpawnOptions } from '@cockpit/pty';

export type { PtyExit };

/**
 * What the renderer sends to start a terminal. Omitted options are filled in by
 * the main process: `command` is the user's `$SHELL` (`/bin/zsh` when unset) run
 * as a login shell, `cwd` the home directory, and `env` the main process's
 * environment with `TERM=xterm-256color` and `COLORTERM=truecolor`.
 */
export type PtySpawnRequest = Pick<PtySpawnOptions, 'cols' | 'rows'> & Partial<PtySpawnOptions>;

/** A linked git worktree of a project; `name` is its branch, or its folder name when detached. */
export interface Workspace {
  path: string;
  name: string;
  branch: string | null;
}

/**
 * A git repository the user added; `path` is its root, `name` its basename. `error` says why git
 * could not list its workspaces (the folder is gone, git is missing…), in which case there are none.
 */
export interface Project {
  path: string;
  name: string;
  workspaces: Workspace[];
  error?: string;
}

/** What adding a project came to; `refused` carries the message to show the user. */
export type AddProjectResult =
  | { status: 'added'; project: Project }
  | { status: 'cancelled' }
  | { status: 'refused'; message: string };

/** A refusal carries the message to show the user. */
export interface Refused {
  status: 'refused';
  message: string;
}

export type BranchesResult =
  | { status: 'listed'; local: string[]; remote: string[]; defaultBase: string | null }
  | Refused;

export type CreateWorkspaceResult = { status: 'created'; workspace: Workspace } | Refused;

/** `dirty`: the workspace has uncommitted changes and was not removed. `branchKept`: its branch is not merged. */
export type RemoveWorkspaceResult = { status: 'removed'; branchKept: boolean } | { status: 'dirty' } | Refused;

/** A run of an agent CLI in a folder of its own; `harness` is its id in the catalogue. */
export interface Session {
  id: string;
  name: string;
  harness: string;
  directory: string;
  /** ISO 8601. */
  createdAt: string;
}

/** A detected agent CLI the user can start a session with. */
export interface AvailableHarness {
  id: string;
  name: string;
}

/** What starting a session came to; `started` carries the id of its pty, `refused` the message to show. */
export type StartSessionResult = { status: 'started'; session: Session; ptyId: number } | Refused;

/**
 * The only surface the renderer may use to reach the main process, exposed by
 * the preload script on `window.api`. A web build would implement the same
 * interface over HTTP.
 */
export interface Api {
  /** The app version, from `package.json`. */
  getVersion(): Promise<string>;
  /** Pseudo-terminals, which run in a utility process. */
  pty: {
    /** Resolves to the session id; rejects when the pty host is not running. */
    spawn(request: PtySpawnRequest): Promise<number>;
    write(id: number, data: string): void;
    resize(id: number, cols: number, rows: number): void;
    kill(id: number): void;
    /** Each listener registration returns its unsubscribe function. */
    onData(listener: (id: number, data: string) => void): () => void;
    onExit(listener: (id: number, exit: PtyExit) => void): () => void;
  };
  /** Git repositories the user works in, kept in the app state. */
  projects: {
    list(): Promise<Project[]>;
    /** Opens the folder picker, then adds the repository that holds the folder. */
    add(): Promise<AddProjectResult>;
    /** Forgets the project; its files stay on disk. */
    remove(path: string): Promise<void>;
  };
  /** Git worktrees of a project; every call refuses a project path that is not in the app state. */
  workspaces: {
    /** The local and `origin/*` branches, and the base to preselect. Runs no fetch. */
    branches(project: string): Promise<BranchesResult>;
    /** Creates the branch `name` from `base` and its worktree under `$COCKPIT_HOME/worktrees`. */
    create(project: string, name: string, base: string): Promise<CreateWorkspaceResult>;
    /** Removes the worktree, and its branch when merged; `force` removes it with its uncommitted changes. */
    remove(project: string, path: string, options?: { force?: boolean }): Promise<RemoveWorkspaceResult>;
  };
  /** Agent CLIs run outside any project, in a folder of their own. */
  sessions: {
    /** The detected agent CLIs, in catalogue order. */
    harnesses(): Promise<AvailableHarness[]>;
    /** The stored sessions, newest first. */
    list(): Promise<Session[]>;
    /** Runs the harness in a new folder, in a pty owned by the calling window. */
    start(harness: string, size: { cols: number; rows: number }): Promise<StartSessionResult>;
  };
  /** The `PATH` of the user's login shell, the only part of its environment the renderer sees. */
  getShellPath(): Promise<string>;
}
