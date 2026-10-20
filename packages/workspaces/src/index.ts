import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { checkGit, git, succeeds, WorkspaceError } from './git';

export { WorkspaceError } from './git';
export type { WorkspaceErrorCode } from './git';

export type GitEnv = { env?: NodeJS.ProcessEnv };

export interface Worktree {
  path: string;
  /** The checked out commit. */
  head: string | null;
  /** The short branch name, `null` on a detached HEAD. */
  branch: string | null;
  /** Whether this is the main working tree. */
  main: boolean;
}

/** The main working tree comes first. */
async function list(repo: string, env?: NodeJS.ProcessEnv): Promise<Worktree[]> {
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

async function repositoryRoot(path: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const [main] = await list(path, env);
  if (!main) throw new WorkspaceError('GIT_FAILED', `git worktree list found no worktree in ${path}`);
  return main.path;
}

const realPath = (path: string) => realpath(path).catch(() => path);

/** The linked worktree at `path`, compared by real path (macOS `/var` is `/private/var`). */
async function findLinked(worktrees: Worktree[], path: string): Promise<Worktree | undefined> {
  const wanted = await realPath(path);
  for (const worktree of worktrees) {
    if (!worktree.main && (await realPath(worktree.path)) === wanted) return worktree;
  }
  return undefined;
}

async function linkedWorktree(worktrees: Worktree[], path: string): Promise<Worktree> {
  const worktree = await findLinked(worktrees, path);
  if (!worktree) throw new WorkspaceError('GIT_FAILED', `not a linked worktree: ${path}`);
  return worktree;
}

/** The main working tree of the repository containing `path`, which may be inside a linked worktree. */
export async function findRepositoryRoot(path: string, { env }: GitEnv = {}): Promise<string> {
  await checkGit(env);
  return repositoryRoot(path, env);
}

export async function listWorktrees(repo: string, { env }: GitEnv = {}): Promise<Worktree[]> {
  await checkGit(env);
  return list(repo, env);
}

/**
 * Creates the worktree at `<root>/<project>-<hash>/<branch>`. With `base` it creates `branch` from
 * it; without, it checks out the existing local `branch`, and refuses a name that is not a local
 * branch (a tag, a SHA, a remote-only name). All or nothing: if git fails, the worktree and the
 * branch this call created are removed, and the original `GIT_FAILED` is rethrown.
 */
export async function createWorktree({
  repo,
  root,
  branch,
  base,
  env,
}: {
  repo: string;
  root: string;
  branch: string;
  base?: string;
} & GitEnv): Promise<Worktree> {
  if (!isAbsolute(root)) throw new TypeError(`root must be an absolute path: ${root}`);
  await checkGit(env);
  const main = await repositoryRoot(repo, env);
  // `--branch` expands shorthands such as `@{-1}`: a name it rewrites is not a branch name.
  const checked = await git(['check-ref-format', '--branch', branch], { cwd: main, env });
  if (checked.trim() !== branch) throw new WorkspaceError('GIT_FAILED', `invalid branch name: ${branch}`);
  const project = `${basename(main)}-${createHash('sha256').update(main).digest('hex').slice(0, 8)}`;
  const path = join(root, project, branch);

  const exists = await succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: main, env });
  if (base === undefined && !exists) {
    throw new WorkspaceError('GIT_FAILED', `no local branch to check out: ${branch}`);
  }
  if (base !== undefined && exists) throw new WorkspaceError('BRANCH_EXISTS', `branch already exists: ${branch}`);
  const registered = (await findLinked(await list(main, env), path)) !== undefined;

  try {
    await git(
      base === undefined
        ? ['worktree', 'add', '--', path, branch]
        : ['worktree', 'add', '-b', branch, '--', path, base],
      { cwd: main, env },
    );
  } catch (error) {
    // All or nothing: undo only what this call created. A failing hook leaves the worktree in place.
    if (!registered) await succeeds(['worktree', 'remove', '--force', '--', path], { cwd: main, env });
    if (!exists) await succeeds(['branch', '-D', '--', branch], { cwd: main, env });
    throw error;
  }
  return linkedWorktree(await list(main, env), path);
}

/**
 * Removes a clean linked worktree. With `deleteBranch`, also deletes its branch if merged: when it
 * is not, the worktree is still removed and the call rejects with `BRANCH_NOT_MERGED`.
 */
export async function removeWorktree({
  repo,
  path,
  deleteBranch,
  env,
}: {
  repo: string;
  path: string;
  deleteBranch?: boolean;
} & GitEnv): Promise<void> {
  await checkGit(env);
  const worktrees = await list(repo, env);
  const worktree = await linkedWorktree(worktrees, path);
  const main = worktrees[0]!.path;

  if ((await git(['status', '--porcelain', '--untracked-files=normal'], { cwd: worktree.path, env })).trim() !== '') {
    throw new WorkspaceError('DIRTY_WORKTREE', `worktree has uncommitted changes: ${worktree.path}`);
  }
  await git(['worktree', 'remove', '--', worktree.path], { cwd: main, env });

  if (!deleteBranch || worktree.branch === null) return;
  // A branch deleted by hand while checked out is still reported by the worktree: nothing to delete.
  if (!(await succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`], { cwd: main, env }))) return;
  if (!(await succeeds(['branch', '-d', '--', worktree.branch], { cwd: main, env }))) {
    throw new WorkspaceError('BRANCH_NOT_MERGED', `branch is not merged: ${worktree.branch}`);
  }
}
