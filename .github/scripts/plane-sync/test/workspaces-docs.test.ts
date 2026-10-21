import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Repo-level check of what AGENTS.md records about workspaces (COCKPIT-26). It
// lives here, next to the other tests that read AGENTS.md (lint.test.ts,
// workflow.test.ts), because no package owns it. It only reads the file.

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');

describe('AGENTS.md on workspaces', () => {
  test('AC24 — worktrees live under $COCKPIT_HOME/worktrees (default ~/.cockpit), not userData, with the two reasons', () => {
    expect(agents).toContain('COCKPIT_HOME');
    expect(agents).toContain('~/.cockpit');
    expect(agents).toMatch(/\$COCKPIT_HOME\/worktrees|COCKPIT_HOME.{0,40}worktrees/s);
    expect(agents).toMatch(/user'?s code/i);
    // Reason 1: the space in `Application Support` breaks some tools run inside a worktree.
    expect(agents).toContain('Application Support');
    expect(agents).toMatch(/space/i);
    // Reason 2: uninstallers delete the app data folder, which would wipe uncommitted work.
    expect(agents).toContain('AppCleaner');
    expect(agents).toMatch(/uncommitted/i);
  });

  test('AC24 — documents the workspaces UI, the workspaces:* IPC and the new package functions', () => {
    expect(agents).toContain('New workspace');
    expect(agents).toContain('Delete workspace');
    expect(agents).toMatch(/workspaces:\*|workspaces:branches/);
    expect(agents).toContain('listBranches');
    expect(agents).toContain('INVALID_BRANCH_NAME');
    expect(agents).toMatch(/`force`|force:/);
  });

  test('AC24 — the COCKPIT_HOME test switch is documented next to the other test variables', () => {
    expect(agents).toMatch(/COCKPIT_USER_DATA_DIR[\s\S]{0,2000}COCKPIT_HOME|COCKPIT_HOME[\s\S]{0,2000}COCKPIT_USER_DATA_DIR/);
  });
});
