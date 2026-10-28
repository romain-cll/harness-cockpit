import { SCROLLBACK } from '@cockpit/daemon/scrollback';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import type {
  AttachedTerminal,
  PtyExit,
  RunCommandsResult,
  SessionStatus,
  StartSessionOptions,
  StartSessionResult,
} from '../../shared/api';
import { exitMessage, readTheme } from './terminal';

// A terminal wired to a pty, kept for the page's lifetime so that leaving its page
// and coming back finds the shell or the agent and its output as they were. The
// view (`Terminal`) moves its element in and out; only `closeLiveTerminal` disposes
// it, and a reload drops the whole store: the ptys run on in the daemon, and the page
// attaches to the shells and sessions again when it loads (`restoreTerminals`). A
// daemon crash ends the process like it exiting (`exited`), the terminal stays.
export interface LiveTerminal {
  term: XTerm;
  fit: FitAddon;
  exited: boolean;
  /** How the process ended, once it did. */
  exit?: PtyExit;
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
// What each running session last reported (the accessible name of its dot).
const statuses = new Map<string, string>();
// The accessible name of each session's dot: what it last reported while it runs, how it ended once
// it did; none for a running session that reported nothing. Replaced, never mutated.
let dots: ReadonlyMap<string, string> = new Map();

const STATUS_DOTS: Record<SessionStatus, string> = { working: 'Working', waiting: 'Needs input', finished: 'Ready' };

// "Exited N" for a non-zero exit code; a signal (node-pty gives exit code 0 with it) and a pty host
// death (no exit code) are plain ends.
const endDot = ({ exitCode, signal }: PtyExit) => (exitCode && !signal ? `Exited ${exitCode}` : 'Ended');

function publish() {
  running = new Set([...sessionTerminals].filter(([, { exited }]) => !exited).map(([id]) => id));
  dots = new Map(
    [...sessionTerminals].flatMap(([id, { exit }]) => {
      const dot = exit ? endDot(exit) : statuses.get(id);
      return dot ? [[id, dot] as const] : [];
    }),
  );
  for (const listener of listeners) listener();
}

window.api.sessions.onStatus((id, status) => {
  if (!sessionTerminals.has(id)) return;
  statuses.set(id, STATUS_DOTS[status]);
  publish();
});

/** What `start` resolves with when the pty already runs: its id and its screen (see `attachLiveTerminal`). */
interface Attachment {
  id: number;
  attached: AttachedTerminal;
}

/**
 * A terminal at 80 x 24, fitted when its view shows it, and `started`, which settles
 * once `start` has resolved with the pty id (or rejected: the terminal then takes no
 * more keys). `start` gets the size the pty must have. `exit` resolves with the exit of the
 * pty (`exitCode: null` when its daemon died), and never when the terminal is closed first.
 * A `start` that resolves with an `Attachment` shows the pty's screen first, at the pty's size.
 */
export function createLiveTerminal(start: (size: { cols: number; rows: number }) => Promise<number | Attachment>) {
  const { pty } = window.api;
  const term = new XTerm({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, scrollback: SCROLLBACK, theme: readTheme() });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const entry: LiveTerminal = { term, fit, exited: false };
  live.add(entry);

  let ptyId: number | undefined;
  let resolveExit!: (exit: PtyExit) => void;
  const exit = new Promise<PtyExit>((resolve) => (resolveExit = resolve));
  let failed = false;
  let closed = false;

  // Output and exit can arrive before `start` resolves with the pty id: they are
  // held until then, and those of other ptys are dropped. When the screen of a running pty
  // was shown, the output it already covers (up to sequence number `covered`) is dropped too.
  let covered = -1;
  const early: Array<{ id: number; seq?: number; apply: () => void }> = [];
  const onPty = (id: number, apply: () => void, seq?: number) => {
    if (ptyId === undefined) early.push({ id, seq, apply });
    else if (id === ptyId && (seq === undefined || seq > covered)) apply();
  };
  const offData = pty.onData((id, data, seq) => onPty(id, () => term.write(data), seq));
  const offExit = pty.onExit((id, ptyExit) =>
    onPty(id, () => {
      entry.exited = true;
      entry.exit = ptyExit;
      term.write(`\r\n${exitMessage(ptyExit)}`);
      offData();
      offExit();
      publish();
      resolveExit(ptyExit);
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
    (result) => {
      const id = typeof result === 'number' ? result : result.id;
      if (closed) {
        pty.kill(id);
        return;
      }
      if (typeof result !== 'number') {
        // The view takes the pty's size and its screen: what follows is the output after them.
        const { cols, rows, screen, seq } = result.attached;
        term.resize(cols, rows);
        requested.cols = cols;
        requested.rows = rows;
        term.write(screen);
        covered = seq;
      }
      ptyId = id;
      // The terminal may have been resized while the pty was starting, when there was none to resize yet.
      if (term.cols !== requested.cols || term.rows !== requested.rows) pty.resize(id, term.cols, term.rows);
      for (const event of early) if (event.id === id && (event.seq === undefined || event.seq > covered)) event.apply();
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
  return { entry, started, exit };
}

/** A live terminal for a pty the daemon already runs: its screen as the daemon holds it, then its output. */
export const attachLiveTerminal = (id: number) =>
  createLiveTerminal(async () => ({ id, attached: await window.api.pty.attach(id) }));

// The ptys this page has attached to, so that restoring again does not show one twice.
const restored = new Set<number>();
let restoredOnce = false;

/**
 * Attaches to the shells and sessions the daemons are running. Called once per page load (`again`
 * to do it for the ptys not attached yet, after the daemon was started by hand). Each session goes
 * to the store, with the status it last reported; the shells come back in creation order, for the
 * terminal page to show one tab each. A terminal that ended meanwhile is left out.
 */
export async function restoreTerminals(again = false): Promise<LiveTerminal[]> {
  if (restoredOnce && !again) return [];
  restoredOnce = true;
  const listed = (await window.api.pty.list()).filter(({ id }) => !restored.has(id));
  const attached = await Promise.all(
    listed.map(async (terminal) => {
      restored.add(terminal.id);
      const { entry, started } = attachLiveTerminal(terminal.id);
      try {
        await started;
      } catch {
        closeLiveTerminal(entry);
        return undefined;
      }
      if (terminal.sessionId === undefined) return entry;
      sessionTerminals.set(terminal.sessionId, entry);
      if (terminal.status) statuses.set(terminal.sessionId, STATUS_DOTS[terminal.status]);
      return undefined;
    }),
  );
  publish();
  return attached.filter((entry) => entry !== undefined);
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

/** The accessible name of each session's dot, by session id. */
export const getSessionDots = () => dots;

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

/**
 * Runs the `setup` or `teardown` commands of a workspace in a terminal of its own. `none`: the config
 * holds no such command. `refused`: they could not run (the message says why). Otherwise the terminal
 * and its `exit`; the caller closes the terminal (which ends the commands if they still run).
 */
export async function runWorkspaceCommands(
  project: string,
  path: string,
  which: 'setup' | 'teardown',
): Promise<{ status: 'none' } | { status: 'refused'; message: string } | { status: 'started'; entry: LiveTerminal; exit: Promise<PtyExit> }> {
  // What `workspaces.runCommands` answered, which the terminal's start cannot return.
  const answer: { result?: RunCommandsResult } = {};
  const { entry, started, exit } = createLiveTerminal(async (size) => {
    const result = await window.api.workspaces.runCommands(project, path, which, size);
    answer.result = result;
    if (result.status !== 'started') throw new Error(result.status === 'refused' ? result.message : 'no commands to run');
    return result.ptyId;
  });
  try {
    await started;
  } catch (error) {
    closeLiveTerminal(entry);
    if (answer.result?.status === 'none') return { status: 'none' };
    return { status: 'refused', message: error instanceof Error ? error.message : String(error) };
  }
  return { status: 'started', entry, exit };
}

/**
 * Whether setup or teardown commands passed. node-pty reports a process killed by a signal as
 * `exitCode: 0` with the signal set, so the exit code alone does not tell.
 */
export const passed = ({ exitCode, signal }: PtyExit) => exitCode === 0 && !signal;

/** The status line of commands that did not pass: their exit code, or that a signal or a pty host death ended them. */
export function failureLine(what: 'Setup' | 'Teardown', { exitCode, signal }: PtyExit): string {
  return exitCode === null || signal ? `${what} ended before it finished.` : `${what} failed with exit code ${exitCode}`;
}

/** Ends the running sessions among `ids` (their workspace or project is gone) and drops their terminals. */
export function endSessions(ids: string[]): void {
  for (const id of ids) {
    const entry = sessionTerminals.get(id);
    if (!entry) continue;
    closeLiveTerminal(entry);
    sessionTerminals.delete(id);
    statuses.delete(id);
  }
  publish();
}
