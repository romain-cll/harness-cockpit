import { existsSync, watch, type FSWatcher } from 'node:fs';
import { copyFile, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkGit, git, succeeds, WorkspaceError } from './git';
import { listBranches, type GitEnv } from './index';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** The previous path of a renamed file. */
  oldPath?: string;
  /** `null` for a binary file. */
  additions: number | null;
  deletions: number | null;
}

export interface Changes {
  /** The branch the changes are against. */
  base: string;
  /** Sorted by path. */
  files: ChangedFile[];
}

export type FileDiff = { kind: 'text'; patch: string } | { kind: 'binary' } | { kind: 'tooLarge' };

/** The largest diff `fileDiff` returns, set on the git call itself. */
const MAX_DIFF_BYTES = 1024 * 1024;

const DEBOUNCE_MS = 200;

// Watcher start-up: how often the folder is touched, how long to wait for the first event, and the
// quiet time after it.
const PROBE_MS = 10;
const PROBE_TIMEOUT_MS = 2000;
const SETTLE_MS = 50;

/** Git's output trimmed, or `null` when git exits with a non-zero code. */
const output = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
  git(args, { cwd, env }).then(
    (stdout) => stdout.trim(),
    () => null,
  );

/**
 * The recorded base of the workspace's branch (see `createWorktree`) when it still resolves to a
 * commit, else the project's default base. Resolves to the base and its merge-base with HEAD.
 */
async function resolveBase(worktree: string, env?: NodeJS.ProcessEnv): Promise<{ base: string; mergeBase: string }> {
  const branch = await output(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktree, env);
  const recorded = branch ? await output(['config', '--get', `branch.${branch}.cockpitBase`], worktree, env) : null;
  const base =
    recorded && (await succeeds(['rev-parse', '--verify', '--quiet', `${recorded}^{commit}`], { cwd: worktree, env }))
      ? recorded
      : (await listBranches(worktree, { env })).defaultBase;
  if (base === null) throw new WorkspaceError('NO_BASE', `no base branch to compare ${worktree} with`);
  const mergeBase = (await git(['merge-base', base, 'HEAD'], { cwd: worktree, env })).trim();
  return { base, mergeBase };
}

/**
 * Runs `task` with the environment of a temporary copy of the worktree's index in which the
 * untracked files that git does not ignore are marked with `git add -N`, so that one `git diff`
 * shows them. The real index is never written.
 */
async function withUntrackedVisible<T>(
  worktree: string,
  env: NodeJS.ProcessEnv | undefined,
  task: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const index = resolve(worktree, (await git(['rev-parse', '--git-path', 'index'], { cwd: worktree, env })).trim());
  const folder = await mkdtemp(join(tmpdir(), 'cockpit-index-'));
  try {
    const indexEnv = { ...(env ?? process.env), GIT_INDEX_FILE: join(folder, 'index') };
    await copyFile(index, indexEnv.GIT_INDEX_FILE);
    await git(['add', '-N', '--', '.'], { cwd: worktree, env: indexEnv });
    return await task(indexEnv);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const STATUSES: Record<string, ChangedFile['status']> = { A: 'added', D: 'deleted', R: 'renamed' };

/**
 * The working tree of a linked worktree (commits, uncommitted edits and untracked files not ignored
 * by git) against `git merge-base <base> HEAD`, as a pull request would show them. The base is the
 * one recorded at creation when it still exists, else the project's default base; `NO_BASE` when
 * there is none.
 */
export async function listChanges(worktree: string, { env }: GitEnv = {}): Promise<Changes> {
  await checkGit(env);
  const { base, mergeBase } = await resolveBase(worktree, env);
  const [statuses, counts] = await withUntrackedVisible(worktree, env, (indexEnv) => {
    const diff = (format: string) => git(['diff', format, '-z', '-M', mergeBase], { cwd: worktree, env: indexEnv });
    return Promise.all([diff('--name-status'), diff('--numstat')] as const);
  });

  // `--numstat -z`: `<added>\t<deleted>\t<path>\0`, or, for a rename, `<added>\t<deleted>\t\0<old>\0<new>\0`.
  const countsByPath = new Map<string, Pick<ChangedFile, 'additions' | 'deletions'>>();
  const fields = counts.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index]!);
    if (!match) continue;
    const path = match[3] === '' ? fields[(index += 2)]! : match[3]!;
    countsByPath.set(path, {
      additions: match[1] === '-' ? null : Number(match[1]),
      deletions: match[2] === '-' ? null : Number(match[2]),
    });
  }

  // `--name-status -z`: `<letter>\0<path>\0`, or, for a rename, `R<score>\0<old>\0<new>\0`.
  const files: ChangedFile[] = [];
  const entries = statuses.split('\0');
  for (let index = 0; entries[index]; ) {
    const letter = entries[index++]![0]!;
    const status = STATUSES[letter] ?? 'modified';
    const oldPath = status === 'renamed' ? entries[index++]! : undefined;
    const path = entries[index++]!;
    files.push({
      path,
      status,
      ...(oldPath === undefined ? {} : { oldPath }),
      ...(countsByPath.get(path) ?? { additions: null, deletions: null }),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { base, files };
}

/**
 * Git's unified diff of one file of `listChanges` against the same merge-base (a rename is one
 * patch). `binary` for a file git cannot diff as text, `tooLarge` for a diff over 1 MiB.
 */
export async function fileDiff(worktree: string, file: ChangedFile, { env }: GitEnv = {}): Promise<FileDiff> {
  await checkGit(env);
  const { mergeBase } = await resolveBase(worktree, env);
  const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];
  let patch: string;
  try {
    patch = await withUntrackedVisible(worktree, env, (indexEnv) =>
      git(['--literal-pathspecs', 'diff', '--no-ext-diff', '-M', mergeBase, '--', ...paths], {
        cwd: worktree,
        env: indexEnv,
        maxBuffer: MAX_DIFF_BYTES,
      }),
    );
  } catch (error) {
    const cause = error instanceof WorkspaceError ? (error.cause as NodeJS.ErrnoException) : undefined;
    if (cause?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'tooLarge' };
    throw error;
  }
  if (!/^@@ /m.test(patch) && /^Binary files .* differ$/m.test(patch)) return { kind: 'binary' };
  return { kind: 'text', patch };
}

export interface BranchStatus {
  /** The short branch name, `null` on a detached HEAD. */
  branch: string | null;
  /** The upstream as `origin/feat`, `null` when the branch has none. */
  upstream: string | null;
  /** Whether the worktree has a change to commit: edits, deletions, untracked files not ignored. */
  uncommitted: boolean;
  /** Whether HEAD has commits the upstream lacks, or, without an upstream, commits beyond the merge-base with the base. */
  unpushed: boolean;
}

/** The state of a worktree's branch against its upstream; `NO_BASE` when it has no upstream and no base either. */
export async function branchStatus(worktree: string, { env }: GitEnv = {}): Promise<BranchStatus> {
  await checkGit(env);
  const branch = await output(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktree, env);
  const upstream = await output(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], worktree, env);
  const since = upstream ?? (await resolveBase(worktree, env)).mergeBase;
  const [status, ahead] = await Promise.all([
    git(['--no-optional-locks', 'status', '--porcelain'], { cwd: worktree, env }),
    git(['rev-list', '--count', `${since}..HEAD`], { cwd: worktree, env }),
  ]);
  return { branch, upstream, uncommitted: status.trim() !== '', unpushed: Number(ahead) > 0 };
}

/** The subject (first line) of HEAD's commit. */
export async function headSubject(worktree: string, { env }: GitEnv = {}): Promise<string> {
  await checkGit(env);
  return (await git(['log', '-1', '--format=%s'], { cwd: worktree, env })).trim();
}

/** Commits every change of the worktree in one commit: `git add -A`, then `git commit -m <message>`. */
export async function commitAll(worktree: string, message: string, { env }: GitEnv = {}): Promise<void> {
  await checkGit(env);
  await git(['add', '-A'], { cwd: worktree, env });
  await git(['commit', '-m', message], { cwd: worktree, env });
}

/**
 * Pushes the worktree's branch with `git push --set-upstream origin <branch>`, never forced. A
 * detached HEAD is `GIT_FAILED`; so is a refusal by the remote, with git's message.
 */
export async function pushBranch(worktree: string, { env }: GitEnv = {}): Promise<void> {
  await checkGit(env);
  const branch = await output(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktree, env);
  if (branch === null) throw new WorkspaceError('GIT_FAILED', `${worktree} has no branch`);
  await git(['push', '--set-upstream', 'origin', branch], {
    cwd: worktree,
    env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
  });
}

/**
 * The git metadata a commit, a push or a fetch changes, besides the files of the worktree: its gitdir
 * (HEAD, the index, its reflog), the common dir's `refs/remotes` (recursive) and its `packed-refs`
 * (a file of the common dir, so the common dir is watched without recursion and filtered on the name).
 * Empty when `path` is not in a repository.
 */
async function gitWatchTargets(path: string, env?: NodeJS.ProcessEnv) {
  try {
    const [gitDir, commonDir] = (
      await git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: path, env })
    )
      .trim()
      .split('\n');
    return [
      { dir: gitDir!, recursive: true },
      { dir: join(commonDir!, 'refs', 'remotes'), recursive: true },
      { dir: commonDir!, recursive: false, name: 'packed-refs' },
    ];
  } catch {
    return [];
  }
}

/**
 * Resolves once the files under `path` and the git metadata of its repository (see `gitWatchTargets`)
 * are being watched (recursive `fs.watch`, FSEvents-backed on macOS), then calls `onChange` once they
 * stopped changing for 200 ms. A git folder that does not exist is not watched. `onError` gets a watcher
 * failure, after which no event comes.
 */
export async function watchWorktree(
  path: string,
  onChange: () => void,
  onError?: (error: Error) => void,
  { env }: GitEnv = {},
): Promise<{ close(): void }> {
  let timer: NodeJS.Timeout | undefined;
  let live = false;
  const targets = [{ dir: path, recursive: true, name: undefined }, ...(await gitWatchTargets(path, env))].filter(
    (target, index, all) => all.findIndex(({ dir }) => dir === target.dir) === index && (index === 0 || existsSync(target.dir)),
  );
  const watchers: FSWatcher[] = [];
  const close = () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
  // Each watcher reports its first event, which says its stream is running.
  const firsts = targets.map(({ dir, recursive, name }) => {
    let reported!: () => void;
    const first = new Promise<void>((resolve) => (reported = resolve));
    const watcher = watch(dir, { recursive }, (_event, filename) => {
      if (!live) return reported();
      if (name !== undefined && filename !== name) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, DEBOUNCE_MS);
    });
    watcher.on('error', (error) => {
      close();
      onError?.(error);
    });
    watchers.push(watcher);
    return { dir, first };
  });

  // FSEvents starts its stream after `watch` returns, and a change made before is never reported:
  // touch the folders until every stream reports it, and let the events of the touches die down.
  const probe = setInterval(() => {
    const now = new Date();
    for (const { dir } of firsts) void utimes(dir, now, now).catch(() => {});
  }, PROBE_MS);
  await Promise.race([Promise.all(firsts.map(({ first }) => first)), sleep(PROBE_TIMEOUT_MS)]);
  clearInterval(probe);
  await sleep(SETTLE_MS);
  live = true;
  return { close };
}
