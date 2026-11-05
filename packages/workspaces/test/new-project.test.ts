import { execFileSync } from 'node:child_process';
import { close, constants, existsSync, open, openSync, read, readdirSync, readFileSync, writeSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { git as runGit, WorkspaceError } from '../src/git';
import { cloneRepository, findRepositoryRoot, initRepository, listBranches, listWorktrees, repairWorktrees } from '../src/index';

// COCKPIT-72: clone, init (with its first empty commit) and worktree repair, on real git in temporary folders.
// A split of `workspaces.test.ts`, which is past the size a test file should keep.

// The variables that give git an identity without a config file.
const IDENTITY_VARIABLES = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'];

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
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temporary folder, resolved to its real path (macOS `/var` is `/private/var`). */
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-new-project-')));
  created.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: testEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository with one commit holding `README.md`. */
async function makeRepo(): Promise<string> {
  const repo = join(await tempDir(), 'source');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

/**
 * An environment where git has no way to find an identity: a global config holding only `config`, the system
 * config off, `user.useConfigOnly` so that a Mac with a full hostname cannot auto-detect one, and none of the
 * variables that would give one.
 */
async function identityEnv(config: string): Promise<NodeJS.ProcessEnv> {
  const file = join(await tempDir(), 'gitconfig');
  await writeFile(file, config);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: file,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.useConfigOnly',
    GIT_CONFIG_VALUE_0: 'true',
  };
  for (const name of IDENTITY_VARIABLES) delete env[name];
  return env;
}

/** A folder with two files and no repository. */
async function plainFolder(): Promise<string> {
  const folder = join(await tempDir(), 'plain');
  await mkdir(join(folder, 'src'), { recursive: true });
  await writeFile(join(folder, 'notes.txt'), 'keep me\n');
  await writeFile(join(folder, 'src', 'main.ts'), 'export {};\n');
  return folder;
}

/** Every file under `folder` with its content, to tell that nothing moved. */
function contentsOf(folder: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === '.git') continue;
      if (entry.isDirectory()) walk(path);
      else found[path.slice(folder.length)] = readFileSync(path, 'utf8');
    }
  };
  walk(folder);
  return found;
}

/**
 * A `GIT_SSH_COMMAND` that stands for a server that never answers: once git runs it, it reports on a FIFO, then
 * reads its stdin, which git closes only when it ends. `ready` resolves at that report, and `gone` once git has
 * ended and every process the script started with it (the script holds the write end of a second FIFO, which its
 * `cat` inherits, and `cat` ends at the end of file of git's pipe): the events to wait for, so no pause is needed.
 */
async function silentServer(): Promise<{ command: string; ready: Promise<void>; gone: Promise<void> }> {
  const dir = await tempDir();
  const readyFifo = join(dir, 'ready');
  const goneFifo = join(dir, 'gone');
  execFileSync('mkfifo', [readyFifo, goneFifo]);
  // Read and write at once, so the script's write never waits for a reader and no line is lost.
  const reader = new Socket({ fd: openSync(readyFifo, constants.O_RDWR), readable: true, writable: false });
  reader.unref();
  closers.push(() => reader.destroy());
  const ready = new Promise<void>((resolve, reject) => {
    reader.on('error', reject);
    reader.once('data', () => resolve());
  });
  // The open returns once the script has opened the FIFO for writing; the read returns 0 once no writer is left.
  const gone = new Promise<void>((resolve, reject) => {
    open(goneFifo, constants.O_RDONLY, (error, fd) => {
      if (error) return reject(error);
      const next = () =>
        read(fd, Buffer.alloc(1), 0, 1, null, (failed, bytes) => {
          if (failed) reject(failed);
          else if (bytes > 0) next();
          else close(fd, () => resolve());
        });
      next();
    });
  });
  const script = join(dir, 'ssh');
  await writeFile(script, `#!/bin/sh\nexec 9> '${goneFifo}'\necho ready > '${readyFifo}'\ncat > /dev/null\n`);
  await chmod(script, 0o755);
  return { command: script, ready, gone };
}

/**
 * A smudge filter that holds the checkout of a clone. Config for `GIT_CONFIG_COUNT` in `env`: git runs `script` for
 * every file it writes, with `.gitattributes` of the source naming the filter. The script reports on a FIFO once
 * git has reached the checkout, then waits for a line on a second FIFO; `release()` writes it (the cleanup does too,
 * so no script outlives the test).
 */
async function heldCheckout(): Promise<{ env: NodeJS.ProcessEnv; ready: Promise<void>; release(): void }> {
  const dir = await tempDir();
  const readyFifo = join(dir, 'ready');
  const holdFifo = join(dir, 'hold');
  execFileSync('mkfifo', [readyFifo, holdFifo]);
  const reader = new Socket({ fd: openSync(readyFifo, constants.O_RDWR), readable: true, writable: false });
  reader.unref();
  closers.push(() => reader.destroy());
  const ready = new Promise<void>((resolve, reject) => {
    reader.on('error', reject);
    reader.once('data', () => resolve());
  });
  // Both ends open, so the script's wait is for the line and never for a reader.
  const holdFd = openSync(holdFifo, constants.O_RDWR);
  const release = () => {
    try {
      writeSync(holdFd, 'go\n');
    } catch {
      // Already released.
    }
  };
  closers.push(release);
  const script = join(dir, 'smudge');
  await writeFile(script, `#!/bin/sh\ncat > "$0.content"\necho ready > '${readyFifo}'\nread _ < '${holdFifo}'\ncat "$0.content"\n`);
  await chmod(script, 0o755);
  return { env: { ...testEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.hold.smudge', GIT_CONFIG_VALUE_0: script }, ready, release };
}

/** A repository whose files all go through the `hold` filter on checkout. */
async function filteredRepo(): Promise<string> {
  const repo = await makeRepo();
  await writeFile(join(repo, '.gitattributes'), '* filter=hold\n');
  git(repo, 'add', '.gitattributes');
  git(repo, 'commit', '-q', '-m', 'filter');
  return repo;
}

/** The outcome of a promise: its error, or `undefined` if it resolved. */
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error ?? new Error('rejected with nothing'));

describe('cloneRepository', () => {
  test('AC11 — clones a repository to the path, creating the parent folders, with the commit of the source', async () => {
    const source = await makeRepo();
    const path = join(await tempDir(), 'a', 'b', 'copy');

    await cloneRepository({ url: source, path, env: testEnv });

    expect(git(path, 'rev-parse', '--show-toplevel')).toBe(path);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(source, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('hello\n');
  });

  test('AC11 — git gets the env it was given and GIT_TERMINAL_PROMPT=0 whatever the env says', async () => {
    const dir = await tempDir();
    const record = join(dir, 'prompt');
    const script = join(dir, 'ssh');
    // An ssh that records what git left in its environment, then fails.
    await writeFile(script, `#!/bin/sh\nprintf '%s' "\${GIT_TERMINAL_PROMPT-unset}" > '${record}'\nexit 1\n`);
    await chmod(script, 0o755);
    const env = { ...testEnv, GIT_SSH_COMMAND: script, GIT_TERMINAL_PROMPT: '1' };

    const error = await failure(cloneRepository({ url: 'ssh://git@example.invalid/a/b.git', path: join(dir, 'copy'), env }));

    expect(error, 'the ssh of the env ran and failed').toBeInstanceOf(WorkspaceError);
    expect(readFileSync(record, 'utf8')).toBe('0');
  });

  test('AC12 — a clone git refuses rejects with GIT_FAILED carrying git\'s message and leaves no folder; a URL starting with "-" is a repository, not an option', async () => {
    const parent = await tempDir();
    const path = join(parent, 'copy');

    const error = (await failure(cloneRepository({ url: join(parent, 'no-such-repository'), path, env: testEnv }))) as WorkspaceError;

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.code).toBe('GIT_FAILED');
    expect(error.message).toContain('does not exist');
    expect(existsSync(path)).toBe(false);

    const dashed = (await failure(cloneRepository({ url: '--bogus-option', path, env: testEnv }))) as WorkspaceError;

    expect(dashed.message).toContain('does not exist');
    expect(dashed.message).not.toContain('unknown option');
    expect(existsSync(path)).toBe(false);
  });

  test('AC14 — a path that exists, empty or not, rejects with DESTINATION_EXISTS before git runs and is left untouched', async () => {
    const source = await makeRepo();
    const parent = await tempDir();
    const full = join(parent, 'full');
    const empty = join(parent, 'empty');
    await mkdir(full);
    await mkdir(empty);
    await writeFile(join(full, 'mine.txt'), 'mine\n');

    for (const path of [full, empty]) {
      const error = (await failure(cloneRepository({ url: source, path, env: testEnv }))) as WorkspaceError;
      expect(error).toBeInstanceOf(WorkspaceError);
      expect(error.code).toBe('DESTINATION_EXISTS');
    }

    expect(readdirSync(full)).toEqual(['mine.txt']);
    expect(readdirSync(empty)).toEqual([]);
  });

  test('AC15 — aborting the signal while git runs ends git, removes the partial folder and rejects', async () => {
    const parent = await tempDir();
    const path = join(parent, 'a', 'held');
    const server = await silentServer();
    const controller = new AbortController();
    const outcome = failure(
      cloneRepository({ url: 'ssh://git@example.invalid/a/b.git', path, env: { ...testEnv, GIT_SSH_COMMAND: server.command }, signal: controller.signal }),
    );

    await server.ready;
    expect(existsSync(path), 'git has created the folder it is cloning into').toBe(true);
    controller.abort();
    const error = await outcome;
    await server.gone;

    expect(error, 'the clone rejected').toBeDefined();
    expect(existsSync(path), 'git removed the partial folder').toBe(false);
    expect(existsSync(join(parent, 'a')), 'the parents git created stay').toBe(true);
  });

  test('AC15, AC16 — aborting during the checkout, after the fetch, ends git and leaves no folder once the clone settles', async () => {
    const source = await filteredRepo();
    const path = join(await tempDir(), 'held-checkout');
    const hold = await heldCheckout();
    const controller = new AbortController();
    const outcome = failure(cloneRepository({ url: source, path, env: hold.env, signal: controller.signal }));

    await hold.ready;
    expect(existsSync(join(path, '.git')), 'the fetch is done: git is checking out').toBe(true);
    controller.abort();
    const error = await outcome;

    expect(error, 'the clone rejected').toBeDefined();
    expect(existsSync(path), 'the folder is gone').toBe(false);
  });

  test('AC12 — a clone whose checkout fails (a required smudge filter fails) rejects and leaves no folder', async () => {
    const source = await filteredRepo();
    const dir = await tempDir();
    const path = join(dir, 'failed-checkout');
    const script = join(dir, 'smudge');
    await writeFile(script, '#!/bin/sh\nexit 1\n');
    await chmod(script, 0o755);
    const env = {
      ...testEnv,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'filter.hold.smudge',
      GIT_CONFIG_VALUE_0: script,
      GIT_CONFIG_KEY_1: 'filter.hold.required',
      GIT_CONFIG_VALUE_1: 'true',
    };

    const error = await failure(cloneRepository({ url: source, path, env }));

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(existsSync(path), 'the folder is gone').toBe(false);
  });

  test('AC31 — a clone to a path under a regular file rejects with git\'s WorkspaceError, not a raw error from the rollback', async () => {
    const source = await makeRepo();
    const file = join(await tempDir(), 'a-file');
    await writeFile(file, 'not a folder\n');

    const error = await failure(cloneRepository({ url: source, path: join(file, 'copy'), env: testEnv }));

    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe('GIT_FAILED');
    expect(readFileSync(file, 'utf8')).toBe('not a folder\n');
  });

  test('AC27 — with no identity at all the clone succeeds: it makes no commit', async () => {
    const source = await makeRepo();
    const path = join(await tempDir(), 'copy');

    await cloneRepository({ url: source, path, env: await identityEnv('') });

    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(source, 'rev-parse', 'HEAD'));
  });
});

describe('initRepository', () => {
  test('AC6, AC18 — makes a repository with one empty commit, leaves the files untouched and untracked, and gives the branch as the base', async () => {
    const folder = await plainFolder();
    const before = contentsOf(folder);

    await initRepository({ path: folder, env: testEnv });

    expect(git(folder, 'rev-parse', '--show-toplevel')).toBe(folder);
    expect(git(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(folder, 'ls-tree', '-r', 'HEAD')).toBe('');
    expect(git(folder, 'status', '--porcelain', '--untracked-files=all').split('\n').sort()).toEqual(['?? notes.txt', '?? src/main.ts']);
    expect(contentsOf(folder)).toEqual(before);
    const branch = git(folder, 'symbolic-ref', '--short', 'HEAD');
    expect((await listBranches(folder, { env: testEnv })).defaultBase).toBe(branch);
  });

  test('AC29 — a folder initialized already (a retry after a failed save) resolves and keeps its single empty commit', async () => {
    const folder = await plainFolder();
    await initRepository({ path: folder, env: testEnv });
    const head = git(folder, 'rev-parse', 'HEAD');

    await initRepository({ path: folder, env: testEnv });

    expect(git(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(folder, 'rev-parse', 'HEAD')).toBe(head);
  });

  test.each([
    ['user.name unset', '[user]\n\temail = test@example.com\n'],
    ['user.email unset', '[user]\n\tname = Test\n'],
    ['user.name and user.email unset', ''],
  ])('AC21, AC24 — %s: rejects with GIT_IDENTITY_MISSING, removes .git and leaves the files', async (_case, config) => {
    const folder = await plainFolder();
    const before = contentsOf(folder);

    const error = (await failure(initRepository({ path: folder, env: await identityEnv(config) }))) as WorkspaceError;

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.code).toBe('GIT_IDENTITY_MISSING');
    expect(existsSync(join(folder, '.git'))).toBe(false);
    expect(contentsOf(folder)).toEqual(before);
  });

  test('AC24 — a second call after an identity is set succeeds', async () => {
    const folder = await plainFolder();
    const env = await identityEnv('');

    const first = (await failure(initRepository({ path: folder, env }))) as WorkspaceError;
    await writeFile(env.GIT_CONFIG_GLOBAL!, '[user]\n\tname = Late\n\temail = late@example.com\n');
    await initRepository({ path: folder, env });

    expect(first.code).toBe('GIT_IDENTITY_MISSING');
    expect(git(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  test('AC25 — an identity git resolves only in the new repository (includeIf on the location) is enough, and signs the commit', async () => {
    const location = await tempDir();
    const folder = join(location, 'project');
    await mkdir(folder);
    await writeFile(join(location, 'identity'), '[user]\n\tname = Located\n\temail = located@example.com\n');
    const env = await identityEnv(`[includeIf "gitdir:${location}/"]\n\tpath = ${join(location, 'identity')}\n`);

    await initRepository({ path: folder, env });

    expect(git(folder, 'log', '-1', '--format=%an <%ae>')).toBe('Located <located@example.com>');
  });

  test('AC25 — an identity from the environment (GIT_AUTHOR_* and GIT_COMMITTER_*) is enough', async () => {
    const folder = await plainFolder();
    const env = {
      ...(await identityEnv('')),
      GIT_AUTHOR_NAME: 'Env Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_NAME: 'Env Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.com',
    };

    await initRepository({ path: folder, env });

    expect(git(folder, 'log', '-1', '--format=%an <%ae> %cn <%ce>')).toBe('Env Author <author@example.com> Env Committer <committer@example.com>');
  });

  test('AC28 — a .git git refuses to read (dubious ownership): findRepositoryRoot says NOT_A_REPOSITORY, initRepository rejects with GIT_DIR_EXISTS, and .git and its history stay intact', async () => {
    const repo = await makeRepo();
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'second');
    const head = git(repo, 'rev-parse', 'HEAD');
    const entries = readdirSync(join(repo, '.git')).sort();
    const env = { ...testEnv, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };

    const notFound = (await failure(findRepositoryRoot(repo, { env }))) as WorkspaceError;
    const refused = (await failure(initRepository({ path: repo, env }))) as WorkspaceError;

    expect(notFound.code).toBe('NOT_A_REPOSITORY');
    expect(refused).toBeInstanceOf(WorkspaceError);
    expect(refused.code).toBe('GIT_DIR_EXISTS');
    expect(readdirSync(join(repo, '.git')).sort()).toEqual(entries);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('hello\n');
  });

  test('AC26 — an identity but a commit that fails anyway (a global pre-commit hook refuses): rejects with git\'s message, removes .git and leaves the files', async () => {
    const folder = await plainFolder();
    const before = contentsOf(folder);
    const hooks = join(await tempDir(), 'hooks');
    await mkdir(hooks);
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho "refused by the hook" >&2\nexit 1\n');
    await chmod(join(hooks, 'pre-commit'), 0o755);
    const env = { ...testEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks };

    const error = (await failure(initRepository({ path: folder, env }))) as WorkspaceError;

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.code).toBe('GIT_FAILED');
    expect(error.message).toContain('refused by the hook');
    expect(existsSync(join(folder, '.git'))).toBe(false);
    expect(contentsOf(folder)).toEqual(before);
  });
});

describe('git with a working directory that is a file', () => {
  test('AC30 — rejects with a WorkspaceError, never a raw ENOTDIR, directly and through listWorktrees', async () => {
    const file = join(await tempDir(), 'replaced-by-a-file');
    await writeFile(file, 'now a file\n');

    const direct = await failure(runGit(['status'], { cwd: file, env: testEnv }));
    const listed = await failure(listWorktrees(file, { env: testEnv }));

    expect(direct).toBeInstanceOf(WorkspaceError);
    expect(listed).toBeInstanceOf(WorkspaceError);
  });
});

describe('repairWorktrees', () => {
  test('AC22 — after the repository moved, reconnects its worktrees: git works in them again and the worktree list is unchanged', async () => {
    const repo = await makeRepo();
    const workspace = join(await tempDir(), 'feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', '--', workspace, 'main');
    const moved = join(await tempDir(), 'moved-repo');
    await rename(repo, moved);
    expect(() => git(workspace, 'status')).toThrow();

    await repairWorktrees(moved, { env: testEnv });

    expect(git(workspace, 'status', '--porcelain')).toBe('');
    const listed = await listWorktrees(moved, { env: testEnv });
    expect(listed.map((worktree) => worktree.path)).toEqual([moved, workspace]);
    expect(listed[1]!.branch).toBe('feature');
  });
});
