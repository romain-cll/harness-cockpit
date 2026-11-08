import { beforeEach, describe, expect, test, vi } from 'vitest';

// The renderer's live terminals (a session's or a terminal tab's), with `window.api`,
// `matchMedia`, xterm.js, its fit addon and the terminal component's helpers faked.
// The listeners a live terminal registers live in the preload's isolated world, which
// no end-to-end test can count, so this one does.

// COCKPIT-91: what xterm.js does, in the order it does it. A write is parsed in the order it was made and its
// callback runs right after it; `hold` keeps the writes queued (a parser that has not got to them yet) until
// `drain()`. `log` lists the chunks parsed (an empty write is no chunk) and the sizes taken, in order.
const xterm = vi.hoisted(() => ({
  hold: false,
  queue: [] as Array<() => void>,
  log: [] as string[],
  drain() {
    for (const run of this.queue.splice(0)) run();
  },
}));
// The size the view's fit addon proposes.
const fitState = vi.hoisted(() => ({ proposed: undefined as { cols: number; rows: number } | undefined }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    written: string[] = [];
    private resized: Array<(size: { cols: number; rows: number }) => void> = [];
    loadAddon() {}
    write(data: string, callback?: () => void) {
      const parse = () => {
        this.written.push(data);
        if (data !== '') xterm.log.push(data);
        callback?.();
      };
      if (xterm.hold || xterm.queue.length > 0) xterm.queue.push(parse);
      else parse();
    }
    onData() {}
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      this.resized.push(listener);
    }
    // As xterm.js does: nothing when the size is unchanged, else every `onResize` listener.
    resize(cols: number, rows: number) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      xterm.log.push(`resize ${cols}x${rows}`);
      for (const listener of this.resized) listener({ cols, rows });
    }
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions = () => fitState.proposed; } }));
vi.mock('../src/renderer/components/terminal', () => ({
  readTheme: () => ({}),
  exitMessage: () => '[Process exited with code 3]',
}));

type DataListener = (id: number, data: string, seq?: number) => void;
type ResizedListener = (id: number, cols: number, rows: number, seq?: number) => void;
type ExitListener = (id: number, exit: { exitCode: number | null; signal: number | null }) => void;
// COCKPIT-57: the status event also carries the setup states and the agent's exit.
type StatusEvent = 'working' | 'waiting' | 'finished' | 'setup-running' | 'setup-done' | 'setup-failed' | 'exited';
type StatusListener = (sessionId: string, event: StatusEvent, exitCode?: number | null) => void;
interface ListedTerminal {
  id: number;
  kind: 'shell' | 'session';
  cwd: string;
  cols: number;
  rows: number;
  sessionId?: string;
  workspace?: string;
  status?: 'working' | 'waiting' | 'finished';
  setup?: 'running' | 'done' | 'failed';
  exitCode?: number | null;
}

const dataListeners: DataListener[] = [];
const exitListeners: ExitListener[] = [];
const resizedListeners: ResizedListener[] = [];
const statusListeners: StatusListener[] = [];
const offData = vi.fn();
const offExit = vi.fn();
const kill = vi.fn();
const start = vi.fn();
let listed: ListedTerminal[] = [];
const resize = vi.fn();
let attachAnswer = { cols: 80, rows: 24, screen: '', seq: 0 };

beforeEach(() => {
  dataListeners.length = 0;
  exitListeners.length = 0;
  resizedListeners.length = 0;
  statusListeners.length = 0;
  xterm.hold = false;
  xterm.queue.length = 0;
  xterm.log.length = 0;
  fitState.proposed = undefined;
  offData.mockClear();
  offExit.mockClear();
  kill.mockClear();
  start.mockReset();
  listed = [];
  resize.mockReset();
  attachAnswer = { cols: 80, rows: 24, screen: '', seq: 0 };
  vi.stubGlobal('matchMedia', () => ({ addEventListener() {} }));
  vi.stubGlobal('window', {
    api: {
      pty: {
        onData: (listener: DataListener) => (dataListeners.push(listener), offData),
        onExit: (listener: ExitListener) => (exitListeners.push(listener), offExit),
        onResized: (listener: ResizedListener) => (resizedListeners.push(listener), () => {}),
        write() {},
        resize,
        kill,
        list: async () => listed,
        attach: async () => attachAnswer,
      },
      sessions: { start, onStatus: (listener: StatusListener) => (statusListeners.push(listener), () => {}) },
    },
  });
});

interface Store {
  createLiveTerminal(start: (size: { cols: number; rows: number }) => Promise<number | { id: number; attached: typeof attachAnswer }>): {
    entry: { term: { cols: number; rows: number; resize(cols: number, rows: number): void } };
    started: Promise<void>;
    exit: Promise<{ exitCode: number | null; signal: number | null }>;
  };
  closeLiveTerminal(entry: unknown): void;
  /** The view asks for the size its fit addon proposes (COCKPIT-91). */
  fitLiveTerminal(entry: unknown): void;
  startSession(harness: string, options?: unknown): Promise<unknown>;
  getSessionTerminal(id: string): unknown;
  subscribe(listener: () => void): () => void;
  /** Session id -> accessible name of its dot; a running session that reported nothing has none. */
  getSessionDots(): ReadonlyMap<string, string>;
  /** Workspace path -> `running` or `failed`, from the running sessions' last setup state; a done setup has no entry. */
  getWorkspaceSetups(): ReadonlyMap<string, 'running' | 'failed'>;
  restoreTerminals(): Promise<Array<{ entry: unknown; workspace: string; sessionId?: string }>>;
  agentRuns(id: string): boolean;
}

// A variable specifier: the test project does not include the app sources, so tsc leaves it alone.
const storePath = '../src/renderer/components/live-terminals';
const loadStore = () => import(/* @vite-ignore */ storePath) as Promise<Store>;

describe('AC15 — listeners of a live terminal', () => {
  test('AC15 — a terminal tab: onData and onExit are unsubscribed once the exit has been written to the terminal, and not before; closing it afterwards throws nothing and kills no pty', async () => {
    const { createLiveTerminal, closeLiveTerminal } = await loadStore();
    const { entry, started } = createLiveTerminal(async () => 7);
    await started;

    expect(dataListeners).toHaveLength(1);
    expect(exitListeners).toHaveLength(1);
    expect(offData).not.toHaveBeenCalled();
    expect(offExit).not.toHaveBeenCalled();

    exitListeners[0]!(7, { exitCode: 3, signal: null });

    expect(offData).toHaveBeenCalledTimes(1);
    expect(offExit).toHaveBeenCalledTimes(1);
    expect(() => closeLiveTerminal(entry)).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });

  test('AC15 — a session: onData and onExit are unsubscribed once the exit has been written to the terminal, and not before; closing it afterwards throws nothing and kills no pty', async () => {
    const { startSession, getSessionTerminal, closeLiveTerminal } = await loadStore();
    start.mockResolvedValue({
      status: 'started',
      ptyId: 7,
      session: { id: 's1', name: 'Claude Code 1', harness: 'claude-code', directory: '/d', createdAt: '2026-10-23T10:00:00.000Z' },
    });

    await startSession('claude-code');
    const entry = getSessionTerminal('s1');

    expect(dataListeners).toHaveLength(1);
    expect(exitListeners).toHaveLength(1);
    expect(offData).not.toHaveBeenCalled();
    expect(offExit).not.toHaveBeenCalled();

    exitListeners[0]!(7, { exitCode: 3, signal: null });

    expect(offData).toHaveBeenCalledTimes(1);
    expect(offExit).toHaveBeenCalledTimes(1);
    expect(() => closeLiveTerminal(entry)).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('exit of a live terminal', () => {
  // A promise already resolved has run its reactions by the next turn of the event loop (`setImmediate`), which
  // follows every queued microtask: no timer, nothing to wait for.
  const pending = async (promise: Promise<unknown>) => {
    let state = 'pending';
    void promise.then(() => (state = 'settled'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    return state;
  };

  test('AC2, AC4–AC9, AC13, AC14 — exit resolves with the exit of its own pty only, a pty host death (exitCode null) included', async () => {
    const { createLiveTerminal } = await loadStore();
    const first = createLiveTerminal(async () => 7);
    const second = createLiveTerminal(async () => 8);
    await Promise.all([first.started, second.started]);
    expect(first.exit).toBeInstanceOf(Promise);

    // The exit of another pty is not this one's.
    exitListeners[0]!(8, { exitCode: 5, signal: null });
    expect(await pending(first.exit)).toBe('pending');

    exitListeners[0]!(7, { exitCode: 3, signal: null });
    await expect(first.exit).resolves.toEqual({ exitCode: 3, signal: null });

    expect(await pending(second.exit)).toBe('pending');
    exitListeners[1]!(8, { exitCode: null, signal: null });
    await expect(second.exit).resolves.toEqual({ exitCode: null, signal: null });
  });
});

// The dot of a session row: what its agent last reported while it runs, how it ended once it
// did. The store holds both (statuses from `sessions.onStatus`, exits from the pty), and publishes
// them as a map from session id to the dot's accessible name.
//
// Interface the tests assume: `getSessionDots()` returns a `ReadonlyMap<string, string>` that is
// replaced, never mutated, on every change (it is a `useSyncExternalStore` snapshot), and
// `sessions.onStatus(listener)` calls `listener(sessionId, 'working' | 'waiting' | 'finished')`.
describe('session dots', () => {
  beforeEach(() => vi.resetModules());

  const session = (id: string) => ({ id, name: `Claude Code ${id}`, harness: 'claude-code', directory: '/d', createdAt: '2026-10-25T10:00:00.000Z' });

  async function startedStore(...sessions: Array<[id: string, ptyId: number]>) {
    const store = await loadStore();
    for (const [id, ptyId] of sessions) {
      start.mockResolvedValueOnce({ status: 'started', ptyId, session: session(id) });
      await store.startSession('claude-code');
    }
    return store;
  }

  const report = (sessionId: string, status: StatusEvent, exitCode?: number | null) => {
    for (const listener of statusListeners) listener(sessionId, status, exitCode);
  };

  test('AC9 — a running session that has reported nothing has no dot', async () => {
    const { getSessionDots } = await startedStore(['s1', 7]);

    expect(getSessionDots().has('s1')).toBe(false);
  });

  test('AC7 — working, waiting and finished reports give the "Working", "Needs input" and "Ready" dots of that session only, and notify the subscribers', async () => {
    const { getSessionDots, subscribe } = await startedStore(['s1', 7], ['s2', 8]);
    const changed = vi.fn();
    subscribe(changed);

    const seen: Array<string | undefined> = [];
    for (const status of ['working', 'waiting', 'working', 'finished'] as const) {
      const before = getSessionDots();
      report('s1', status);
      seen.push(getSessionDots().get('s1'));
      // A snapshot is replaced, never mutated: React compares them by identity.
      expect(getSessionDots()).not.toBe(before);
      expect(before.get('s1')).not.toBe(getSessionDots().get('s1'));
    }

    expect(seen).toEqual(['Working', 'Needs input', 'Working', 'Ready']);
    expect(getSessionDots().has('s2')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(4);
    // Nothing changed since: the same snapshot.
    expect(getSessionDots()).toBe(getSessionDots());
  });

  test('AC7 — a report for a session the store does not hold is ignored', async () => {
    const { getSessionDots } = await startedStore(['s1', 7]);

    expect(() => report('unknown', 'working')).not.toThrow();

    expect(getSessionDots().has('unknown')).toBe(false);
    expect(getSessionDots().has('s1')).toBe(false);
  });

  test.each([
    ['exit code 0', { exitCode: 0, signal: null }, 'Ended'],
    ['a signal (node-pty gives exit code 0 with it)', { exitCode: 0, signal: 15 }, 'Ended'],
    ['no exit code (the pty host died)', { exitCode: null, signal: null }, 'Ended'],
    ['a non-zero exit code', { exitCode: 3, signal: null }, 'Exited 3'],
  ])('AC8 — %s: its dot is the end dot whatever the session last reported, and the other session keeps its own', async (_label, exit, dot) => {
    const { getSessionDots } = await startedStore(['s1', 7], ['s2', 8]);
    report('s1', 'working');
    report('s2', 'waiting');
    expect(getSessionDots().get('s1')).toBe('Working');

    for (const listener of exitListeners) listener(7, exit);

    expect(getSessionDots().get('s1')).toBe(dot);
    expect(getSessionDots().get('s2')).toBe('Needs input');
  });
});

// COCKPIT-57: `exited` (the agent ended, the shell `cockpit setup` leaves goes on) and the setup states
// come with the session statuses, from `sessions.onStatus` and, after a reload, from `pty.list`.
//
// Interface the tests assume: `onStatus(listener)` calls `listener(sessionId, event, exitCode?)` with
// `event` one of the three statuses, `setup-running`, `setup-done`, `setup-failed` or `exited` (with
// the exit code, `null` for a signal); `pty.list()` entries carry `workspace`, `setup` and `exitCode`;
// `getWorkspaceSetups()` is a `ReadonlyMap` replaced, never mutated, on every change, keyed by the
// session's directory (a workspace's worktree).
describe('agent exit and setup states', () => {
  beforeEach(() => vi.resetModules());

  const workspaceSession = (id: string, directory: string) => ({
    id,
    name: `Claude Code ${id}`,
    harness: 'claude-code',
    directory,
    project: '/p',
    createdAt: '2026-10-30T10:00:00.000Z',
  });

  async function startedStore(...sessions: Array<[id: string, ptyId: number, directory: string]>) {
    const store = await loadStore();
    for (const [id, ptyId, directory] of sessions) {
      start.mockResolvedValueOnce({ status: 'started', ptyId, session: workspaceSession(id, directory) });
      await store.startSession('claude-code', { workspace: { project: '/p', path: directory } });
    }
    return store;
  }

  const report = (sessionId: string, event: StatusEvent, exitCode?: number | null) => {
    for (const listener of statusListeners) listener(sessionId, event, exitCode);
  };

  test.each([
    ['code 3', 3, 'Exited 3'],
    ['code 0', 0, 'Ended'],
    ['a signal (no code)', null, 'Ended'],
  ])('AC5 — exited with %s sets the dot at once, whatever it reported before, and a later pty exit (the shell the agent left) leaves it', async (_label, exitCode, dot) => {
    const { getSessionDots } = await startedStore(['s1', 7, '/w1']);
    report('s1', 'working');

    report('s1', 'exited', exitCode);
    expect(getSessionDots().get('s1')).toBe(dot);

    for (const code of [0, 5]) {
      for (const listener of exitListeners) listener(7, { exitCode: code, signal: null });
      expect(getSessionDots().get('s1'), `after the shell exited with ${code}`).toBe(dot);
    }
  });

  test('AC5 — without an exited report, the pty exit still sets the dot as before', async () => {
    const { getSessionDots } = await startedStore(['s1', 7, '/w1']);

    for (const listener of exitListeners) listener(7, { exitCode: 3, signal: null });

    expect(getSessionDots().get('s1')).toBe('Exited 3');
  });

  test('AC2, AC3 — setup-running gives the workspace "running", setup-failed "failed", setup-done nothing; each change replaces the snapshot and notifies, and another workspace is untouched', async () => {
    const { getWorkspaceSetups, subscribe } = await startedStore(['s1', 7, '/w1'], ['s2', 8, '/w2']);
    const changed = vi.fn();
    subscribe(changed);
    expect(getWorkspaceSetups().size).toBe(0);

    const seen: Array<string | undefined> = [];
    for (const event of ['setup-running', 'setup-failed', 'setup-running', 'setup-done'] as const) {
      const before = getWorkspaceSetups();
      report('s1', event);
      seen.push(getWorkspaceSetups().get('/w1'));
      expect(getWorkspaceSetups()).not.toBe(before);
    }

    expect(seen).toEqual(['running', 'failed', 'running', undefined]);
    expect(getWorkspaceSetups().has('/w2')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  test('AC2 — a report for a session the store does not hold changes no setup', async () => {
    const { getWorkspaceSetups } = await startedStore(['s1', 7, '/w1']);

    expect(() => report('unknown', 'setup-running')).not.toThrow();

    expect(getWorkspaceSetups().size).toBe(0);
  });

  test('AC3 — a session whose terminal ended drops its setup state', async () => {
    const { getWorkspaceSetups } = await startedStore(['s1', 7, '/w1'], ['s2', 8, '/w2']);
    report('s1', 'setup-failed');
    report('s2', 'setup-running');
    expect(Object.fromEntries(getWorkspaceSetups())).toEqual({ '/w1': 'failed', '/w2': 'running' });

    for (const listener of exitListeners) listener(7, { exitCode: 0, signal: null });

    expect(Object.fromEntries(getWorkspaceSetups())).toEqual({ '/w2': 'running' });
  });

  test('AC6 — after a reload, restoring seeds the dots and the setup states from pty.list: the setup state, and the exit of an agent that left its shell running', async () => {
    const entry = (id: number, sessionId: string, workspace: string, extra: Partial<ListedTerminal> = {}): ListedTerminal => ({
      id,
      kind: 'session',
      cwd: workspace,
      cols: 80,
      rows: 24,
      sessionId,
      workspace,
      ...extra,
    });
    listed = [
      entry(7, 's1', '/w1', { setup: 'failed' }),
      entry(8, 's2', '/w2', { setup: 'running' }),
      entry(9, 's3', '/w3', { setup: 'done', status: 'working' }),
      entry(10, 's4', '/w4', { setup: 'done', exitCode: 3 }),
      entry(11, 's5', '/w5', { setup: 'done', exitCode: null }),
    ];
    const { restoreTerminals, getWorkspaceSetups, getSessionDots } = await loadStore();

    await restoreTerminals();

    expect(Object.fromEntries(getWorkspaceSetups())).toEqual({ '/w1': 'failed', '/w2': 'running' });
    expect(getSessionDots().get('s3')).toBe('Working');
    expect(getSessionDots().get('s4')).toBe('Exited 3');
    expect(getSessionDots().get('s5')).toBe('Ended');
    expect(getSessionDots().has('s1')).toBe(false);
    // The shell of s4 exiting later leaves the dot.
    for (const listener of exitListeners) listener(10, { exitCode: 0, signal: null });
    expect(getSessionDots().get('s4')).toBe('Exited 3');
  });
});

// COCKPIT-70: what a restore gives the workspace page to show as tabs.
describe('restoreTerminals — the terminals of a workspace', () => {
  const shell = (id: number, extra: Partial<ListedTerminal> = {}): ListedTerminal => ({ id, kind: 'shell', cwd: '/w1', cols: 80, rows: 24, workspace: '/w1', ...extra });

  test('the shells and sessions that run in a workspace come back in the order listed, with their workspace and session id; a shell of no workspace is left alone', async () => {
    listed = [
      shell(1),
      { id: 2, kind: 'session', cwd: '/w1', cols: 80, rows: 24, sessionId: 's1', workspace: '/w1' },
      shell(3, { workspace: undefined }),
      shell(4, { workspace: '/w2' }),
      { id: 5, kind: 'session', cwd: '/outside', cols: 80, rows: 24, sessionId: 's2' },
    ];
    vi.resetModules();
    const { restoreTerminals, getSessionTerminal } = await loadStore();

    const restored = await restoreTerminals();

    expect(restored.map(({ workspace, sessionId }) => [workspace, sessionId])).toEqual([
      ['/w1', undefined],
      ['/w1', 's1'],
      ['/w2', undefined],
    ]);
    // A session outside any project is in the store for its own page, and is not a tab.
    expect(getSessionTerminal('s2')).toBeDefined();
    expect(getSessionTerminal('s1')).toBe(restored[1]!.entry);
  });

  test('a session runs until its agent exits: the exit `cockpit setup` reported, or its terminal ending, ends it', async () => {
    listed = [
      { id: 1, kind: 'session', cwd: '/w1', cols: 80, rows: 24, sessionId: 'runs', workspace: '/w1' },
      { id: 2, kind: 'session', cwd: '/w1', cols: 80, rows: 24, sessionId: 'agent-left', workspace: '/w1', exitCode: 3 },
    ];
    vi.resetModules();
    const { restoreTerminals, agentRuns } = await loadStore();

    await restoreTerminals();

    expect(agentRuns('runs')).toBe(true);
    expect(agentRuns('agent-left')).toBe(false);
    for (const listener of exitListeners) listener(1, { exitCode: 0, signal: null });
    expect(agentRuns('runs')).toBe(false);
  });
});

// COCKPIT-91: the view asks for a size (`fitLiveTerminal`, from the fit addon's proposal); a running pty is
// resized through `pty.resize` and the xterm takes the size from the `resized` event, in order with the output.
describe('size of a live terminal (COCKPIT-91)', () => {
  const ask = (entry: unknown, cols: number, rows: number, fit: (entry: unknown) => void) => {
    fitState.proposed = { cols, rows };
    fit(entry);
  };

  test('AC4 — the view asks for a size: pty.resize gets it and the xterm keeps its size until the resized event, which it takes after every chunk written before it and before any chunk after it', async () => {
    const { createLiveTerminal, fitLiveTerminal } = await loadStore();
    const { entry, started } = createLiveTerminal(async () => 7);
    await started;

    ask(entry, 100, 30, fitLiveTerminal);

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(7, 100, 30);
    expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 80, rows: 24 });

    // Two chunks the parser has not got to, the event, a chunk after it.
    xterm.hold = true;
    expect(resizedListeners).toHaveLength(1);
    dataListeners[0]!(7, 'before-1', 1);
    dataListeners[0]!(7, 'before-2', 2);
    resizedListeners[0]!(7, 100, 30, 3);
    dataListeners[0]!(7, 'after-1', 4);
    expect(xterm.log, 'nothing is taken before the parser got to it').toEqual([]);
    xterm.drain();

    expect(xterm.log).toEqual(['before-1', 'before-2', 'resize 100x30', 'after-1']);
    expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 100, rows: 30 });
  });

  test('AC5 — a resized event at or below the sequence number of the screen shown is ignored, one above is applied', async () => {
    attachAnswer = { cols: 80, rows: 24, screen: 'screen', seq: 5 };
    const { createLiveTerminal } = await loadStore();
    const { entry, started } = createLiveTerminal(async () => ({ id: 7, attached: attachAnswer }));
    await started;
    expect(resizedListeners).toHaveLength(1);

    resizedListeners[0]!(7, 100, 30, 5);
    expect({ cols: entry.term.cols, rows: entry.term.rows }, 'at the screen\'s sequence number').toEqual({ cols: 80, rows: 24 });
    resizedListeners[0]!(7, 100, 30, 3);
    expect({ cols: entry.term.cols, rows: entry.term.rows }, 'below it').toEqual({ cols: 80, rows: 24 });

    resizedListeners[0]!(7, 120, 40, 6);
    expect({ cols: entry.term.cols, rows: entry.term.rows }, 'above it').toEqual({ cols: 120, rows: 40 });
  });

  test('AC6 — a size asked before the start resolves is not taken by the xterm; once it resolves pty.resize gets it and the xterm takes it on the resized event', async () => {
    const { createLiveTerminal, fitLiveTerminal } = await loadStore();
    let resolveStart!: (id: number) => void;
    const { entry, started } = createLiveTerminal(() => new Promise<number>((resolve) => (resolveStart = resolve)));

    ask(entry, 100, 30, fitLiveTerminal);

    expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 80, rows: 24 });
    expect(resize).not.toHaveBeenCalled();

    resolveStart(7);
    await started;

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(7, 100, 30);
    expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 80, rows: 24 });
    resizedListeners[0]!(7, 100, 30, 1);
    expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 100, rows: 30 });
  });

  test('AC6 — a terminal whose pty exited takes a size the view asks for at once, and sends nothing', async () => {
    const { createLiveTerminal, fitLiveTerminal } = await loadStore();
    const { entry, started } = createLiveTerminal(async () => 7);
    await started;
    exitListeners[0]!(7, { exitCode: 3, signal: null });

    ask(entry, 100, 30, fitLiveTerminal);

    expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 100, rows: 30 });
    expect(resize).not.toHaveBeenCalled();
  });

  // Every order of two asks and the start resolving (COCKPIT-76), each step followed or not by the microtasks
  // it queues (an ask can land between the start resolving and the code that reads its id): the pty ends at the
  // last size asked, even when it is the size the xterm already has.
  type Step = 'ask 63x26' | 'ask 80x24' | 'resolve';

  const permutations = <T,>(items: T[]): T[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));

  const cases = permutations<Step>(['ask 63x26', 'ask 80x24', 'resolve']).flatMap((order) =>
    [0, 1, 2, 3, 4, 5, 6, 7].map((flushes) => order.map((step, i) => ({ step, flush: Boolean(flushes & (1 << i)) }))),
  );

  const label = (steps: Array<{ step: Step; flush: boolean }>) =>
    steps.map(({ step, flush }) => (flush ? `${step}, flush` : step)).join(' → ');

  test.each(cases.map((steps) => [label(steps), steps] as const))('AC6 — %s: the pty ends at the last size asked', async (_label, steps) => {
    const { createLiveTerminal, fitLiveTerminal } = await loadStore();
    let resolveSpawn!: (id: number) => void;
    let spawnedAt: { cols: number; rows: number } | undefined;
    const { entry, started } = createLiveTerminal((size) => {
      spawnedAt = { ...size };
      return new Promise<number>((resolve) => (resolveSpawn = resolve));
    });

    let asked: { cols: number; rows: number } | undefined;
    for (const { step, flush } of steps) {
      if (step === 'resolve') resolveSpawn(7);
      else {
        const [cols, rows] = step.slice(4).split('x').map(Number) as [number, number];
        asked = { cols, rows };
        ask(entry, cols, rows, fitLiveTerminal);
      }
      if (flush) await Promise.resolve();
    }
    await started;

    // No resize reaches a pty before the spawn told its id, nor another pty.
    for (const [id] of resize.mock.calls) expect(id).toBe(7);
    const last = resize.mock.calls.at(-1);
    expect(last ? { cols: last[1], rows: last[2] } : spawnedAt).toEqual(asked);
  });
});
