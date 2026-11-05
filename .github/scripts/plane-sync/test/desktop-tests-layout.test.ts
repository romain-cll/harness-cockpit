import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

// COCKPIT-84: the desktop tests are one file per feature, each launching only the built app; the other
// launch modes live in `dev-server`, `packaged` and `launchd`. This file guards that layout. Like
// agents-md.test.ts it lives here because no package owns a repo-wide check, and it only reads files.

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const testFolder = join(repoRoot, 'apps', 'desktop', 'test');

/** Every `.ts` file under `apps/desktop/test`, as a path relative to that folder, sorted. */
function desktopFiles(): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path);
      } else if (entry.name.endsWith('.ts')) {
        found.push(relative(testFolder, path));
      }
    }
  };
  walk(testFolder);
  return found.sort();
}

const desktopTestFiles = () => desktopFiles().filter((file) => file.endsWith('.test.ts'));
const read = (file: string) => readFileSync(join(testFolder, file), 'utf8');

/** The modes' files: the only test files that may launch the dev server or the package. */
const MODE_FILES = ['built-app.test.ts', 'dev-server.test.ts', 'packaged.test.ts', 'launchd.test.ts'];

/** The five launches split off the shared session of the former catch-all file. */
const SPLIT_LAUNCHES = ['terminal.test.ts', 'projects.test.ts', 'workspaces.test.ts', 'workspace-scripts.test.ts', 'right-bar-ship.test.ts'];
/** Those split from the built app's mode block, which watched the frontmost app. */
const FROM_BUILT_APP = ['terminal.test.ts', 'projects.test.ts', 'workspaces.test.ts', 'workspace-scripts.test.ts'];

/** The text of each `afterAll(...)` call of a source: from its opening parenthesis to the matching one. */
function afterAllBlocks(source: string): string[] {
  const blocks: string[] = [];
  for (const match of source.matchAll(/\bafterAll\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let at = open; at < source.length; at++) {
      if (source[at] === '(') depth++;
      else if (source[at] === ')' && --depth === 0) {
        blocks.push(source.slice(open, at + 1));
        break;
      }
    }
  }
  return blocks;
}

describe('apps/desktop/test layout', () => {
  test('AC3 — app.test.ts does not exist and no *.test.ts is longer than 1,500 lines', () => {
    expect(existsSync(join(testFolder, 'app.test.ts')), 'app.test.ts exists').toBe(false);
    const tooLong = desktopTestFiles()
      .map((file) => ({ file, lines: read(file).split('\n').length - (read(file).endsWith('\n') ? 1 : 0) }))
      .filter(({ lines }) => lines > 1500)
      .map(({ file, lines }) => `${file}: ${lines} lines`);
    expect(tooLong).toEqual([]);
  });

  test('AC4 — no *.test.ts other than dev-server, packaged and launchd holds launchDev, launchPackaged, launchLaunchd or packagedAppDir', () => {
    const holding = desktopTestFiles()
      .filter((file) => !['dev-server.test.ts', 'packaged.test.ts', 'launchd.test.ts'].includes(file))
      .filter((file) => /\b(?:launchDev|launchPackaged|launchLaunchd|packagedAppDir)\b/.test(read(file)));
    expect(holding).toEqual([]);
  });

  test('AC5 — describeMode( is called exactly once in each of built-app, dev-server, packaged and launchd, and nowhere else', () => {
    // Comment lines and the definition of `describeMode` itself are not calls.
    const calls = (file: string) =>
      read(file)
        .split('\n')
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line) && !/\b(?:function|const|let)\s+describeMode\b/.test(line))
        .reduce((total, line) => total + (line.match(/\bdescribeMode\(/g) ?? []).length, 0);
    const counts = Object.fromEntries(desktopFiles().map((file) => [file, calls(file)]).filter(([, count]) => count !== 0));
    expect(counts).toEqual(Object.fromEntries(MODE_FILES.map((file) => [file, 1])));
  });

  test('AC7 — terminal, projects, workspaces, workspace-scripts and right-bar-ship call expectNoErrors(session) in an afterAll; the four split from the built app also check front.activated(session.pid) is false', () => {
    const missing: string[] = [];
    for (const file of SPLIT_LAUNCHES) {
      if (!existsSync(join(testFolder, file))) {
        missing.push(`${file}: does not exist`);
        continue;
      }
      const blocks = afterAllBlocks(read(file));
      if (!blocks.some((block) => /\bexpectNoErrors\(session\)/.test(block))) missing.push(`${file}: no afterAll calls expectNoErrors(session)`);
      const frontNotActivated = (block: string) => /expect\(await front\??\.activated\(session\.pid\)\)\.toBe\(false\)/.test(block);
      if (FROM_BUILT_APP.includes(file) && !blocks.some(frontNotActivated)) missing.push(`${file}: no afterAll checks front.activated(session.pid) is false`);
    }
    expect(missing).toEqual([]);
  });

  test('AC9 — no file of apps/desktop/test, nor AGENTS.md, names app.test.ts', () => {
    // `built-app.test.ts` ends with the same characters: only a whole file name counts.
    const names = /(?<![\w.-])app\.test\.ts/;
    const naming = desktopFiles()
      .filter((file) => names.test(read(file)))
      .map((file) => `apps/desktop/test/${file}`);
    if (names.test(readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8'))) naming.push('AGENTS.md');
    expect(naming).toEqual([]);
  });
});
