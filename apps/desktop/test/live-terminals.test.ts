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

const dataListeners: DataListener[] = [];
const exitListeners: ExitListener[] = [];
const offData = vi.fn();
const offExit = vi.fn();
const kill = vi.fn();
const start = vi.fn();

beforeEach(() => {
  dataListeners.length = 0;
  exitListeners.length = 0;
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
      sessions: { start },
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
