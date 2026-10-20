import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { harnesses } from '../src/index';

// The catalogue is data: these tests pin its exact values. They never run a real CLI.

function harness(id: string) {
  const found = harnesses.find((h) => h.id === id);
  if (!found) throw new Error(`no harness ${id}`);
  return found;
}

describe('catalogue', () => {
  test('AC1 — lists exactly claude-code, codex and opencode, in this order', () => {
    expect(harnesses.map(({ id, name, binary }) => ({ id, name, binary }))).toEqual([
      { id: 'claude-code', name: 'Claude Code', binary: 'claude' },
      { id: 'codex', name: 'Codex', binary: 'codex' },
      { id: 'opencode', name: 'OpenCode', binary: 'opencode' },
    ]);
  });

  test('AC2 — start() without a prompt returns []', () => {
    expect(harnesses.length).toBe(3);
    for (const h of harnesses) {
      expect(h.start(), h.id).toEqual([]);
    }
  });

  test.each([
    ['claude-code', ['fix the bug']],
    ['codex', ['fix the bug']],
    ['opencode', ['--prompt', 'fix the bug']],
  ])('AC2 — start("fix the bug") for %s', (id, argv) => {
    expect(harness(id).start('fix the bug')).toEqual(argv);
  });

  test.each([
    ['claude-code', ['--continue']],
    ['codex', ['resume', '--last']],
    ['opencode', ['--continue']],
  ])('AC3 — continueLast for %s', (id, argv) => {
    expect(harness(id).continueLast).toEqual(argv);
  });

  test.each([
    ['claude-code', ['--resume', 'abc-123']],
    ['codex', ['resume', 'abc-123']],
    ['opencode', ['--session', 'abc-123']],
  ])('AC4 — resume("abc-123") for %s', (id, argv) => {
    expect(harness(id).resume('abc-123')).toEqual(argv);
  });

  test.each([
    ['claude-code', { path: '/h/.claude/projects', format: 'jsonl' }],
    ['codex', { path: '/h/.codex/sessions', format: 'jsonl' }],
    ['opencode', { path: '/h/.local/share/opencode/opencode.db', format: 'sqlite' }],
  ])('AC5 — sessions({ HOME }) for %s', (id, store) => {
    expect(harness(id).sessions({ HOME: '/h' })).toEqual(store);
  });

  test.each([
    ['claude-code', '/c/projects', 'jsonl'],
    ['codex', '/x/sessions', 'jsonl'],
    ['opencode', '/d/opencode/opencode.db', 'sqlite'],
  ])('AC6 — sessions honours the relocation variable for %s', (id, path, format) => {
    const env = { HOME: '/h', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x', XDG_DATA_HOME: '/d' };
    expect(harness(id).sessions(env)).toEqual({ path, format });
  });

  test.each([
    ['claude-code', '/h/.claude/projects', 'jsonl'],
    ['codex', '/h/.codex/sessions', 'jsonl'],
    ['opencode', '/h/.local/share/opencode/opencode.db', 'sqlite'],
  ])('AC6 — sessions treats empty relocation variables as unset for %s', (id, path, format) => {
    const env = { HOME: '/h', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', XDG_DATA_HOME: '' };
    expect(harness(id).sessions(env)).toEqual({ path, format });
  });
});

describe('Electron boundary', () => {
  const packageDir = join(import.meta.dirname, '..');

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
    });
  }

  test('AC14 — no source imports or requires electron', () => {
    const files = sources(join(packageDir, 'src'));
    expect(files.map((f) => basename(f)).sort()).toEqual(expect.arrayContaining(['catalogue.ts', 'index.ts']));

    const pattern = /(from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"`]electron(\/[^'"`]*)?['"`]/;
    for (const file of files) {
      expect(pattern.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });

  test('AC14 — package.json lists electron in no dependency field', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest.name).toBe('@cockpit/harnesses');
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
      'bundledDependencies',
      'bundleDependencies',
    ]) {
      const value = manifest[field];
      const names = Array.isArray(value) ? value : Object.keys((value as object | undefined) ?? {});
      expect(names, field).not.toContain('electron');
    }
  });
});
