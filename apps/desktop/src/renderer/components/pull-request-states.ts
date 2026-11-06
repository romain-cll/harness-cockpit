import { useEffect, useSyncExternalStore } from 'react';
import type { Api, PullRequestState } from '../../shared/api';

type States = Readonly<Record<string, PullRequestState>>;

/**
 * Reads the pull request states of a project's branches for the sidebar (one `gh` run for the whole project): at
 * once, then on each `refresh()` and each time the window gains focus. Never on a timer, never because a file
 * changed. One read runs at a time; a request made meanwhile triggers one more read after it. A refusal or a
 * failure gives `onStates` nothing: the rows keep the states they had. `stop()` ends it all.
 */
export function readPullRequestStates(project: string, onStates: (states: States) => void) {
  let stopped = false;
  let running = false;
  let queued = false;

  async function read() {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    let states: States | undefined;
    try {
      // Not `window.api`: `test/pull-request-states.test.ts` imports this module, and the test program does not declare it.
      const result = await (window as unknown as { api: Api }).api.workspaces.pullRequestStates(project);
      if (result.status === 'read') states = result.states;
    } catch {
      // gh missing, logged out or failing: nothing to show.
    }
    running = false;
    if (stopped) return;
    if (states) onStates(states);
    if (queued) {
      queued = false;
      void read();
    }
  }

  const refresh = () => void read();
  window.addEventListener('focus', refresh);
  refresh();

  return {
    refresh,
    stop() {
      stopped = true;
      window.removeEventListener('focus', refresh);
    },
  };
}

// The store: the last states of each project, and the reads of the projects the sidebar shows.
let statesByProject: ReadonlyMap<string, States> = new Map();
const readers = new Map<string, { branches: string; reads: ReturnType<typeof readPullRequestStates> }>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function store(project: string, states: States) {
  statesByProject = new Map(statesByProject).set(project, states);
  for (const listener of listeners) listener();
}

/**
 * Keeps one read per entry, an expanded project with its workspaces' branches: it starts with the entry, reads
 * again when the entry's branches change, and stops when the entry goes.
 */
export function usePullRequestStates(entries: readonly { project: string; branches: readonly string[] }[]) {
  // The content of `entries`, which is rebuilt at each render: the effect depends on it and reads it back.
  const key = JSON.stringify(entries.map(({ project, branches }) => [project, [...branches].sort().join('\n')]));
  useEffect(() => {
    const wanted = new Map<string, string>(JSON.parse(key));
    for (const [project, reader] of readers) {
      if (wanted.has(project)) continue;
      reader.reads.stop();
      readers.delete(project);
    }
    for (const [project, branches] of wanted) {
      const reader = readers.get(project);
      if (!reader) readers.set(project, { branches, reads: readPullRequestStates(project, (states) => store(project, states)) });
      else if (reader.branches !== branches) {
        reader.branches = branches;
        reader.reads.refresh();
      }
    }
  }, [key]);
  // The sidebar went (hidden, or the page left): no project is read any more.
  useEffect(
    () => () => {
      for (const { reads } of readers.values()) reads.stop();
      readers.clear();
    },
    [],
  );
}

/** The state of the newest pull request of `branch` as the last read gave it, `undefined` before any or without one. */
export function usePullRequestState(project: string, branch: string | null): PullRequestState | undefined {
  return useSyncExternalStore(subscribe, () => (branch === null ? undefined : statesByProject.get(project)?.[branch]));
}

/** Reads `project` again, when the sidebar shows it: after a merge or a pull request created in the app. */
export function refreshPullRequestStates(project: string) {
  readers.get(project)?.reads.refresh();
}
