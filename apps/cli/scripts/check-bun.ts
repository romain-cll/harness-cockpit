import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Bun that compiles the CLI is the one the root `packageManager` names: the exact `bun`
// devDependency of this package, which the lockfile pins. Whatever Bun runs the build script
// (this one is that binary), a version that differs fails the build before anything is compiled.
const { packageManager } = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
  packageManager: string;
};
const expected = packageManager.replace(/^bun@/, '');
const actual = process.versions.bun;

if (actual !== expected) {
  console.error(`The CLI must be compiled with Bun ${expected} (packageManager), but this is Bun ${actual}.`);
  process.exit(1);
}
