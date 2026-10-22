import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import type { StartSessionResult } from '../../shared/api';
import { exitMessage, readTheme } from './terminal';

// A running session's terminal, kept for the page's lifetime so that leaving the
// session's page and coming back finds the agent and its output as they were.
// Nothing is disposed: a reload drops the whole store, and the sessions with it. A pty
// host crash ends a session like its agent exiting (`exited`), the terminal stays.
export interface SessionTerminal {
  term: XTerm;
  fit: FitAddon;
  exited: boolean;
}

const terminals = new Map<string, SessionTerminal>();
const listeners = new Set<() => void>();
// Replaced, never mutated, so `useSyncExternalStore` sees a stable snapshot.
let running: ReadonlySet<string> = new Set();

function publish() {
  running = new Set([...terminals].filter(([, { exited }]) => !exited).map(([id]) => id));
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The ids of the sessions whose agent is still running. */
export const getRunningIds = () => running;

export const getSessionTerminal = (id: string) => terminals.get(id);

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  for (const { term } of terminals.values()) term.options.theme = readTheme();
});

/**
 * Starts the session in the main process and, once it is running, keeps its
 * terminal. The terminal starts at 80 x 24 and is fitted when its page shows it.
 */
export async function startSession(harness: string): Promise<StartSessionResult> {
  const { pty, sessions } = window.api;
  const term = new XTerm({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, theme: readTheme() });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const entry: SessionTerminal = { term, fit, exited: false };

  let ptyId: number | undefined;

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
      publish();
    }),
  );

  let result: StartSessionResult;
  try {
    result = await sessions.start(harness, { cols: term.cols, rows: term.rows });
  } catch (error) {
    offData();
    offExit();
    term.dispose();
    throw error;
  }
  if (result.status === 'refused') {
    offData();
    offExit();
    term.dispose();
    return result;
  }

  ptyId = result.ptyId;
  terminals.set(result.session.id, entry);
  term.onData((data) => {
    if (!entry.exited) pty.write(result.ptyId, data);
  });
  term.onResize(({ cols, rows }) => {
    if (!entry.exited) pty.resize(result.ptyId, cols, rows);
  });
  for (const event of early) if (event.id === ptyId) event.apply();
  early.length = 0;
  publish();
  return result;
}
