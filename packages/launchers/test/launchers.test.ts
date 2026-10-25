import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { apps } from '../src/catalogue';
import { defaultApplicationDirs, detectApps, LaunchError, openIn, reveal } from '../src/index';

// Detection runs on temporary folders holding fake bundles, and the `open` runs against a
// `#!/bin/sh` stub named `open` on a temporary `PATH`. The real `open` never runs.

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temporary folder, resolved to its real path (macOS `/var` is `/private/var`). */
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-launchers-')));
  created.push(dir);
  return dir;
}

describe('catalogue', () => {
  test('AC11 — lists the editors then the terminals, in catalogue order', () => {
    expect(apps.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual([
      { id: 'vscode', name: 'Visual Studio Code', kind: 'editor' },
      { id: 'cursor', name: 'Cursor', kind: 'editor' },
      { id: 'zed', name: 'Zed', kind: 'editor' },
      { id: 'terminal', name: 'Terminal', kind: 'terminal' },
      { id: 'iterm2', name: 'iTerm2', kind: 'terminal' },
      { id: 'ghostty', name: 'Ghostty', kind: 'terminal' },
      { id: 'warp', name: 'Warp', kind: 'terminal' },
    ]);
  });

  // Every attempt runs in strict mode (an ES module): a write to a frozen object throws.
  test('AC11 — the catalogue is frozen: a push, an assignment and an added field throw a TypeError', () => {
    const list = apps as unknown as { id: string; extra?: string }[];
    expect(() => list.push({ id: 'other' })).toThrow(TypeError);
    expect(() => {
      list[0]!.id = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      list[0]!.extra = 'added';
    }).toThrow(TypeError);
    expect(apps.map(({ id }) => id)).toEqual(['vscode', 'cursor', 'zed', 'terminal', 'iterm2', 'ghostty', 'warp']);
  });
});

describe('defaultApplicationDirs', () => {
  test('AC11 — /Applications, the home Applications folder, then /System/Applications/Utilities', () => {
    expect(defaultApplicationDirs('/Users/someone')).toEqual([
      '/Applications',
      '/Users/someone/Applications',
      '/System/Applications/Utilities',
    ]);
  });
});

describe('detectApps', () => {
  test('AC11 — finds the bundles named after the catalogue, with their absolute path, in catalogue order', async () => {
    const dir = await tempDir();
    // Created in an order unlike the catalogue's; iTerm2's bundle is iTerm.app.
    for (const bundle of ['Warp.app', 'iTerm.app', 'Zed.app', 'Visual Studio Code.app', 'Terminal.app', 'Cursor.app', 'Ghostty.app']) {
      await mkdir(join(dir, bundle));
    }
    expect(await detectApps([dir])).toEqual([
      { id: 'vscode', path: join(dir, 'Visual Studio Code.app') },
      { id: 'cursor', path: join(dir, 'Cursor.app') },
      { id: 'zed', path: join(dir, 'Zed.app') },
      { id: 'terminal', path: join(dir, 'Terminal.app') },
      { id: 'iterm2', path: join(dir, 'iTerm.app') },
      { id: 'ghostty', path: join(dir, 'Ghostty.app') },
      { id: 'warp', path: join(dir, 'Warp.app') },
    ]);
  });

  test('AC11 — reports only the apps that are there', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'Cursor.app'));
    await mkdir(join(dir, 'Ghostty.app'));
    await mkdir(join(dir, 'Slack.app'));
    expect((await detectApps([dir])).map(({ id }) => id)).toEqual(['cursor', 'ghostty']);
  });

  test('AC11 — nothing found gives an empty list, for empty folders and for no folder', async () => {
    expect(await detectApps([await tempDir()])).toEqual([]);
    expect(await detectApps([])).toEqual([]);
  });

  test('AC11 — the first folder holding an app wins; the others still contribute their own apps', async () => {
    const first = await tempDir();
    const second = await tempDir();
    await mkdir(join(first, 'Cursor.app'));
    await mkdir(join(second, 'Cursor.app'));
    await mkdir(join(second, 'Zed.app'));
    expect(await detectApps([first, second])).toEqual([
      { id: 'cursor', path: join(first, 'Cursor.app') },
      { id: 'zed', path: join(second, 'Zed.app') },
    ]);
  });

  test('AC11 — a folder that does not exist is skipped', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'Zed.app'));
    expect(await detectApps([join(dir, 'missing'), dir])).toEqual([{ id: 'zed', path: join(dir, 'Zed.app') }]);
  });

  test('AC11 — a regular file named like a bundle is ignored', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'Cursor.app'), 'not a bundle');
    await mkdir(join(dir, 'Zed.app'));
    expect(await detectApps([dir])).toEqual([{ id: 'zed', path: join(dir, 'Zed.app') }]);
  });

  test('AC11 — a symlink to a directory counts as a bundle', async () => {
    const dir = await tempDir();
    const elsewhere = await tempDir();
    await mkdir(join(elsewhere, 'real-cursor'));
    await symlink(join(elsewhere, 'real-cursor'), join(dir, 'Cursor.app'));
    expect(await detectApps([dir])).toEqual([{ id: 'cursor', path: join(dir, 'Cursor.app') }]);
  });

  test('AC11 — it only looks: the folders are left as they were', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'Cursor.app'));
    await detectApps([dir]);
    expect(readdirSync(dir)).toEqual(['Cursor.app']);
  });
});

describe('reveal and openIn', () => {
  /** A folder holding a stub `open` that logs its arguments, one per line, and `$LAUNCH_TEST` apart. */
  async function stubOpen(body = ''): Promise<{ bin: string; log: string; envLog: string }> {
    const bin = await tempDir();
    const log = join(bin, 'args.log');
    const envLog = join(bin, 'env.log');
    await writeFile(
      join(bin, 'open'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nprintf '%s' "$LAUNCH_TEST" > '${envLog}'\n${body}\n`,
    );
    await chmod(join(bin, 'open'), 0o755);
    return { bin, log, envLog };
  }

  const argv = (log: string) => readFileSync(log, 'utf8').split('\n').filter(Boolean);

  test('AC3, AC11 — reveal runs open -R <path> and resolves on exit 0', async () => {
    const { bin, log } = await stubOpen();
    await reveal('/work/tree', { env: { PATH: bin } });
    expect(argv(log)).toEqual(['-R', '/work/tree']);
  });

  test('AC4, AC11 — openIn runs open -a <bundle path> <path> and resolves on exit 0', async () => {
    const { bin, log } = await stubOpen();
    await openIn('/Applications/Cursor.app', '/work/tree', { env: { PATH: bin } });
    expect(argv(log)).toEqual(['-a', '/Applications/Cursor.app', '/work/tree']);
  });

  test('AC11 — the run uses the env it is given, to find open and for the child', async () => {
    const { bin, envLog } = await stubOpen();
    await reveal('/work/tree', { env: { PATH: bin, LAUNCH_TEST: 'from-the-caller' } });
    expect(readFileSync(envLog, 'utf8')).toBe('from-the-caller');
  });

  test('AC11 — no shell: a path with spaces and $(…) is one argument and nothing is expanded', async () => {
    const { bin, log } = await stubOpen();
    const dir = await tempDir();
    const path = `${dir}/my project $(touch ${dir}/pwned) \`touch ${dir}/pwned2\``;
    const bundle = `${dir}/Some App $(touch ${dir}/pwned3).app`;

    await reveal(path, { env: { PATH: bin } });
    await openIn(bundle, path, { env: { PATH: bin } });

    expect(argv(log)).toEqual(['-R', path, '-a', bundle, path]);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });

  test.each([
    ['reveal', (env: NodeJS.ProcessEnv) => reveal('/work/tree', { env })],
    ['openIn', (env: NodeJS.ProcessEnv) => openIn('/Applications/Zed.app', '/work/tree', { env })],
  ])('AC8, AC11 — %s rejects with a LaunchError whose message is the trimmed stderr when open exits non-zero', async (_name, run) => {
    const { bin } = await stubOpen(`printf '  The file does not exist.\\n\\n' >&2\nexit 1`);
    const error = await run({ PATH: bin }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LaunchError);
    expect((error as Error).message).toBe('The file does not exist.');
  });

  test.each([
    ['reveal', (env: NodeJS.ProcessEnv) => reveal('/work/tree', { env })],
    ['openIn', (env: NodeJS.ProcessEnv) => openIn('/Applications/Zed.app', '/work/tree', { env })],
  ])('AC8, AC11 — %s rejects with "open exited with code <n>" when stderr is empty', async (_name, run) => {
    const { bin } = await stubOpen('exit 7');
    const error = await run({ PATH: bin }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LaunchError);
    expect((error as Error).message).toBe('open exited with code 7');
  });

  test('AC8, AC11 — a stderr of whitespace only counts as empty', async () => {
    const { bin } = await stubOpen(`printf ' \\n' >&2\nexit 2`);
    const error = await reveal('/work/tree', { env: { PATH: bin } }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('open exited with code 2');
  });

  test('AC8, AC11 — with no open on PATH, it rejects with a LaunchError carrying the spawn error message', async () => {
    const empty = await tempDir();
    const error = await reveal('/work/tree', { env: { PATH: empty } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LaunchError);
    expect((error as Error).message).toContain('ENOENT');
  });
});

describe('the package stays out of electron', () => {
  const packageDir = join(import.meta.dirname, '..');

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
    });
  }

  test('AC11 — no source imports or requires electron', () => {
    const files = sources(join(packageDir, 'src'));
    expect(files.map((f) => basename(f)).sort()).toEqual(expect.arrayContaining(['catalogue.ts', 'index.ts']));

    const pattern = /(from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"`]electron(\/[^'"`]*)?['"`]/;
    for (const file of files) {
      expect(pattern.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });

  test('AC11 — package.json is @cockpit/launchers, lists electron in no dependency field and no runtime dependency', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.name).toBe('@cockpit/launchers');
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const names = Object.keys((manifest[field] as object | undefined) ?? {});
      expect(names, field).not.toContain('electron');
    }
    expect(Object.keys((manifest.dependencies as object | undefined) ?? {})).toEqual([]);
  });
});
