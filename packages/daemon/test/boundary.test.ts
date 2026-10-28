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
