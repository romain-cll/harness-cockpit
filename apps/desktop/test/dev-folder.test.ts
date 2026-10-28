import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { devFolderName } from '../src/main/dev-folder';

// COCKPIT-61: the folder an unpackaged build keeps its data in, `~/.cockpit-dev/<folder>`, is
// derived from the worktree root alone: `<prefix>-<hash>`, the prefix being the root's basename made
// of `[A-Za-z0-9._-]` and cut to 20 characters, the hash the first 8 hex characters of the SHA-256
// of the root's path.

const hash = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 8);

describe('devFolderName', () => {
  test('AC1 — is <prefix>-<8 hex of the SHA-256 of the root>, characters outside [A-Za-z0-9._-] replaced by "-" and the prefix cut to 20 characters', () => {
    const root = '/Users/someone/worktrees/cockpit-61';
    expect(devFolderName(root)).toBe(`cockpit-61-${hash(root)}`);

    const spaced = '/work/my repo (copy)/feature branch';
    expect(devFolderName(spaced)).toBe(`feature-branch-${hash(spaced)}`);

    const dotted = '/work/.superset_v1.2-x';
    expect(devFolderName(dotted)).toBe(`.superset_v1.2-x-${hash(dotted)}`);

    const long = `/work/${'abcdefghij'.repeat(3)}`;
    expect(devFolderName(long)).toBe(`${'abcdefghij'.repeat(2)}-${hash(long)}`);

    const accented = '/work/café-ünï';
    expect(devFolderName(accented)).toBe(`caf---n--${hash(accented)}`);
  });

  test('AC2 — is the same for the same root, and differs for two roots, even with the same basename', () => {
    expect(devFolderName('/a/cockpit')).toBe(devFolderName('/a/cockpit'));
    expect(devFolderName('/a/cockpit')).not.toBe(devFolderName('/b/cockpit'));
    expect(devFolderName('/a/cockpit')).not.toBe(devFolderName('/a/cockpit-2'));
  });

  test('AC3 — is at most 29 bytes for a basename of 200 characters, for non-ASCII ones, and keeps the socket path within 103 bytes for a 26-character user', () => {
    const roots = [`/work/${'x'.repeat(200)}`, `/work/${'é'.repeat(200)}`, '/work/日本語のワークツリー名前', '/work/emoji-😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'];
    for (const root of roots) {
      const folder = devFolderName(root);
      expect(Buffer.byteLength(folder), root).toBeLessThanOrEqual(29);
      expect(folder, root).toMatch(/^[A-Za-z0-9._-]*-[0-9a-f]{8}$/);
      const socket = `/Users/${'u'.repeat(26)}/.cockpit-dev/${folder}/daemon-1-${'a'.repeat(12)}.sock`;
      expect(Buffer.byteLength(socket), root).toBeLessThanOrEqual(103);
    }
    // The longest name is reached with a long ASCII basename.
    expect(Buffer.byteLength(devFolderName(roots[0]!))).toBe(29);
  });
});
