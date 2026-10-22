import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Repo-level check of what AGENTS.md records about the desktop test split
// (COCKPIT-48). It lives here, next to the other tests that read AGENTS.md
// (lint.test.ts, workflow.test.ts, workspaces-docs.test.ts), because no package
// owns it. It only reads the file.

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');

// A top-level bullet and its indented continuation, up to the next top-level
// bullet or heading.
function bulletStartingWith(start: string): string {
  const lines = agents.split('\n');
  const first = lines.findIndex((line) => line.startsWith(start));
  expect(first, `AGENTS.md has a bullet starting with ${start}`).toBeGreaterThanOrEqual(0);
  let end = first + 1;
  while (end < lines.length && !/^(- |#)/.test(lines[end]!)) end++;
  return lines.slice(first, end).join('\n');
}

const runtimeTests = () => bulletStartingWith('- **Runtime tests**');
const desktopTests = () => bulletStartingWith('- `apps/desktop` (vitest + Playwright');

describe('AGENTS.md on the desktop test split', () => {
  test('AC8 — the sentence "Every change to the desktop app extends these tests to cover what it adds" is gone', () => {
    expect(agents).not.toContain('Every change to the desktop app extends these tests to cover what it adds');
  });

  test('AC8 — the Runtime tests paragraph states the rule: full block once in the built app, one smoke path per feature in the other modes, git and shell paths in the launchd mode, mode-specific checks everywhere', () => {
    const paragraph = runtimeTests();
    // A feature's full block runs once, in the built app.
    expect(paragraph).toMatch(/full block[\s\S]{0,120}\bonce\b[\s\S]{0,60}built app|built app[\s\S]{0,120}full block/i);
    // Each other launch mode runs one smoke path per feature, through its IPC end to end.
    expect(paragraph).toMatch(/smoke path/i);
    expect(paragraph).toMatch(/smoke path[\s\S]{0,200}IPC|IPC[\s\S]{0,200}smoke path/i);
    expect(paragraph).toMatch(/one smoke path per feature/i);
    // The launchd-environment mode keeps the paths that spawn git or a shell.
    expect(paragraph).toContain('launchd');
    expect(paragraph).toMatch(/launchd[\s\S]{0,250}spawn\w*\s+(git|a shell|the login shell)/i);
    expect(paragraph).toMatch(/\bshell\b/i);
    // Mode-specific checks run in every mode.
    expect(paragraph).toMatch(/mode-specific[\s\S]{0,120}every (launch )?mode/i);
  });

  test('AC8 — the apps/desktop paragraph of "Tests and validation" says which mode runs what', () => {
    const paragraph = desktopTests();
    expect(paragraph).toMatch(/smoke path/i);
    expect(paragraph).toMatch(/full/i);
    expect(paragraph).toContain('built app');
    expect(paragraph).toContain('dev');
    expect(paragraph).toContain('packaged');
    expect(paragraph).toContain('launchd');
    // The launchd-environment mode runs the paths that spawn git or a shell.
    expect(paragraph).toMatch(/launchd[\s\S]{0,400}\b(git|shell)\b/i);
  });

  test('AC8 — AGENTS.md states the principle: as fast as possible without losing coverage', () => {
    expect(agents).toMatch(/as fast as possible/i);
    expect(agents).toMatch(/without losing coverage/i);
  });

  test('AC8 — AGENTS.md states the principle: an assertion runs in every launch mode only when what it checks differs between modes, and once otherwise', () => {
    expect(agents).toMatch(/only when[\s\S]{0,80}differs? between (launch )?modes/i);
    expect(agents).toMatch(/\bonce otherwise\b/i);
  });

  test('AC8 — AGENTS.md states the principle: test a behaviour at the lowest level that can observe it, a package\'s vitest tests before Playwright', () => {
    expect(agents).toMatch(/lowest level that can observe it/i);
    expect(agents).toMatch(/vitest tests? before Playwright/i);
  });

  test('AC8 — AGENTS.md states the principle: no fixed pause where a wait on a condition works', () => {
    expect(agents).toMatch(/no fixed pause where a wait on a condition works/i);
  });
});
