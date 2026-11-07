import { type Frame } from 'playwright-core';
import { describe, expect, test } from 'vitest';
import { evaluateUntil, reportFailedWaits } from './launch';

// COCKPIT-90: what the failure report does with a task and a page it cannot or must not read. No app: a fake `Frame`
// whose first `evaluate` is the wait itself (it stays pending until `release()`), and whose later calls are the
// reads the report makes. `reportFailedWaits(task)` is the body of the `afterEach` of `launch.ts`: it appends to
// `task.result.errors[0].message` and resolves.

function fakeFrame(reads: 'answer' | 'reject') {
  let release = () => {};
  const calls: unknown[] = [];
  const evaluate = (script: unknown) => {
    calls.push(script);
    if (calls.length === 1) return new Promise<void>((resolve) => (release = resolve));
    // 'answer': the page reads fine, whatever the report asks (an empty page dump).
    return reads === 'reject' ? Promise.reject(new Error('Target page, context or browser has been closed')) : Promise.resolve({ tabs: [], terminals: [], connected: [false] });
  };
  const frame: { evaluate: typeof evaluate; page(): unknown } = { evaluate, page: () => page };
  const page = { evaluate, mainFrame: () => frame, isClosed: () => reads === 'reject' };
  return { frame: frame as unknown as Frame, calls, release: () => release() };
}

// The wait registers synchronously: the fake's first `evaluate` call is its own script.
const startWait = (frame: Frame) => evaluateUntil(frame, () => false, 'a row', () => 'wait');

const task = (state: string, message?: string) => {
  const error = message === undefined ? undefined : { message };
  return { error, task: { result: { state, errors: error ? [error] : undefined } } as never };
};

describe('reportFailedWaits', () => {
  test('AC5 — a test that passed leaves its result unchanged and reads nothing from the page', async () => {
    const fake = fakeFrame('answer');
    const wait = startWait(fake.frame);
    const passed = task('pass');
    await reportFailedWaits(passed.task);
    expect((passed.task as { result: unknown }).result).toEqual({ state: 'pass', errors: undefined });
    expect(fake.calls).toHaveLength(1);
    fake.release();
    await wait;
  });

  test('AC5 — a failed test with no wait running keeps its error as it is', async () => {
    const failed = task('fail', 'boom');
    await reportFailedWaits(failed.task);
    expect(failed.error!.message).toBe('boom');
  });

  test('AC6 — a page that is gone: the report resolves, the test\'s own error stays first and the unreadable sources are reported', async () => {
    const fake = fakeFrame('reject');
    const wait = startWait(fake.frame);
    const failed = task('fail', 'boom');
    await reportFailedWaits(failed.task);
    expect(failed.error!.message.startsWith('boom')).toBe(true);
    expect(failed.error!.message).toContain('  tabs, terminals and waited elements: unreadable');
    fake.release();
    await wait;
  });

  test('AC6 — an app with no daemon socket (a page no launch registered): the report resolves, the test\'s own error stays first and the unreadable source is reported', async () => {
    const fake = fakeFrame('answer');
    const wait = startWait(fake.frame);
    const failed = task('fail', 'boom');
    await reportFailedWaits(failed.task);
    const message = failed.error!.message;
    expect(message.startsWith('boom')).toBe(true);
    expect(message).toContain("  daemon's screens: unreadable");
    // The page answered: only the daemon is reported unreadable.
    expect(message).toContain('  terminals (.xterm):');
    expect(message).not.toContain('tabs, terminals and waited elements: unreadable');
    fake.release();
    await wait;
  });
});
