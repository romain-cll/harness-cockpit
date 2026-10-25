import { beforeEach, describe, expect, test, vi } from 'vitest';

// The renderer's live terminals (a session's or a terminal tab's), with `window.api`,
// `matchMedia`, xterm.js, its fit addon and the terminal component's helpers faked.
// The listeners a live terminal registers live in the preload's isolated world, which
// no end-to-end test can count, so this one does.

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    written: string[] = [];
    loadAddon() {}
    write(data: string) {
      this.written.push(data);
    }
    onData() {}
    onResize() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('../src/renderer/components/terminal', () => ({
  readTheme: () => ({}),
  exitMessage: () => '[Process exited with code 3]',
}));

type DataListener = (id: number, data: string) => void;
type ExitListener = (id: number, exit: { exitCode: number | null; signal: number | null }) => void;
type StatusListener = (sessionId: string, status: 'working' | 'waiting' | 'finished') => void;

const dataListeners: DataListener[] = [];
const exitListeners: ExitListener[] = [];
const statusListeners: StatusListener[] = [];
const offData = vi.fn();
const offExit = vi.fn();
const kill = vi.fn();
const start = vi.fn();

beforeEach(() => {
  dataListeners.length = 0;
  exitListeners.length = 0;
  statusListeners.length = 0;
  offData.mockClear();
  offExit.mockClear();
  kill.mockClear();
  start.mockReset();
  vi.stubGlobal('matchMedia', () => ({ addEventListener() {} }));
  vi.stubGlobal('window', {
    api: {
      pty: {
        onData: (listener: DataListener) => (dataListeners.push(listener), offData),
        onExit: (listener: ExitListener) => (exitListeners.push(listener), offExit),
        write() {},
        resize() {},
        kill,
      },
      sessions: { start, onStatus: (listener: StatusListener) => (statusListeners.push(listener), () => {}) },
    },
  });
});

interface Store {
  createLiveTerminal(start: (size: { cols: number; rows: number }) => Promise<number>): {
    entry: unknown;
    started: Promise<void>;
    exit: Promise<{ exitCode: number | null; signal: number | null }>;
  };
  closeLiveTerminal(entry: unknown): void;
  startSession(harness: string, options?: unknown): Promise<unknown>;
  getSessionTerminal(id: string): unknown;
  subscribe(listener: () => void): () => void;
  /** Session id -> accessible name of its dot; a running session that reported nothing has none. */
  getSessionDots(): ReadonlyMap<string, string>;
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
  const pending = (promise: Promise<unknown>) =>
    Promise.race([promise.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('pending'), 0))]);

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

  const report = (sessionId: string, status: 'working' | 'waiting' | 'finished') => {
    for (const listener of statusListeners) listener(sessionId, status);
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
