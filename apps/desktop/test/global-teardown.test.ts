import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import config from '../vitest.config';
import * as globalTeardown from './global-teardown';

// AC16: the vitest global teardown kills the daemons a failed test left behind. The stand-ins
// are detached processes that wait forever, started as the daemon entry is (`--cockpit-daemon`
// on the command line), so no real daemon is needed.

const folders: string[] = [];
const children: ChildProcess[] = [];
const exited = new WeakMap<ChildProcess, Promise<void>>();

afterEach(() => {
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

// A root named like the tests' own, with `h` inside as the tests' COCKPIT_HOME.
function makeRoot(prefix: 'cockpit-test-' | 'ck-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  folders.push(root);
  const home = join(root, 'h');
  mkdirSync(home);
  return { root, home };
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

async function runTeardown(): Promise<void> {
  const module = globalTeardown as { teardown?: () => unknown; default?: () => unknown };
  if (module.teardown) {
    await module.teardown();
    return;
  }
  const afterwards = await module.default?.();
  if (typeof afterwards === 'function') await afterwards();
}

describe('global teardown', () => {
  test('AC16 — vitest runs it as a global setup', () => {
    expect(config.test?.globalSetup).toContain('test/global-teardown.ts');
  });

  test('AC16 — kills a daemon whose .pid sits under a cockpit-* or ck-* root, a stopped one included, and leaves a process without the marker alone', async () => {
    const cockpit = makeRoot('cockpit-test-');
    const ck = makeRoot('ck-');
    const running = await standIn(['--cockpit-daemon', 'aaaa1111']);
    const stopped = await standIn(['--cockpit-daemon', 'bbbb2222']);
    const stranger = await standIn(['--something-else']);
    process.kill(stopped.pid!, 'SIGSTOP');
    pidFile(cockpit.home, 'daemon-1-aaaa1111.pid', running.pid!);
    pidFile(ck.root, 'daemon-1-bbbb2222.pid', stopped.pid!);
    pidFile(ck.home, 'daemon-1-cccc3333.pid', stranger.pid!);

    await runTeardown();

    expect(await hasExited(running), 'the running daemon is killed').toBe(true);
    expect(await hasExited(stopped), 'the stopped daemon is killed').toBe(true);
    expect(await hasExited(stranger, 500), 'a process that is not a Cockpit daemon is left alone').toBe(false);
    expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
  });

  test('AC16 — a stale pid, a garbage .pid file and a root without .pid files are ignored', async () => {
    const stale = makeRoot('cockpit-test-');
    makeRoot('ck-');
    const gone = await standIn(['--cockpit-daemon', 'dddd4444']);
    process.kill(gone.pid!, 'SIGKILL');
    await hasExited(gone);
    pidFile(stale.home, 'daemon-1-dddd4444.pid', gone.pid!);
    writeFileSync(join(stale.home, 'daemon-1-eeee5555.pid'), 'not a pid');

    await expect(runTeardown()).resolves.toBeUndefined();
  });
});
