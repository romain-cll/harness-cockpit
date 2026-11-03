import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { availableBranch, branchSlug, createWorktree, listWorktrees, nameWorkspace } from '../src/index';

// COCKPIT-66: the branch of a workspace is the slug of the task, renamed to the slug of the agent's
// title; the readable name lives in `branch.<branch>.cockpitName`. Real git, temporary repositories.

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

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-names-')));
  created.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: testEnv, encoding: 'utf8' }).trim();
}

const config = (repo: string, key: string): string | null => {
  try {
    return git(repo, 'config', '--get', key);
  } catch {
    return null;
  }
};

const branches = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

async function makeRepo(): Promise<string> {
  const repo = join(await tempDir(), 'my-repo');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'initial');
  return repo;
}

/** A workspace created the way the composer does: from `main`, so `cockpitBase` is recorded. */
async function makeWorkspace(repo: string, branch: string, root: string) {
  return createWorktree({ repo, root, branch, base: 'main', env: testEnv });
}

describe('branchSlug', () => {
  test.each([
    ['Fix the login redirect loop!', 'fix-the-login-redirect-loop'],
    ['Café déjà vu: Ça marche', 'cafe-deja-vu-ca-marche'],
    ['  --Hello,   World__  ', 'hello-world'],
    ['feature/login (v2) & more...', 'feature-login-v2-more'],
    ['ALL CAPS 123', 'all-caps-123'],
  ])('AC18 — "%s" gives %s', (text, slug) => {
    expect(branchSlug(text)).toBe(slug);
  });

  test.each(['', '   ', '!!!', '日本語 ✳ ☃'])('AC18 — %j leaves nothing: "workspace"', (text) => {
    expect(branchSlug(text)).toBe('workspace');
  });

  test('AC18 — a slug over 40 characters is cut at the last "-" within 40 characters', () => {
    expect(branchSlug('alpha beta gamma delta epsilon zeta eta theta iota')).toBe('alpha-beta-gamma-delta-epsilon-zeta-eta');
    expect(branchSlug('refactor the authentication middleware layer')).toBe('refactor-the-authentication-middleware');
  });

  test('AC18 — a slug of exactly 40 characters is kept whole', () => {
    const forty = `${'a'.repeat(19)}-${'b'.repeat(20)}`;
    expect(forty).toHaveLength(40);
    expect(branchSlug(forty)).toBe(forty);
  });

  test('AC18 — a slug over 40 characters with no "-" is hard-cut at 40', () => {
    expect(branchSlug('x'.repeat(60))).toBe('x'.repeat(40));
  });

  test('AC18 — every result is a valid branch name', () => {
    for (const text of ['Fix the login redirect loop!', '--x--', '!!!', 'a'.repeat(100), 'Ünïcödé  text / with.dots..', '.lock']) {
      expect(() => git(tmpdir(), 'check-ref-format', '--branch', branchSlug(text)), text).not.toThrow();
    }
  });
});

describe('availableBranch', () => {
  test('AC18 — gives the slug when no local branch has that name', async () => {
    const repo = await makeRepo();
    expect(await availableBranch(repo, 'Fix the login redirect loop!', { env: testEnv })).toBe('fix-the-login-redirect-loop');
  });

  test('AC18 — appends -2, then -3, … while a local branch of that name exists', async () => {
    const repo = await makeRepo();
    git(repo, 'branch', 'fix-bug');
    expect(await availableBranch(repo, 'Fix bug', { env: testEnv })).toBe('fix-bug-2');
    git(repo, 'branch', 'fix-bug-2');
    expect(await availableBranch(repo, 'Fix bug', { env: testEnv })).toBe('fix-bug-3');
    expect(await availableBranch(repo, 'Something else', { env: testEnv })).toBe('something-else');
  });

  test('AC18 — a branch checked out in a linked worktree counts as taken', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    await makeWorkspace(repo, 'fix-bug', root);
    expect(await availableBranch(repo, 'fix bug', { env: testEnv })).toBe('fix-bug-2');
  });

  // The fix needs the worktrees root to see a folder, so these calls pass it as `root` next to `env`.
  // The options go through a variable: the current signature has no `root`, and the call must still
  // typecheck before the fix.
  test('AC18 — a name whose worktree folder is still there counts as taken, once its branch was renamed away (sending the same task again)', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const workspace = await makeWorkspace(repo, 'fix-bug-in-login', root);
    await nameWorkspace({ worktree: workspace.path, name: 'A better title', env: testEnv });
    expect(branches(repo)).toEqual(['a-better-title', 'main']);
    expect(existsSync(workspace.path)).toBe(true);

    const options = { env: testEnv, root };
    expect(await availableBranch(repo, 'Fix bug in login', options)).toBe('fix-bug-in-login-2');
    // The name it would take is usable: the creation is not refused.
    const again = await makeWorkspace(repo, await availableBranch(repo, 'Fix bug in login', options), root);
    expect(again.path).toBe(join(root, `my-repo-${createHash('sha256').update(repo).digest('hex').slice(0, 8)}`, 'fix-bug-in-login-2'));
  });

  test('AC18 — a folder at the worktree path counts as taken even when no branch or worktree has the name', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const hash = createHash('sha256').update(repo).digest('hex').slice(0, 8);
    await mkdir(join(root, `${basename(repo)}-${hash}`, 'leftover-task'), { recursive: true });

    const options = { env: testEnv, root };
    expect(await availableBranch(repo, 'Leftover task', options)).toBe('leftover-task-2');
    expect(await availableBranch(repo, 'Another task', options)).toBe('another-task');
  });

  test('AC18 — a text with nothing left becomes "workspace", then "workspace-2"', async () => {
    const repo = await makeRepo();
    expect(await availableBranch(repo, '???', { env: testEnv })).toBe('workspace');
    git(repo, 'branch', 'workspace');
    expect(await availableBranch(repo, '???', { env: testEnv })).toBe('workspace-2');
  });
});

describe('nameWorkspace', () => {
  test('AC21 — renames the branch to the slug of the name, sets cockpitName, keeps cockpitBase, and the folder does not move', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const workspace = await makeWorkspace(repo, 'please-fix-the-login-redirect-loop', root);
    expect(config(repo, 'branch.please-fix-the-login-redirect-loop.cockpitBase')).toBe('main');

    const result = await nameWorkspace({ worktree: workspace.path, name: 'Fix the login redirect loop', env: testEnv });

    expect(result).toEqual({ branch: 'fix-the-login-redirect-loop' });
    expect(branches(repo)).toEqual(['fix-the-login-redirect-loop', 'main']);
    expect(config(repo, 'branch.fix-the-login-redirect-loop.cockpitName')).toBe('Fix the login redirect loop');
    expect(config(repo, 'branch.fix-the-login-redirect-loop.cockpitBase')).toBe('main');
    expect(config(repo, 'branch.please-fix-the-login-redirect-loop.cockpitBase')).toBeNull();
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(workspace.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix-the-login-redirect-loop');
  });

  test('AC22 — listWorktrees gives the name from cockpitName, and the branch and folder are untouched', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const named = await makeWorkspace(repo, 'first-task', root);
    const plain = await makeWorkspace(repo, 'plain-task', root);
    await nameWorkspace({ worktree: named.path, name: 'A readable name', env: testEnv });

    const listed = await listWorktrees(repo, { env: testEnv });
    const byPath = (path: string) => listed.find((worktree) => worktree.path === path)!;

    expect(byPath(named.path).name).toBe('A readable name');
    expect(byPath(named.path).branch).toBe('a-readable-name');
    expect(byPath(plain.path).branch).toBe('plain-task');
    // Without cockpitName the row falls back to the branch.
    expect(byPath(plain.path).name ?? byPath(plain.path).branch).toBe('plain-task');
  });

  test('AC21 — a taken target gets a suffix', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    git(repo, 'branch', 'fix-bug');
    const workspace = await makeWorkspace(repo, 'my-first-words', root);

    const result = await nameWorkspace({ worktree: workspace.path, name: 'Fix bug', env: testEnv });

    expect(result).toEqual({ branch: 'fix-bug-2' });
    expect(branches(repo)).toEqual(['fix-bug', 'fix-bug-2', 'main']);
    expect(config(repo, 'branch.fix-bug-2.cockpitName')).toBe('Fix bug');
    expect(config(repo, 'branch.fix-bug.cockpitName')).toBeNull();
  });

  test('AC21 — two workspaces named alike at once end on distinct branches (calls run one at a time)', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const one = await makeWorkspace(repo, 'first-words', root);
    const two = await makeWorkspace(repo, 'second-words', root);

    const results = await Promise.all([
      nameWorkspace({ worktree: one.path, name: 'Same title', env: testEnv }),
      nameWorkspace({ worktree: two.path, name: 'Same title', env: testEnv }),
    ]);

    expect(results.map((result) => result.branch).sort()).toEqual(['same-title', 'same-title-2']);
    expect(branches(repo)).toEqual(['main', 'same-title', 'same-title-2']);
  });

  test('AC21 — no rename when the slug equals the current branch: only cockpitName is set', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const workspace = await makeWorkspace(repo, 'fix-the-login-redirect-loop', root);

    const result = await nameWorkspace({ worktree: workspace.path, name: 'Fix the login redirect loop', env: testEnv });

    expect(result).toEqual({ branch: 'fix-the-login-redirect-loop' });
    expect(branches(repo)).toEqual(['fix-the-login-redirect-loop', 'main']);
    expect(config(repo, 'branch.fix-the-login-redirect-loop.cockpitName')).toBe('Fix the login redirect loop');
    expect(config(repo, 'branch.fix-the-login-redirect-loop.cockpitBase')).toBe('main');
  });

  test('AC23 — a branch with an upstream is not renamed: only cockpitName is set', async () => {
    const repo = await makeRepo();
    const root = await tempDir();
    const origin = join(await tempDir(), 'origin.git');
    git(repo, 'init', '--bare', '-b', 'main', origin);
    git(repo, 'remote', 'add', 'origin', origin);
    const workspace = await makeWorkspace(repo, 'already-pushed', root);
    git(workspace.path, 'push', '--set-upstream', 'origin', 'already-pushed');
    expect(config(repo, 'branch.already-pushed.remote')).toBe('origin');

    const result = await nameWorkspace({ worktree: workspace.path, name: 'A better name', env: testEnv });

    expect(result).toEqual({ branch: 'already-pushed' });
    expect(branches(repo)).toEqual(['already-pushed', 'main']);
    expect(config(repo, 'branch.already-pushed.cockpitName')).toBe('A better name');
    expect(config(repo, 'branch.already-pushed.cockpitBase')).toBe('main');
    expect(git(workspace.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/already-pushed');
  });
});
