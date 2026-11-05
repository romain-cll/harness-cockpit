import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readPullRequestStates } from '../src/renderer/components/pull-request-states';

// COCKPIT-75: when the sidebar reads the pull request states of one project. `window.api` is faked and the
// clock is fake: a timer that should not exist cannot hide behind real time.
//
// The contract these tests fix (the spec names the module, the hooks and the call, not the function tested here):
// - `readPullRequestStates(project, onStates)` calls `window.api.workspaces.pullRequestStates(project)` at once,
//   and returns `{ refresh(), stop() }` like `readPullRequests`; the hooks of the module are built on it;
// - a successful read is `{ status: 'read', states }`, `states` mapping a branch to `'open' | 'closed' | 'merged'`
//   (a branch with no pull request has none); `onStates` gets those `states` and nothing else;
// - a refusal or a rejection calls nothing: the rows keep the states they had.

const states = vi.fn();
const win = new EventTarget();

const read = (value: Record<string, 'open' | 'closed' | 'merged'>) => ({ status: 'read' as const, states: value });

beforeEach(() => {
  vi.useFakeTimers();
  states.mockReset();
  Object.assign(win, { api: { workspaces: { pullRequestStates: states } } });
  vi.stubGlobal('window', win);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('readPullRequestStates', () => {
  test('AC17 — reads the project at once, and gives onStates the states it answered', async () => {
    states.mockResolvedValue(read({ feat: 'open' }));
    const onStates = vi.fn();

    const reads = readPullRequestStates('/repo', onStates);
    await vi.advanceTimersByTimeAsync(0);

    expect(states).toHaveBeenCalledTimes(1);
    expect(states).toHaveBeenCalledWith('/repo');
    expect(onStates).toHaveBeenCalledTimes(1);
    expect(onStates).toHaveBeenLastCalledWith({ feat: 'open' });
    reads.stop();
  });

  test('AC17 — each window focus and each refresh() reads again', async () => {
    states.mockResolvedValue(read({ feat: 'open' }));
    const reads = readPullRequestStates('/repo', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveBeenCalledTimes(2);

    reads.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveBeenCalledTimes(3);
    reads.stop();
  });

  test('AC17 — one read at a time: requests made during a read trigger exactly one more, started when it ends', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    states.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(read({}));

    const reads = readPullRequestStates('/repo', vi.fn());
    reads.refresh();
    win.dispatchEvent(new Event('focus'));
    reads.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveBeenCalledTimes(1);

    first.resolve(read({ feat: 'open' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveBeenCalledTimes(2);

    second.resolve(read({ feat: 'merged' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveBeenCalledTimes(2);
    reads.stop();
  });

  test('AC17 — never on a timer: hours go by with no read', async () => {
    states.mockResolvedValue(read({ feat: 'open' }));
    const reads = readPullRequestStates('/repo', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    expect(states).toHaveBeenCalledTimes(1);
    reads.stop();
  });

  test('AC17 — after stop(), neither focus, refresh() nor an answer in flight does anything', async () => {
    const inFlight = deferred<unknown>();
    states.mockReturnValueOnce(inFlight.promise).mockResolvedValue(read({}));
    const onStates = vi.fn();
    const reads = readPullRequestStates('/repo', onStates);
    reads.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveBeenCalledTimes(1);

    reads.stop();
    inFlight.resolve(read({ feat: 'open' }));
    win.dispatchEvent(new Event('focus'));
    reads.refresh();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(states).toHaveBeenCalledTimes(1);
    expect(onStates).not.toHaveBeenCalled();
  });

  test('AC19 — a refusal or a rejection gives onStates nothing, so the rows keep the states they had, and the next focus reads again', async () => {
    states.mockResolvedValueOnce(read({ feat: 'merged' }));
    const onStates = vi.fn();
    const reads = readPullRequestStates('/repo', onStates);
    await vi.advanceTimersByTimeAsync(0);
    expect(onStates).toHaveBeenCalledTimes(1);

    states.mockResolvedValueOnce({ status: 'refused', message: 'gh is not logged in. Run gh auth login in a terminal.' });
    reads.refresh();
    await vi.advanceTimersByTimeAsync(0);
    states.mockRejectedValueOnce(new Error('Error invoking remote method'));
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveBeenCalledTimes(3);
    expect(onStates).toHaveBeenCalledTimes(1);

    states.mockResolvedValueOnce(read({ feat: 'open' }));
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onStates).toHaveBeenLastCalledWith({ feat: 'open' });
    reads.stop();
  });
});
