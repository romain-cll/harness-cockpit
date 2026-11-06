import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// COCKPIT-62: the CI is split into parallel jobs. Like workflow.test.ts this reads the workflow as text
// (no YAML parser in the repository); what a run does on a runner is proved by the real runs, not here.

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

const indentOf = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => line.trim().startsWith('#');

/** The lines of each job (comments dropped), by job id: the 2-space keys under `jobs:`. */
function jobs(text: string): Record<string, string[]> {
  const lines = text.split('\n').filter((line) => !isComment(line));
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  const found: Record<string, string[]> = {};
  if (start < 0) return found;
  let current: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) === 0) break;
    const key = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (key) {
      current = [];
      found[key] = current;
    } else current?.push(line);
  }
  return found;
}

/** Lines of every `run:` step, including the lines of a block scalar (`run: |`). */
function runLines(lines: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const match = /^(\s*)(?:-\s+)?run:(.*)$/.exec(line);
    if (!match) continue;
    found.push(line);
    const indent = (match[1] ?? '').length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (next.trim() !== '' && indentOf(next) <= indent) break;
      found.push(next);
    }
  }
  return found;
}

/** The items of a list under `key:`, as a flow (`[a, b]`) or a block (`- a`) sequence. */
function listOf(lines: string[], key: string): string[] {
  const at = lines.findIndex((line) => new RegExp(`^\\s*${key}:`).test(line));
  if (at < 0) return [];
  const line = lines[at] ?? '';
  const flow = /\[(.*)\]/.exec(line)?.[1];
  if (flow !== undefined) return flow.split(',').map((item) => item.trim()).filter(Boolean);
  const inline = line.slice(line.indexOf(':') + 1).trim();
  if (inline !== '') return [inline];
  const items: string[] = [];
  for (const next of lines.slice(at + 1)) {
    if (next.trim() === '') continue;
    if (indentOf(next) <= indentOf(line) && !next.trim().startsWith('-')) break;
    const item = /^\s*-\s+(.*)$/.exec(next)?.[1];
    if (item === undefined) break;
    items.push(item.trim());
  }
  return items;
}

const JOBS = ['changes', 'lint', 'typecheck', 'repo-checks', 'packages', 'desktop', 'check'];

describe('ci.yml', () => {
  test('AC3 — the jobs, only packages and desktop on macOS, an expression in no run line, no timeout above 20 minutes', () => {
    const all = jobs(workflow);
    expect(Object.keys(all).sort()).toEqual([...JOBS].sort());
    for (const [name, lines] of Object.entries(all)) {
      const runsOn = lines.find((line) => /^\s+runs-on:/.test(line)) ?? '';
      if (name === 'packages' || name === 'desktop') expect(runsOn, name).toMatch(/macos/i);
      else expect(runsOn, name).toMatch(/ubuntu/i);
    }
    for (const line of runLines(workflow.split('\n').filter((l) => !isComment(l)))) {
      expect(line, 'a run: line must not contain an expression').not.toContain('${{');
    }
    for (const match of workflow.matchAll(/timeout-minutes:\s*(\d+)/g)) {
      expect(Number(match[1])).toBeLessThanOrEqual(20);
    }
  });

  test('AC3 — check runs always and needs every other job; repo-checks has no if:', () => {
    const all = jobs(workflow);
    const check = all.check ?? [];
    expect(check.some((line) => /^ {4}if:\s*always\(\)\s*$/.test(line))).toBe(true);
    expect(listOf(check, 'needs').sort()).toEqual(JOBS.filter((job) => job !== 'check').sort());
    expect((all['repo-checks'] ?? []).filter((line) => /^\s*(?:-\s+)?if:/.test(line))).toEqual([]);
  });

  test('AC3 — desktop is the matrix of shards 1, 2, 3, never failing fast, and a step runs vitest with --shard=$SHARD/3', () => {
    const desktop = jobs(workflow).desktop ?? [];
    expect(desktop.some((line) => /^\s+fail-fast:\s*false\s*$/.test(line))).toBe(true);

    const matrix = desktop.findIndex((line) => /^\s+matrix:\s*$/.test(line));
    expect(matrix, 'desktop has a matrix').toBeGreaterThanOrEqual(0);
    const body: string[] = [];
    for (const line of desktop.slice(matrix + 1)) {
      if (line.trim() !== '' && indentOf(line) <= indentOf(desktop[matrix] ?? '')) break;
      body.push(line);
    }
    const keys = body.filter((line) => indentOf(line) === indentOf(body[0] ?? '') && /^\s*[\w-]+:/.test(line));
    expect(keys.map((line) => line.trim().split(':')[0])).toEqual(['shard']);
    expect(listOf(body, 'shard')).toEqual(['1', '2', '3']);

    expect(desktop.some((line) => /^\s+SHARD:\s*\$\{\{\s*matrix\.shard\s*\}\}\s*$/.test(line))).toBe(true);
    expect(runLines(desktop).some((line) => line.includes('vitest') && line.includes('--shard=$SHARD/3'))).toBe(true);
  });
});
