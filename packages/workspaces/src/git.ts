import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** `git worktree list --porcelain -z` needs git 2.36. */
const MIN_GIT = { major: 2, minor: 36 };

/** Node's default of 1 MiB fails a command whose output is merely long (`status` in a big worktree, a chatty hook). */
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;

export type WorkspaceErrorCode =
  | 'NOT_A_REPOSITORY'
  | 'BRANCH_EXISTS'
  | 'INVALID_BRANCH_NAME'
  | 'DIRTY_WORKTREE'
  | 'BRANCH_NOT_MERGED'
  | 'INVALID_CONFIG'
  | 'NO_BASE'
  | 'GIT_MISSING'
  | 'GIT_TOO_OLD'
  | 'DESTINATION_EXISTS'
  | 'GIT_IDENTITY_MISSING'
  | 'GIT_DIR_EXISTS'
  | 'GIT_FAILED'
  | 'FS_FAILED';

/** The only error this package throws: a string `code` survives serialization over IPC. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides the default stdout buffer of 256 MiB. */
  maxBuffer?: number;
  /** Ends git (SIGTERM) when aborted; the call then settles once git has exited. */
  signal?: AbortSignal;
}

/**
 * Runs git without a shell and resolves to its stdout. Every failure is `GIT_FAILED`, a missing
 * executable included: with a `cwd`, ENOENT also means the folder is missing.
 */
export async function git(args: string[], { cwd, env, maxBuffer, signal }: GitOptions = {}): Promise<string> {
  const run = execFileAsync('git', args, { cwd, env, signal, maxBuffer: maxBuffer ?? DEFAULT_MAX_BUFFER });
  try {
    return (await run).stdout;
  } catch (error) {
    // `execFile` rejects at the abort, before git has exited and finished what it was doing.
    if (signal?.aborted && run.child.exitCode === null && run.child.signalCode === null) {
      await new Promise((resolve) => run.child.once('exit', resolve));
    }
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    throw new WorkspaceError(
      'GIT_FAILED',
      `git ${args.join(' ')} failed: ${failure.stderr?.trim() || failure.message}`,
      { cause: failure },
    );
  }
}

/** Whether git exits with 0: for the commands whose exit code is the answer. */
export async function succeeds(args: string[], options: GitOptions = {}): Promise<boolean> {
  try {
    await git(args, options);
    return true;
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'GIT_FAILED') return false;
    throw error;
  }
}

/** Rejects with `GIT_MISSING` or `GIT_TOO_OLD` unless the git on `PATH` is 2.36 or later. */
export async function checkGit(env?: NodeJS.ProcessEnv): Promise<void> {
  let output: string;
  try {
    output = await git(['--version'], { env });
  } catch (error) {
    // Without a `cwd`, ENOENT can only be the missing executable.
    const cause = (error as WorkspaceError).cause as NodeJS.ErrnoException;
    if (cause.code === 'ENOENT') throw new WorkspaceError('GIT_MISSING', 'git is not installed', { cause });
    throw error;
  }
  const match = /(\d+)\.(\d+)/.exec(output);
  if (!match) throw new WorkspaceError('GIT_FAILED', `unrecognised git version: ${output.trim()}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < MIN_GIT.major || (major === MIN_GIT.major && minor < MIN_GIT.minor)) {
    throw new WorkspaceError('GIT_TOO_OLD', `git ${MIN_GIT.major}.${MIN_GIT.minor} or later is required, found ${major}.${minor}`);
  }
}

export type GitEnv = { env?: NodeJS.ProcessEnv };

export interface Worktree {
  path: string;
  /** The checked out commit. */
  head: string | null;
  /** The short branch name, `null` on a detached HEAD. */
  branch: string | null;
  /** Whether this is the main working tree. */
  main: boolean;
  /** The readable name `nameWorkspace` stored in `branch.<branch>.cockpitName`; absent when there is none. */
  name?: string;
}

/** The main working tree comes first. */
export async function list(repo: string, env?: NodeJS.ProcessEnv): Promise<Worktree[]> {
  if (!(await succeeds(['rev-parse', '--show-toplevel'], { cwd: repo, env }))) {
    throw new WorkspaceError('NOT_A_REPOSITORY', `not a git repository: ${repo}`);
  }
  const output = await git(['worktree', 'list', '--porcelain', '-z'], { cwd: repo, env });
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  // Fields end with NUL, and an empty field ends a record.
  for (const field of output.split('\0')) {
    if (field === '') {
      current = undefined;
    } else if (field.startsWith('worktree ')) {
      current = { path: field.slice('worktree '.length), head: null, branch: null, main: worktrees.length === 0 };
      worktrees.push(current);
    } else if (current && field.startsWith('HEAD ')) {
      current.head = field.slice('HEAD '.length);
    } else if (current && field.startsWith('branch ')) {
      current.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return worktrees;
}

export interface Branches {
  /** Short names of the local branches. */
  local: string[];
  /** `origin/<branch>` remote-tracking branches, without `origin/HEAD`. */
  remote: string[];
  /** The branch a new workspace starts from unless told otherwise, `null` when there is none. */
  defaultBase: string | null;
}

/**
 * The local and `origin/*` branches of the repository, as they are: nothing is fetched. The default
 * base is `origin/D` when it exists, else the local `D`, else `null`, where `D` is the branch
 * `origin/HEAD` points at or, without it, the one checked out in the main working tree.
 */
export async function listBranches(repo: string, { env }: GitEnv = {}): Promise<Branches> {
  await checkGit(env);
  const [main] = await list(repo, env);
  if (!main) throw new WorkspaceError('GIT_FAILED', `git worktree list found no worktree in ${repo}`);

  const output = await git(
    ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes/origin'],
    { cwd: main.path, env },
  );
  const local: string[] = [];
  const remote: string[] = [];
  for (const line of output.split('\n')) {
    const [ref = '', symref = ''] = line.split('\0');
    if (symref !== '') continue;
    if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/origin/')) remote.push(ref.slice('refs/remotes/'.length));
  }

  let target: string | null = main.branch;
  try {
    const head = (await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: main.path, env })).trim();
    target = head.replace(/^refs\/remotes\/origin\//, '');
  } catch (error) {
    // Exit 1 means `origin/HEAD` is not a symbolic ref (or is missing): fall back to the checked out branch.
    if (!(error instanceof WorkspaceError && error.code === 'GIT_FAILED')) throw error;
  }
  const defaultBase =
    target === null ? null : remote.includes(`origin/${target}`) ? `origin/${target}` : local.includes(target) ? target : null;
  return { local, remote, defaultBase };
}
