import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorkspaceError } from '../src/git';
import { createWorktree, findRepositoryRoot, listWorktrees, removeWorktree } from '../src/index';

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

  test.each(['../escape', '-x'])('AC13 — rejects GIT_FAILED for the invalid branch name %s', async (branch) => {
    const repo = await makeRepo();
    const container = await tempDir();
    const root = join(container, 'root');
    await mkdir(root);

    for (const base of ['main', undefined]) {
      const error = await rejection(createWorktree({ repo, root, branch, base, env: testEnv }));
      expect(error.code).toBe('GIT_FAILED');
    }

    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(container)).toEqual(['root']);
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
