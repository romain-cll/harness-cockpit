import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { checkGit, git, succeeds, WorkspaceError } from './git';

export { WorkspaceError } from './git';
export type { WorkspaceErrorCode } from './git';
export * from './changes';

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

const queues = new Map<string, Promise<void>>();

/** Runs `task` after the earlier ones for `key` settle, whatever their outcome. */
function serialised<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.then(
    () => {},
    () => {},
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/**
 * Creates the worktree at `<root>/<project>-<hash>/<branch>`, creating `root` if needed. With `base`
 * it creates `branch` from it; without, it checks out the existing local `branch`, and refuses a
 * name that is not a local branch (a tag, a SHA, a remote-only name). All or nothing: if git fails,
 * the worktree and the branch this call created are removed, and the original `GIT_FAILED` is
 * rethrown; a root that cannot be created is `GIT_FAILED` too. A name git refuses is `INVALID_BRANCH_NAME`. Calls for one repository run one at a time,
 * so of two creating the same branch, the second gets `BRANCH_EXISTS`.
 */
export async function createWorktree({
  repo,
  root: requestedRoot,
  branch,
  base,
  env,
}: {
  repo: string;
  root: string;
  branch: string;
  base?: string;
} & GitEnv): Promise<Worktree> {
  if (!isAbsolute(requestedRoot)) throw new TypeError(`root must be an absolute path: ${requestedRoot}`);
  // Canonical, so the paths built from it match the ones git reports (symbolic links, macOS `/var`).
  let root: string;
  try {
    await mkdir(requestedRoot, { recursive: true });
    root = await realpath(requestedRoot);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkspaceError('GIT_FAILED', `cannot create ${requestedRoot}: ${reason}`, { cause: error });
  }
  await checkGit(env);
  const main = await repositoryRoot(repo, env);
  const project = `${basename(main)}-${createHash('sha256').update(main).digest('hex').slice(0, 8)}`;
  const path = join(root, project, branch);

  return serialised(main, async () => {
    // `--branch` expands shorthands such as `@{-1}`: a name it rewrites is not a branch name.
    const checked = await git(['check-ref-format', '--branch', branch], { cwd: main, env }).catch(() => undefined);
    if (checked?.trim() !== branch) throw new WorkspaceError('INVALID_BRANCH_NAME', `invalid branch name: ${branch}`);

    const exists = await succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: main, env });
    if (base === undefined && !exists) {
      throw new WorkspaceError('GIT_FAILED', `no local branch to check out: ${branch}`);
    }
    if (base !== undefined && exists) throw new WorkspaceError('BRANCH_EXISTS', `branch already exists: ${branch}`);
    const registered = (await findLinked(await list(main, env), path)) !== undefined;

    try {
      // The base a workspace is compared with later; git keeps it next to the branch's own settings.
      if (base !== undefined) await git(['config', `branch.${branch}.cockpitBase`, base], { cwd: main, env });
      await git(
        base === undefined
          ? ['worktree', 'add', '--', path, branch]
          : ['worktree', 'add', '-b', branch, '--', path, base],
        { cwd: main, env },
      );
    } catch (error) {
      // All or nothing: undo only what this call created. A failing hook leaves the worktree in place.
      if (!registered) await succeeds(['worktree', 'remove', '--force', '--', path], { cwd: main, env });
      if (!exists) {
        await succeeds(['branch', '-D', '--', branch], { cwd: main, env });
        await succeeds(['config', '--unset', `branch.${branch}.cockpitBase`], { cwd: main, env });
      }
      throw error;
    }
    return linkedWorktree(await list(main, env), path);
  });
}

/**
 * Removes a clean linked worktree, or any with `force`, uncommitted changes included. With
 * `deleteBranch`, also deletes its branch if merged: when it is not, the worktree is still removed
 * and the call rejects with `BRANCH_NOT_MERGED`.
 */
export async function removeWorktree({
  repo,
  path,
  deleteBranch,
  force,
  env,
}: {
  repo: string;
  path: string;
  deleteBranch?: boolean;
  force?: boolean;
} & GitEnv): Promise<void> {
  await checkGit(env);
  const worktrees = await list(repo, env);
  const worktree = await linkedWorktree(worktrees, path);
  const main = worktrees[0]!.path;

  if (
    !force &&
    (await git(['status', '--porcelain', '--untracked-files=normal'], { cwd: worktree.path, env })).trim() !== ''
  ) {
    throw new WorkspaceError('DIRTY_WORKTREE', `worktree has uncommitted changes: ${worktree.path}`);
  }
  await git(['worktree', 'remove', ...(force ? ['--force'] : []), '--', worktree.path], { cwd: main, env });

  if (!deleteBranch || worktree.branch === null) return;
  // A branch deleted by hand while checked out is still reported by the worktree: nothing to delete.
  if (!(await succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`], { cwd: main, env }))) return;
  if (!(await succeeds(['branch', '-d', '--', worktree.branch], { cwd: main, env }))) {
    throw new WorkspaceError('BRANCH_NOT_MERGED', `branch is not merged: ${worktree.branch}`);
  }
}

export interface WorkspaceConfig {
  /** Shell commands to run, in order, in the new worktree. */
  setup: string[];
  /** Shell commands to run, in order, in the worktree before it is removed. */
  teardown: string[];
  /** The variables to add to the environment the commands run in. */
  env: {
    COCKPIT_ROOT_PATH: string;
    COCKPIT_WORKSPACE_PATH: string;
    COCKPIT_WORKSPACE_NAME: string;
  };
}

/** Throws `INVALID_CONFIG` unless `value` is `{ setup?: string[], teardown?: string[] }` with non-blank commands. */
function parseConfig(value: unknown, file: string): Pick<WorkspaceConfig, 'setup' | 'teardown'> {
  const invalid = (reason: string) => new WorkspaceError('INVALID_CONFIG', `invalid config ${file}: ${reason}`);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('expected an object');
  const config: Pick<WorkspaceConfig, 'setup' | 'teardown'> = { setup: [], teardown: [] };
  for (const [key, commands] of Object.entries(value)) {
    if (key !== 'setup' && key !== 'teardown') throw invalid(`unknown key "${key}"`);
    if (!Array.isArray(commands)) throw invalid(`"${key}" must be an array of commands`);
    if (!commands.every((command) => typeof command === 'string' && command.trim() !== '')) {
      throw invalid(`"${key}" must hold only non-empty strings`);
    }
    config[key] = commands;
  }
  return config;
}

/**
 * The setup and teardown commands that `<main working tree>/.cockpit/config.json` declares for the
 * linked worktree `path`, with the variables to run them with. The file is
 * `{ "setup": string[], "teardown": string[] }`, both keys optional, no other key. It is read from
 * the main working tree only, never from the worktree; a missing file means no commands, and one that
 * cannot be read or is invalid is `INVALID_CONFIG`. The caller runs the commands in order, in the
 * worktree, with `env` added to its environment: nothing is run here.
 */
export async function readWorkspaceConfig({
  repo,
  path,
  env,
}: {
  repo: string;
  path: string;
} & GitEnv): Promise<WorkspaceConfig> {
  await checkGit(env);
  const worktrees = await list(repo, env);
  const worktree = await linkedWorktree(worktrees, path);
  const main = worktrees[0]!.path;
  const file = join(main, '.cockpit', 'config.json');

  let text: string | undefined;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const failure = error as NodeJS.ErrnoException;
      throw new WorkspaceError('INVALID_CONFIG', `cannot read config ${file}: ${failure.code ?? failure.message}`, {
        cause: error,
      });
    }
  }

  let commands: Pick<WorkspaceConfig, 'setup' | 'teardown'> = { setup: [], teardown: [] };
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new WorkspaceError('INVALID_CONFIG', `config ${file} is not valid JSON: ${(error as Error).message}`, {
        cause: error,
      });
    }
    commands = parseConfig(parsed, file);
  }

  return {
    ...commands,
    env: {
      COCKPIT_ROOT_PATH: main,
      COCKPIT_WORKSPACE_PATH: worktree.path,
      COCKPIT_WORKSPACE_NAME: worktree.branch ?? basename(worktree.path),
    },
  };
}

/**
 * The `/bin/sh` invocation that runs `commands` in order, each in a `/bin/sh -c` of its own and
 * preceded by a `$ <command>` line, and stops at the first failure with its exit code. The commands
 * are positional arguments of the script, never interpolated into it.
 */
export function commandsInvocation(commands: readonly string[]): { command: '/bin/sh'; args: string[] } {
  return {
    command: '/bin/sh',
    args: ['-c', 'for c do printf "$ %s\\n" "$c"; /bin/sh -c "$c" || exit; done', 'sh', ...commands],
  };
}
