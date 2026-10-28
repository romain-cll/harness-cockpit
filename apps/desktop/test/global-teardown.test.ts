import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import config from '../vitest.config';
import { killDaemonsUnder, setup, teardown } from './global-teardown';
import { makeTestDir, RUN_ROOT_ENV } from './run-root';

// AC16: the vitest global setup makes one root for the run, and its teardown kills the daemons a
// failed test left behind under that root and removes it. The stand-ins are detached processes that
// wait forever, started as the daemon entry is (`--cockpit-daemon` on the command line), so no real
// daemon is needed. This file's own roots are made by hand, not under the run's root: they play the
// root of this run, and the root of another run.

const folders: string[] = [];
const children: ChildProcess[] = [];
const exited = new WeakMap<ChildProcess, Promise<void>>();
let savedRoot: string | undefined;

beforeEach(() => {
  savedRoot = process.env[RUN_ROOT_ENV];
});

afterEach(() => {
  // `setup` and `teardown` write the variable the real run's root is in.
  if (savedRoot === undefined) delete process.env[RUN_ROOT_ENV];
  else process.env[RUN_ROOT_ENV] = savedRoot;
  for (const child of children.splice(0)) {
    try {
      process.kill(child.pid!, 'SIGCONT');
      process.kill(child.pid!, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const script = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'standin-script-'));
  const file = join(dir, 'wait.mjs');
  writeFileSync(file, 'setInterval(() => {}, 1000);\n');
  return file;
})();

// A root as the setup makes them, with a test folder and `h` (the tests' COCKPIT_HOME) inside.
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ck-'));
  folders.push(root);
  const folder = join(root, 'd-test');
  const home = join(folder, 'h');
  mkdirSync(home, { recursive: true });
  return { root, folder, home };
}

async function standIn(args: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: 'ignore' });
  children.push(child);
  exited.set(child, new Promise((resolve) => child.once('exit', () => resolve())));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  // The command line is readable once the process has exec'ed.
  await sleep(100);
  return child;
}

const pidFile = (dir: string, name: string, pid: number) => writeFileSync(join(dir, name), String(pid));

const hasExited = async (child: ChildProcess, timeout = 5_000) =>
  Promise.race([exited.get(child)!.then(() => true), sleep(timeout).then(() => false)]);

const isAlive = (child: ChildProcess) => {
  try {
    process.kill(child.pid!, 0);
    return true;
  } catch {
    return false;
  }
};

describe('global setup and teardown', () => {
  test('AC16 — vitest runs it as a global setup', () => {
    expect(config.test?.globalSetup).toContain('test/global-teardown.ts');
  });

  test('AC16 — the run has one root, a ck-* folder of the temporary directory, and the test folders are made inside it with a socket path within 103 bytes', () => {
    const root = process.env[RUN_ROOT_ENV];
    expect(root, 'the global setup published the run\'s root').toBeTruthy();
    expect(root!.startsWith(join(tmpdir(), 'ck-'))).toBe(true);
    expect(existsSync(root!)).toBe(true);

    const folder = makeTestDir('d-');

    expect(folder.startsWith(`${root}/`)).toBe(true);
    const socket = join(folder, 'h', `daemon-1-${'a'.repeat(12)}.sock`);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
    rmSync(folder, { recursive: true, force: true });
  });

  test('AC16 — setup makes the root and the teardown removes it, with the daemons under it', async () => {
    setup();
    const root = process.env[RUN_ROOT_ENV]!;
    folders.push(root);
    expect(root.startsWith(join(tmpdir(), 'ck-'))).toBe(true);
    expect(root).not.toBe(savedRoot);
    expect(existsSync(root)).toBe(true);
    const home = join(root, 'd-test', 'h');
    mkdirSync(home, { recursive: true });
    const daemon = await standIn(['--cockpit-daemon', 'aaaa1111']);
    pidFile(home, 'daemon-1-aaaa1111.pid', daemon.pid!);

    teardown();

    expect(await hasExited(daemon), 'the daemon is killed').toBe(true);
    expect(existsSync(root), 'the root is removed').toBe(false);
  });

  test('AC16 — kills a daemon whose .pid sits under the root, a stopped one included, and leaves a process without the marker and a daemon under another root alone', async () => {
    const mine = makeRoot();
    const another = makeRoot();
    const running = await standIn(['--cockpit-daemon', 'aaaa1111']);
    const stopped = await standIn(['--cockpit-daemon', 'bbbb2222']);
    const stranger = await standIn(['--something-else']);
    const ofAnotherRun = await standIn(['--cockpit-daemon', 'cccc3333']);
    process.kill(stopped.pid!, 'SIGSTOP');
    pidFile(mine.home, 'daemon-1-aaaa1111.pid', running.pid!);
    pidFile(mine.folder, 'daemon-1-bbbb2222.pid', stopped.pid!);
    pidFile(mine.home, 'daemon-1-dddd4444.pid', stranger.pid!);
    pidFile(another.home, 'daemon-1-cccc3333.pid', ofAnotherRun.pid!);

    killDaemonsUnder(mine.root);

    expect(await hasExited(running), 'the running daemon is killed').toBe(true);
    expect(await hasExited(stopped), 'the stopped daemon is killed').toBe(true);
    expect(await hasExited(stranger, 500), 'a process that is not a Cockpit daemon is left alone').toBe(false);
    expect(isAlive(stranger)).toBe(true);
    expect(isAlive(ofAnotherRun), 'a daemon of another run is left alone').toBe(true);
  });

  test('AC16 — a stale pid, a garbage .pid file and a root without .pid files are ignored', async () => {
    const stale = makeRoot();
    const empty = makeRoot();
    const gone = await standIn(['--cockpit-daemon', 'dddd4444']);
    process.kill(gone.pid!, 'SIGKILL');
    await hasExited(gone);
    pidFile(stale.home, 'daemon-1-dddd4444.pid', gone.pid!);
    writeFileSync(join(stale.home, 'daemon-1-eeee5555.pid'), 'not a pid');

    expect(() => killDaemonsUnder(stale.root)).not.toThrow();
    expect(() => killDaemonsUnder(empty.root)).not.toThrow();
    expect(() => killDaemonsUnder(join(tmpdir(), 'ck-does-not-exist'))).not.toThrow();
  });
});
