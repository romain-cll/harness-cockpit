import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { UI_TIMEOUT, fifo, gonePipe, groupAlive, heldProcess, isAlive, launchBuilt, stopGroup, untilDom, waitForGroupGone, type Session } from './launch';

// COCKPIT-81 (part 0): the helpers of `launch.ts` that wait on events instead of polling. AC6 to AC8
// run real `/bin/sh` processes and FIFOs, no app; AC9 and AC10 share one built-app launch.
//
// The API these tests rely on (the helpers' contract):
// - `fifo()` returns `{ path, line() }`: a FIFO at `path`; `line()` resolves with the first line a
//   process writes to it, and stays pending until one does.
// - `heldProcess()` returns `{ snippet, release() }`: `snippet` is shell text that blocks until the
//   test calls `release()` (and then ends with status 0), for a stub or a `sh -c`.
// - `gonePipe()` returns `{ snippet, gone }`: `snippet` is shell text that makes the running shell hold
//   the write end of the pipe on a descriptor its children inherit; `gone` resolves once no process holds
//   it any more, and stays pending while one does.
// - `untilDom(page, predicate, arg)` resolves once `predicate(arg)` holds in the page, checked at once
//   and after each DOM mutation.
//
// The tests check that something is still pending only after an event ordered after the moment it
// could have settled (a process exit, a line on a FIFO), never after a pause.

// Records every use of Node's promise timers while a test watches for them. The wrapper passes the call through.
const timerPromiseCalls = vi.hoisted(() => [] as string[]);
vi.mock('node:timers/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...original,
    setTimeout: (...args: Parameters<typeof original.setTimeout>) => {
      timerPromiseCalls.push('timers/promises setTimeout');
      return Reflect.apply(original.setTimeout, original, args);
    },
    setInterval: (...args: Parameters<typeof original.setInterval>) => {
      timerPromiseCalls.push('timers/promises setInterval');
      return Reflect.apply(original.setInterval, original, args);
    },
  };
});

const sh = (script: string, detached = false): ChildProcess => spawn('/bin/sh', ['-c', script], { detached, stdio: ['ignore', 'pipe', 'ignore'] });

/** True when the promise has not settled yet (a microtask turn after the event the caller awaited). */
const stillPending = (promise: Promise<unknown>): Promise<boolean> => Promise.race([promise.then(() => false, () => false), Promise.resolve(true)]);

describe('stopGroup', () => {
  test('AC6 — resolves only once the child and its SIGTERM-ignoring background child, which holds its stdout, are gone, sets no timer and sends the background child SIGKILL', async () => {
    const held = heldProcess();
    // The background child ignores SIGTERM and holds the child's stdout; the child ends on SIGTERM.
    const child = sh(`( trap '' TERM; ${held.snippet} ) & echo $!; wait`, true);
    const [chunk] = (await once(child.stdout!, 'data')) as [Buffer];
    const background = Number(String(chunk).trim());
    expect(isAlive(background)).toBe(true);

    const timers = [vi.spyOn(globalThis, 'setTimeout'), vi.spyOn(globalThis, 'setInterval')];
    const signals: string[] = [];
    const realKill = process.kill.bind(process);
    const kills = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      signals.push(String(signal));
      return realKill(pid, signal);
    }) as typeof process.kill);
    timerPromiseCalls.length = 0;
    try {
      await stopGroup(child);
    } finally {
      kills.mockRestore();
      for (const timer of timers) timer.mockRestore();
    }

    expect(isAlive(child.pid!)).toBe(false);
    expect(isAlive(background)).toBe(false);
    expect(groupAlive(child.pid!)).toBe(false);
    expect(signals).toContain('SIGKILL');
    expect(timers.map((timer) => timer.mock.calls.length)).toEqual([0, 0]);
    expect(timerPromiseCalls).toEqual([]);
  });
});

describe('waitForGroupGone', () => {
  test('part 1 review note — rejects for a pid no launch started, instead of returning at once as if the group were gone', async () => {
    const held = heldProcess();
    // A child of the test that no launch started: nothing tells when its group is gone.
    const child = sh(held.snippet, true);
    try {
      await expect(waitForGroupGone(child.pid!)).rejects.toThrow();
      // It was still running: returning at once would have been a lie.
      expect(groupAlive(child.pid!)).toBe(true);
    } finally {
      await held.release();
      await once(child, 'exit');
    }
  });
});

describe('fifo and heldProcess', () => {
  test('AC7 — fifo().line() stays pending until a shell command writes a line to it, then resolves with it', async () => {
    const pipe = fifo();
    const line = pipe.line();
    const witness = sh('true');
    await once(witness, 'exit');
    expect(await stillPending(line)).toBe(true);

    sh(`echo hello world > '${pipe.path}'`);
    expect(await line).toBe('hello world');
  });

  test('AC7 — a held process stays running until it is released, then exits 0', async () => {
    const up = fifo();
    const held = heldProcess();
    const child = sh(`echo up > '${up.path}'; ${held.snippet}`);
    const exited = once(child, 'exit') as Promise<[number | null, string | null]>;
    await up.line();
    expect(child.exitCode).toBeNull();
    expect(await stillPending(exited)).toBe(true);

    await held.release();
    const [code] = await exited;
    expect(code).toBe(0);
  });
});

describe('gonePipe', () => {
  test('AC8 — gone stays pending while one holder lives, and resolves once the process and the child it passed the descriptor to are killed', async () => {
    const pipe = gonePipe();
    const up = fifo();
    const parent = heldProcess();
    const background = heldProcess();
    // The shell holds the pipe, its background child inherits it, then the shell is held too.
    const child = sh(`${pipe.snippet}; ( ${background.snippet} ) & echo up > '${up.path}'; ${parent.snippet}`, true);
    await up.line();
    expect(await stillPending(pipe.gone)).toBe(true);

    // The shell dies; the background child still holds the descriptor.
    process.kill(child.pid!, 'SIGKILL');
    await once(child, 'exit');
    expect(await stillPending(pipe.gone)).toBe(true);

    // The last holder ends.
    await background.release();
    await pipe.gone;
  });
});

describe('with the built app', () => {
  let session: Session;

  beforeAll(async () => {
    session = await launchBuilt();
  });

  afterAll(async () => {
    await session?.close();
  });

  test('AC9 — untilDom resolves once the predicate holds after a DOM mutation, with a MutationObserver and no polling interval', async () => {
    const { page } = session;
    await page.evaluate(() => {
      const probe = { observed: 0, intervals: 0 };
      (window as unknown as { __untilDomProbe: typeof probe }).__untilDomProbe = probe;
      const observe = MutationObserver.prototype.observe;
      MutationObserver.prototype.observe = function (this: MutationObserver, ...args: Parameters<MutationObserver['observe']>) {
        probe.observed++;
        return observe.apply(this, args);
      };
      const interval = window.setInterval;
      window.setInterval = ((...args: Parameters<typeof window.setInterval>) => {
        probe.intervals++;
        return interval.apply(window, args);
      }) as typeof window.setInterval;
      // The element the helper waits for appears 300 ms from now.
      setTimeout(() => {
        const element = document.createElement('div');
        element.id = 'until-dom-probe';
        document.body.append(element);
      }, 300);
    });

    await untilDom(page, (id: string) => document.getElementById(id) !== null, 'until-dom-probe');

    expect(await page.locator('#until-dom-probe').count()).toBe(1);
    const probe = await page.evaluate(() => (window as unknown as { __untilDomProbe: { observed: number; intervals: number } }).__untilDomProbe);
    expect(probe.observed).toBeGreaterThan(0);
    expect(probe.intervals).toBe(0);
  });

  test('AC10 — clicking a locator that matches nothing, with no timeout option, rejects with a TimeoutError and the locator call log after the default action timeout', async () => {
    const error = await session.page.getByRole('button', { name: 'no such button, ever' }).click().then(
      () => undefined,
      (failure: unknown) => failure as Error,
    );
    expect(error?.name).toBe('TimeoutError');
    expect(error?.message).toContain(`Timeout ${UI_TIMEOUT}ms exceeded`);
    expect(error?.message).toContain('Call log');
    expect(error?.message).toContain('no such button, ever');
  });
});
