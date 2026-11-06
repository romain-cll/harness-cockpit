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

describe('frozen catalogue', () => {
  // Every attempt runs in strict mode (an ES module): a write to a frozen
  // object throws. The restore keeps a failed attempt from leaking into the
  // other tests of this file.
  const expectTypeError = (change: () => void, restore: () => void) => {
    try {
      expect(change).toThrow(TypeError);
    } finally {
      try {
        restore();
      } catch {
        // The object is frozen: nothing was changed, nothing to restore.
      }
    }
  };

  test('AC13 — pushing to continueLast throws a TypeError and leaves it unchanged', () => {
    const list = harness('claude-code').continueLast as string[];

    expectTypeError(
      () => list.push('--extra'),
      () => {
        while (list.length > 1) list.pop();
      },
    );

    expect(harness('claude-code').continueLast).toEqual(['--continue']);
    expect(harness('codex').continueLast).toEqual(['resume', '--last']);
    expect(harness('opencode').continueLast).toEqual(['--continue']);
  });

  test.each(['claude-code', 'codex', 'opencode'])('AC13 — assigning a field of the %s entry throws a TypeError', (id) => {
    const entry = harness(id) as unknown as { name: string };
    const name = entry.name;

    expectTypeError(
      () => {
        entry.name = 'Changed';
      },
      () => {
        entry.name = name;
      },
    );

    expect(harness(id).name).toBe(name);
  });

  test('AC13 — pushing to harnesses throws a TypeError and leaves the three entries', () => {
    const list = harnesses as unknown as unknown[];

    expectTypeError(
      () => list.push({ id: 'extra' }),
      () => {
        list.length = 3;
      },
    );

    expect(harnesses.map((h) => h.id)).toEqual(['claude-code', 'codex', 'opencode']);
  });

  test('AC13 — assigning an index of harnesses throws a TypeError and leaves the entry', () => {
    const list = harnesses as unknown as unknown[];
    const first = list[0];

    expectTypeError(
      () => {
        list[0] = { id: 'extra' };
      },
      () => {
        list[0] = first;
      },
    );

    expect(harnesses[0]!.id).toBe('claude-code');
  });
});

describe('sessionIdFrom (COCKPIT-30 AC1)', () => {
  // A conversation id no harness would make: it must come out byte for byte (AC5).
  const ODD = 'not/a:uuid é';
  // The hook input of the docs: JSON on stdin with `session_id` (Claude Code: https://code.claude.com/docs/en/hooks;
  // Codex: `UserPromptSubmitCommandInput`).
  const hookInput = (fields: Record<string, unknown>) =>
    JSON.stringify({ transcript_path: '/home/u/.claude/projects/x/y.jsonl', cwd: '/work', hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug', ...fields });

  test.each(['claude-code', 'codex'])('AC1 — %s: reads session_id from the hook JSON', (id) => {
    expect(harness(id).sessionIdFrom(hookInput({ session_id: 'abc-123' }))).toBe('abc-123');
  });

  test.each(['claude-code', 'codex'])('AC5 — %s: an id that looks like no harness\'s comes out byte for byte', (id) => {
    expect(harness(id).sessionIdFrom(hookInput({ session_id: ODD }))).toBe(ODD);
  });

  test.each(['claude-code', 'codex'])('AC1 — %s: a subagent\'s hook carries the main session\'s id, which is the one read', (id) => {
    expect(harness(id).sessionIdFrom(hookInput({ session_id: 'main-id', agent_id: 'sub-1', agent_type: 'Explore' }))).toBe('main-id');
  });

  test.each([
    ['an empty input', ''],
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['an object without session_id', '{}'],
    ['an empty session_id', '{"session_id":""}'],
    ['a numeric session_id', '{"session_id":7}'],
    ['a null session_id', '{"session_id":null}'],
    ['another spelling of the field', '{"sessionId":"abc","sessionID":"abc"}'],
  ])('AC6 — claude-code and codex: %s gives no id', (_label, input) => {
    expect(harness('claude-code').sessionIdFrom(input)).toBeNull();
    expect(harness('codex').sessionIdFrom(input)).toBeNull();
  });

  test('AC1 — opencode: the plain id its plugin sends, trimmed', () => {
    expect(harness('opencode').sessionIdFrom('ses_abc123')).toBe('ses_abc123');
    expect(harness('opencode').sessionIdFrom('ses_abc123\n')).toBe('ses_abc123');
    expect(harness('opencode').sessionIdFrom('  ses_abc123 \n')).toBe('ses_abc123');
  });

  test('AC5 — opencode: an id that looks like no harness\'s comes out byte for byte', () => {
    expect(harness('opencode').sessionIdFrom(ODD)).toBe(ODD);
  });

  test.each([
    ['an empty input', ''],
    ['blanks', '  \n'],
  ])('AC6 — opencode: %s gives no id', (_label, input) => {
    expect(harness('opencode').sessionIdFrom(input)).toBeNull();
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
