import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const srcDir = join(import.meta.dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
  });
}

test('constraint — no source imports electron or anything from apps/', () => {
  const files = sources(srcDir);
  expect(files.length).toBeGreaterThan(0);

  const pattern = /(from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"`](electron(\/[^'"`]*)?|[^'"`]*\/apps\/[^'"`]*|@cockpit\/desktop)['"`]/;
  for (const file of files) expect(pattern.test(readFileSync(file, 'utf8')), file).toBe(false);
});

// COCKPIT-30: to the daemon, the state and the app the conversation id is an opaque string; only the adapters of
// `packages/harnesses` know where a harness puts it.
test('COCKPIT-30 AC5 — the hook field names session_id and sessionID are in no source of the daemon, the state or the desktop app, and the harness adapters read session_id', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  for (const folder of ['packages/daemon/src', 'packages/state/src', 'apps/desktop/src']) {
    const files = sources(join(root, folder));
    expect(files.length, folder).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/session_id|sessionID/);
  }
  expect(readFileSync(join(root, 'packages/harnesses/src/catalogue.ts'), 'utf8')).toContain('session_id');
});
