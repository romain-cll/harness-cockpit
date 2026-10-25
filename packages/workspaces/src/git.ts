import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** `git worktree list --porcelain -z` needs git 2.36. */
const MIN_GIT = { major: 2, minor: 36 };

export type WorkspaceErrorCode =
  | 'NOT_A_REPOSITORY'
  | 'BRANCH_EXISTS'
  | 'INVALID_BRANCH_NAME'
  | 'DIRTY_WORKTREE'
  | 'BRANCH_NOT_MERGED'
  | 'INVALID_CONFIG'
  | 'GIT_MISSING'
  | 'GIT_TOO_OLD'
  | 'GIT_FAILED';

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
}

/**
 * Runs git without a shell and resolves to its stdout. Every failure is `GIT_FAILED`, a missing
 * executable included: with a `cwd`, ENOENT also means the folder is missing.
 */
export async function git(args: string[], { cwd, env }: GitOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env });
    return stdout;
  } catch (error) {
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
