import { createHash } from 'node:crypto';
import { basename } from 'node:path';

// The folder an unpackaged build keeps its data in, under `~/.cockpit-dev`: `<prefix>-<hash>`, the
// worktree root's basename made of `[A-Za-z0-9._-]` and cut to 20 characters, then the first 8 hex
// characters of the SHA-256 of its path. At most 29 bytes, so the daemon's socket path fits the 103
// bytes macOS allows.
export function devFolderName(worktreeRoot: string): string {
  const prefix = basename(worktreeRoot).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 20);
  const hash = createHash('sha256').update(worktreeRoot).digest('hex').slice(0, 8);
  return `${prefix}-${hash}`;
}
