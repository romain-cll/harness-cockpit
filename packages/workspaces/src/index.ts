import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { checkGit, git, list, succeeds, WorkspaceError, type GitEnv, type Worktree } from './git';

export { checkGit, listBranches, WorkspaceError } from './git';
export type { Branches, GitEnv, WorkspaceErrorCode, Worktree } from './git';
export * from './changes';

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

/**
 * Clones `url` into `path`, which must not exist (`DESTINATION_EXISTS`); git creates the parent folders.
 * `GIT_TERMINAL_PROMPT=0` so a credential prompt fails instead of waiting. Aborting `signal` ends git, which
 * removes the partial folder itself.
 */
export async function cloneRepository({
  url,
  path,
  env,
  signal,
}: {
  url: string;
  path: string;
  signal?: AbortSignal;
} & GitEnv): Promise<void> {
  await checkGit(env);
  if (await exists(path)) throw new WorkspaceError('DESTINATION_EXISTS', `${path} already exists.`);
  await git(['clone', '--', url, path], { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, signal });
}

/**
 * Makes `path` (an existing folder) a repository holding one empty commit, so that a worktree can start from
 * it; its files stay untracked. Without an identity git resolves in the new repository, `GIT_IDENTITY_MISSING`.
 * On any failure `.git` is removed again.
 */
export async function initRepository({ path, env }: { path: string } & GitEnv): Promise<void> {
  await checkGit(env);
  await git(['init'], { cwd: path, env });
  try {
    for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      if (!(await succeeds(['var', variable], { cwd: path, env }))) {
        throw new WorkspaceError(
          'GIT_IDENTITY_MISSING',
          'Git needs your name and email to commit. Set user.name and user.email, then try again.',
        );
      }
    }
    await git(['commit', '--allow-empty', '--no-gpg-sign', '-m', 'Initial commit'], { cwd: path, env });
  } catch (error) {
    await rm(join(path, '.git'), { recursive: true, force: true });
    throw error;
  }
}

/** Reconnects the linked worktrees of `repo` after it moved (`git worktree repair`). */
export async function repairWorktrees(repo: string, { env }: GitEnv = {}): Promise<void> {
  await checkGit(env);
  await git(['worktree', 'repair'], { cwd: repo, env });
}

/** The main working tree of the repository containing `path`, which may be inside a linked worktree. */
export async function findRepositoryRoot(path: string, { env }: GitEnv = {}): Promise<string> {
  await checkGit(env);
  return repositoryRoot(path, env);
}

/** The readable names kept in git config, by branch: one `git config` call for the repository. */
async function cockpitNames(repo: string, env?: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let output: string;
  try {
    output = await git(['config', '--get-regexp', '^branch\\..*\\.cockpitname$'], { cwd: repo, env });
  } catch (error) {
    // Exit 1 means no such key.
    if (error instanceof WorkspaceError && error.code === 'GIT_FAILED') return names;
    throw error;
  }
  for (const line of output.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    names.set(key.slice('branch.'.length, -'.cockpitname'.length), line.slice(space + 1));
  }
  return names;
}

export async function listWorktrees(repo: string, { env }: GitEnv = {}): Promise<Worktree[]> {
  await checkGit(env);
  const worktrees = await list(repo, env);
  const names = await cockpitNames(worktrees[0]!.path, env);
  for (const worktree of worktrees) {
    const name = worktree.branch === null ? undefined : names.get(worktree.branch);
    if (name !== undefined) worktree.name = name;
  }
  return worktrees;
}

/** The folder of a project's worktrees under the root: its name and a hash of its path. */
const projectFolder = (main: string) => `${basename(main)}-${createHash('sha256').update(main).digest('hex').slice(0, 8)}`;

const exists = (path: string) => access(path).then(() => true, () => false);

const MAX_SLUG = 40;

/**
 * The branch name for a task or a title: lower-cased, accents removed, every run of characters
 * outside `[a-z0-9]` one `-`, cut to 40 characters at the last `-` (hard-cut without one);
 * `workspace` when nothing is left.
 */
export function branchSlug(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug === '') return 'workspace';
  if (slug.length <= MAX_SLUG) return slug;
  const cut = slug.slice(0, MAX_SLUG + 1).lastIndexOf('-');
  return cut > 0 ? slug.slice(0, cut) : slug.slice(0, MAX_SLUG);
}

async function localBranches(main: string, env?: NodeJS.ProcessEnv): Promise<Set<string>> {
  const output = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: main, env });
  return new Set(output.split('\n').filter((name) => name !== ''));
}

/** The slug of `text`, with `-2`, `-3`… appended until no name in `taken` has it. */
function freeName(text: string, taken: Set<string>): string {
  const slug = branchSlug(text);
  let name = slug;
  for (let n = 2; taken.has(name); n++) name = `${slug}-${n}`;
  return name;
}

/**
 * The branch name for `text` in `repo`: its slug, with `-2`, `-3`… appended while a local branch has that
 * name. With `root` (the worktrees root) a name whose worktree folder exists there is taken too: a renamed
 * workspace keeps its folder, so the name its branch left would be refused by the next creation.
 */
export async function availableBranch(repo: string, text: string, { env, root }: GitEnv & { root?: string } = {}): Promise<string> {
  await checkGit(env);
  const main = await repositoryRoot(repo, env);
  const taken = await localBranches(main, env);
  if (root === undefined) return freeName(text, taken);
  const folder = join(root, projectFolder(main));
  const slug = branchSlug(text);
  let name = slug;
  for (let n = 2; taken.has(name) || (await exists(join(folder, name))); n++) name = `${slug}-${n}`;
  return name;
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
 * rethrown. A name git refuses is `INVALID_BRANCH_NAME`. `root` is created only after every check
 * passed; one that cannot be created is `FS_FAILED`, naming the errno code. Calls for one repository run one at a time,
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
  await checkGit(env);
  const main = await repositoryRoot(repo, env);
  const project = projectFolder(main);

  return serialised(main, async () => {
    // `--branch` expands shorthands such as `@{-1}`: a name it rewrites is not a branch name.
    const checked = await git(['check-ref-format', '--branch', branch], { cwd: main, env }).catch(() => undefined);
    if (checked?.trim() !== branch) throw new WorkspaceError('INVALID_BRANCH_NAME', `invalid branch name: ${branch}`);

    const exists = await succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: main, env });
    if (base === undefined && !exists) {
      throw new WorkspaceError('GIT_FAILED', `no local branch to check out: ${branch}`);
    }
    if (base !== undefined && exists) throw new WorkspaceError('BRANCH_EXISTS', `branch already exists: ${branch}`);
    // Canonical, so the paths built from it match the ones git reports (symbolic links, macOS `/var`).
    // Created only now that every check passed, so a refusal leaves no folder behind.
    let root: string;
    try {
      await mkdir(requestedRoot, { recursive: true });
      root = await realpath(requestedRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
      throw new WorkspaceError('FS_FAILED', `cannot create ${requestedRoot}: ${code}`, { cause: error });
    }
    const path = join(root, project, branch);
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
 * Gives the linked worktree a readable name: stores `name` in `branch.<branch>.cockpitName` and, unless
 * the branch was pushed (it tracks a branch of its own name) or already has the name's slug, renames the branch to it (a taken slug
 * gets a suffix). `git branch -m` carries the branch's other settings, `cockpitBase` included, and the
 * folder stays where it is. Calls for one repository run one at a time.
 */
export async function nameWorkspace({
  worktree,
  name,
  env,
}: {
  worktree: string;
  name: string;
} & GitEnv): Promise<{ branch: string }> {
  await checkGit(env);
  const worktrees = await list(worktree, env);
  const main = worktrees[0]!.path;
  const linked = await linkedWorktree(worktrees, worktree);
  const current = linked.branch;
  if (current === null) throw new WorkspaceError('GIT_FAILED', `no branch to name: ${worktree}`);

  return serialised(main, async () => {
    let branch = current;
    // Pushed: its upstream is a branch of its own name. A branch made from a remote base tracks that
    // base (`git worktree add -b` sets the upstream), which is not a publication.
    const merge = await git(['config', '--get', `branch.${current}.merge`], { cwd: main, env }).catch(() => '');
    if (merge.trim() !== `refs/heads/${current}`) {
      const taken = await localBranches(main, env);
      taken.delete(current);
      branch = freeName(name, taken);
      if (branch !== current) await git(['branch', '-m', '--', current, branch], { cwd: main, env });
    }
    await git(['config', `branch.${branch}.cockpitName`, name], { cwd: main, env });
    return { branch };
  });
}

/** Whether `worktree` has changes `git worktree remove` would refuse: modified, staged or untracked files. */
async function hasUncommitted(worktree: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  // `--no-optional-locks`: a read must not write the index under the gitdir.
  const output = await git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'], { cwd: worktree, env });
  return output.trim() !== '';
}

/**
 * What removing the linked worktree `path` would lose: `uncommitted`, as `removeWorktree`'s check decides,
 * and `merged`, as `git branch -d` would decide for its branch (the upstream if the branch has one that
 * exists, else the main working tree's HEAD); `null` when there is no branch to delete. Writes nothing
 * under the gitdir.
 */
export async function removalState({
  repo,
  path,
  env,
}: {
  repo: string;
  path: string;
} & GitEnv): Promise<{ uncommitted: boolean; merged: boolean | null }> {
  await checkGit(env);
  const worktrees = await list(repo, env);
  const worktree = await linkedWorktree(worktrees, path);
  const main = worktrees[0]!.path;
  const uncommitted = await hasUncommitted(worktree.path, env);
  const branch = worktree.branch;
  if (branch === null || !(await succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: main, env }))) {
    return { uncommitted, merged: null };
  }
  const upstream = await succeeds(['rev-parse', '--verify', '--quiet', `${branch}@{upstream}`], { cwd: main, env });
  const reference = upstream ? `${branch}@{upstream}` : 'HEAD';
  const merged = await succeeds(['merge-base', '--is-ancestor', `refs/heads/${branch}`, reference], { cwd: main, env });
  return { uncommitted, merged };
}

/**
 * Removes a clean linked worktree, or any with `force`, uncommitted changes included. With
 * `deleteBranch`, also deletes its branch if merged: when it is not merged, the worktree is still
 * removed and the call rejects with `BRANCH_NOT_MERGED`. `forceBranch`, the name of a branch, makes it
 * `git branch -D` only when that is the worktree's branch at removal; any other name changes nothing.
 */
export async function removeWorktree({
  repo,
  path,
  deleteBranch,
  force,
  forceBranch,
  env,
}: {
  repo: string;
  path: string;
  deleteBranch?: boolean;
  force?: boolean;
  forceBranch?: string;
} & GitEnv): Promise<void> {
  await checkGit(env);
  const worktrees = await list(repo, env);
  const worktree = await linkedWorktree(worktrees, path);
  const main = worktrees[0]!.path;

  if (!force && (await hasUncommitted(worktree.path, env))) {
    throw new WorkspaceError('DIRTY_WORKTREE', `worktree has uncommitted changes: ${worktree.path}`);
  }
  await git(['worktree', 'remove', ...(force ? ['--force'] : []), '--', worktree.path], { cwd: main, env });

  if (!deleteBranch || worktree.branch === null) return;
  // A branch deleted by hand while checked out is still reported by the worktree: nothing to delete.
  if (!(await succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`], { cwd: main, env }))) return;
  if (!(await succeeds(['branch', forceBranch === worktree.branch ? '-D' : '-d', '--', worktree.branch], { cwd: main, env }))) {
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

/** The `/bin/sh` invocation that runs one setup or teardown command; the command is an argument, never part of a script. */
export function shellInvocation(command: string): { command: '/bin/sh'; args: string[] } {
  return { command: '/bin/sh', args: ['-c', command] };
}
