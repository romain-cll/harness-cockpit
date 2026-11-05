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
 * The counts each test file holds, non-zero entries only (a file absent holds none). COCKPIT-81 part 3
 * left it empty: a new pause, `timeout:`, poll or deadline in any test file fails the ratchet. Do not add
 * an entry; a re-check loop whose source cannot notify goes in `ALLOWED` instead.
 */
const BASELINE: Baseline = {};

/** The `// legitimate poll: <reason>` lines the test files may hold: a re-check loop whose source cannot notify. */
const ALLOWED: AllowedLine[] = [];

/** The desktop test files COCKPIT-81 part 2 cleans: none keeps a baseline entry. */
const PART_2_FILES = ['workspace-panes.test.ts', 'daemon.test.ts', 'global-teardown.test.ts', 'live-terminals.test.ts', 'new-workspace.test.ts', 'composer.ts'];

/**
 * The number of `test(` cases and of `expect(` calls per file of `packages/* /test` and `.github/scripts/plane-sync/test`
 * at COCKPIT-81 part 3's base commit (6701963), counted by `countCases`. A file may not go below its entry
 * (no test or assertion removed or weakened); lowering one means the PR names the replaced check and its replacement.
 */
const PART_3_FLOOR: Record<string, { tests: number; expects: number }> = {
  '.github/scripts/plane-sync/test/agents-md.test.ts': { tests: 2, expects: 2 },
  '.github/scripts/plane-sync/test/lint.test.ts': { tests: 10, expects: 21 },
  '.github/scripts/plane-sync/test/readme.test.ts': { tests: 9, expects: 13 },
  '.github/scripts/plane-sync/test/sync.test.ts': { tests: 27, expects: 88 },
  '.github/scripts/plane-sync/test/ticket.test.ts': { tests: 11, expects: 14 },
  '.github/scripts/plane-sync/test/workflow.test.ts': { tests: 4, expects: 9 },
  'packages/daemon/test/boundary.test.ts': { tests: 3, expects: 2 },
  'packages/daemon/test/cli.test.ts': { tests: 6, expects: 16 },
  'packages/daemon/test/client.test.ts': { tests: 13, expects: 22 },
  'packages/daemon/test/entry.test.ts': { tests: 1, expects: 3 },
  'packages/daemon/test/helpers.ts': { tests: 0, expects: 1 },
  'packages/daemon/test/paths.test.ts': { tests: 2, expects: 4 },
  'packages/daemon/test/setup-markers.test.ts': { tests: 5, expects: 8 },
  'packages/daemon/test/start.test.ts': { tests: 6, expects: 26 },
  'packages/daemon/test/status.test.ts': { tests: 11, expects: 35 },
  'packages/daemon/test/terminals.test.ts': { tests: 17, expects: 46 },
  'packages/daemon/test/title.test.ts': { tests: 6, expects: 11 },
  'packages/github/test/github.test.ts': { tests: 18, expects: 31 },
  'packages/harnesses/test/catalogue.test.ts': { tests: 16, expects: 20 },
  'packages/harnesses/test/detect.test.ts': { tests: 12, expects: 18 },
  'packages/harnesses/test/prompt-title.test.ts': { tests: 6, expects: 6 },
  'packages/harnesses/test/status.test.ts': { tests: 17, expects: 53 },
  'packages/launchers/test/launchers.test.ts': { tests: 23, expects: 33 },
  'packages/shell-env/test/resolve-shell-env.test.ts': { tests: 9, expects: 50 },
  'packages/state/test/state.test.ts': { tests: 54, expects: 189 },
  'packages/workspaces/test/changes.test.ts': { tests: 28, expects: 76 },
  'packages/workspaces/test/names.test.ts': { tests: 18, expects: 49 },
  'packages/workspaces/test/workspaces.test.ts': { tests: 85, expects: 247 },
};

/** The `test(`, `test.each(` and `it(` cases and the `expect(` calls of a file, lines starting with `//` or `*` skipped. */
function countCases(source: string): { tests: number; expects: number } {
  let tests = 0;
  let expects = 0;
  for (const line of source.split('\n')) {
    const text = line.trim();
    if (text.startsWith('//') || text.startsWith('*')) continue;
    tests += (line.match(/\b(?:test|it)(?:\.each)?\(/g) ?? []).length;
    expects += (line.match(/\bexpect\(/g) ?? []).length;
  }
  return { tests, expects };
}

const inPart3 = (file: string) => file.startsWith('packages/') || file.startsWith('.github/scripts/plane-sync/test/');

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

  test('COCKPIT-81 part 3 AC4 — launch.ts has no poll helper left (no caller is left), no timers import, and holds no pause, timeout option, poll or deadline', () => {
    const source = readFileSync(join(repoRoot, 'apps/desktop/test/launch.ts'), 'utf8');
    expect(/function poll\b/.test(source), 'launch.ts defines poll').toBe(false);
    expect(/node:timers\/promises/.test(source), 'launch.ts imports node:timers/promises').toBe(false);
    expect(countRepo().found['apps/desktop/test/launch.ts']).toBeUndefined();
  });

  test('COCKPIT-81 part 1 AC1 — app.test.ts holds no pause, no timeout option, no poll and no deadline, and has no baseline entry', () => {
    expect(countRepo().found['apps/desktop/test/app.test.ts']).toBeUndefined();
    expect(BASELINE['apps/desktop/test/app.test.ts']).toBeUndefined();
  });

  test('COCKPIT-81 part 2 AC1 — workspace-panes, daemon, global-teardown, live-terminals, new-workspace and composer hold no pause, no timeout option, no poll and no deadline, have no baseline entry, and every allowed line they hold is listed in ALLOWED', () => {
    const { found, allowed } = countRepo();
    const files = PART_2_FILES.map((name) => `apps/desktop/test/${name}`);
    for (const file of files) {
      expect(found[file], file).toBeUndefined();
      expect(BASELINE[file], file).toBeUndefined();
    }
    const inPart = (each: AllowedLine) => files.includes(each.file);
    expect(allowedProblems(allowed.filter(inPart), ALLOWED.filter(inPart))).toEqual([]);
  });

  test('COCKPIT-81 part 2 AC3 — the title of daemon AC7/AC10 no longer says the processes still run "5 s later"', () => {
    const source = readFileSync(join(repoRoot, 'apps/desktop/test/daemon.test.ts'), 'utf8');
    const titles = source.split('\n').filter((line) => /^\s*test\('AC7, AC10 — /.test(line));
    expect(titles).toHaveLength(1);
    expect(titles[0]).not.toMatch(/5 s later/);
  });

  test('COCKPIT-81 part 2 AC4 — quitApp (daemon.test.ts, workspace-panes.test.ts) runs app.quit() on setImmediate, with no 300 ms timer and no poll of isRunning', () => {
    for (const name of ['daemon.test.ts', 'workspace-panes.test.ts']) {
      const source = readFileSync(join(repoRoot, 'apps/desktop/test', name), 'utf8');
      const start = source.indexOf('async function quitApp(');
      expect(start, `${name} defines quitApp`).toBeGreaterThanOrEqual(0);
      const body = source.slice(start, source.indexOf('\n}\n', start));
      expect(body, name).toMatch(/setImmediate\(.*app\.quit\(\)/);
      expect(body, name).not.toMatch(/300|setTimeout|poll\(|isRunning/);
      expect(body, name).toMatch(/exit/);
    }
  });

  test('COCKPIT-81 part 3 AC1 — no file of packages/*/test or .github/scripts/plane-sync/test holds a pause, timeout option, poll or deadline, has a baseline entry, or holds a "// legitimate poll:" line that is not in ALLOWED', () => {
    const { found, allowed } = countRepo();
    expect(Object.keys(found).filter(inPart3)).toEqual([]);
    expect(Object.keys(BASELINE).filter(inPart3)).toEqual([]);
    expect(allowedProblems(allowed.filter((each) => inPart3(each.file)), ALLOWED.filter((each) => inPart3(each.file)))).toEqual([]);
  });

  test('COCKPIT-81 part 3 AC1 — daemon helpers.ts no longer defines until(), and no daemon test calls it (each caller waits on the client event)', () => {
    const using = testFiles()
      .map((path) => relative(repoRoot, path))
      .filter((name) => name.startsWith('packages/daemon/test/') && /\buntil\(|function until\b/.test(readFileSync(join(repoRoot, name), 'utf8')));
    expect(using).toEqual([]);
  });

  test('COCKPIT-81 part 3 AC2 — status.test.ts still asserts the hook timeouts of Claude Code (5) and Codex (3), written as expect(hook.timeout).toBe(n)', () => {
    const source = readFileSync(join(repoRoot, 'packages/harnesses/test/status.test.ts'), 'utf8');
    expect(/expect\(hook\.timeout\)\.toBe\(5\)/.test(source), 'no expect(hook.timeout).toBe(5)').toBe(true);
    expect(/expect\(hook\.timeout\)\.toBe\(3\)/.test(source), 'no expect(hook.timeout).toBe(3)').toBe(true);
    expect(countCategories(source).counts.timeouts).toBe(0);
  });

  test('COCKPIT-81 part 3 AC4 — BASELINE is empty and no test file holds any count at all', () => {
    expect(BASELINE).toEqual({});
    expect(countRepo().found).toEqual({});
  });

  test('COCKPIT-81 part 3 AC5 — no file of packages/*/test or .github/scripts/plane-sync/test holds fewer test( cases or expect( calls than at 6701963', () => {
    const lower: string[] = [];
    for (const [file, floor] of Object.entries(PART_3_FLOOR)) {
      const now = countCases(readFileSync(join(repoRoot, file), 'utf8'));
      if (now.tests < floor.tests) lower.push(`${file}: ${now.tests} test( cases, ${floor.tests} at 6701963`);
      if (now.expects < floor.expects) lower.push(`${file}: ${now.expects} expect( calls, ${floor.expects} at 6701963`);
    }
    expect(lower).toEqual([]);
  });

  test('AC5 — every file holds exactly its baseline entry', () => {
    expect(verdict(countRepo().found, BASELINE)).toEqual([]);
  });
});
