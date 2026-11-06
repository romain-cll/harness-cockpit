import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

// COCKPIT-62: `ci-scope.sh` decides what the CI runs. It runs on a temp git repository holding a merge
// commit (what a pull request's checkout is) with a stub `bun` on PATH standing in for `turbo ls`.

const script = join(import.meta.dirname, '..', '..', 'ci-scope.sh');
const root = mkdtempSync(join(tmpdir(), 'ci-scope-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

let counter = 0;

/** A repository whose HEAD is a merge commit: first parent `main`, second parent a branch changing `changed`. */
function mergeRepo(changed: string[]): string {
  const dir = join(root, `repo-${counter++}`);
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { ...process.env, ...gitEnv } });
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  write('README.md', 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'pr');
  for (const file of changed) write(file, 'changed by the pull request\n');
  git('add', '.');
  git('commit', '-q', '-m', 'pull request');
  git('checkout', '-q', 'main');
  write('main-only.txt', 'moved on\n');
  git('add', '.');
  git('commit', '-q', '-m', 'main moves on');
  git('merge', '-q', '--no-ff', 'pr', '-m', 'merge');
  return dir;
}

interface Run {
  output: Record<string, string>;
  /** One line per call of the stub: its arguments, then the SCM variables it saw. */
  calls: string[];
}

/** Runs the script in `repo` with a stub `bun` whose `turbo ls` lists `listed`. */
function run(repo: string, event: 'pull_request' | 'push', listed: string[]): Run {
  const stubDir = join(root, `stub-${counter++}`);
  mkdirSync(stubDir);
  const log = join(stubDir, 'calls.log');
  const list = join(stubDir, 'list.json');
  const items = listed.map((name) => ({ name, path: name.replace('@cockpit/', 'packages/') }));
  writeFileSync(list, JSON.stringify({ packageManager: 'bun', packages: { count: items.length, items } }));
  writeFileSync(
    join(stubDir, 'bun'),
    `#!/bin/sh\necho "$* base=$TURBO_SCM_BASE head=$TURBO_SCM_HEAD" >> '${log}'\necho 'turbo 2.11.9 banner' >&2\ncat '${list}'\n`,
  );
  chmodSync(join(stubDir, 'bun'), 0o755);
  const outputFile = join(stubDir, 'github-output');
  writeFileSync(outputFile, '');
  execFileSync(script, [], {
    cwd: repo,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      HOME: stubDir,
      ...gitEnv,
      GITHUB_OUTPUT: outputFile,
      GITHUB_EVENT_NAME: event,
    },
  });
  const output: Record<string, string> = {};
  for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) output[line.slice(0, at)] = line.slice(at + 1);
  }
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } catch {
    // The script may decide without asking turbo.
  }
  return { output, calls };
}

const DESKTOP = '@cockpit/desktop';
const PLANE_SYNC = '@cockpit/plane-sync';

describe('ci-scope.sh', () => {
  test.each([
    { listed: [DESKTOP, PLANE_SYNC], desktop: 'true', packages: 'false', name: 'the desktop app (plane-sync is no package)' },
    { listed: ['@cockpit/daemon', '@cockpit/cli'], desktop: 'false', packages: 'true', name: 'packages but not the desktop app' },
    { listed: [DESKTOP, '@cockpit/daemon'], desktop: 'true', packages: 'true', name: 'both' },
    { listed: [PLANE_SYNC], desktop: 'false', packages: 'false', name: 'plane-sync alone' },
  ])('AC1 — a pull request touching none of the global files, turbo lists $name', ({ listed, desktop, packages }) => {
    const { output, calls } = run(mergeRepo(['AGENTS.md']), 'pull_request', listed);
    expect(output).toEqual({ flag: '--affected', desktop, packages });
    const ls = calls.filter((call) => call.startsWith('turbo ls'));
    expect(ls.length).toBeGreaterThan(0);
    for (const call of ls) {
      expect(call).toContain('--affected');
      expect(call).toContain('--output=json');
      expect(call).toContain('base=HEAD^1 head=HEAD');
    }
  });

  test.each([
    'bun.lock',
    'package.json',
    'turbo.json',
    'tsconfig.base.json',
    '.oxlintrc.json',
    '.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
    '.github/scripts/ci-scope.sh',
  ])('AC2 — a pull request touching %s runs everything, whatever turbo lists', (file) => {
    const { output, calls } = run(mergeRepo([file]), 'pull_request', [PLANE_SYNC]);
    expect(output).toEqual({ flag: '', desktop: 'true', packages: 'true' });
    for (const call of calls) expect(call).not.toContain('--affected');
  });

  test('AC2 — a push event runs everything, whatever the diff and turbo say', () => {
    const { output, calls } = run(mergeRepo(['AGENTS.md']), 'push', [PLANE_SYNC]);
    expect(output).toEqual({ flag: '', desktop: 'true', packages: 'true' });
    for (const call of calls) expect(call).not.toContain('--affected');
  });
});
