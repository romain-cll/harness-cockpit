import { closeSync, constants, openSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { connectDaemon, daemonFiles, reportReady, runDaemonEntry } from '../src/index';
import { BUILD, exists, makeHome, OTHER_BUILD, registerCleanup, fifo } from './helpers';

// AC21: the daemon entry (`<binary> daemon.js --cockpit-daemon <build>`) takes its build from the
// argument after the marker. `runDaemonEntry(argv, env, { stderr, exit, ready })` is the logic of the
// entry in `apps/desktop/src/main/daemon.ts`, which only passes `process.argv`, `process.env`,
// `process.stderr`, `process.exit` and `reportReady`; after calling `exit` it returns.

registerCleanup();

const usage = 'usage: cockpit daemon --cockpit-daemon <build>';

/** The io of an entry run: what it wrote, the codes it exited with, and `ready` (called by the entry once the daemon is up) recorded by `onReady`. */
function entryIo(onReady: () => void = () => {}) {
  const written: string[] = [];
  const exits: number[] = [];
  const readyCalls: number[] = [];
  let exited!: () => void;
  const exitedOnce = new Promise<void>((resolve) => (exited = resolve));
  const io = {
    stderr: { write: (text: string) => written.push(text) },
    exit: (code: number) => {
      exits.push(code);
      exited();
    },
    ready: () => {
      readyCalls.push(readyCalls.length);
      onReady();
    },
  };
  return { io, written, exits, readyCalls, exitedOnce };
}

describe('the daemon entry started without --cockpit-daemon <build>', () => {
  test.each([
    ['no marker', ['/usr/bin/electron', '/app/daemon.js']],
    ['no argument at all', []],
    ['the marker and no build after it', ['/usr/bin/electron', '/app/daemon.js', '--cockpit-daemon']],
  ])('AC21 — %s: exit code 2, the usage on stderr, no daemon file and never ready (AC4)', async (_label, argv) => {
    const home = makeHome();
    const { io, written, exits, readyCalls } = entryIo();

    await runDaemonEntry(argv, { COCKPIT_HOME: home }, io);

    expect(exits).toEqual([2]);
    expect(written.join('').trim()).toBe(usage);
    expect(readdirSync(home)).toEqual([]);
    expect(readyCalls).toEqual([]);
  });
});

describe('the daemon entry reports ready (AC4)', () => {
  test('AC4 — with a valid build and home it reports ready once .token and .pid are on disk, and a client connects at its first attempt', async () => {
    const home = makeHome();
    const files = daemonFiles(home, 1, BUILD);
    let onDisk: boolean[] = [];
    let connecting: ReturnType<typeof connectDaemon> | undefined;
    const { io, readyCalls, exitedOnce } = entryIo(() => {
      onDisk = [exists(files.token), exists(files.pid)];
      connecting = connectDaemon(files.socket);
    });

    await runDaemonEntry(['/usr/bin/electron', '/app/daemon.js', '--cockpit-daemon', BUILD], { COCKPIT_HOME: home }, io);
    // Another build asks for the daemon: it is empty, so it closes itself and the entry exits (this is also the cleanup).
    const stopper = await connectDaemon(files.socket);
    await stopper.hello(OTHER_BUILD);
    stopper.close();
    await exitedOnce;

    expect(readyCalls).toHaveLength(1);
    expect(onDisk).toEqual([true, true]);
    const client = await connecting!;
    client.close();
  });

  test('AC4 — a start that fails (home is a regular file) never reports ready and exits with 1 and the reason on stderr', async () => {
    const home = join(makeHome(), 'a-file');
    writeFileSync(home, '');
    const { io, written, exits, readyCalls } = entryIo();

    await runDaemonEntry(['/usr/bin/electron', '/app/daemon.js', '--cockpit-daemon', BUILD], { COCKPIT_HOME: home }, io);

    expect(exits).toEqual([1]);
    expect(written.join('')).toContain(home);
    expect(readyCalls).toEqual([]);
  });
});

describe('reportReady (AC5)', () => {
  test('AC5 — a file descriptor that is unusable (the starter is gone) throws nothing', () => {
    const pipe = fifo();
    const fd = openSync(pipe.path, constants.O_RDWR);
    closeSync(fd);

    expect(() => reportReady(fd)).not.toThrow();
  });
});
