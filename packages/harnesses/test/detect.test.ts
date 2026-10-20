import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { detectHarnesses } from '../src/index';

// Drives the real detection on stub binaries (`#!/bin/sh` scripts) written to
// temporary folders under os.tmpdir(). No real CLI is ever run.

vi.setConfig({ testTimeout: 30_000 });

const created: string[] = [];
const leftoverPids: number[] = [];

afterEach(async () => {
  for (const pid of leftoverPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temporary folder, resolved to its real path (macOS `/var` is `/private/var`). */
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-harnesses-')));
  created.push(dir);
  return dir;
}

/** Writes an executable `#!/bin/sh` stub named `name` in `dir` and returns its path. */
async function stub(dir: string, name: string, body: string, mode = 0o755): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, mode);
  return file;
}

/** A folder holding the three stubs of AC7. */
async function allStubs(): Promise<string> {
  const dir = await tempDir();
  await stub(dir, 'claude', 'echo "2.1.304 (Claude Code)"');
  await stub(dir, 'codex', 'echo "codex-cli 0.163.0"');
  await stub(dir, 'opencode', 'echo "opencode v2.0.31"');
  return dir;
}

describe('detectHarnesses', () => {
  test('AC7 — reports the three stubs with absolute paths and parsed versions, in catalogue order', async () => {
    const dir = await allStubs();
    expect(await detectHarnesses({ PATH: dir })).toEqual([
      { id: 'claude-code', path: join(dir, 'claude'), version: '2.1.304' },
      { id: 'codex', path: join(dir, 'codex'), version: '0.163.0' },
      { id: 'opencode', path: join(dir, 'opencode'), version: '2.0.31' },
    ]);
  });

  test('AC8 — only the harnesses whose binary is on PATH are reported', async () => {
    const dir = await tempDir();
    await stub(dir, 'codex', 'echo "codex-cli 0.163.0"');
    expect(await detectHarnesses({ PATH: dir })).toEqual([
      { id: 'codex', path: join(dir, 'codex'), version: '0.163.0' },
    ]);
  });

  test('AC8 — an env with no PATH or an empty PATH reports nothing', async () => {
    expect(await detectHarnesses({})).toEqual([]);
    expect(await detectHarnesses({ PATH: '' })).toEqual([]);
  });

  test('AC9 — the first directory holding the binary wins', async () => {
    const first = await tempDir();
    const second = await tempDir();
    await stub(first, 'claude', 'echo "1.0.0"');
    await stub(second, 'claude', 'echo "9.9.9"');
    expect(await detectHarnesses({ PATH: `${first}:${second}` })).toEqual([
      { id: 'claude-code', path: join(first, 'claude'), version: '1.0.0' },
    ]);
  });

  test('AC9 — a non-executable file is skipped', async () => {
    const first = await tempDir();
    const second = await tempDir();
    await stub(first, 'claude', 'echo "1.0.0"', 0o644);
    await stub(second, 'claude', 'echo "2.0.0"');
    expect(await detectHarnesses({ PATH: `${first}:${second}` })).toEqual([
      { id: 'claude-code', path: join(second, 'claude'), version: '2.0.0' },
    ]);
  });

  test('AC9 — a directory with the binary name is skipped', async () => {
    const first = await tempDir();
    const second = await tempDir();
    await mkdir(join(first, 'claude'), { mode: 0o755 });
    await stub(second, 'claude', 'echo "2.0.0"');
    expect(await detectHarnesses({ PATH: `${first}:${second}` })).toEqual([
      { id: 'claude-code', path: join(second, 'claude'), version: '2.0.0' },
    ]);
  });

  test('AC9 — an empty PATH entry and a relative PATH entry are skipped', async () => {
    // Both entries would resolve against the current directory, so run from a
    // folder that holds decoy stubs for them.
    const cwdDir = await tempDir();
    await stub(cwdDir, 'claude', 'echo "6.6.6"');
    await mkdir(join(cwdDir, 'rel'));
    await stub(join(cwdDir, 'rel'), 'claude', 'echo "7.7.7"');
    const real = await tempDir();
    await stub(real, 'claude', 'echo "2.0.0"');

    const previous = process.cwd();
    process.chdir(cwdDir);
    try {
      expect(await detectHarnesses({ PATH: `:rel:${real}` })).toEqual([
        { id: 'claude-code', path: join(real, 'claude'), version: '2.0.0' },
      ]);
      expect(await detectHarnesses({ PATH: ':rel' })).toEqual([]);
    } finally {
      process.chdir(previous);
    }
  });

  test('AC10 — a --version that exits 1 is not detected, whatever it prints', async () => {
    const dir = await tempDir();
    await stub(dir, 'codex', 'echo "Superset: codex not found in PATH"\nexit 1');
    await stub(dir, 'claude', 'echo "2.1.304 (Claude Code)"');
    expect(await detectHarnesses({ PATH: dir })).toEqual([
      { id: 'claude-code', path: join(dir, 'claude'), version: '2.1.304' },
    ]);
  });

  test('AC11 — a --version that never exits is abandoned at the timeout, with its process group killed', async () => {
    const dir = await tempDir();
    const pidFile = join(dir, 'pids');
    // The background child inherits the stub's stdout, so the pipe stays open.
    await stub(
      dir,
      'codex',
      `echo $$ > "${pidFile}"\n/bin/sleep 300 &\necho $! >> "${pidFile}"\nwait`,
    );

    const started = Date.now();
    const result = await detectHarnesses({ PATH: dir }, { timeoutMs: 2000 });
    const elapsed = Date.now() - started;

    expect(result).toEqual([]);
    expect(elapsed).toBeLessThan(5000);

    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    leftoverPids.push(...pids);

    const deadline = Date.now() + 3000;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (pids.some(alive) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pids.map(alive)).toEqual([false, false]);
  }, 15000);

  test('AC12 — a --version that exits 0 without a x.y.z version gives version null', async () => {
    const dir = await tempDir();
    await stub(dir, 'opencode', 'echo "no version to see here"');
    expect(await detectHarnesses({ PATH: dir })).toEqual([
      { id: 'opencode', path: join(dir, 'opencode'), version: null },
    ]);
  });

  test('AC13 — the stub runs with the env passed in', async () => {
    const dir = await tempDir();
    await stub(dir, 'claude', 'echo "$STUB_VERSION"');
    expect(await detectHarnesses({ PATH: dir, STUB_VERSION: '7.8.9' })).toEqual([
      { id: 'claude-code', path: join(dir, 'claude'), version: '7.8.9' },
    ]);
  });

  test('AC13 — an executable file that cannot be run is not detected and detection never rejects', async () => {
    const dir = await tempDir();
    // No shebang and not a binary: spawn fails.
    const broken = join(dir, 'codex');
    await writeFile(broken, 'this is not a program\n');
    await chmod(broken, 0o755);
    await stub(dir, 'claude', 'echo "2.1.304 (Claude Code)"');

    await expect(detectHarnesses({ PATH: dir })).resolves.toEqual([
      { id: 'claude-code', path: join(dir, 'claude'), version: '2.1.304' },
    ]);
    expect(existsSync(broken)).toBe(true);
  });
});
