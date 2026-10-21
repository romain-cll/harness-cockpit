import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const workflow = () => readFileSync(join(repoRoot, '.github', 'workflows', 'plane-sync.yml'), 'utf8');

// Lines of every `run:` step, including the lines of a block scalar (`run: |`).
function runLines(text: string): string[] {
  const lines = text.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const match = /^(\s*)(?:-\s+)?run:(.*)$/.exec(line);
    if (!match) continue;
    found.push(line);
    const indent = (match[1] ?? '').length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break;
      found.push(next);
    }
  }
  return found;
}

describe('plane-sync.yml', () => {
  test('AC10 — triggers on pull_request closed, targeting main', () => {
    const text = workflow();
    expect(text).toMatch(/^on:\s*\n\s+pull_request:/m);
    expect(text).toMatch(/types:\s*\[\s*closed\s*\]/);
    expect(text).toMatch(/branches:\s*\[\s*main\s*\]/);
  });

  test('AC10 — runs its job only when the pull request is merged', () => {
    expect(workflow()).toMatch(/^\s+if:\s*github\.event\.pull_request\.merged\s*==\s*true\s*$/m);
  });

  test('AC10 — passes the secret, the title and the head branch through env', () => {
    const text = workflow();
    expect(text).toMatch(/^\s+PLANE_API_KEY:\s*\$\{\{\s*secrets\.PLANE_API_KEY\s*\}\}\s*$/m);
    expect(text).toMatch(/^\s+PR_TITLE:\s*\$\{\{\s*github\.event\.pull_request\.title\s*\}\}\s*$/m);
    expect(text).toMatch(/^\s+PR_BRANCH:\s*\$\{\{\s*github\.event\.pull_request\.head\.ref\s*\}\}\s*$/m);
  });

  test('AC10 — runs the script, and no run line holds a ${{ }} expression', () => {
    const text = workflow();
    const lines = runLines(text);
    expect(lines.some((l) => l.includes('bun .github/scripts/plane-sync/src/main.ts'))).toBe(true);
    for (const line of lines) {
      expect(line, 'a run: line must not contain an expression').not.toContain('${{');
    }
  });
});

describe('AGENTS.md', () => {
  const agents = () => readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');

  test('AC12 — the monorepo section lists .github/scripts/plane-sync', () => {
    const text = agents();
    const monorepo = text.slice(text.indexOf('## Monorepo'), text.indexOf('## Desktop app'));
    expect(monorepo).toContain('.github/scripts/plane-sync');
  });

  test('AC12 — the CI section describes the Plane sync workflow', () => {
    const text = agents();
    const start = text.indexOf('## Tests and validation');
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(start);
    expect(section).toMatch(/plane sync/i);
    expect(section).toContain('plane-sync.yml');
    expect(section).toContain('PLANE_API_KEY');
    expect(section).toMatch(/merged/i);
    expect(section).toMatch(/Done/);
    expect(section).toMatch(/Todo/);
    expect(section).toMatch(/idempoten|already/i);
  });
});
