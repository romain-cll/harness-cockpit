import { watch } from 'node:fs';
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

/**
 * Resolves once the files under `path` are being watched (recursive `fs.watch`, FSEvents-backed on
 * macOS), then calls `onChange` once they stopped changing for 200 ms. `onError` gets a watcher
 * failure, after which no event comes.
 */
export async function watchWorktree(
  path: string,
  onChange: () => void,
  onError?: (error: Error) => void,
): Promise<{ close(): void }> {
  let timer: NodeJS.Timeout | undefined;
  let live = false;
  let reported!: () => void;
  const first = new Promise<void>((resolve) => (reported = resolve));
  const watcher = watch(path, { recursive: true }, () => {
    if (!live) return reported();
    clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  });
  const close = () => {
    clearTimeout(timer);
    watcher.close();
  };
  watcher.on('error', (error) => {
    close();
    onError?.(error);
  });

  // FSEvents starts its stream after `watch` returns, and a change made before is never reported:
  // touch the folder until the stream reports it, and let the events of the touches die down.
  const probe = setInterval(() => {
    const now = new Date();
    void utimes(path, now, now).catch(() => {});
  }, PROBE_MS);
  await Promise.race([first, sleep(PROBE_TIMEOUT_MS)]);
  clearInterval(probe);
  await sleep(SETTLE_MS);
  live = true;
  return { close };
}
