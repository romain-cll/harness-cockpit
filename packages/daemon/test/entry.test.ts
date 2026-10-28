import { readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { runDaemonEntry } from '../src/index';
import { makeHome, registerCleanup } from './helpers';

// AC21: the daemon entry (`<binary> daemon.js --cockpit-daemon <build>`) takes its build from the
// argument after the marker. `runDaemonEntry(argv, env, { stderr, exit })` is the logic of the
// entry in `apps/desktop/src/main/daemon.ts`, which only passes `process.argv`, `process.env`,
// `process.stderr` and `process.exit`; after calling `exit` it returns.

registerCleanup();

const usage = 'usage: cockpit daemon --cockpit-daemon <build>';

describe('the daemon entry started without --cockpit-daemon <build>', () => {
  test.each([
    ['no marker', ['/usr/bin/electron', '/app/daemon.js']],
    ['no argument at all', []],
    ['the marker and no build after it', ['/usr/bin/electron', '/app/daemon.js', '--cockpit-daemon']],
  ])('AC21 — %s: exit code 2, the usage on stderr and no daemon file', async (_label, argv) => {
    const home = makeHome();
    const written: string[] = [];
    const exits: number[] = [];

    await runDaemonEntry(argv, { COCKPIT_HOME: home }, { stderr: { write: (text: string) => written.push(text) }, exit: (code: number) => void exits.push(code) });

    expect(exits).toEqual([2]);
    expect(written.join('').trim()).toBe(usage);
    expect(readdirSync(home)).toEqual([]);
  });
});
