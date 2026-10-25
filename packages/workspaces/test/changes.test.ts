import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorkspaceError } from '../src/git';
import { branchStatus, commitAll, createWorktree, fileDiff, listChanges, pushBranch, removeWorktree, watchWorktree } from '../src/index';

// COCKPIT-34: the changes of a workspace against its base, the diff of one file, and the
// watcher. Drives the real git on temporary repositories under os.tmpdir(), with an env that
// ignores the user's global and system git config.

vi.setConfig({ testTimeout: 30_000 });

const testEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temporary folder, resolved to its real path (macOS `/var` is `/private/var`). */
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-changes-')));
  created.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: testEnv, encoding: 'utf8' }).trim();
}

const lines = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join('');

/**
 * A repository on `main` holding `a.txt`, `b.txt`, `c.txt`, `d.txt` and `z.txt` (committed),
 * and a `.gitignore` for `*.log`.
 */
async function makeRepo(): Promise<string> {
  const repo = join(await tempDir(), 'my-repo');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, '.gitignore'), '*.log\n');
  await writeFile(join(repo, 'a.txt'), lines('a', 10));
  await writeFile(join(repo, 'b.txt'), lines('b', 5));
  await writeFile(join(repo, 'c.txt'), lines('c', 3));
  await writeFile(join(repo, 'd.txt'), lines('d', 12));
  await writeFile(join(repo, 'z.txt'), lines('z', 4));
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  return repo;
}

/** The workspace `feat` created by the package from `main`, with the folder it lives in. */
async function makeWorkspace(repo: string): Promise<string> {
  const root = await tempDir();
  const { path } = await createWorktree({ repo, root, branch: 'feat', base: 'main', env: testEnv });
  return path;
}

/** The workspace of AC3: every kind of change, and a later commit on `main` that must not show. */
async function makeChangedWorkspace(): Promise<{ repo: string; worktree: string }> {
  const repo = await makeRepo();
  const worktree = await makeWorkspace(repo);

  // A commit modifying a.txt.
  await writeFile(join(worktree, 'a.txt'), lines('a', 10).replace('a 2\n', 'a two\n'));
  git(worktree, 'add', 'a.txt');
  git(worktree, 'commit', '-m', 'edit a');
  // Uncommitted: an edit, a deletion, a rename with the content unchanged.
  await writeFile(join(worktree, 'b.txt'), `${lines('b', 5)}b extra\n`);
  await rm(join(worktree, 'c.txt'));
  await rename(join(worktree, 'd.txt'), join(worktree, 'e.txt'));
  // Untracked: one file, and one that git ignores.
  await writeFile(join(worktree, 'new.txt'), 'one\ntwo\n');
  await writeFile(join(worktree, 'out.log'), 'ignored\n');
  // A later commit on main, which a pull request would not show.
  await writeFile(join(repo, 'z.txt'), lines('z', 4).replace('z 1\n', 'z one\n'));
  git(repo, 'commit', '-am', 'later on main');

  return { repo, worktree };
}

/** The rejection of a promise, failing the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<WorkspaceError> {
  const outcome = await promise.then(
    (value) => ({ resolved: true as const, value }),
    (error: unknown) => ({ resolved: false as const, error }),
  );
  if (outcome.resolved) throw new Error(`expected a rejection, got ${JSON.stringify(outcome.value)}`);
  expect(outcome.error).toBeInstanceOf(WorkspaceError);
  return outcome.error as WorkspaceError;
}

async function changedFile(worktree: string, path: string) {
  const { files } = await listChanges(worktree, { env: testEnv });
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`${path} is not among the changes: ${JSON.stringify(files)}`);
  return file;
}

describe('listChanges', () => {
  test('AC3 — lists the working tree against the merge-base: statuses, counts, renames and untracked files, sorted, the real index untouched', async () => {
    const { worktree } = await makeChangedWorkspace();
    const statusBefore = git(worktree, 'status', '--porcelain');

    const changes = await listChanges(worktree, { env: testEnv });

    expect(changes.base).toBe('main');
    expect(
      changes.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
    ).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 1 },
      { path: 'b.txt', status: 'modified', additions: 1, deletions: 0 },
      { path: 'c.txt', status: 'deleted', additions: 0, deletions: 3 },
      { path: 'e.txt', status: 'renamed', additions: 0, deletions: 0 },
      { path: 'new.txt', status: 'added', additions: 2, deletions: 0 },
    ]);
    expect(changes.files.find((file) => file.path === 'e.txt')).toMatchObject({ oldPath: 'd.txt' });
    expect(git(worktree, 'status', '--porcelain')).toBe(statusBefore);
  });

  test('AC4 — falls back to the default base when the recorded base branch was deleted', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    git(repo, 'branch', 'dev', 'main');
    git(repo, 'switch', '-q', 'dev');
    await writeFile(join(repo, 'dev.txt'), 'dev\n');
    git(repo, 'add', 'dev.txt');
    git(repo, 'commit', '-m', 'on dev');
    git(repo, 'switch', '-q', 'main');
    const { path: worktree } = await createWorktree({ repo, root, branch: 'feat', base: 'dev', env: testEnv });
    await writeFile(join(worktree, 'b.txt'), `${lines('b', 5)}b extra\n`);
    git(repo, 'branch', '-D', 'dev');

    const changes = await listChanges(worktree, { env: testEnv });

    expect(changes.base).toBe('main');
    expect(changes.files.map(({ path, status }) => [path, status])).toEqual([
      ['b.txt', 'modified'],
      ['dev.txt', 'added'],
    ]);
  });

  test('AC4 — falls back to the default base for a workspace made with plain git worktree add', async () => {
    const repo = await makeRepo();
    const worktree = join(await tempDir(), 'plain');
    git(repo, 'worktree', 'add', '-b', 'plain', '--', worktree, 'main');
    await writeFile(join(worktree, 'new.txt'), 'one\n');

    const changes = await listChanges(worktree, { env: testEnv });

    expect(changes.base).toBe('main');
    expect(changes.files.map(({ path, status }) => [path, status])).toEqual([['new.txt', 'added']]);
  });

  test('AC5 — rejects NO_BASE when nothing was recorded and the repository has no default base', async () => {
    const repo = await makeRepo();
    const worktree = join(await tempDir(), 'plain');
    git(repo, 'worktree', 'add', '-b', 'plain', '--', worktree, 'main');
    // A detached HEAD in the main working tree and no origin: no default base.
    git(repo, 'checkout', '--detach');

    const error = await rejection(listChanges(worktree, { env: testEnv }));

    expect(error.code).toBe('NO_BASE');
  });

  test('AC7 — gives a binary file null counts', async () => {
    const repo = await makeRepo();
    const worktree = await makeWorkspace(repo);
    await writeFile(join(worktree, 'bin.dat'), Buffer.from([0, 1, 2]));

    const file = await changedFile(worktree, 'bin.dat');

    expect(file).toMatchObject({ path: 'bin.dat', status: 'added', additions: null, deletions: null });
  });
});

describe('fileDiff', () => {
  test('AC6 — gives git\'s unified diff of a modified, an added, a deleted and a renamed file', async () => {
    const { worktree } = await makeChangedWorkspace();

    const modified = await fileDiff(worktree, await changedFile(worktree, 'a.txt'), { env: testEnv });
    expect(modified.kind).toBe('text');
    const modifiedPatch = (modified as { kind: 'text'; patch: string }).patch;
    expect(modifiedPatch).toContain('--- a/a.txt');
    expect(modifiedPatch).toContain('+++ b/a.txt');
    expect(modifiedPatch).toMatch(/^@@ -1,5 \+1,5 @@/m);
    expect(modifiedPatch).toContain('-a 2\n+a two\n');

    const added = await fileDiff(worktree, await changedFile(worktree, 'new.txt'), { env: testEnv });
    expect(added.kind).toBe('text');
    const addedPatch = (added as { kind: 'text'; patch: string }).patch;
    expect(addedPatch).toContain('new file mode');
    expect(addedPatch).toContain('--- /dev/null');
    expect(addedPatch).toContain('+++ b/new.txt');
    expect(addedPatch).toContain('@@ -0,0 +1,2 @@');
    expect(addedPatch).toContain('+one\n+two\n');

    const deleted = await fileDiff(worktree, await changedFile(worktree, 'c.txt'), { env: testEnv });
    expect(deleted.kind).toBe('text');
    const deletedPatch = (deleted as { kind: 'text'; patch: string }).patch;
    expect(deletedPatch).toContain('deleted file mode');
    expect(deletedPatch).toContain('+++ /dev/null');
    expect(deletedPatch).toContain('-c 1\n-c 2\n-c 3\n');

    const renamed = await fileDiff(worktree, await changedFile(worktree, 'e.txt'), { env: testEnv });
    expect(renamed.kind).toBe('text');
    const renamedPatch = (renamed as { kind: 'text'; patch: string }).patch;
    expect(renamedPatch).toContain('diff --git a/d.txt b/e.txt');
    expect(renamedPatch).toContain('rename from d.txt');
    expect(renamedPatch).toContain('rename to e.txt');
  });

  test('AC7 — gives { kind: "binary" } for an untracked file holding bytes 00 01 02', async () => {
    const repo = await makeRepo();
    const worktree = await makeWorkspace(repo);
    await writeFile(join(worktree, 'bin.dat'), Buffer.from([0, 1, 2]));

    const result = await fileDiff(worktree, await changedFile(worktree, 'bin.dat'), { env: testEnv });

    expect(result).toEqual({ kind: 'binary' });
  });

  test('AC8 — gives { kind: "tooLarge" } for a diff over 1 MiB, without rejecting', async () => {
    const repo = await makeRepo();
    const worktree = await makeWorkspace(repo);
    // 15,000 lines of 80 bytes: 1.2 MB, more than 1,048,576 bytes once diffed.
    await writeFile(join(worktree, 'big.txt'), `${'x'.repeat(79)}\n`.repeat(15_000));

    const file = await changedFile(worktree, 'big.txt');
    const result = await fileDiff(worktree, file, { env: testEnv });

    expect(result).toEqual({ kind: 'tooLarge' });
  });
});

describe('watchWorktree', () => {
  test('AC12 — a burst of writes gives one onChange, and none comes after close()', async () => {
    const dir = await tempDir();
    const changed = vi.fn();
    // A second watcher on the same folder shows, once it fires, that the events of a write have arrived.
    const witness = vi.fn();
    const watcher = await watchWorktree(dir, changed);
    const other = await watchWorktree(dir, witness);
    try {
      for (let index = 0; index < 10; index++) await writeFile(join(dir, `first-${index}.txt`), 'x\n');
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 });
      expect(changed).toHaveBeenCalledTimes(1);

      for (let index = 0; index < 10; index++) await writeFile(join(dir, `second-${index}.txt`), 'x\n');
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2), { timeout: 5_000 });
      expect(changed).toHaveBeenCalledTimes(2);

      watcher.close();
      const seen = witness.mock.calls.length;
      await writeFile(join(dir, 'after-close.txt'), 'x\n');
      await vi.waitFor(() => expect(witness.mock.calls.length).toBeGreaterThan(seen), { timeout: 5_000 });
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      watcher.close();
      other.close();
    }
  });
});

// COCKPIT-38: commit, push and the state of the branch, against a local bare `origin`. Nothing here
// reaches a real remote.

/** A bare repository as `origin` of `repo`, holding `main`. */
async function addOrigin(repo: string): Promise<string> {
  const origin = join(await tempDir(), 'origin.git');
  git(repo, 'init', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'main');
  git(repo, 'fetch', '--quiet', 'origin');
  return origin;
}

/** A workspace `feat` of a repository with a local bare `origin`. */
async function makeShippableWorkspace(): Promise<{ repo: string; origin: string; worktree: string }> {
  const repo = await makeRepo();
  const origin = await addOrigin(repo);
  const worktree = await makeWorkspace(repo);
  return { repo, origin, worktree };
}

const remoteHead = (origin: string, branch: string) => git(origin, 'rev-parse', `refs/heads/${branch}`);

async function commitFile(worktree: string, name: string, message: string): Promise<string> {
  await writeFile(join(worktree, name), `${name}\n`);
  git(worktree, 'add', name);
  git(worktree, 'commit', '-m', message);
  return git(worktree, 'rev-parse', 'HEAD');
}

describe('branchStatus', () => {
  test('AC8 — a fresh workspace has its branch, no upstream, nothing uncommitted and nothing to push', async () => {
    const { worktree } = await makeShippableWorkspace();

    expect(await branchStatus(worktree, { env: testEnv })).toEqual({
      branch: 'feat',
      upstream: null,
      uncommitted: false,
      unpushed: false,
    });
  });

  test('AC6 — uncommitted is true for an edit, a deletion or an untracked file, and not for a file git ignores', async () => {
    const { worktree } = await makeShippableWorkspace();
    await writeFile(join(worktree, 'out.log'), 'ignored\n');
    expect((await branchStatus(worktree, { env: testEnv })).uncommitted).toBe(false);

    await writeFile(join(worktree, 'brand-new.txt'), 'new\n');
    expect((await branchStatus(worktree, { env: testEnv })).uncommitted).toBe(true);
    await rm(join(worktree, 'brand-new.txt'));

    await rm(join(worktree, 'c.txt'));
    expect((await branchStatus(worktree, { env: testEnv })).uncommitted).toBe(true);
  });

  test('AC8 — without an upstream, commits beyond the merge-base with the base are unpushed', async () => {
    const { worktree } = await makeShippableWorkspace();
    await commitFile(worktree, 'one.txt', 'one');

    expect(await branchStatus(worktree, { env: testEnv })).toMatchObject({ branch: 'feat', upstream: null, unpushed: true });
  });

  test('AC8 — with an upstream, only the commits the upstream lacks are unpushed', async () => {
    const { worktree } = await makeShippableWorkspace();
    await commitFile(worktree, 'one.txt', 'one');
    await pushBranch(worktree, { env: testEnv });
    expect(await branchStatus(worktree, { env: testEnv })).toMatchObject({ upstream: 'origin/feat', unpushed: false });

    await commitFile(worktree, 'two.txt', 'two');

    expect(await branchStatus(worktree, { env: testEnv })).toMatchObject({ upstream: 'origin/feat', unpushed: true });
  });
});

describe('commitAll', () => {
  test('AC6 — commits every change in one commit with the message: edits, deletions and untracked files, not the ignored ones', async () => {
    const { worktree } = await makeShippableWorkspace();
    const before = git(worktree, 'rev-list', '--count', 'HEAD');
    await writeFile(join(worktree, 'a.txt'), 'edited\n');
    await rm(join(worktree, 'c.txt'));
    await writeFile(join(worktree, 'new.txt'), 'new\n');
    await writeFile(join(worktree, 'out.log'), 'ignored\n');

    await commitAll(worktree, 'Edit, delete and add', { env: testEnv });

    expect(Number(git(worktree, 'rev-list', '--count', 'HEAD'))).toBe(Number(before) + 1);
    expect(git(worktree, 'log', '-1', '--format=%B')).toBe('Edit, delete and add');
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(worktree, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'D\tc.txt',
      'A\tnew.txt',
      'M\ta.txt',
    ].sort());
    expect(git(worktree, 'ls-files', 'out.log')).toBe('');
  });

  test('AC7 — a failing pre-commit hook rejects GIT_FAILED with its message and creates no commit', async () => {
    const { repo, worktree } = await makeShippableWorkspace();
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
    await chmod(hook, 0o755);
    const head = git(worktree, 'rev-parse', 'HEAD');
    await writeFile(join(worktree, 'new.txt'), 'new\n');

    const error = await rejection(commitAll(worktree, 'Will not be made', { env: testEnv }));

    expect(error.code).toBe('GIT_FAILED');
    expect(error.message).toContain('hook says no');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head);
  });
});

describe('pushBranch', () => {
  test('AC8 — pushes the branch to origin, the remote ref is HEAD and the upstream is origin/<branch>', async () => {
    const { origin, worktree } = await makeShippableWorkspace();
    const head = await commitFile(worktree, 'one.txt', 'one');

    await pushBranch(worktree, { env: testEnv });

    expect(remoteHead(origin, 'feat')).toBe(head);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'feat@{upstream}')).toBe('origin/feat');
  });

  test('AC9 — a push that is not a fast-forward rejects GIT_FAILED with git\'s refusal and leaves the remote branch as it was (no force)', async () => {
    const { origin, worktree } = await makeShippableWorkspace();
    await commitFile(worktree, 'one.txt', 'one');
    await pushBranch(worktree, { env: testEnv });
    // Someone else pushes a commit to origin/feat.
    const other = join(await tempDir(), 'other');
    git(await tempDir(), 'clone', '--quiet', origin, other);
    git(other, 'switch', '--quiet', 'feat');
    const theirs = await commitFile(other, 'theirs.txt', 'theirs');
    git(other, 'push', '--quiet', 'origin', 'feat');
    await commitFile(worktree, 'two.txt', 'two');

    const error = await rejection(pushBranch(worktree, { env: testEnv }));

    expect(error.code).toBe('GIT_FAILED');
    expect(error.message).toMatch(/rejected/);
    expect(remoteHead(origin, 'feat')).toBe(theirs);
  });

  test('AC12 — a detached HEAD rejects GIT_FAILED and pushes nothing', async () => {
    const { origin, worktree } = await makeShippableWorkspace();
    git(worktree, 'checkout', '--quiet', '--detach');
    await commitFile(worktree, 'one.txt', 'one');

    const error = await rejection(pushBranch(worktree, { env: testEnv }));

    expect(error.code).toBe('GIT_FAILED');
    expect(git(origin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
  });
});

// COCKPIT-38 AC13: commits, pushes and fetches made outside the app reach the watcher through the
// worktree's gitdir, the common dir's `refs/remotes` and its `packed-refs`. Each test runs the git
// command that must be seen from the place where it writes nothing else the watcher already watched:
// a fetch and a pack-refs from the main repository (their FETCH_HEAD is not the worktree's).
describe('watchWorktree on the git metadata', () => {
  /** Calls `onChange` counts: the watcher runs on `worktree` and is closed by the test's end. */
  async function watched(worktree: string) {
    const changed = vi.fn();
    const watcher = await watchWorktree(worktree, changed);
    return { changed, close: () => watcher.close() };
  }

  test('AC13 — a git commit made in the worktree calls onChange', async () => {
    const { worktree } = await makeShippableWorkspace();
    await writeFile(join(worktree, 'a.txt'), 'edited\n');
    const { changed, close } = await watched(worktree);
    try {
      git(worktree, 'commit', '-q', '-am', 'edit a');

      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 });
    } finally {
      close();
    }
  });

  test('AC13 — a git push -u origin <branch> made in the worktree calls onChange', async () => {
    const { worktree } = await makeShippableWorkspace();
    await commitFile(worktree, 'one.txt', 'one');
    const { changed, close } = await watched(worktree);
    try {
      git(worktree, 'push', '-q', '-u', 'origin', 'feat');

      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 });
    } finally {
      close();
    }
  });

  test('AC13 — a git fetch that updates refs/remotes calls onChange', async () => {
    const { repo, origin, worktree } = await makeShippableWorkspace();
    const other = join(await tempDir(), 'other');
    git(await tempDir(), 'clone', '--quiet', origin, other);
    await commitFile(other, 'theirs.txt', 'theirs');
    git(other, 'push', '--quiet', 'origin', 'main');
    const { changed, close } = await watched(worktree);
    try {
      git(repo, 'fetch', '--quiet', 'origin');

      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 });
    } finally {
      close();
    }
  });

  test('AC13 — a git pack-refs --all that rewrites packed-refs calls onChange', async () => {
    const { repo, worktree } = await makeShippableWorkspace();
    // Every remote ref is packed already, and a loose local branch is the one left to pack: the rewrite
    // of packed-refs is then the only change in the watched places.
    git(repo, 'pack-refs', '--all');
    git(repo, 'branch', 'extra');
    const { changed, close } = await watched(worktree);
    try {
      git(repo, 'pack-refs', '--all');

      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 });
    } finally {
      close();
    }
  });

  test('AC13 — branchStatus and listChanges on a settled worktree call nothing, even with a stale index, and a commit still does', async () => {
    const { worktree } = await makeShippableWorkspace();
    // A tracked file with the same content and another mtime: a plain `git status` would refresh the
    // index and write it, which the watcher on the gitdir would see again and again.
    const stale = join(worktree, 'a.txt');
    await writeFile(stale, await readFile(stale));
    await utimes(stale, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    const { changed, close } = await watched(worktree);
    try {
      for (let round = 0; round < 3; round++) {
        await branchStatus(worktree, { env: testEnv });
        await listChanges(worktree, { env: testEnv });
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(changed).not.toHaveBeenCalled();

      git(worktree, 'commit', '-q', '--allow-empty', '-m', 'an empty commit');
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 });
    } finally {
      close();
    }
  });
});

describe('removeWorktree after a pull request merged', () => {
  test('AC11 — deletes a pushed branch whose commits are not on the base (squash-merge case), as it is merged into its upstream', async () => {
    const { repo, worktree } = await makeShippableWorkspace();
    await commitFile(worktree, 'one.txt', 'one');
    git(worktree, 'push', '--quiet', '--set-upstream', 'origin', 'feat');

    await removeWorktree({ repo, path: worktree, deleteBranch: true, env: testEnv });

    expect(git(repo, 'branch', '--list', 'feat')).toBe('');
  });
});
