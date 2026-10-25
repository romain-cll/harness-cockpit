import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorkspaceError } from '../src/git';
import { createWorktree, fileDiff, listChanges, watchWorktree } from '../src/index';

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
