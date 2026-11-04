import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CATEGORIES, countCategories, type Category } from '../src/sleeps-count';

// COCKPIT-80, COCKPIT-81: a per-file ratchet over the waits left in the test files. The counter lives
// in `../src/sleeps-count.ts`: `countCategories(source)` returns `{ counts, allowed }`, the occurrences
// per category in one file's text (lines whose trimmed text starts with `//` or `*` skipped) and the
// lines that end with `// legitimate poll: <reason>` (counted nowhere, returned with their reason).
// This file holds its unit cases, the per-file baseline, the `ALLOWED` list and the repo check. A count
// above its file's entry fails (a new wait), a count below fails too (lower the entry in the same change,
// so the ratchet only ever tightens), and the allowed lines found must be exactly `ALLOWED`.
//
// Like agents-md.test.ts it lives here because no package owns a repo-wide check, and it only reads files.

type Counts = Record<Category, number>;
type Baseline = Record<string, Partial<Record<Category, number>>>;
type Found = Record<string, Counts>;
interface AllowedLine {
  file: string;
  line: string;
  reason: string;
}

/**
 * The counts each test file holds, non-zero entries only (a file absent holds none). Lower a number
 * here when a test below it, and delete the entry when it reaches zero.
 * `launch.ts` keeps the three lines of the definition of `poll` while other files call it; the one
 * `setTimeout(` of `launch-helpers.test.ts` is the page-side timer that AC9's element waits for.
 */
const BASELINE: Baseline = {
  '.github/scripts/plane-sync/test/lint.test.ts': { timeouts: 1 },
  'apps/desktop/test/composer.ts': { timeouts: 14, polls: 1 },
  'apps/desktop/test/daemon.test.ts': { pauses: 3, timeouts: 47, polls: 32 },
  'apps/desktop/test/global-teardown.test.ts': { pauses: 2, polls: 1 },
  'apps/desktop/test/launch-helpers.test.ts': { pauses: 1 },
  'apps/desktop/test/launch.ts': { pauses: 1, timeouts: 1, deadlines: 1 },
  'apps/desktop/test/live-terminals.test.ts': { pauses: 1 },
  'apps/desktop/test/new-workspace.test.ts': { timeouts: 1, polls: 4 },
  'apps/desktop/test/workspace-panes.test.ts': { pauses: 5, timeouts: 65, polls: 29, deadlines: 1 },
  'packages/daemon/test/cli.test.ts': { pauses: 1 },
  'packages/daemon/test/client.test.ts': { pauses: 2 },
  'packages/daemon/test/helpers.ts': { pauses: 2, deadlines: 1 },
  'packages/daemon/test/status.test.ts': { pauses: 1 },
  'packages/daemon/test/terminals.test.ts': { pauses: 2 },
  'packages/harnesses/test/detect.test.ts': { pauses: 2, deadlines: 1 },
  'packages/harnesses/test/status.test.ts': { pauses: 1, timeouts: 7, polls: 4 },
  'packages/shell-env/test/resolve-shell-env.test.ts': { pauses: 4, deadlines: 1 },
  'packages/workspaces/test/changes.test.ts': { pauses: 2, timeouts: 9, polls: 9 },
};

/** The `// legitimate poll: <reason>` lines the test files may hold: a re-check loop whose source cannot notify. */
const ALLOWED: AllowedLine[] = [
  {
    file: 'apps/desktop/test/app.test.ts',
    line: 'await sleep(100); // legitimate poll: Launch Services registers a launched app at no event we can listen to',
    reason: 'Launch Services registers a launched app at no event we can listen to',
  },
  {
    file: 'apps/desktop/test/app.test.ts',
    line: 'await sleep(100); // legitimate poll: the frontmost app is sampled, no notification is proven for it',
    reason: 'the frontmost app is sampled, no notification is proven for it',
  },
];

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

function countRepo(): { found: Found; allowed: AllowedLine[] } {
  const found: Found = {};
  const allowed: AllowedLine[] = [];
  for (const path of testFiles()) {
    const file = relative(repoRoot, path);
    const result = countCategories(readFileSync(path, 'utf8'));
    if (CATEGORIES.some((category) => result.counts[category] > 0)) found[file] = result.counts;
    for (const each of result.allowed) allowed.push({ file, line: each.line, reason: each.reason });
  }
  return { found, allowed };
}

/** What is wrong with the counts against the baseline: one message per file and category above or below its entry. */
function verdict(found: Found, baseline: Baseline): string[] {
  const problems: string[] = [];
  for (const file of [...new Set([...Object.keys(found), ...Object.keys(baseline)])].sort()) {
    for (const category of CATEGORIES) {
      const count = found[file]?.[category] ?? 0;
      const entry = baseline[file]?.[category] ?? 0;
      if (count > entry) {
        problems.push(`${file}: ${category} is ${count}, above its baseline ${entry}; remove the new ones`);
      } else if (count < entry) {
        problems.push(`${file}: ${category} is ${count}, below its baseline ${entry}; lower the entry of ${file} to ${count}`);
      }
    }
  }
  return problems;
}

const key = (each: AllowedLine) => `${each.file} | ${each.line} | ${each.reason}`;

/** The allowed lines found that `ALLOWED` lacks, and the entries of `ALLOWED` that no line matches. */
function allowedProblems(found: AllowedLine[], allowed: AllowedLine[]): string[] {
  const listed = new Set(allowed.map(key));
  const present = new Set(found.map(key));
  return [
    ...found.filter((each) => !listed.has(key(each))).map((each) => `${each.file}: add to ALLOWED: ${each.line} (${each.reason})`),
    ...allowed.filter((each) => !present.has(key(each))).map((each) => `${each.file}: remove from ALLOWED, its line is gone: ${each.line}`),
  ];
}

const none: Counts = { pauses: 0, timeouts: 0, polls: 0, deadlines: 0 };

describe('the counter', () => {
  test('COCKPIT-80 — counts the pauses: sleep(, setTimeout(, waitForTimeout(, Atomics.wait( and a shell "sleep <n>"', () => {
    const source = [
      'await sleep(100);',
      'await new Promise((done) => setTimeout(done, 20));',
      'await page.waitForTimeout(50);',
      'Atomics.wait(cell, 0, 0, 10);',
      "writeFileSync(stub, 'while true; do sleep 0.1; done');",
      'await sleep(1); await sleep(2);',
    ].join('\n');
    expect(countCategories(source).counts).toEqual({ ...none, pauses: 7 });
  });

  test('COCKPIT-80 — counts the "timeout:" options, the poll( calls and the Date.now() + deadlines, each in its own category', () => {
    const source = [
      'await button.click({ timeout: UI_TIMEOUT });',
      'await locator.waitFor({ state: "hidden", timeout: 15_000 });',
      'const labels = await poll(() => read(), (found) => found.length === 2, UI_TIMEOUT);',
      'const deadline = Date.now() + 3_000;',
      'while (Date.now() < deadline) await next();',
    ].join('\n');
    expect(countCategories(source).counts).toEqual({ pauses: 0, timeouts: 2, polls: 1, deadlines: 1 });
  });

  test('COCKPIT-80 — the definition of poll is not a poll( call (its "timeout:" parameter is still a "timeout:" hit)', () => {
    const source = 'export async function poll<T>(read: () => T, done: (value: T) => boolean, timeout: number): Promise<T> {';
    expect(countCategories(source).counts).toEqual({ ...none, timeouts: 1 });
  });

  test('COCKPIT-80 — skips the lines whose trimmed text starts with // or *', () => {
    const source = [
      '// await sleep(100) was here, with a timeout: 5_000',
      '  // poll( and Date.now() + 1',
      ' * a doc line: setTimeout( and timeout: 1',
      '/** not skipped by the rule, but it holds nothing */',
      '    await sleep(5); // a trailing comment on a counted line',
    ].join('\n');
    expect(countCategories(source).counts).toEqual({ ...none, pauses: 1 });
  });

  test('AC1 — counts vi.waitFor(, expect.poll(, waitForFunction( and setInterval( under polls, each occurrence once, next to poll(', () => {
    const source = [
      'await vi.waitFor(() => expect(read()).toBe(1), { interval: 50 });',
      'await expect.poll(() => read()).toBe(2);',
      'await page.waitForFunction(() => window.ready);',
      'const timer = setInterval(tick, 100);',
      'const found = await poll(() => read(), Boolean, UI_TIMEOUT);',
      'await vi.waitFor(a); await vi.waitFor(b);',
    ].join('\n');
    expect(countCategories(source).counts).toEqual({ ...none, polls: 7 });
  });

  test('AC2 — a line ending with "// legitimate poll: <reason>" counts nothing and is returned with its reason', () => {
    const source = [
      'await sleep(100); await vi.waitFor(() => alive(pid), { timeout: 5_000 }); // legitimate poll: a pid in another process tree cannot notify',
      'await sleep(5);',
    ].join('\n');
    const { counts, allowed } = countCategories(source);
    expect(counts).toEqual({ ...none, pauses: 1 });
    expect(allowed).toHaveLength(1);
    expect(allowed[0]!.reason).toBe('a pid in another process tree cannot notify');
    expect(allowed[0]!.line).toContain('vi.waitFor(');
  });

  test('AC2 — a "// legitimate poll:" comment with no reason does not excuse the line', () => {
    const source = ['await sleep(100); // legitimate poll:', 'await sleep(100); // legitimate poll:    '].join('\n');
    const { counts, allowed } = countCategories(source);
    expect(counts).toEqual({ ...none, pauses: 2 });
    expect(allowed).toEqual([]);
  });

  test('counts nothing and allows nothing in a file with none', () => {
    expect(countCategories("import { test } from 'vitest';\ntest('x', () => {});\n")).toEqual({ counts: none, allowed: [] });
  });
});

describe('the verdict', () => {
  const baseline: Baseline = { 'a.ts': { pauses: 2, timeouts: 1 }, 'b.ts': { polls: 1 } };

  test('AC3 — equal to every entry passes', () => {
    const found: Found = { 'a.ts': { ...none, pauses: 2, timeouts: 1 }, 'b.ts': { ...none, polls: 1 } };
    expect(verdict(found, baseline)).toEqual([]);
  });

  test('AC3 — above the entry fails, naming the file, the category and both counts', () => {
    const found: Found = { 'a.ts': { ...none, pauses: 3, timeouts: 1 }, 'b.ts': { ...none, polls: 1 } };
    const problems = verdict(found, baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('a.ts');
    expect(problems[0]).toContain('pauses');
    expect(problems[0]).toContain('3');
    expect(problems[0]).toContain('2');
  });

  test('AC3 — a file absent from the baseline has 0: any count in it fails, naming it', () => {
    const found: Found = { 'a.ts': { ...none, pauses: 2, timeouts: 1 }, 'b.ts': { ...none, polls: 1 }, 'new.ts': { ...none, timeouts: 1 } };
    const problems = verdict(found, baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('new.ts');
    expect(problems[0]).toContain('timeouts');
  });

  test("AC3 — below the entry fails, asking to lower that file's entry to the new count (one file's slack never covers another's excess)", () => {
    const found: Found = { 'a.ts': { ...none, pauses: 1, timeouts: 1 }, 'b.ts': { ...none, polls: 1 } };
    const problems = verdict(found, baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('a.ts');
    expect(problems[0]).toContain('pauses');
    expect(problems[0]).toMatch(/lower the entry .* to 1/);
    const swapped: Found = { 'a.ts': { ...none, pauses: 1, timeouts: 1 }, 'b.ts': { ...none, polls: 2 } };
    expect(verdict(swapped, baseline)).toHaveLength(2);
  });
});

describe('the allowed lines', () => {
  const line = { file: 'a.ts', line: 'await vi.waitFor(alive); // legitimate poll: no event', reason: 'no event' };

  test('AC4 — a line found and listed passes', () => {
    expect(allowedProblems([line], [line])).toEqual([]);
  });

  test('AC4 — a new "// legitimate poll:" line fails until it is added to ALLOWED', () => {
    const problems = allowedProblems([line], []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('a.ts');
    expect(problems[0]).toContain('add to ALLOWED');
  });

  test('AC4 — an entry whose line is gone fails until it is removed', () => {
    const problems = allowedProblems([], [line]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('a.ts');
    expect(problems[0]).toContain('remove from ALLOWED');
  });
});

describe('the test files', () => {
  test('AC4 — the allowed lines found are exactly the ALLOWED list', () => {
    expect(allowedProblems(countRepo().allowed, ALLOWED)).toEqual([]);
  });

  test('AC5 — launch.ts holds only the three lines of the definition of poll: one pause, one timeout option, one deadline, no poll( call', () => {
    const { found } = countRepo();
    expect(found['apps/desktop/test/launch.ts']).toEqual({ pauses: 1, timeouts: 1, polls: 0, deadlines: 1 });
  });

  test('COCKPIT-81 part 1 AC1 — app.test.ts holds no pause, no timeout option, no poll and no deadline, and has no baseline entry', () => {
    expect(countRepo().found['apps/desktop/test/app.test.ts']).toBeUndefined();
    expect(BASELINE['apps/desktop/test/app.test.ts']).toBeUndefined();
  });

  test('AC5 — every file holds exactly its baseline entry', () => {
    expect(verdict(countRepo().found, BASELINE)).toEqual([]);
  });
});
