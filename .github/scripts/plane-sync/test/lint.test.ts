import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Repo-level checks of the lint setup (COCKPIT-40). They live here, next to the
// other tests of repository tooling (workflow.test.ts), because no package owns them.
// They only read files: CI runs `lint` and `test` in parallel, so a test must not run the
// linter or write into other workspaces. The deliberate-error checks (AC2 to AC5) are a
// scripted check at build time, logged in the pull request.

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8');

const workspaces = [
  'apps/cli',
  'apps/desktop',
  'packages/daemon',
  'packages/github',
  'packages/harnesses',
  'packages/launchers',
  'packages/shell-env',
  'packages/state',
  'packages/workspaces',
  '.github/scripts/plane-sync',
];

describe('lint scripts', () => {
  test.each(workspaces)('AC1 — %s has a check-only oxlint lint script', (workspace) => {
    const pkg = JSON.parse(read(workspace, 'package.json')) as { scripts?: Record<string, string> };
    const lint = pkg.scripts?.lint;
    expect(lint, `${workspace} has no lint script`).toBeDefined();
    expect(lint).toMatch(/^oxlint(\s|$)/);
    expect(lint).not.toContain('--fix');
  });
});

describe('turbo.json', () => {
  test('AC6 — the lint task is never cached', () => {
    const turbo = JSON.parse(read('turbo.json')) as { tasks: Record<string, { cache?: boolean }> };
    expect(turbo.tasks.lint?.cache).toBe(false);
  });
});

describe('ci.yml', () => {
  // COCKPIT-62: the CI is split into jobs; the `lint` job runs the lint task (`ci-workflow.test.ts` pins the jobs).
  test('AC7 — a step runs bun turbo run lint', () => {
    expect(read('.github', 'workflows', 'ci.yml')).toMatch(/^\s*-?\s*run:\s*bun turbo run lint(\s.*)?$/m);
  });
});

// COCKPIT-56: the `cockpit` CLI replaces the curl line.
describe('statusCommand is gone and the daemon exports the CLI (COCKPIT-56)', () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'release') return [];
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
    });

  test('AC9 — no source or test of apps/ and packages/ mentions statusCommand', () => {
    const offenders = ['apps', 'packages']
      .flatMap((dir) => sourceFiles(join(repoRoot, dir)))
      .filter((file) => readFileSync(file, 'utf8').includes('statusCommand'));
    expect(offenders).toEqual([]);
  });

  test('AC9 — @cockpit/daemon exports ./cli', () => {
    const pkg = JSON.parse(read('packages/daemon/package.json')) as { exports: Record<string, string> };
    expect(pkg.exports['./cli']).toBe('./src/cli.ts');
  });
});

// COCKPIT-56 AC10: the Bun that compiles the CLI is the one `packageManager` names.
describe('the Bun that compiles apps/cli (AC10)', () => {
  const pinned = () => /^bun@(\d+\.\d+\.\d+)$/.exec((JSON.parse(read('package.json')) as { packageManager: string }).packageManager)![1]!;
  const cliPackage = () => JSON.parse(read('apps/cli/package.json')) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

  test('AC10 — the bun devDependency of apps/cli is exactly the packageManager version', () => {
    expect(cliPackage().devDependencies.bun).toBe(pinned());
  });

  test('AC10 — bun.lock resolves the bun of apps/cli to that version', () => {
    const lock = read('bun.lock');
    const at = lock.indexOf('"apps/cli": {');
    expect(at, 'bun.lock has no apps/cli workspace').toBeGreaterThan(-1);
    const workspace = lock.slice(at);
    expect(workspace.slice(0, workspace.indexOf('}')).replace(/\s+/g, ' ')).toContain(`"bun": "${pinned()}"`);
    expect(lock).toMatch(new RegExp(`"bun": \\["bun@${pinned().replaceAll('.', '\\.')}"`));
  });

  test('AC10 — the build script checks the version, then compiles with the devDependency binary, not the Bun on PATH', () => {
    const build = cliPackage().scripts.build!;
    const steps = build.split('&&').map((step) => step.trim());
    expect(steps.length).toBeGreaterThanOrEqual(2);
    const compile = steps[steps.length - 1]!;
    expect(compile).toMatch(/node_modules\/(\.bin\/bun|bun\/bin\/bun)\s+build\b/);
    expect(compile).toContain('--compile');
    expect(compile).toContain('src/main.ts');
    expect(compile).toContain('dist/cockpit');
    expect(steps.slice(0, -1).join(' ')).not.toContain('--compile');
  });

  test('AC10 — a binary whose version differs from packageManager fails the build with a message naming both versions, and compiles nothing', async () => {
    // A copy of the repository's root package.json and of apps/cli, whose root says another Bun.
    const root = mkdtempSync(join(tmpdir(), 'ck-pin-'));
    try {
      const real = join(repoRoot, 'apps', 'cli');
      const copy = join(root, 'apps', 'cli');
      mkdirSync(copy, { recursive: true });
      for (const entry of readdirSync(real)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        cpSync(join(real, entry), join(copy, entry), { recursive: true });
      }
      if (existsSync(join(real, 'node_modules'))) symlinkSync(join(real, 'node_modules'), join(copy, 'node_modules'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fake', private: true, packageManager: 'bun@0.0.1' }));

      const outcome = await new Promise<{ code: number | null; output: string }>((resolve) =>
        execFile('bun', ['run', 'build'], { cwd: copy, env: process.env }, (error, stdout, stderr) =>
          resolve({ code: error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, output: `${stdout}${stderr}` }),
        ),
      );

      expect(outcome.code).not.toBe(0);
      expect(outcome.output).toContain('0.0.1');
      expect(outcome.output).toContain(pinned());
      expect(existsSync(join(copy, 'dist', 'cockpit'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
