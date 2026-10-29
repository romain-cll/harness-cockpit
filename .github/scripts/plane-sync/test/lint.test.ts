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
  test('AC7 — a step runs bun turbo run build typecheck lint test', () => {
    expect(read('.github', 'workflows', 'ci.yml')).toMatch(
      /^\s*-?\s*run:\s*bun turbo run build typecheck lint test\s*$/m,
    );
  });
});

describe('AGENTS.md', () => {
  const agents = () => read('AGENTS.md');
  // The linting paragraph starts where oxlint is first named.
  const linting = () => {
    const text = agents();
    const start = text.indexOf('oxlint');
    return start === -1 ? '' : text.slice(start, start + 4000);
  };

  test('AC8 — records the linter choice with the comparison facts and their date', () => {
    expect(agents()).toContain('oxlint');
    const text = linting();
    expect(text).toContain('Biome');
    expect(text).toContain('ESLint');
    expect(text).toContain('typescript-eslint');
    expect(text).toContain('VoidZero');
    expect(text).toMatch(/TypeScript 7/);
    expect(text).toContain('2026-10-21');
  });

  test('AC8 — records the root config, the check-only scripts and the uncached task', () => {
    const text = agents();
    const monorepo = text.slice(text.indexOf('## Monorepo'), text.indexOf('## Desktop app'));
    expect(monorepo).toContain('.oxlintrc.json');
    expect(monorepo).toContain('oxlint');
    const linting_ = linting();
    expect(linting_).toContain('.oxlintrc.json');
    expect(linting_).toMatch(/check-only|without `--fix`|no `--fix`|never fixes/i);
    expect(linting_).toMatch(/uncached|not cached|never cached|"cache": false/i);
  });

  test('AC8 — the Tests and validation section records the lint check', () => {
    const text = agents();
    const start = text.indexOf('## Tests and validation');
    expect(start).toBeGreaterThan(-1);
    expect(text.slice(start)).toContain('oxlint');
  });
});

// COCKPIT-55: the daemon replaces packages/pty and packages/control.
describe('AGENTS.md and the daemon', () => {
  const agents = () => read('AGENTS.md');

  test('AC15 — lifts the "no daemon" rule and says the terminals run in the daemon, not a utility process', () => {
    expect(/Daemon, artifacts, stats, cloud backend, web app, mobile: create none/.test(agents()), 'the no-daemon rule is still there').toBe(false);
    expect(agents().includes('not a daemon'), 'AGENTS.md still says '+'not a daemon').toBe(false);
    expect(agents().includes('Sessions therefore end when the app quits'), 'AGENTS.md still says '+'Sessions therefore end when the app quits').toBe(false);
  });

  test('AC15 — describes packages/daemon and the daemon entry, and drops packages/pty and packages/control', () => {
    const text = agents();
    expect(text.includes('packages/daemon'), 'AGENTS.md lacks '+'packages/daemon').toBe(true);
    expect(text.includes('src/main/daemon.ts'), 'AGENTS.md lacks '+'src/main/daemon.ts').toBe(true);
    expect(text.includes('--cockpit-daemon'), 'AGENTS.md lacks '+'--cockpit-daemon').toBe(true);
    expect(text.includes('packages/pty'), 'AGENTS.md still says '+'packages/pty').toBe(false);
    expect(text.includes('packages/control'), 'AGENTS.md still says '+'packages/control').toBe(false);
    expect(/^\s+(pty|control)\/\s+#/m.test(text), 'the tree still lists pty/ or control/').toBe(false);
  });

  test('AC15 — records the daemon files and its dependency on the RunAsNode fuse that later fuse hardening must keep on', () => {
    const text = agents();
    expect(text.includes('daemon-1-'), 'AGENTS.md lacks '+'daemon-1-').toBe(true);
    expect(text.includes('ELECTRON_RUN_AS_NODE'), 'AGENTS.md lacks '+'ELECTRON_RUN_AS_NODE').toBe(true);
    const fuse = text.slice(text.indexOf('RunAsNode'));
    expect(fuse).toMatch(/RunAsNode/);
    expect(fuse.slice(0, 600)).toMatch(/keep|stay|on\b/i);
    expect(fuse.slice(0, 600)).toMatch(/fuse hardening|Developer ID|notarization/);
  });

  test('AC15 — the sections describing the pty host and the control endpoint no longer talk about a utility process or control.sock', () => {
    const text = agents();
    expect(text.includes('Cockpit Pty Host'), 'AGENTS.md still says '+'Cockpit Pty Host').toBe(false);
    expect(text.includes('control.sock'), 'AGENTS.md still says '+'control.sock').toBe(false);
    expect(text.includes('control.token'), 'AGENTS.md still says '+'control.token').toBe(false);
    expect(text.includes('runPtyHost'), 'AGENTS.md still says '+'runPtyHost').toBe(false);
    expect(text.includes('createPtyClient'), 'AGENTS.md still says '+'createPtyClient').toBe(false);
  });

  test('AC20 — mentions neither @cockpit/control, packages/control, @cockpit/pty nor packages/pty', () => {
    const text = agents();
    for (const stale of ['@cockpit/control', 'packages/control', '@cockpit/pty', 'packages/pty']) {
      expect(text.includes(stale), 'AGENTS.md still says ' + stale).toBe(false);
    }
  });

  test('AC20, AC9 — the Harnesses status-reporting section names the cockpit CLI path, not statusCommand', () => {
    const text = agents();
    const start = text.indexOf('**Status reporting (COCKPIT-36)**');
    expect(start, 'the status-reporting paragraph').toBeGreaterThan(-1);
    const paragraph = text.slice(start, start + 800);
    expect(paragraph).toContain('cockpit status');
    expect(paragraph).not.toContain('statusCommand');
  });
});

// COCKPIT-56: the `cockpit` CLI replaces the curl line.
describe('statusCommand is gone and AGENTS.md describes apps/cli (COCKPIT-56)', () => {
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

  test('AC9 — @cockpit/daemon exports ./cli and AGENTS.md does not name statusCommand', () => {
    const pkg = JSON.parse(read('packages/daemon/package.json')) as { exports: Record<string, string> };
    expect(pkg.exports['./cli']).toBe('./src/cli.ts');
    expect(read('AGENTS.md').includes('statusCommand'), 'AGENTS.md still names statusCommand').toBe(false);
  });

  test('AC9 — AGENTS.md describes apps/cli: its contract, where it ships, why a Bun compiled binary with the cold-start measurement, and its exit cost', () => {
    const text = read('AGENTS.md');
    for (const needed of [
      '`apps/cli`',
      'usage: cockpit status <working|waiting|finished>',
      'Contents/Resources/bin/cockpit',
      'apps/cli/dist/cockpit',
      'bun build --compile',
      'oven-sh/bun',
    ]) {
      expect(text.includes(needed), `AGENTS.md lacks ${needed}`).toBe(true);
    }
    expect(/^\s+cli\/\s+#/m.test(text), 'the tree lists no cli/').toBe(true);
    const section = text.slice(text.indexOf('`apps/cli`'));
    expect(/cold start/i.test(section), 'no cold start').toBe(true);
    expect(/\d+(\.\d+)? ms/.test(section), 'no measurement in ms').toBe(true);
    expect(/exit cost/i.test(section), 'no exit cost').toBe(true);
  });

  test('AC9 — the lint section counts 10 workspaces', () => {
    const text = read('AGENTS.md');
    expect(text.includes('all 10 workspaces'), 'AGENTS.md lacks all 10 workspaces').toBe(true);
    expect(text.includes('all 9 workspaces'), 'AGENTS.md still says all 9 workspaces').toBe(false);
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
        execFile('bun', ['run', 'build'], { cwd: copy, env: process.env, timeout: 60_000 }, (error, stdout, stderr) =>
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
