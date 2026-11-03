import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CATEGORIES, countCategories, type Category } from '../src/sleeps-count';

// COCKPIT-80: a ratchet over the pauses and deadlines left in the test files. The counter lives in
// `../src/sleeps-count.ts` (`countCategories(source)`: occurrences per category in one file's text, lines
// whose trimmed text starts with `//` or `*` skipped); this file holds its unit cases, the baseline and
// the repo check. A count above its baseline fails (a new pause or deadline), a count below fails too
// (lower the baseline in the same change, so the ratchet only ever tightens).
//
// Like agents-md.test.ts it lives here because no package owns a repo-wide check, and it only reads files.

/** The counts the test files hold at the end of COCKPIT-80. Lower a number here when a test below it. */
const BASELINE: Record<Category, number> = { pauses: 79, timeouts: 372, polls: 241, deadlines: 8 };

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const SELF = join(import.meta.dirname, 'sleeps-ratchet.test.ts');

/** `apps/* /test`, `packages/* /test` and this workspace's `test`, every `.ts` file, this one excluded. */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path);
      } else if (entry.name.endsWith('.ts') && path !== SELF) {
        found.push(path);
      }
    }
  };
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(repoRoot, group), { withFileTypes: true })) {
      if (entry.isDirectory() && readdirSync(join(repoRoot, group, entry.name)).includes('test')) walk(join(repoRoot, group, entry.name, 'test'));
    }
  }
  walk(join(repoRoot, '.github', 'scripts', 'plane-sync', 'test'));
  return found.sort();
}

type Found = Record<Category, Record<string, number>>;

function countRepo(): Found {
  const found = Object.fromEntries(CATEGORIES.map((category) => [category, {}])) as Found;
  for (const file of testFiles()) {
    const counts = countCategories(readFileSync(file, 'utf8'));
    for (const category of CATEGORIES) if (counts[category] > 0) found[category][relative(repoRoot, file)] = counts[category];
  }
  return found;
}

const total = (files: Record<string, number>) => Object.values(files).reduce((sum, count) => sum + count, 0);

/** What is wrong with the counts against the baseline: one message per category above or below it. */
function verdict(found: Found, baseline: Record<Category, number>): string[] {
  const problems: string[] = [];
  for (const category of CATEGORIES) {
    const count = total(found[category]);
    const files = Object.entries(found[category])
      .map(([file, each]) => `${file} (${each})`)
      .join(', ');
    if (count > baseline[category]) {
      problems.push(`${category}: ${count} is above the baseline ${baseline[category]}; remove the new ones. Files: ${files}`);
    } else if (count < baseline[category]) {
      problems.push(`${category}: ${count} is below the baseline ${baseline[category]}; lower the baseline to ${count}. Files: ${files}`);
    }
  }
  return problems;
}

describe('the counter', () => {
  test('AC7 — counts the pauses: sleep(, setTimeout(, waitForTimeout(, Atomics.wait( and a shell "sleep <n>"', () => {
    const source = [
      'await sleep(100);',
      'await new Promise((done) => setTimeout(done, 20));',
      'await page.waitForTimeout(50);',
      'Atomics.wait(cell, 0, 0, 10);',
      "writeFileSync(stub, 'while true; do sleep 0.1; done');",
      'await sleep(1); await sleep(2);',
    ].join('\n');
    expect(countCategories(source)).toEqual({ pauses: 7, timeouts: 0, polls: 0, deadlines: 0 });
  });

  test('AC7 — counts the "timeout:" options, the poll( calls and the Date.now() + deadlines, each in its own category', () => {
    const source = [
      'await button.click({ timeout: UI_TIMEOUT });',
      'await locator.waitFor({ state: "hidden", timeout: 15_000 });',
      'const labels = await poll(() => read(), (found) => found.length === 2, UI_TIMEOUT);',
      'const deadline = Date.now() + 3_000;',
      'while (Date.now() < deadline) await next();',
    ].join('\n');
    expect(countCategories(source)).toEqual({ pauses: 0, timeouts: 2, polls: 1, deadlines: 1 });
  });

  test('AC7 — the definition of poll is not a poll( call (its "timeout:" parameter is still a "timeout:" hit)', () => {
    const source = 'export async function poll<T>(read: () => T, done: (value: T) => boolean, timeout: number): Promise<T> {';
    expect(countCategories(source)).toEqual({ pauses: 0, timeouts: 1, polls: 0, deadlines: 0 });
    expect(countCategories('function poll(read, done, timeout) {').polls).toBe(0);
  });

  test('AC7 — skips the lines whose trimmed text starts with // or *', () => {
    const source = [
      '// await sleep(100) was here, with a timeout: 5_000',
      '  // poll( and Date.now() + 1',
      ' * a doc line: setTimeout( and timeout: 1',
      '/** not skipped by the rule, but it holds nothing */',
      '    await sleep(5); // a trailing comment on a counted line',
    ].join('\n');
    expect(countCategories(source)).toEqual({ pauses: 1, timeouts: 0, polls: 0, deadlines: 0 });
  });

  test('AC7 — counts nothing in a file with none', () => {
    expect(countCategories("import { test } from 'vitest';\ntest('x', () => {});\n")).toEqual({ pauses: 0, timeouts: 0, polls: 0, deadlines: 0 });
  });
});

describe('the verdict', () => {
  const found = (counts: Partial<Record<Category, Record<string, number>>>): Found => ({ pauses: {}, timeouts: {}, polls: {}, deadlines: {}, ...counts });
  const baseline = { pauses: 2, timeouts: 3, polls: 1, deadlines: 0 };

  test('AC7 — equal to the baseline passes', () => {
    expect(verdict(found({ pauses: { 'a.ts': 2 }, timeouts: { 'a.ts': 1, 'b.ts': 2 }, polls: { 'c.ts': 1 } }), baseline)).toEqual([]);
  });

  test('AC7 — above the baseline fails, naming the category, the count and the files', () => {
    const problems = verdict(found({ pauses: { 'a.ts': 2, 'b.ts': 1 }, timeouts: { 'a.ts': 3 }, polls: { 'c.ts': 1 } }), baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('pauses');
    expect(problems[0]).toContain('3');
    expect(problems[0]).toContain('a.ts');
    expect(problems[0]).toContain('b.ts');
  });

  test('AC7 — below the baseline fails, asking to lower the baseline to the new count', () => {
    const problems = verdict(found({ pauses: { 'a.ts': 2 }, timeouts: { 'a.ts': 2 }, polls: { 'c.ts': 1 } }), baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('timeouts');
    expect(problems[0]).toMatch(/lower the baseline to 2/);
  });
});

describe('the test files', () => {
  test('AC7 — hold exactly the baseline count of pauses, timeout options, poll deadlines and other deadlines', () => {
    expect(verdict(countRepo(), BASELINE)).toEqual([]);
  });
});
