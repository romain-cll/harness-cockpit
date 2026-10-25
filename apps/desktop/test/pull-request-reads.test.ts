import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readPullRequests } from '../src/renderer/components/pull-request-reads';

// COCKPIT-38: when the Changes sidebar reads the branch's pull request. `window.api` is faked and the
// clock is fake: the 30 s poll cannot wait for real.
//
// The contract these tests fix (the spec leaves the shape of `PullRequestResult` open):
// - `readPullRequests(project, path, onResult)` calls `window.api.workspaces.pullRequest(project, path)`
//   at once, passes the object that call resolves to `onResult`, and returns `{ refresh(), stop() }`;
// - a successful read is `{ status: 'read', pullRequest: PullRequest | null }`, any other `status`
//   (`refused`, a `gh` failure) is not a pull request and is never polled;
// - `pullRequest.state` is `'open' | 'closed' | 'merged'` and `pullRequest.checks` is `'none' | 'pending'
//   | 'passing' | 'failing' | 'unknown'`.

const POLL_MS = 30_000;

type Checks = 'none' | 'pending' | 'passing' | 'failing' | 'unknown';
type State = 'open' | 'closed' | 'merged';

const read = (state: State, checks: Checks) => ({
  status: 'read' as const,
  pullRequest: { number: 7, title: 'Fix the bug', url: 'https://github.test/acme/app/pull/7', state, checks },
});

const win = new EventTarget();
const pullRequest = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  pullRequest.mockReset();
  Object.assign(win, { api: { workspaces: { pullRequest } } });
  vi.stubGlobal('window', win);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A read that resolves when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('readPullRequests: when it reads', () => {
  test('AC3 — reads at once, and gives onResult what the read resolved to', async () => {
    const result = read('open', 'passing');
    pullRequest.mockResolvedValue(result);
    const onResult = vi.fn();

    const reads = readPullRequests('/repo', '/wt', onResult);
    await vi.advanceTimersByTimeAsync(0);

    expect(pullRequest).toHaveBeenCalledTimes(1);
    expect(pullRequest).toHaveBeenCalledWith('/repo', '/wt');
    expect(onResult).toHaveBeenLastCalledWith(result);
    reads.stop();
  });

  test('AC3 — at most one read runs at a time: refresh() during a read queues exactly one more, started when the first ends', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    pullRequest.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(read('open', 'passing'));

    const reads = readPullRequests('/repo', '/wt', vi.fn());
    reads.refresh();
    reads.refresh();
    reads.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(pullRequest).toHaveBeenCalledTimes(1);

    first.resolve(read('open', 'passing'));
    await vi.advanceTimersByTimeAsync(0);
    expect(pullRequest).toHaveBeenCalledTimes(2);

    // The queued read is the last one: nothing else follows it.
    second.resolve(read('open', 'passing'));
    await vi.advanceTimersByTimeAsync(0);
    expect(pullRequest).toHaveBeenCalledTimes(2);
    reads.stop();
  });

  test('AC3 — refresh() with nothing running reads at once', async () => {
    pullRequest.mockResolvedValue(read('open', 'passing'));
    const reads = readPullRequests('/repo', '/wt', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    reads.refresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(pullRequest).toHaveBeenCalledTimes(2);
    reads.stop();
  });

  test('AC3 — the window gaining focus triggers a read', async () => {
    pullRequest.mockResolvedValue(read('open', 'passing'));
    const reads = readPullRequests('/repo', '/wt', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(pullRequest).toHaveBeenCalledTimes(2);
    reads.stop();
  });

  test('AC3 — after stop(), neither focus, refresh() nor time starts a read', async () => {
    pullRequest.mockResolvedValue(read('open', 'pending'));
    const reads = readPullRequests('/repo', '/wt', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(pullRequest).toHaveBeenCalledTimes(1);

    reads.stop();
    win.dispatchEvent(new Event('focus'));
    reads.refresh();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);

    expect(pullRequest).toHaveBeenCalledTimes(1);
  });
});

describe('readPullRequests: the CI poll', () => {
  test('AC4 — an open pull request with pending checks is read again every 30 s', async () => {
    pullRequest.mockResolvedValue(read('open', 'pending'));
    const reads = readPullRequests('/repo', '/wt', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(pullRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pullRequest).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(pullRequest).toHaveBeenCalledTimes(3);
    reads.stop();
  });

  test('AC4 — polling stops once the checks are no longer pending', async () => {
    pullRequest.mockResolvedValueOnce(read('open', 'pending')).mockResolvedValue(read('open', 'passing'));
    const reads = readPullRequests('/repo', '/wt', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(pullRequest).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(pullRequest).toHaveBeenCalledTimes(2);
    reads.stop();
  });

  test('AC4 — polling stops once the pull request is no longer open', async () => {
    pullRequest.mockResolvedValueOnce(read('open', 'pending')).mockResolvedValue(read('merged', 'pending'));
    const reads = readPullRequests('/repo', '/wt', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(pullRequest).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(pullRequest).toHaveBeenCalledTimes(2);
    reads.stop();
  });

  test('AC4 — stop() ends the polling', async () => {
    pullRequest.mockResolvedValue(read('open', 'pending'));
    const reads = readPullRequests('/repo', '/wt', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    reads.stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);

    expect(pullRequest).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['unknown checks', read('open', 'unknown')],
    ['passing checks', read('open', 'passing')],
    ['failing checks', read('open', 'failing')],
    ['no check', read('open', 'none')],
    ['a merged pull request', read('merged', 'pending')],
    ['a closed pull request', read('closed', 'pending')],
    ['no pull request', { status: 'read', pullRequest: null }],
    ['a refusal', { status: 'refused', message: 'gh is not logged in. Run gh auth login in a terminal.' }],
  ])('AC4b — %s is not polled', async (_label, result) => {
    pullRequest.mockResolvedValue(result);
    const reads = readPullRequests('/repo', '/wt', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(POLL_MS * 4);

    expect(pullRequest).toHaveBeenCalledTimes(1);
    reads.stop();
  });
});
