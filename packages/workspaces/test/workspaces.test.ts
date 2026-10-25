import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorkspaceError } from '../src/git';
import {
  commandsInvocation,
  createWorktree,
  findRepositoryRoot,
  listBranches,
  listWorktrees,
  readWorkspaceConfig,
  removeWorktree,
} from '../src/index';

// Drives the real git on temporary repositories and roots under os.tmpdir(),
// with an env that ignores the user's global and system git config.

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
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-workspaces-')));
  created.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: testEnv, encoding: 'utf8' }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, 'commit', '--allow-empty', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A repository with one commit on `main` (containing `README.md`). */
async function makeRepo(): Promise<string> {
  const parent = await tempDir();
  const repo = join(parent, 'my-repo');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'initial');
  return repo;
}

/** Adds a linked worktree with git itself, so removal tests do not depend on `createWorktree`. */
async function addWorktree(repo: string, name: string, branch: string): Promise<string> {
  const dir = join(await tempDir(), name);
  git(repo, 'worktree', 'add', '-b', branch, '--', dir, 'main');
  return dir;
}

function projectDir(repo: string): string {
  const hash = createHash('sha256').update(repo).digest('hex').slice(0, 8);
  return `${basename(repo)}-${hash}`;
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

function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

describe('findRepositoryRoot', () => {
  test('AC1 — resolves a subdirectory to the main working tree', async () => {
    const repo = await makeRepo();
    const sub = join(repo, 'a', 'b');
    await mkdir(sub, { recursive: true });

    expect(await findRepositoryRoot(sub, { env: testEnv })).toBe(repo);
    expect(await findRepositoryRoot(repo, { env: testEnv })).toBe(repo);
  });

  test('AC1 — resolves a linked worktree, and a folder inside it, to the main working tree', async () => {
    const repo = await makeRepo();
    const linked = await addWorktree(repo, 'topic', 'topic');
    const inside = join(linked, 'deep');
    await mkdir(inside);

    expect(await findRepositoryRoot(linked, { env: testEnv })).toBe(repo);
    expect(await findRepositoryRoot(inside, { env: testEnv })).toBe(repo);
  });

  test('AC2 — rejects NOT_A_REPOSITORY outside a repository', async () => {
    const folder = await tempDir();
    const error = await rejection(findRepositoryRoot(folder, { env: testEnv }));
    expect(error.code).toBe('NOT_A_REPOSITORY');
  });
});

describe('listWorktrees', () => {
  test('AC2 — rejects NOT_A_REPOSITORY outside a repository', async () => {
    const folder = await tempDir();
    const error = await rejection(listWorktrees(folder, { env: testEnv }));
    expect(error.code).toBe('NOT_A_REPOSITORY');
  });

  test('AC7 — lists the main working tree first, then the linked ones, from any of them', async () => {
    const repo = await makeRepo();
    const mainHead = git(repo, 'rev-parse', 'HEAD');
    const onBranch = await addWorktree(repo, 'on-branch', 'on-branch');
    const detached = await addWorktree(repo, 'detached', 'to-detach');
    git(detached, 'checkout', '--detach');
    const detachedHead = commit(detached, 'detached commit');

    const fromMain = await listWorktrees(repo, { env: testEnv });
    const fromLinked = await listWorktrees(onBranch, { env: testEnv });

    expect(fromMain).toHaveLength(3);
    expect(fromMain[0]).toEqual({ path: repo, head: mainHead, branch: 'main', main: true });
    expect(fromMain.slice(1)).toHaveLength(2);
    expect(fromMain.slice(1)).toEqual(
      expect.arrayContaining([
        { path: onBranch, head: mainHead, branch: 'on-branch', main: false },
        { path: detached, head: detachedHead, branch: null, main: false },
      ]),
    );
    expect(fromLinked).toEqual(fromMain);
  });
});

describe('createWorktree', () => {
  test('AC2 — rejects NOT_A_REPOSITORY outside a repository', async () => {
    const folder = await tempDir();
    const root = await tempDir();
    const error = await rejection(
      createWorktree({ repo: folder, root, branch: 'topic', base: 'main', env: testEnv }),
    );
    expect(error.code).toBe('NOT_A_REPOSITORY');
    expect(readdirSync(root)).toEqual([]);
  });

  test('AC3 — creates the worktree under <root>/<project>-<hash>/<branch> at the base commit', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const mainHead = git(repo, 'rev-parse', 'main');
    const expected = join(root, projectDir(repo), 'topic');

    const result = await createWorktree({ repo, root, branch: 'topic', base: 'main', env: testEnv });

    expect(existsSync(expected)).toBe(true);
    expect(git(expected, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('topic');
    expect(git(expected, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(result).toEqual({ path: expected, head: mainHead, branch: 'topic', main: false });
  });

  test('AC4 — checks out an existing local branch when no base is given', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    git(repo, 'checkout', '-b', 'existing');
    const existingHead = commit(repo, 'on existing');
    git(repo, 'checkout', 'main');
    const expected = join(root, projectDir(repo), 'existing');

    const result = await createWorktree({ repo, root, branch: 'existing', env: testEnv });

    expect(result.path).toBe(expected);
    expect(result.branch).toBe('existing');
    expect(result.head).toBe(existingHead);
    expect(git(expected, 'rev-parse', 'HEAD')).toBe(existingHead);
    expect(git(expected, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('existing');
  });

  test('AC5 — rejects BRANCH_EXISTS when the branch exists and a base is given, creating nothing', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    git(repo, 'branch', 'topic');

    const error = await rejection(
      createWorktree({ repo, root, branch: 'topic', base: 'main', env: testEnv }),
    );

    expect(error.code).toBe('BRANCH_EXISTS');
    expect(readdirSync(root)).toEqual([]);
  });

  test('AC6 — nests a branch with a slash, lists it and removes it', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const expected = join(root, projectDir(repo), 'feature', 'login');

    const created = await createWorktree({
      repo,
      root,
      branch: 'feature/login',
      base: 'main',
      env: testEnv,
    });

    expect(created.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    const listed = await listWorktrees(repo, { env: testEnv });
    expect(listed.find((w) => w.path === expected)?.branch).toBe('feature/login');

    await removeWorktree({ repo, path: expected, env: testEnv });

    expect(existsSync(expected)).toBe(false);
    expect((await listWorktrees(repo, { env: testEnv })).some((w) => w.path === expected)).toBe(false);
  });

  test.each(['../escape', '-x'])('AC13 — rejects INVALID_BRANCH_NAME for the invalid branch name %s', async (branch) => {
    const repo = await makeRepo();
    const container = await tempDir();
    const root = join(container, 'root');
    await mkdir(root);

    for (const base of ['main', undefined]) {
      const error = await rejection(createWorktree({ repo, root, branch, base, env: testEnv }));
      expect(error.code).toBe('INVALID_BRANCH_NAME');
    }

    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(container)).toEqual(['root']);
  });
});

describe('createWorktree arguments', () => {
  test('AC19 — rejects a relative root with a TypeError and creates nothing anywhere', async () => {
    const repo = await makeRepo();
    const listBefore = git(repo, 'worktree', 'list', '--porcelain');
    // A relative root may resolve against the process cwd: never leave a stray folder in the real
    // repository, even when the implementation is wrong.
    const strayInCwd = join(process.cwd(), 'worktrees');
    const strayExisted = existsSync(strayInCwd);

    try {
      for (const base of ['main', undefined]) {
        const outcome = await createWorktree({ repo, root: 'worktrees', branch: 'topic', base, env: testEnv }).then(
          (value) => ({ resolved: true as const, value }),
          (error: unknown) => ({ resolved: false as const, error }),
        );
        expect(outcome.resolved, 'a relative root must be rejected').toBe(false);
        if (outcome.resolved) continue;
        expect(outcome.error).toBeInstanceOf(TypeError);
        expect(outcome.error).not.toBeInstanceOf(WorkspaceError);
      }

      expect(existsSync(join(repo, 'worktrees'))).toBe(false);
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(listBefore);
      expect(existsSync(strayInCwd)).toBe(strayExisted);
      expect(readdirSync(dirname(repo))).toEqual(['my-repo']);
    } finally {
      if (!strayExisted) await rm(strayInCwd, { recursive: true, force: true });
    }
  });

  test('AC20 — rejects INVALID_BRANCH_NAME for @{-1}, with or without a base, creating nothing', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    git(repo, 'checkout', '-b', 'other');
    git(repo, 'checkout', 'main');
    const listBefore = git(repo, 'worktree', 'list', '--porcelain');

    for (const base of ['main', undefined]) {
      const error = await rejection(createWorktree({ repo, root, branch: '@{-1}', base, env: testEnv }));
      expect(error.code, `base: ${String(base)}`).toBe('INVALID_BRANCH_NAME');
    }

    expect(readdirSync(root)).toEqual([]);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(listBefore);
  });

  test('AC21 — a failed creation in a non-empty folder leaves no new branch behind', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const target = join(root, projectDir(repo), 'topic');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.txt'), 'keep me\n');
    const listBefore = git(repo, 'worktree', 'list', '--porcelain');

    const error = await rejection(
      createWorktree({ repo, root, branch: 'topic', base: 'main', env: testEnv }),
    );

    expect(error.code).toBe('GIT_FAILED');
    expect(branchExists(repo, 'topic')).toBe(false);
    expect(readdirSync(target)).toEqual(['keep.txt']);
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep me\n');
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(listBefore);
  });

  test('AC22 — rejects GIT_FAILED for a tag without a base, creating nothing', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    git(repo, 'tag', 'v1');
    const listBefore = git(repo, 'worktree', 'list', '--porcelain');

    const error = await rejection(createWorktree({ repo, root, branch: 'v1', env: testEnv }));

    expect(error.code).toBe('GIT_FAILED');
    expect(readdirSync(root)).toEqual([]);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(listBefore);
  });

  /** A `post-checkout` hook that always fails; linked worktrees share the repository's hooks. */
  async function failingPostCheckoutHook(repo: string): Promise<void> {
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
  }

  test('AC23 (a) — a failing post-checkout hook rolls back the worktree and the new branch', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const target = join(root, projectDir(repo), 'topic');
    const listBefore = git(repo, 'worktree', 'list', '--porcelain');
    await failingPostCheckoutHook(repo);

    const error = await rejection(
      createWorktree({ repo, root, branch: 'topic', base: 'main', env: testEnv }),
    );

    expect(error.code).toBe('GIT_FAILED');
    expect(existsSync(target)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(listBefore);
    expect(branchExists(repo, 'topic')).toBe(false);
  });

  test('AC23 (b) — a failing post-checkout hook rolls back the worktree and keeps the existing branch', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    git(repo, 'branch', 'existing');
    const existingHead = git(repo, 'rev-parse', 'existing');
    const target = join(root, projectDir(repo), 'existing');
    const listBefore = git(repo, 'worktree', 'list', '--porcelain');
    await failingPostCheckoutHook(repo);

    const error = await rejection(createWorktree({ repo, root, branch: 'existing', env: testEnv }));

    expect(error.code).toBe('GIT_FAILED');
    expect(existsSync(target)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(listBefore);
    expect(branchExists(repo, 'existing')).toBe(true);
    expect(git(repo, 'rev-parse', 'existing')).toBe(existingHead);
  });

  test('COCKPIT-34 AC1 — records the base in branch.<name>.cockpitBase', async () => {
    const repo = await makeRepo();
    const root = await tempDir();

    await createWorktree({ repo, root, branch: 'feat', base: 'main', env: testEnv });

    expect(git(repo, 'config', '--get', 'branch.feat.cockpitBase')).toBe('main');
  });

  test('COCKPIT-34 AC2 — a failed creation leaves no branch.<name>.* config behind', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const target = join(root, projectDir(repo), 'feat');
    const listBefore = git(repo, 'worktree', 'list', '--porcelain');
    const noFeatConfig = () =>
      expect(() => git(repo, 'config', '--get-regexp', '^branch\\.feat\\.')).toThrow(expect.objectContaining({ status: 1 }));

    // Git refuses before it creates the branch (the folder is taken): `git branch -D` has no
    // section to drop, so only an explicit unset leaves the config clean.
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.txt'), 'keep me\n');
    await rejection(createWorktree({ repo, root, branch: 'feat', base: 'main', env: testEnv }));
    expect(branchExists(repo, 'feat')).toBe(false);
    noFeatConfig();
    await rm(target, { recursive: true });

    await failingPostCheckoutHook(repo);
    await rejection(createWorktree({ repo, root, branch: 'feat', base: 'main', env: testEnv }));

    expect(existsSync(target)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(listBefore);
    expect(branchExists(repo, 'feat')).toBe(false);
    noFeatConfig();
  });

  test('AC24 — a failed creation on an already registered path leaves the existing worktree intact', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const target = join(root, projectDir(repo), 'topic');
    await mkdir(dirname(target), { recursive: true });
    git(repo, 'worktree', 'add', '-b', 'topic', '--', target, 'main');
    await writeFile(join(target, 'notes.txt'), 'keep me\n');
    const listBefore = git(repo, 'worktree', 'list', '--porcelain');

    const error = await rejection(createWorktree({ repo, root, branch: 'topic', env: testEnv }));

    expect(error.code).toBe('GIT_FAILED');
    expect(existsSync(target)).toBe(true);
    expect(await readFile(join(target, 'notes.txt'), 'utf8')).toBe('keep me\n');
    expect((await listWorktrees(repo, { env: testEnv })).some((w) => w.path === target && w.branch === 'topic')).toBe(
      true,
    );
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(listBefore);
    expect(branchExists(repo, 'topic')).toBe(true);
  });

  test('AC25 — a root reached through a symbolic link does not let the rollback drop a prunable registration', async () => {
    const repo = await makeRepo();
    const realRoot = await tempDir();
    const link = join(await tempDir(), 'link');
    await symlink(realRoot, link);
    git(repo, 'branch', 'topic');
    const target = join(realRoot, projectDir(repo), 'topic');
    await createWorktree({ repo, root: realRoot, branch: 'topic', env: testEnv });
    await rm(target, { recursive: true, force: true });
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(`worktree ${target}\n`);

    const error = await rejection(createWorktree({ repo, root: link, branch: 'topic', env: testEnv }));

    expect(error.code).toBe('GIT_FAILED');
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(`worktree ${target}\n`);
    expect(branchExists(repo, 'topic')).toBe(true);
  });

  test('AC25 — a root that does not exist yet is created and the worktree is under it', async () => {
    const repo = await makeRepo();
    const root = join(await tempDir(), 'not', 'yet', 'there');
    expect(existsSync(root)).toBe(false);

    const worktree = await createWorktree({ repo, root, branch: 'topic', base: 'main', env: testEnv });

    expect(worktree.path).toBe(join(root, projectDir(repo), 'topic'));
    expect(existsSync(worktree.path)).toBe(true);
    expect((await listWorktrees(repo, { env: testEnv })).some((w) => w.path === worktree.path)).toBe(true);
  });
});

describe('removeWorktree', () => {
  test('AC8 — removes a clean worktree and keeps its branch', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'clean', 'clean');

    await removeWorktree({ repo, path, env: testEnv });

    expect(existsSync(path)).toBe(false);
    expect((await listWorktrees(repo, { env: testEnv })).some((w) => w.path === path)).toBe(false);
    expect(branchExists(repo, 'clean')).toBe(true);
  });

  test('AC9 — refuses a worktree with a modified tracked file', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'tracked', 'tracked');
    await writeFile(join(path, 'README.md'), 'changed\n');
    const before = git(repo, 'worktree', 'list', '--porcelain');

    const error = await rejection(removeWorktree({ repo, path, env: testEnv }));

    expect(error.code).toBe('DIRTY_WORKTREE');
    expect(existsSync(path)).toBe(true);
    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('changed\n');
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(before);
  });

  test('AC9 — refuses a worktree with only an untracked file', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'untracked', 'untracked');
    await writeFile(join(path, 'notes.txt'), 'keep me\n');
    const before = git(repo, 'worktree', 'list', '--porcelain');

    const error = await rejection(removeWorktree({ repo, path, env: testEnv }));

    expect(error.code).toBe('DIRTY_WORKTREE');
    expect(existsSync(path)).toBe(true);
    expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('keep me\n');
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(before);
  });

  test('AC10 — deletes the branch with the worktree when it is merged', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'merged', 'merged');

    await removeWorktree({ repo, path, deleteBranch: true, env: testEnv });

    expect(existsSync(path)).toBe(false);
    expect(branchExists(repo, 'merged')).toBe(false);
  });

  test('AC11 — rejects BRANCH_NOT_MERGED, but still removes the worktree and keeps the branch', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'unmerged', 'unmerged');
    const branchHead = commit(path, 'not on main');

    const error = await rejection(removeWorktree({ repo, path, deleteBranch: true, env: testEnv }));

    expect(error.code).toBe('BRANCH_NOT_MERGED');
    expect(existsSync(path)).toBe(false);
    expect(branchExists(repo, 'unmerged')).toBe(true);
    expect(git(repo, 'rev-parse', 'unmerged')).toBe(branchHead);
  });
});

/** A repository with `develop`, `feature/x` and `release/1.0` on top of `main`, and a clone of it as `origin`. */
async function makeClone(): Promise<{ upstream: string; clone: string }> {
  const upstream = await makeRepo();
  git(upstream, 'branch', 'develop');
  git(upstream, 'branch', 'feature/x');
  git(upstream, 'branch', 'release/1.0');
  const clone = join(await tempDir(), 'my-clone');
  git(upstream, 'clone', upstream, clone);
  return { upstream, clone };
}

describe('listBranches', () => {
  test('AC2 — lists local and origin branches, skips origin/HEAD, preselects origin/main, runs no fetch', async () => {
    const { upstream, clone } = await makeClone();
    git(clone, 'branch', 'local-only');
    git(clone, 'branch', 'topic/nested');
    // A commit that only a fetch would bring in.
    const upstreamHead = commit(upstream, 'new on origin');
    const originMain = git(clone, 'rev-parse', 'refs/remotes/origin/main');
    expect(originMain).not.toBe(upstreamHead);

    const result = await listBranches(clone, { env: testEnv });

    expect([...result.local].sort()).toEqual(['local-only', 'main', 'topic/nested']);
    expect([...result.remote].sort()).toEqual([
      'origin/develop',
      'origin/feature/x',
      'origin/main',
      'origin/release/1.0',
    ]);
    expect(result.remote).not.toContain('origin/HEAD');
    expect(result.local.some((name) => name.includes('HEAD'))).toBe(false);
    expect(result.defaultBase).toBe('origin/main');
    expect(git(clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(originMain);
    expect(existsSync(join(clone, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  test('AC2 — works from a linked worktree and lists the branches checked out elsewhere', async () => {
    const { clone } = await makeClone();
    const linked = await addWorktree(clone, 'linked', 'linked-branch');

    const result = await listBranches(linked, { env: testEnv });

    expect([...result.local].sort()).toEqual(['linked-branch', 'main']);
    expect(result.remote).toContain('origin/main');
  });

  test('AC2 — a repository without a remote has no remote branch', async () => {
    const repo = await makeRepo();
    git(repo, 'branch', 'other');

    const result = await listBranches(repo, { env: testEnv });

    expect([...result.local].sort()).toEqual(['main', 'other']);
    expect(result.remote).toEqual([]);
  });

  test('AC2 — only origin is listed, not other remotes', async () => {
    const { upstream, clone } = await makeClone();
    git(clone, 'remote', 'add', 'fork', upstream);
    git(clone, 'fetch', '--quiet', 'fork');
    expect(git(clone, 'branch', '-r')).toContain('fork/main');

    const result = await listBranches(clone, { env: testEnv });

    expect(result.remote.every((name) => name.startsWith('origin/'))).toBe(true);
    expect(result.remote).toContain('origin/main');
  });

  test('AC3 — origin/HEAD pointing at another branch gives that branch as the default base', async () => {
    const { clone } = await makeClone();
    git(clone, 'remote', 'set-head', 'origin', 'develop');
    expect(git(clone, 'branch', '--show-current')).toBe('main');

    expect((await listBranches(clone, { env: testEnv })).defaultBase).toBe('origin/develop');
  });

  test('AC3 — no origin/HEAD: the branch checked out in the main working tree, as origin/<branch> when it exists', async () => {
    const { clone } = await makeClone();
    git(clone, 'remote', 'set-head', 'origin', '--delete');
    expect(() => git(clone, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')).toThrow();

    const result = await listBranches(clone, { env: testEnv });

    expect(result.defaultBase).toBe('origin/main');
    expect(result.remote).not.toContain('origin/HEAD');
  });

  test('AC3 — no origin/HEAD and a branch without a remote-tracking twin: the local branch', async () => {
    const { clone } = await makeClone();
    git(clone, 'remote', 'set-head', 'origin', '--delete');
    git(clone, 'checkout', '-b', 'local-only');

    expect((await listBranches(clone, { env: testEnv })).defaultBase).toBe('local-only');
  });

  test('AC3 — a local main only (no remote) is the default base', async () => {
    const repo = await makeRepo();

    expect(await listBranches(repo, { env: testEnv })).toEqual({ local: ['main'], remote: [], defaultBase: 'main' });
  });

  test('AC3 — origin/HEAD naming a branch whose origin/<D> is gone falls back to the local <D>', async () => {
    const { clone } = await makeClone();
    git(clone, 'remote', 'set-head', 'origin', 'develop');
    git(clone, 'branch', 'develop', 'origin/develop');
    git(clone, 'update-ref', '-d', 'refs/remotes/origin/develop');

    const result = await listBranches(clone, { env: testEnv });

    expect(result.defaultBase).toBe('develop');
    expect(result.remote).not.toContain('origin/develop');
  });

  test('AC3 — origin/HEAD naming a branch with neither origin/<D> nor a local <D> gives no default base', async () => {
    const { clone } = await makeClone();
    git(clone, 'remote', 'set-head', 'origin', 'develop');
    git(clone, 'update-ref', '-d', 'refs/remotes/origin/develop');

    expect((await listBranches(clone, { env: testEnv })).defaultBase).toBeNull();
  });

  test('AC3 — no origin/HEAD and a detached main working tree: no default base, branches still listed', async () => {
    const repo = await makeRepo();
    git(repo, 'branch', 'other');
    git(repo, 'checkout', '--detach');

    const result = await listBranches(repo, { env: testEnv });

    expect(result.defaultBase).toBeNull();
    expect([...result.local].sort()).toEqual(['main', 'other']);
  });

  test('AC3 — an empty repository (no commit) has no branch and no default base', async () => {
    const empty = join(await tempDir(), 'empty');
    await mkdir(empty);
    git(empty, 'init', '-b', 'main');

    expect(await listBranches(empty, { env: testEnv })).toEqual({ local: [], remote: [], defaultBase: null });
  });

  test('AC8 — rejects NOT_A_REPOSITORY outside a repository and for a missing folder', async () => {
    const folder = await tempDir();
    expect((await rejection(listBranches(folder, { env: testEnv }))).code).toBe('NOT_A_REPOSITORY');
    expect((await rejection(listBranches(join(folder, 'gone'), { env: testEnv }))).code).toBe('NOT_A_REPOSITORY');
  });

  test('AC8 — rejects GIT_MISSING when PATH holds no git', async () => {
    const repo = await makeRepo();
    const env = { ...testEnv, PATH: await tempDir() };

    expect((await rejection(listBranches(repo, { env }))).code).toBe('GIT_MISSING');
  });
});

describe('createWorktree branch names and concurrency', () => {
  test.each(['my feature', 'a..b', 'bad~name', 'with:colon', 'ends.lock', '/leading', 'trailing/'])(
    'AC7 — rejects INVALID_BRANCH_NAME for %j, creating nothing',
    async (branch) => {
      const repo = await makeRepo();
      const root = await tempDir();
      const listBefore = git(repo, 'worktree', 'list', '--porcelain');
      const branchesBefore = git(repo, 'branch', '--list');

      for (const base of ['main', undefined]) {
        const error = await rejection(createWorktree({ repo, root, branch, base, env: testEnv }));
        expect(error.code, `base: ${String(base)}`).toBe('INVALID_BRANCH_NAME');
      }

      expect(readdirSync(root)).toEqual([]);
      expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(listBefore);
      expect(git(repo, 'branch', '--list')).toBe(branchesBefore);
    },
  );

  test('AC6 — an existing local branch is BRANCH_EXISTS, not INVALID_BRANCH_NAME, and nothing is created', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    git(repo, 'branch', 'feature/login');
    const listBefore = git(repo, 'worktree', 'list', '--porcelain');

    const error = await rejection(createWorktree({ repo, root, branch: 'feature/login', base: 'main', env: testEnv }));

    expect(error.code).toBe('BRANCH_EXISTS');
    expect(readdirSync(root)).toEqual([]);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(listBefore);
  });

  test('AC9 — two simultaneous calls for the same new branch: one resolves, the other is BRANCH_EXISTS, the winner is intact', async () => {
    // A race is not certain to show on one attempt: repeat on fresh repositories.
    for (let attempt = 0; attempt < 5; attempt++) {
      const repo = await makeRepo();
      const root = await tempDir();
      const mainHead = git(repo, 'rev-parse', 'main');
      const expected = join(root, projectDir(repo), 'race');

      const settled = await Promise.allSettled([
        createWorktree({ repo, root, branch: 'race', base: 'main', env: testEnv }),
        createWorktree({ repo, root, branch: 'race', base: 'main', env: testEnv }),
      ]);

      const winners = settled.filter((outcome) => outcome.status === 'fulfilled');
      const losers = settled.filter((outcome) => outcome.status === 'rejected');
      expect(winners, `attempt ${attempt}`).toHaveLength(1);
      expect(losers, `attempt ${attempt}`).toHaveLength(1);
      const reason = (losers[0] as PromiseRejectedResult).reason as WorkspaceError;
      expect(reason).toBeInstanceOf(WorkspaceError);
      expect(reason.code, `attempt ${attempt}`).toBe('BRANCH_EXISTS');

      expect((winners[0] as PromiseFulfilledResult<{ path: string }>).value.path).toBe(expected);
      expect(existsSync(join(expected, 'README.md')), `attempt ${attempt}`).toBe(true);
      expect(branchExists(repo, 'race'), `attempt ${attempt}`).toBe(true);
      expect(git(expected, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('race');
      expect(git(expected, 'rev-parse', 'HEAD')).toBe(mainHead);
      const listed = await listWorktrees(repo, { env: testEnv });
      expect(listed.filter((w) => w.path === expected && w.branch === 'race')).toHaveLength(1);
    }
  });

  test('AC9 — simultaneous calls for different branches of one repository all resolve', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const branches = ['one', 'two', 'three', 'four'];

    const created = await Promise.all(
      branches.map((branch) => createWorktree({ repo, root, branch, base: 'main', env: testEnv })),
    );

    expect(created.map((w) => w.branch).sort()).toEqual([...branches].sort());
    const listed = await listWorktrees(repo, { env: testEnv });
    for (const branch of branches) {
      expect(listed.some((w) => w.branch === branch && w.path === join(root, projectDir(repo), branch))).toBe(true);
      expect(branchExists(repo, branch)).toBe(true);
    }
  });

  test('AC9 — a rejected call does not block the next one for the same repository', async () => {
    const repo = await makeRepo();
    const root = await tempDir();

    await rejection(createWorktree({ repo, root, branch: 'my feature', base: 'main', env: testEnv }));
    const created = await createWorktree({ repo, root, branch: 'after', base: 'main', env: testEnv });

    expect(created.branch).toBe('after');
  });
});

describe('removeWorktree force', () => {
  test('AC18 — force removes a worktree with modified and untracked files, and the changes are gone', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'dirty', 'dirty');
    await writeFile(join(path, 'README.md'), 'changed\n');
    await writeFile(join(path, 'notes.txt'), 'untracked\n');

    await removeWorktree({ repo, path, force: true, env: testEnv });

    expect(existsSync(path)).toBe(false);
    expect((await listWorktrees(repo, { env: testEnv })).some((w) => w.path === path)).toBe(false);
    expect(branchExists(repo, 'dirty')).toBe(true);
    // The main working tree is untouched.
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('hello\n');
  });

  test('AC18 — without force the same worktree is still DIRTY_WORKTREE, and force: false is the same', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'dirty', 'dirty');
    await writeFile(join(path, 'notes.txt'), 'untracked\n');

    for (const force of [undefined, false]) {
      const error = await rejection(removeWorktree({ repo, path, force, env: testEnv }));
      expect(error.code, `force: ${String(force)}`).toBe('DIRTY_WORKTREE');
    }

    expect(existsSync(path)).toBe(true);
    expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('untracked\n');
  });

  test('AC18 — force with deleteBranch deletes a merged branch (AC16 rule)', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'dirty-merged', 'dirty-merged');
    await writeFile(join(path, 'notes.txt'), 'untracked\n');

    await removeWorktree({ repo, path, force: true, deleteBranch: true, env: testEnv });

    expect(existsSync(path)).toBe(false);
    expect(branchExists(repo, 'dirty-merged')).toBe(false);
  });

  test('AC18 — force with deleteBranch keeps an unmerged branch and rejects BRANCH_NOT_MERGED (AC17 rule)', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'dirty-unmerged', 'dirty-unmerged');
    const branchHead = commit(path, 'not on main');
    await writeFile(join(path, 'README.md'), 'changed\n');

    const error = await rejection(removeWorktree({ repo, path, force: true, deleteBranch: true, env: testEnv }));

    expect(error.code).toBe('BRANCH_NOT_MERGED');
    expect(existsSync(path)).toBe(false);
    expect((await listWorktrees(repo, { env: testEnv })).some((w) => w.path === path)).toBe(false);
    expect(git(repo, 'rev-parse', 'dirty-unmerged')).toBe(branchHead);
  });

  test('AC19 — a locked worktree is not removed, with or without force', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'locked', 'locked');
    git(repo, 'worktree', 'lock', path);

    for (const force of [undefined, true]) {
      const error = await rejection(removeWorktree({ repo, path, force, env: testEnv }));
      expect(error.code, `force: ${String(force)}`).toBe('GIT_FAILED');
    }

    expect(existsSync(path)).toBe(true);
    expect(branchExists(repo, 'locked')).toBe(true);
  });
});

describe('missing folders', () => {
  test('AC16 — a path that does not exist is NOT_A_REPOSITORY, never GIT_MISSING', async () => {
    const missing = join(await tempDir(), 'never-created');
    const root = await tempDir();

    const calls: Record<string, () => Promise<unknown>> = {
      findRepositoryRoot: () => findRepositoryRoot(missing, { env: testEnv }),
      listWorktrees: () => listWorktrees(missing, { env: testEnv }),
      createWorktree: () =>
        createWorktree({ repo: missing, root, branch: 'topic', base: 'main', env: testEnv }),
    };
    for (const [name, call] of Object.entries(calls)) {
      const error = await rejection(call());
      expect(error.code, name).toBe('NOT_A_REPOSITORY');
    }
    expect(readdirSync(root)).toEqual([]);
  });

  test('AC16 — a linked worktree whose folder was deleted by hand is GIT_FAILED, never GIT_MISSING', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'gone', 'gone');
    await rm(path, { recursive: true, force: true });

    const error = await rejection(removeWorktree({ repo, path, env: testEnv }));

    expect(error.code).toBe('GIT_FAILED');
  });
});

describe('removeWorktree dirty check and vanished branches', () => {
  test('AC17 — an untracked file is DIRTY_WORKTREE even with status.showUntrackedFiles=no', async () => {
    const repo = await makeRepo();
    git(repo, 'config', 'status.showUntrackedFiles', 'no');
    const path = await addWorktree(repo, 'quiet', 'quiet');
    await writeFile(join(path, 'notes.txt'), 'keep me\n');

    const error = await rejection(removeWorktree({ repo, path, env: testEnv }));

    expect(error.code).toBe('DIRTY_WORKTREE');
    expect(existsSync(path)).toBe(true);
    expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('keep me\n');
  });

  test('AC18 (a) — resolves when the worktree is detached and its branch was deleted by hand', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'detached-gone', 'detached-gone');
    git(path, 'checkout', '--detach');
    git(repo, 'branch', '-D', 'detached-gone');

    await removeWorktree({ repo, path, deleteBranch: true, env: testEnv });

    expect(existsSync(path)).toBe(false);
    expect((await listWorktrees(repo, { env: testEnv })).some((w) => w.path === path)).toBe(false);
    expect(branchExists(repo, 'detached-gone')).toBe(false);
  });

  test('AC18 (b) — resolves when the branch ref was deleted while checked out and the worktree is clean', async () => {
    const repo = await makeRepo();
    const path = await addWorktree(repo, 'ref-gone', 'ref-gone');
    git(repo, 'update-ref', '-d', 'refs/heads/ref-gone');
    git(path, 'rm', '-r', '-q', '--cached', '.');
    await rm(join(path, 'README.md'), { force: true });
    expect(git(path, 'status', '--porcelain')).toBe('');
    // Git still reports the checked out branch name.
    const listed = await listWorktrees(repo, { env: testEnv });
    expect(listed.find((w) => w.path === path)?.branch).toBe('ref-gone');

    await removeWorktree({ repo, path, deleteBranch: true, env: testEnv });

    expect(existsSync(path)).toBe(false);
    expect((await listWorktrees(repo, { env: testEnv })).some((w) => w.path === path)).toBe(false);
    expect(branchExists(repo, 'ref-gone')).toBe(false);
  });
});

describe('git availability', () => {
  /** A folder to use as the whole `PATH`, optionally holding a `git` script. */
  async function pathWith(gitScript?: string): Promise<string> {
    const dir = await tempDir();
    if (gitScript !== undefined) {
      const file = join(dir, 'git');
      await writeFile(file, gitScript);
      await chmod(file, 0o755);
    }
    return dir;
  }

  /** A fake `git` that only knows `--version`; any other call fails. */
  const fakeGit = (version: string) =>
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${version}"; else exit 1; fi\n`;

  /** Each public function, called on a real repository with the given env. */
  async function calls(env: NodeJS.ProcessEnv): Promise<Record<string, () => Promise<unknown>>> {
    const repo = await makeRepo();
    const root = await tempDir();
    const linked = await addWorktree(repo, 'linked', 'linked');
    return {
      findRepositoryRoot: () => findRepositoryRoot(repo, { env }),
      listWorktrees: () => listWorktrees(repo, { env }),
      createWorktree: () => createWorktree({ repo, root, branch: 'topic', base: 'main', env }),
      removeWorktree: () => removeWorktree({ repo, path: linked, env }),
    };
  }

  test('AC12 — rejects GIT_MISSING when PATH holds no git', async () => {
    const env = { ...testEnv, PATH: await pathWith() };
    for (const [name, call] of Object.entries(await calls(env))) {
      const error = await rejection(call());
      expect(error.code, name).toBe('GIT_MISSING');
    }
  });

  test('AC12 — rejects GIT_TOO_OLD for git 2.35.9', async () => {
    const env = { ...testEnv, PATH: await pathWith(fakeGit('2.35.9')) };
    for (const [name, call] of Object.entries(await calls(env))) {
      const error = await rejection(call());
      expect(error.code, name).toBe('GIT_TOO_OLD');
    }
  });

  test.each(['2.36.0', '2.50.1', '3.0.0'])('AC12 — accepts git %s', async (version) => {
    const env = { ...testEnv, PATH: await pathWith(fakeGit(version)) };
    for (const [name, call] of Object.entries(await calls(env))) {
      // The fake git fails every other command: the version check passed if the
      // error is neither GIT_MISSING nor GIT_TOO_OLD.
      const error = await rejection(call());
      expect(['GIT_MISSING', 'GIT_TOO_OLD'], name).not.toContain(error.code);
    }
  });
});

describe('readWorkspaceConfig', () => {
  const rwc = (repo: string, path: string, env: NodeJS.ProcessEnv = testEnv) =>
    readWorkspaceConfig({ repo, path, env });

  async function writeConfig(repo: string, content: string): Promise<string> {
    await mkdir(join(repo, '.cockpit'), { recursive: true });
    const file = join(repo, '.cockpit', 'config.json');
    await writeFile(file, content);
    return file;
  }

  test('AC1 — returns the commands of the file, in order, with the three variables', async () => {
    const repo = await makeRepo();
    const setup = ['cp "$COCKPIT_ROOT_PATH/.env" .env', 'bun install'];
    const teardown = ['docker compose down'];
    await writeConfig(repo, JSON.stringify({ setup, teardown }));
    const worktree = await addWorktree(repo, 'login', 'feature/login');

    const result = await rwc(repo, worktree);

    expect(result).toEqual({
      setup,
      teardown,
      env: {
        COCKPIT_ROOT_PATH: repo,
        COCKPIT_WORKSPACE_PATH: worktree,
        COCKPIT_WORKSPACE_NAME: 'feature/login',
      },
    });
    // `repo` may be the linked worktree itself.
    expect(await rwc(worktree, worktree)).toEqual(result);
  });

  test.each([
    ['setup only', { setup: ['bun install'] }, { setup: ['bun install'], teardown: [] }],
    ['teardown only', { teardown: ['x'] }, { setup: [], teardown: ['x'] }],
    ['empty object', {}, { setup: [], teardown: [] }],
  ])('AC2 — a key absent from the file is [] (%s)', async (_name, content, expected) => {
    const repo = await makeRepo();
    await writeConfig(repo, JSON.stringify(content));
    const worktree = await addWorktree(repo, 'topic', 'topic');

    const result = await rwc(repo, worktree);

    expect(result.setup).toEqual(expected.setup);
    expect(result.teardown).toEqual(expected.teardown);
  });

  test('AC3 — a detached HEAD is named after the basename of the worktree folder', async () => {
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, 'detached-folder', 'to-detach');
    git(worktree, 'checkout', '--detach');

    const { env } = await rwc(repo, worktree);

    expect(env.COCKPIT_WORKSPACE_NAME).toBe('detached-folder');
  });

  test('AC4 — no config file resolves to empty lists and creates nothing', async () => {
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, 'topic', 'topic');
    const before = [readdirSync(repo).sort(), readdirSync(worktree).sort()];

    const result = await rwc(repo, worktree);

    expect(result).toEqual({
      setup: [],
      teardown: [],
      env: { COCKPIT_ROOT_PATH: repo, COCKPIT_WORKSPACE_PATH: worktree, COCKPIT_WORKSPACE_NAME: 'topic' },
    });
    expect(existsSync(join(repo, '.cockpit'))).toBe(false);
    expect(existsSync(join(worktree, '.cockpit'))).toBe(false);
    expect([readdirSync(repo).sort(), readdirSync(worktree).sort()]).toEqual(before);
  });

  test('AC5 — the main working tree decides, not the worktree checkout', async () => {
    const repo = await makeRepo();
    await writeConfig(repo, JSON.stringify({ setup: ['from-main'], teardown: ['bye-main'] }));
    const worktree = await addWorktree(repo, 'topic', 'topic');
    await writeConfig(worktree, JSON.stringify({ setup: ['from-worktree'], teardown: ['bye-worktree'] }));
    git(worktree, 'add', '.cockpit/config.json');
    git(worktree, 'commit', '-m', 'config');

    const result = await rwc(repo, worktree);

    expect(result.setup).toEqual(['from-main']);
    expect(result.teardown).toEqual(['bye-main']);
  });

  test('AC5 — a config only in the worktree is ignored', async () => {
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, 'topic', 'topic');
    await writeConfig(worktree, JSON.stringify({ setup: ['from-worktree'], teardown: ['bye-worktree'] }));
    git(worktree, 'add', '.cockpit/config.json');
    git(worktree, 'commit', '-m', 'config');

    const result = await rwc(repo, worktree);

    expect(result.setup).toEqual([]);
    expect(result.teardown).toEqual([]);
  });

  test('AC6 — a file that is not valid JSON is INVALID_CONFIG naming the file', async () => {
    const repo = await makeRepo();
    const file = await writeConfig(repo, '{"setup": [');
    const worktree = await addWorktree(repo, 'topic', 'topic');

    const error = await rejection(rwc(repo, worktree));

    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message).toContain(file);
  });

  test.each([
    ['a top-level array', '[]', undefined],
    ['a top-level null', 'null', undefined],
    ['a top-level string', '"setup"', undefined],
    ['setup as a string', '{"setup": "bun install"}', 'setup'],
    ['teardown holding a number', '{"teardown": [1]}', 'teardown'],
    ['setup holding an empty string', '{"setup": [""]}', 'setup'],
    ['setup holding whitespace', '{"setup": ["   "]}', 'setup'],
    ['an unknown key', '{"setpu": ["bun install"]}', 'setpu'],
    ['the run key', '{"run": ["bun dev"]}', 'run'],
  ])('AC7 — %s is INVALID_CONFIG naming the file and the key', async (_name, content, key) => {
    const repo = await makeRepo();
    const file = await writeConfig(repo, content);
    const worktree = await addWorktree(repo, 'topic', 'topic');

    const error = await rejection(rwc(repo, worktree));

    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message).toContain(file);
    if (key) expect(error.message).toContain(key);
  });

  test('AC8 — a folder named config.json is INVALID_CONFIG with EISDIR and is left as it was', async () => {
    const repo = await makeRepo();
    const file = join(repo, '.cockpit', 'config.json');
    await mkdir(file, { recursive: true });
    const worktree = await addWorktree(repo, 'topic', 'topic');

    const error = await rejection(rwc(repo, worktree));

    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message).toContain(file);
    expect(error.message).toContain('EISDIR');
    expect(statSync(file).isDirectory()).toBe(true);
    expect(readdirSync(file)).toEqual([]);
  });

  // Root ignores permission bits.
  test.skipIf(process.getuid?.() === 0)(
    'AC8 — a file without read permission is INVALID_CONFIG with EACCES and is left as it was',
    async () => {
      const repo = await makeRepo();
      const file = await writeConfig(repo, '{"setup": ["x"]}');
      await chmod(file, 0o000);
      const worktree = await addWorktree(repo, 'topic', 'topic');

      try {
        const error = await rejection(rwc(repo, worktree));

        expect(error.code).toBe('INVALID_CONFIG');
        expect(error.message).toContain(file);
        expect(error.message).toContain('EACCES');
        expect(statSync(file).mode & 0o777).toBe(0);
      } finally {
        await chmod(file, 0o644);
      }
      expect(await readFile(file, 'utf8')).toBe('{"setup": ["x"]}');
    },
  );

  test('AC9 — the main working tree or a stray folder is GIT_FAILED, even with an invalid config', async () => {
    const repo = await makeRepo();
    await writeConfig(repo, '{"setup": [');
    const stray = await tempDir();

    for (const path of [repo, stray]) {
      const error = await rejection(rwc(repo, path));
      expect(error.code, path).toBe('GIT_FAILED');
      expect(error.message, path).toContain(`not a linked worktree: ${path}`);
    }
  });

  test('AC9 — a repo outside any repository is NOT_A_REPOSITORY', async () => {
    const folder = await tempDir();
    const error = await rejection(rwc(folder, folder));
    expect(error.code).toBe('NOT_A_REPOSITORY');
  });

  test('AC9 — a PATH without git is GIT_MISSING', async () => {
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, 'topic', 'topic');
    const env = { ...testEnv, PATH: await tempDir() };

    const error = await rejection(rwc(repo, worktree, env));

    expect(error.code).toBe('GIT_MISSING');
  });

  test('AC10 — runs no command of the config', async () => {
    const repo = await makeRepo();
    const marker = join(await tempDir(), 'marker');
    await writeConfig(repo, JSON.stringify({ setup: [`touch ${marker}`], teardown: [`touch ${marker}`] }));
    const worktree = await addWorktree(repo, 'topic', 'topic');

    const result = await rwc(repo, worktree);

    expect(result.setup).toEqual([`touch ${marker}`]);
    expect(existsSync(marker)).toBe(false);
  });

  test('AC11 — a worktree path given through a symbolic link resolves to the path git reports', async () => {
    const repo = await makeRepo();
    await writeConfig(repo, JSON.stringify({ setup: ['bun install'] }));
    const worktree = await addWorktree(repo, 'topic', 'topic');
    const link = join(await tempDir(), 'link');
    await symlink(worktree, link);

    const result = await rwc(repo, link);

    expect(result.setup).toEqual(['bun install']);
    expect(result.env.COCKPIT_WORKSPACE_PATH).toBe(worktree);
  });
});

describe('commandsInvocation', () => {
  // Runs the invocation with the real /bin/sh, as the main process spawns it.
  function runInvocation(commands: string[], cwd: string) {
    const { command, args } = commandsInvocation(commands);
    expect(command).toBe('/bin/sh');
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    return { status: result.status, stdout: result.stdout };
  }

  test('AC3 — runs the commands in order, each preceded by a "$ <command>" line, and exits 0', async () => {
    const cwd = await tempDir();
    expect(runInvocation(['echo one', 'echo two'], cwd)).toEqual({
      status: 0,
      stdout: '$ echo one\none\n$ echo two\ntwo\n',
    });
  });

  test('AC3 — stops at the first failing command and exits with its code', async () => {
    const cwd = await tempDir();
    expect(runInvocation(['echo a', 'exit 7', 'echo never'], cwd)).toEqual({
      status: 7,
      stdout: '$ echo a\na\n$ exit 7\n',
    });
  });

  test('AC3 — each command runs in its own shell: a cd or an export does not carry to the next', async () => {
    const cwd = await tempDir();
    expect(runInvocation(['cd /', 'pwd -P', 'export FOO=bar', 'echo "[${FOO-unset}]"'], cwd)).toEqual({
      status: 0,
      stdout: `$ cd /\n$ pwd -P\n${cwd}\n$ export FOO=bar\n$ echo "[\${FOO-unset}]"\n[unset]\n`,
    });
  });

  test('AC3 — quotes, $ and a newline run as written, and a command holding % or starting with - prints as is', async () => {
    const cwd = await tempDir();
    const quoted = `echo 'single "double" $HOME'`;
    const multiline = 'echo first\necho second';
    expect(runInvocation([quoted, multiline, 'echo 100%d'], cwd)).toEqual({
      status: 0,
      stdout: `$ ${quoted}\nsingle "double" $HOME\n$ ${multiline}\nfirst\nsecond\n$ echo 100%d\n100%d\n`,
    });
    // The echoed line is not read as an option or a format by printf (what the shell then does with such a command is not ours to pin).
    expect(runInvocation(['-bogus'], cwd).stdout.startsWith('$ -bogus\n')).toBe(true);
  });
});

describe('Electron boundary', () => {
  const packageDir = join(import.meta.dirname, '..');

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
    });
  }

  test('AC14 — no source imports or requires electron', () => {
    const files = sources(join(packageDir, 'src'));
    expect(files.map((f) => basename(f)).sort()).toEqual(expect.arrayContaining(['git.ts', 'index.ts']));

    const pattern = /(from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"`]electron(\/[^'"`]*)?['"`]/;
    for (const file of files) {
      expect(pattern.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });

  test('AC14 — package.json lists electron in no dependency field', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
      'bundledDependencies',
      'bundleDependencies',
    ]) {
      const value = manifest[field];
      const names = Array.isArray(value) ? value : Object.keys((value as object | undefined) ?? {});
      expect(names, field).not.toContain('electron');
    }
  });
});
