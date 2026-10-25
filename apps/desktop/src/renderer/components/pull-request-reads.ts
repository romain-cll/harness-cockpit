import type { Api, PullRequestResult } from '../../shared/api';

/** How long an open pull request with pending checks waits before it is read again. */
const POLL_MS = 30_000;

/**
 * Reads a workspace's pull request through `gh` for the Changes sidebar: at once, then on each
 * `refresh()`, each time the window gains focus, and every 30 s while the last result is an open pull
 * request with pending checks. Never because a file of the worktree changed. One read runs at a time;
 * a request made meanwhile triggers one more read after it. `stop()` ends it all.
 */
export function readPullRequests(project: string, path: string, onResult: (result: PullRequestResult) => void) {
  let stopped = false;
  let running = false;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function read() {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    clearTimeout(timer);
    let result: PullRequestResult;
    try {
      // Not `window.api`: `test/pull-request-reads.test.ts` imports this module, and the test program does not declare it.
      result = await (window as unknown as { api: Api }).api.workspaces.pullRequest(project, path);
    } catch (error) {
      result = { status: 'refused', message: error instanceof Error ? error.message : String(error) };
    }
    running = false;
    if (stopped) return;
    onResult(result);
    if (queued) {
      queued = false;
      void read();
    } else if (result.status === 'read' && result.pullRequest?.state === 'open' && result.pullRequest.checks === 'pending') {
      timer = setTimeout(() => void read(), POLL_MS);
    }
  }

  const refresh = () => void read();
  window.addEventListener('focus', refresh);
  refresh();

  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
    },
  };
}
