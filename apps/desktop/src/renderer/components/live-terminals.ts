import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import type { StartSessionOptions, StartSessionResult } from '../../shared/api';
import { exitMessage, readTheme } from './terminal';

// A terminal wired to a pty, kept for the page's lifetime so that leaving its page
// and coming back finds the shell or the agent and its output as they were. The
// view (`Terminal`) moves its element in and out; only `closeLiveTerminal` disposes
// it, and a reload drops the whole store. A pty host crash ends the process like it
// exiting (`exited`), the terminal stays.
export interface LiveTerminal {
  term: XTerm;
  fit: FitAddon;
  exited: boolean;
}

const live = new Set<LiveTerminal>();
const closers = new WeakMap<LiveTerminal, () => void>();

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  for (const { term } of live) term.options.theme = readTheme();
});

const sessionTerminals = new Map<string, LiveTerminal>();
const listeners = new Set<() => void>();
// Replaced, never mutated, so `useSyncExternalStore` sees a stable snapshot.
let running: ReadonlySet<string> = new Set();

function publish() {
  running = new Set([...sessionTerminals].filter(([, { exited }]) => !exited).map(([id]) => id));
  for (const listener of listeners) listener();
}

/**
 * A terminal at 80 x 24, fitted when its view shows it, and `started`, which settles
 * once `start` has resolved with the pty id (or rejected: the terminal then takes no
 * more keys). `start` gets the size the pty must have.
 */
export function createLiveTerminal(start: (size: { cols: number; rows: number }) => Promise<number>) {
  const { pty } = window.api;
  const term = new XTerm({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, theme: readTheme() });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const entry: LiveTerminal = { term, fit, exited: false };
  live.add(entry);

  let ptyId: number | undefined;
  let failed = false;
  let closed = false;

  // Output and exit can arrive before `start` resolves with the pty id: they are
  // held until then, and those of other ptys are dropped.
  const early: Array<{ id: number; apply: () => void }> = [];
  const onPty = (id: number, apply: () => void) => {
    if (ptyId === undefined) early.push({ id, apply });
    else if (id === ptyId) apply();
  };
  const offData = pty.onData((id, data) => onPty(id, () => term.write(data)));
  const offExit = pty.onExit((id, exit) =>
    onPty(id, () => {
      entry.exited = true;
      term.write(`\r\n${exitMessage(exit)}`);
      offData();
      offExit();
      publish();
    }),
  );

  // Keys typed before the pty id is known are held too, and written in order once it is.
  const pending: string[] = [];
  term.onData((data) => {
    if (ptyId === undefined) {
      if (!failed) pending.push(data);
    } else if (!entry.exited) {
      pty.write(ptyId, data);
    }
  });
  term.onResize(({ cols, rows }) => {
    if (ptyId !== undefined && !entry.exited) pty.resize(ptyId, cols, rows);
  });

  const requested = { cols: term.cols, rows: term.rows };
  const started = start(requested).then(
    (id) => {
      if (closed) {
        pty.kill(id);
        return;
      }
      ptyId = id;
      // The terminal may have been resized while the pty was starting, when there was none to resize yet.
      if (term.cols !== requested.cols || term.rows !== requested.rows) pty.resize(id, term.cols, term.rows);
      for (const event of early) if (event.id === id) event.apply();
      early.length = 0;
      if (pending.length > 0 && !entry.exited) pty.write(id, pending.join(''));
      pending.length = 0;
    },
    (error: unknown) => {
      failed = true;
      pending.length = 0;
      throw error;
    },
  );

  closers.set(entry, () => {
    closed = true;
    if (ptyId !== undefined && !entry.exited) pty.kill(ptyId);
    offData();
    offExit();
    live.delete(entry);
    term.dispose();
  });
  return { entry, started };
}

/** Ends the terminal's process, or the one a pending start will resolve with, and disposes it. */
export function closeLiveTerminal(entry: LiveTerminal): void {
  closers.get(entry)?.();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The ids of the sessions whose agent is still running. */
export const getRunningIds = () => running;

export const getSessionTerminal = (id: string) => sessionTerminals.get(id);

/**
 * Starts the session in the main process and, once it is running, keeps its terminal.
 */
export async function startSession(harness: string, options?: StartSessionOptions): Promise<StartSessionResult> {
  // What `sessions.start` answered, which the terminal's start cannot return.
  const answer: { result?: StartSessionResult } = {};
  const { entry, started } = createLiveTerminal(async (size) => {
    const result = await window.api.sessions.start(harness, size, options);
    answer.result = result;
    if (result.status === 'refused') throw new Error(result.message);
    return result.ptyId;
  });
  try {
    await started;
  } catch (error) {
    closeLiveTerminal(entry);
    if (answer.result?.status === 'refused') return answer.result;
    throw error;
  }
  const result = answer.result!;
  if (result.status === 'started') sessionTerminals.set(result.session.id, entry);
  publish();
  return result;
}

/** Ends the running sessions among `ids` (their workspace or project is gone) and drops their terminals. */
export function endSessions(ids: string[]): void {
  for (const id of ids) {
    const entry = sessionTerminals.get(id);
    if (!entry) continue;
    closeLiveTerminal(entry);
    sessionTerminals.delete(id);
  }
  publish();
}
