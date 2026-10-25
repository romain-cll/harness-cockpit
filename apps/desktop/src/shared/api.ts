import type { PtyExit, PtySpawnOptions } from '@cockpit/pty';

export type { PtyExit };

/**
 * What the renderer sends to start a terminal. Omitted options are filled in by
 * the main process: `command` is the user's `$SHELL` (`/bin/zsh` when unset) run
 * as a login shell (`-l` is the default shell's only: a `command` without `args`
 * runs with no argument), `cwd` the home directory, and `env` the login shell's
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

/** An editor or a terminal app found on this machine. */
export interface AvailableApp {
  id: string;
  name: string;
}

/**
 * The detected apps, in catalogue order. `editor` and `terminal` are the ids of the ones to show
 * first: the remembered app when it is detected, else the first detected, else `null`.
 */
export interface AppsResult {
  editors: AvailableApp[];
  terminals: AvailableApp[];
  editor: string | null;
  terminal: string | null;
}

/** `refused` carries the message to show the user, a failed run included. */
export type OpenWorkspaceResult = { status: 'opened' } | Refused;

/** A file of a workspace that differs from its base; the same shape as `@cockpit/workspaces` gives. */
export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** The previous path of a renamed file. */
  oldPath?: string;
  /** `null` for a binary file. */
  additions: number | null;
  deletions: number | null;
}

/** The diff of one file: git's unified diff, or why there is none to show. */
export type FileDiff = { kind: 'text'; patch: string } | { kind: 'binary' } | { kind: 'tooLarge' };

/** The changes of a workspace against `base`, sorted by path. */
export type ChangesResult = { status: 'listed'; base: string; files: ChangedFile[] } | Refused;

export type DiffResult = { status: 'shown'; diff: FileDiff } | Refused;

/**
 * A run of an agent CLI, in a folder of its own or in a workspace's worktree (`directory`);
 * `harness` is its id in the catalogue.
 */
export interface Session {
  id: string;
  name: string;
  harness: string;
  directory: string;
  /** ISO 8601. */
  createdAt: string;
  /** The root of the project whose workspace it runs in; absent for a session outside any project. */
  project?: string;
}

/**
 * `workspace`: run in that linked worktree of a project instead of a new folder. `prompt`: the
 * harness's initial prompt (trimmed; blank means none).
 */
export interface StartSessionOptions {
  workspace?: { project: string; path: string };
  prompt?: string;
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
    /**
     * Resolves to the session id. The pty host restarts at the next spawn after it
     * died, and ids are never reused; rejects only when the host dies while the
     * spawn waits for it.
     */
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
    /** The detected editors and terminals, looked up at each call. */
    apps(): Promise<AppsResult>;
    /** Shows the worktree in the Finder. Refused when the path is not a linked worktree of the project. */
    reveal(project: string, path: string): Promise<OpenWorkspaceResult>;
    /** Opens the worktree in the detected app `app`, and remembers it as the editor or terminal shown first. */
    open(project: string, path: string, app: string): Promise<OpenWorkspaceResult>;

    /**
     * The working tree of a workspace (commits, uncommitted edits, untracked files) against its base.
     * Refused when the path is not a linked worktree of the project, or when there is no base.
     */
    changes(project: string, path: string): Promise<ChangesResult>;
    /** Git's unified diff of one file of `changes`. */
    diff(project: string, path: string, file: ChangedFile): Promise<DiffResult>;
    /**
     * Calls `listener` after the files of the workspace changed (debounced). Resolves once the folder is
     * watched, with the function that stops it. One watch per window, which the next `watch` replaces; a
     * project or path that `changes` would refuse is never watched (the function then stops nothing).
     */
    watch(project: string, path: string, listener: () => void): Promise<() => void>;
  };
  /** Agent CLIs, run in a folder of their own outside any project or in a workspace of a project. */
  sessions: {
    /** The detected agent CLIs, in catalogue order. */
    harnesses(): Promise<AvailableHarness[]>;
    /** The stored sessions, newest first. */
    list(): Promise<Session[]>;
    /**
     * Runs the harness in a new folder, or in `options.workspace`, in a pty owned by the calling window.
     * Refused when the project is not in the app state or the path is not one of its linked worktrees.
     */
    start(harness: string, size: { cols: number; rows: number }, options?: StartSessionOptions): Promise<StartSessionResult>;
  };
  /** The `PATH` of the user's login shell, the only part of its environment the renderer sees. */
  getShellPath(): Promise<string>;
}
