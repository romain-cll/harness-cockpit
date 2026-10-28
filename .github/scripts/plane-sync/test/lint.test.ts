import { readFileSync } from 'node:fs';
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
});
