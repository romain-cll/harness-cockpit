import { describe, expect, test } from 'vitest';
import { parsePatch } from '../src/renderer/components/diff-view';

// COCKPIT-34 AC11: git's unified diff of one file, parsed for the changes sidebar into one block
// per hunk. A line has one number: the new one for a context or an added line, the old one for a
// removed line.

describe('parsePatch', () => {
  test('AC11 — gives one block per hunk with its @@ header, and each line its kind, number and text', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      'index c4352f8..bd17d1b 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,4 +1,5 @@',
      ' line 1',
      '-line 2',
      '+line two',
      '+line 2b',
      ' line 3',
      ' line 4',
      '@@ -15,3 +16,3 @@ line 14',
      ' line 15',
      '-line 16',
      '+line sixteen',
      ' line 17',
      '',
    ].join('\n');

    expect(parsePatch(patch)).toEqual([
      {
        header: '@@ -1,4 +1,5 @@',
        lines: [
          { kind: 'context', number: 1, text: 'line 1' },
          { kind: 'removed', number: 2, text: 'line 2' },
          { kind: 'added', number: 2, text: 'line two' },
          { kind: 'added', number: 3, text: 'line 2b' },
          { kind: 'context', number: 4, text: 'line 3' },
          { kind: 'context', number: 5, text: 'line 4' },
        ],
      },
      {
        header: '@@ -15,3 +16,3 @@ line 14',
        lines: [
          { kind: 'context', number: 16, text: 'line 15' },
          { kind: 'removed', number: 16, text: 'line 16' },
          { kind: 'added', number: 17, text: 'line sixteen' },
          { kind: 'context', number: 18, text: 'line 17' },
        ],
      },
    ]);
  });

  test('AC11 — gives no block for a patch without hunk (a pure rename)', () => {
    const rename = ['diff --git a/d.txt b/e.txt', 'similarity index 100%', 'rename from d.txt', 'rename to e.txt', ''].join('\n');

    expect(parsePatch(rename)).toEqual([]);
  });
});
