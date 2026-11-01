import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// COCKPIT-78: AGENTS.md is loaded whole by every session (Claude Code truncates at 150,000
// characters), so it holds rules, decisions and pitfalls only. This test caps its size and
// pins its first section; what the file says is reviewed, not asserted.

const agents = () => readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'AGENTS.md'), 'utf8');

describe('AGENTS.md', () => {
  test('AC2 — is shorter than 40,000 characters', () => {
    expect(agents().length).toBeLessThan(40_000);
  });

  test('AC3 — its first ## section is "What belongs in this file"', () => {
    const first = agents()
      .split('\n')
      .find((line) => line.startsWith('## '));
    expect(first).toBe('## What belongs in this file');
  });
});
