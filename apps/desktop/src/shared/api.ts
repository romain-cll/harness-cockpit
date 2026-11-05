/** `exitCode` and `signal` are `null` when the daemon died while the process was running. */
export interface PtyExit {
  exitCode: number | null;
  signal: number | null;
}

export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/**
 * What the renderer sends to start a terminal. Omitted options are filled in by
 * the main process: `command` is the user's `$SHELL` (`/bin/zsh` when unset) run
 * as a login shell (`-l` is the default shell's only: a `command` without `args`
 * runs with no argument), `cwd` the home directory, and `env` the login shell's
 * environment with `TERM=xterm-256color` and `COLORTERM=truecolor`. With a `workspace`, `cwd` is
 * the worktree.
 */
export type PtySpawnRequest = Pick<PtySpawnOptions, 'cols' | 'rows'> &
  Partial<PtySpawnOptions> & {
    /** The linked worktree the terminal belongs to: its `cwd` unless one is given, and the daemon lists it with it. */
    workspace?: string;
  };

/** A terminal the daemon is running that the page can show again; `status` is what its session last reported. */
export interface ListedTerminal {
  id: number;
  kind: 'shell' | 'session';
  cwd: string;
  cols: number;
  rows: number;
  sessionId?: string;
  workspace?: string;
  status?: SessionStatus;
  /** The last setup state `cockpit setup` reported. */
  setup?: SetupState;
  /** How the agent ended, once `cockpit setup` reported it (`null` for a signal). */
  exitCode?: number | null;
}

/**
 * A terminal's screen as the daemon holds it, scrollback included, at the pty's size. `seq` is the
 * sequence number of the last chunk of output the screen covers: the output events that follow
 * carry a higher one.
 */
export interface AttachedTerminal {
  cols: number;
  rows: number;
  screen: string;
  seq: number;
}

/**
 * Whether the background service that runs the terminals is up; `log` says whether its log file exists.
 * `stopped`: it died while `terminals` shells and sessions ran, and no spawn has started it again.
 */
export type DaemonStatus = { status: 'running' } | { status: 'down'; reason: string; log: boolean } | { status: 'stopped'; terminals: number };

/** A shell or session held by a daemon of another protocol; `status` is what the session last reported. */
export interface OutdatedTerminal {
  kind: 'shell' | 'session';
  /** The session's name, `Terminal` for a shell. */
  name: string;
  /** The harness's name, or the shell's basename. */
  program: string;
  status?: SessionStatus;
}

/** A workspace session still marked open that no daemon holds; `reboot` when it began before the Mac started. */
export interface EndedSession {
  sessionId: string;
  reboot: boolean;
}

/**
 * A linked git worktree of a project; `name` is the readable name the composer gave it
 * (`branch.<branch>.cockpitName`), else its branch, or its folder name when detached.
 */
export interface Workspace {
  path: string;
  name: string;
  branch: string | null;
  /** The main process is still setting it up (its worktree, then its session): the row and the page say so. */
  settingUp?: true;
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
  /** The project's folder no longer exists. */
  missing?: true;
}

/** What adding a project came to; `refused` carries the message to show the user. */
export type AddProjectResult =
  | { status: 'added'; project: Project }
  | { status: 'cancelled' }
  /** The picked folder is in no repository: the user may initialize one (`projects.init`). */
  | { status: 'not-a-repository'; folder: string }
  | { status: 'refused'; message: string };

/** `location/name` is where a clone or a new repository goes; `name` is a single folder name. */
export interface CloneRequest {
  url: string;
  location: string;
  name: string;
}
export type CreateRequest = Omit<CloneRequest, 'url'>;

export type UpdatePathResult = { status: 'updated' } | { status: 'cancelled' } | Refused;

/** A refusal carries the message to show the user. */
export interface Refused {
  status: 'refused';
  message: string;
}

export type BranchesResult =
  | { status: 'listed'; local: string[]; remote: string[]; defaultBase: string | null }
  | Refused;

export type CreateWorkspaceResult = { status: 'created'; workspace: Workspace } | Refused;

/** `reserved`: the workspace exists as a row at `path` (a branch `name`) while the main process makes it. */
export type ComposeResult = { status: 'reserved'; path: string; name: string } | Refused;

/** A workspace whose worktree could not be created: kept until dismissed, with what the composer needs to show the send again. */
export interface FailedSetup {
  id: string;
  project: string;
  path: string;
  name: string;
  message: string;
  prompt: string;
  /** The harness id of the send, or `terminal`. */
  agent: string;
  base: string;
}

/** A workspace stopped setting up; `message` says why its agent could not start (the workspace stays). */
export interface SettledSetup {
  path: string;
  message?: string;
}

/** What deleting a workspace would lose: `uncommitted` changes, and whether its branch is `merged` (`null`: no branch). */
export type RemovalResult = { status: 'read'; uncommitted: boolean; merged: boolean | null } | Refused;

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

/** The pull request of a workspace's branch; the same shape as `@cockpit/github` gives. */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  checks: 'none' | 'pending' | 'passing' | 'failing' | 'unknown';
  /** `ghost` when GitHub has no author. */
  author: string;
  body: string;
  headOid: string;
  /** GitHub's `reviewDecision` as it is, `''` when the repository requires no review. */
  reviewDecision: string;
  /** Each check, named `<workflow> / <name>`; the times are gh's raw strings. */
  checkRuns: {
    name: string;
    check: 'pending' | 'passing' | 'failing' | 'unknown';
    startedAt: string | null;
    completedAt: string | null;
  }[];
  reviews: { login: string; state: 'changes_requested' | 'approved' | 'commented' | 'dismissed' | 'unknown' }[];
}

export type PullRequestState = 'open' | 'closed' | 'merged';

export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** A branch maps to the state of its newest pull request; a branch with none has no key. */
export type PullRequestStatesResult = { status: 'read'; states: Record<string, PullRequestState> } | Refused;

export type MergePullRequestResult = { status: 'merged' } | Refused;

/**
 * Where a workspace's branch stands: `uncommitted` changes to commit, `unpushed` commits to push.
 * `subject` is the first line of HEAD's commit.
 */
export type BranchStatusResult =
  | { status: 'read'; branch: string | null; upstream: string | null; uncommitted: boolean; unpushed: number; subject: string }
  | Refused;

export type CommitResult = { status: 'committed' } | Refused;

export type PushResult = { status: 'pushed' } | Refused;

/** `pullRequest` is `null` when the branch has none; `refused` carries why `gh` could not tell. */
export type PullRequestResult = { status: 'read'; pullRequest: PullRequest | null } | Refused;

export type CreatePullRequestResult = { status: 'created'; pullRequest: PullRequest } | Refused;

/**
 * `started`: the teardown runs in the pty `ptyId`, which the calling window owns. `none`: the config
 * holds no teardown command.
 */
export type TeardownResult = { status: 'started'; ptyId: number } | { status: 'none' } | Refused;

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

/** What a session's agent reported through its hooks; the values of the daemon's session events. */
export type SessionStatus = 'working' | 'waiting' | 'finished';

/** What `cockpit setup` reported of a run; the values of the daemon's `setup-*` events without the prefix. */
export type SetupState = 'running' | 'done' | 'failed';

/** What a session reports: its agent's status, `cockpit setup`'s states, and the agent's exit. */
export type SessionEvent = SessionStatus | 'setup-running' | 'setup-done' | 'setup-failed' | 'exited';

/**
 * `workspace`: run in that linked worktree of a project instead of a new folder. `prompt`: the
 * harness's initial prompt (trimmed; blank means none).
 */
export interface StartSessionOptions {
  workspace?: { project: string; path: string };
  prompt?: string;
  /** Run `cockpit setup` in the workspace first, then the agent, then the login shell. */
  setup?: boolean;
  /** Name the workspace after the first title the agent derives from the prompt (with `workspace`). */
  nameFromTitle?: boolean;
}

/** A detected agent CLI the user can start a session with. */
export interface AvailableHarness {
  id: string;
  name: string;
  /** What `--version` printed, `null` when it printed no version. */
  version: string | null;
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
  /** Pseudo-terminals, which run in the daemon and outlive the page and the app. */
  pty: {
    /**
     * Resolves to the terminal's id. The daemon starts again at the next spawn after it died, and
     * ids are never reused; rejects with the reason when the daemon cannot start.
     */
    spawn(request: PtySpawnRequest): Promise<number>;
    /** The shells and sessions the daemons are running, in creation order. Setup and teardown runs are not listed. */
    list(): Promise<ListedTerminal[]>;
    /** Makes the calling window the terminal's owner and answers its screen. */
    attach(id: number): Promise<AttachedTerminal>;
    write(id: number, data: string): void;
    resize(id: number, cols: number, rows: number): void;
    kill(id: number): void;
    /** Each listener registration returns its unsubscribe function. `seq` numbers a terminal's chunks of output. */
    onData(listener: (id: number, data: string, seq: number) => void): () => void;
    onExit(listener: (id: number, exit: PtyExit) => void): () => void;
  };
  /** Git repositories the user works in, kept in the app state. */
  projects: {
    list(): Promise<Project[]>;
    /** Whether git is on the login shell's `PATH`; checked once per launch, on the first call. */
    git(): Promise<'ok' | 'missing'>;
    /** Opens the folder picker, then adds the repository that holds the folder. */
    add(): Promise<AddProjectResult>;
    /** Makes `folder` a repository with one empty commit (its files stay untracked), then adds it. */
    init(folder: string): Promise<AddProjectResult>;
    /**
     * Clones into `location/name` and adds it; a name that is not a single folder name is refused. Answers
     * `cancelled` once `cancelClone` ended the clone, or the page navigated away from it.
     */
    clone(request: CloneRequest): Promise<AddProjectResult>;
    /** Ends the running clone, which removes its partial folder. */
    cancelClone(): Promise<void>;
    /** Makes `location/name` a repository with one empty commit, then adds it; refused like `clone`. */
    create(request: CreateRequest): Promise<AddProjectResult>;
    /** Opens the folder picker; `null` when cancelled. */
    pickFolder(): Promise<string | null>;
    /** The user's home folder. */
    home(): Promise<string>;
    /** Opens the folder picker for the project whose folder moved and points the project at the repository picked. */
    updatePath(from: string): Promise<UpdatePathResult>;
    /** Forgets the project; its files stay on disk. */
    remove(path: string): Promise<void>;
    /** Calls `listener` when the main process changed a project's workspaces (a workspace named from its agent's title). */
    onChanged(listener: () => void): () => void;
  };
  /** Git worktrees of a project; every call refuses a project path that is not in the app state. */
  workspaces: {
    /** The local and `origin/*` branches, and the base to preselect. Runs no fetch. */
    branches(project: string): Promise<BranchesResult>;
    /**
     * Creates a branch named after the task (its slug, with `-2`, `-3`… when taken) from `base` and its
     * worktree under `$COCKPIT_HOME/worktrees`.
     */
    create(project: string, task: string, base: string): Promise<CreateWorkspaceResult>;
    /**
     * Reserves a branch named after the task and the worktree's path, answers at once, and makes the worktree
     * then starts `harness` (`terminal`: the setup shell) in the main process, which needs no page for it:
     * `onSettled` tells the end. A refusal here reserved nothing.
     */
    compose(project: string, task: string, base: string, harness: string): Promise<ComposeResult>;
    /** The workspaces whose worktree could not be created and that nobody dismissed. */
    failedSetups(): Promise<FailedSetup[]>;
    /** Forgets a failed setup. */
    dismissSetup(id: string): Promise<void>;
    /** Calls `listener` when a workspace stopped setting up, whatever the outcome; returns the unsubscribe function. */
    onSettled(listener: (settled: SettledSetup) => void): () => void;
    /** Reads what removing the worktree would lose, without writing anything. */
    removal(project: string, path: string): Promise<RemovalResult>;
    /**
     * Removes the worktree. `force` removes it with its uncommitted changes; `deleteBranch` also deletes its
     * branch when merged; `forceBranch`, the name of the branch the caller showed, deletes it whatever its state
     * if it is still the worktree's branch.
     */
    remove(
      project: string,
      path: string,
      options: { force?: boolean; deleteBranch?: boolean; forceBranch?: string },
    ): Promise<RemoveWorkspaceResult>;
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

    /**
     * Runs `cockpit teardown` (the `teardown` commands of the repository's `.cockpit/config.json`) in the
     * worktree, in a pty owned by the calling window. Refused when the project is not in the app state, the path is
     * not one of its linked worktrees, or the config is invalid.
     */
    teardown(project: string, path: string, size: { cols: number; rows: number }): Promise<TeardownResult>;

    /** Where the workspace's branch stands against its upstream. Refused like `changes`. */
    status(project: string, path: string): Promise<BranchStatusResult>;
    /** Commits every change of the worktree (`git add -A`, `git commit`) with the message, trimmed. */
    commit(project: string, path: string, message: string): Promise<CommitResult>;
    /** Runs `git push --set-upstream origin <branch>`, never forced. */
    push(project: string, path: string): Promise<PushResult>;
    /** The newest pull request of the branch, read with `gh`; refused with why when `gh` cannot tell. */
    pullRequest(project: string, path: string): Promise<PullRequestResult>;
    /** Opens a pull request of the branch into the workspace's base with `gh pr create`. */
    createPullRequest(project: string, path: string, title: string, body: string): Promise<CreatePullRequestResult>;
    /** Merges the pull request with `gh pr merge`, refused by gh when the branch's head is no longer `headOid`. */
    mergePullRequest(project: string, path: string, number: number, method: MergeMethod, headOid: string): Promise<MergePullRequestResult>;
    /** The state of the newest pull request of every workspace's branch of the project, in one `gh` run. */
    pullRequestStates(project: string): Promise<PullRequestStatesResult>;
  };
  /** Agent CLIs, run in a folder of their own outside any project or in a workspace of a project. */
  sessions: {
    /**
     * The detected agent CLIs, in catalogue order. Detection runs once per launch; with `again` it runs
     * again (each found CLI's `--version`) and replaces the result every caller shares.
     */
    harnesses(options?: { again?: boolean }): Promise<AvailableHarness[]>;
    /** The stored sessions, newest first. */
    list(): Promise<Session[]>;
    /**
     * Runs the harness in a new folder, or in `options.workspace`, in a pty owned by the calling window.
     * The harness `terminal` runs the login shell instead of an agent CLI; it serves a session with no project.
     * Refused when the project is not in the app state or the path is not one of its linked worktrees.
     */
    start(harness: string, size: { cols: number; rows: number }, options?: StartSessionOptions): Promise<StartSessionResult>;
    /**
     * Calls `listener` each time a session of this window reports (a status, a setup state, the agent's exit,
     * whose `exitCode` is then given); returns the unsubscribe function.
     */
    onStatus(listener: (sessionId: string, event: SessionEvent, exitCode?: number | null) => void): () => void;
    /** Calls `listener` with the id of the session whose notification the user clicked. */
    onOpen(listener: (sessionId: string) => void): () => void;
    /** The workspace sessions whose terminal was lost with its daemon, in creation order. */
    ended(): Promise<EndedSession[]>;
    /** Forgets that a session was open: its ended tab does not come back. */
    dismiss(sessionId: string): Promise<void>;
  };
  /** The background service that runs the terminals and the sessions. */
  daemon: {
    status(): Promise<DaemonStatus>;
    /** Starts the service again after it could not start, and answers its new status. */
    retry(): Promise<DaemonStatus>;
    /** Opens the service's log file. */
    showLog(): Promise<void>;
    /** Calls `listener` each time the status may have changed (the service died, started, or failed to start). */
    onChanged(listener: () => void): () => void;
    /** The terminals of daemons of another protocol, to end before they can be replaced; none once deferred. */
    outdated(): Promise<OutdatedTerminal[]>;
    /** Ends those daemons; refused with why when one refuses or does not answer. */
    restart(): Promise<{ status: 'restarted' } | Refused>;
    /** Keeps those daemons until the next launch. */
    later(): Promise<void>;
  };
  /** The `PATH` of the user's login shell, the only part of its environment the renderer sees. */
  getShellPath(): Promise<string>;
}
