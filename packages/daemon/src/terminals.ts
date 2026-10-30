import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as Headless } from '@xterm/headless';
import { spawn, type IPty } from 'node-pty';
import { SCROLLBACK, type Attached, type SessionEventName, type SpawnOptions, type TerminalExit, type TerminalInfo } from './protocol';

/** Who receives what a terminal produces: one connection. */
export interface Subscriber {
  data(terminal: number, seq: number, data: string): void;
  exit(terminal: number, exit: TerminalExit): void;
}

interface Terminal {
  info: TerminalInfo;
  pty: IPty;
  headless: Headless;
  serializer: SerializeAddon;
  /** The sequence number of the last chunk the pty produced. */
  seq: number;
  subscribers: Set<Subscriber>;
  /** The connection a `commands` terminal ends with. */
  owner?: Subscriber;
  /** The pending SIGKILL of a terminal that was hung up, cleared when it exits. */
  killTimer?: NodeJS.Timeout;
}

/** How long a hung-up process has to end before it is killed. */
const HANGUP_GRACE_MS = 1000;

/**
 * The terminals the daemon owns: node-pty sessions, each mirrored by a headless terminal that
 * follows the pty's size, so that a client attaching later gets the screen as it is. Every chunk
 * of output carries a sequence number, per terminal.
 */
export function createTerminals(onEnd: () => void) {
  const terminals = new Map<unknown, Terminal>();
  let lastId = 0;

  // node-pty throws on a bad size, and on a terminal whose pty closed but whose exit was not
  // reported yet. A failure stays with its own terminal: it ends through its exit event.
  const withTerminal = (id: unknown, operation: (terminal: Terminal) => void) => {
    const terminal = terminals.get(id);
    if (!terminal) return;
    try {
      operation(terminal);
    } catch {
      // The terminal ends through its own exit event.
    }
  };

  // node-pty's `kill()` sends SIGHUP, which bash 3.2 (macOS's /bin/sh and /bin/bash) drops when it
  // arrives during the shell's startup, and which a process may ignore: the terminal would then
  // never end. A process that has not exited after the grace period gets SIGKILL.
  const hangUp = (terminal: Terminal) => {
    terminal.killTimer ??= setTimeout(() => {
      try {
        terminal.pty.kill('SIGKILL');
      } catch {
        // The terminal ends through its own exit event.
      }
    }, HANGUP_GRACE_MS).unref();
    terminal.pty.kill();
  };

  return {
    get size() {
      return terminals.size;
    },

    spawn(options: SpawnOptions, subscriber: Subscriber): number {
      const { kind, command, args, cwd, env, cols, rows, sessionId, workspace } = options;
      const pty = spawn(command, args, { name: env.TERM ?? 'xterm-256color', cwd, env, cols, rows });
      const headless = new Headless({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
      const serializer = new SerializeAddon();
      headless.loadAddon(serializer);

      const id = ++lastId;
      const info: TerminalInfo = { id, kind, cwd, cols, rows, ...(sessionId !== undefined && { sessionId }), ...(workspace !== undefined && { workspace }) };
      const terminal: Terminal = {
        info,
        pty,
        headless,
        serializer,
        seq: 0,
        subscribers: new Set([subscriber]),
        ...(kind === 'commands' && { owner: subscriber }),
      };
      terminals.set(id, terminal);

      pty.onData((data) => {
        const seq = ++terminal.seq;
        headless.write(data);
        for (const each of terminal.subscribers) each.data(id, seq, data);
      });
      pty.onExit(({ exitCode, signal }) => {
        clearTimeout(terminal.killTimer);
        terminals.delete(id);
        headless.dispose();
        for (const each of terminal.subscribers) each.exit(id, { exitCode, signal: signal ?? null });
        onEnd();
      });
      return id;
    },

    list: (): TerminalInfo[] => [...terminals.values()].map(({ info }) => ({ ...info })),

    /**
     * Subscribes the connection and answers the screen as of the last chunk written before the
     * answer: the headless terminal parses writes in order, so a write with no data is called back
     * once everything before it is on the screen, and the chunks that follow (which the
     * subscriber gets, with a higher sequence number) are not yet.
     */
    attach(id: unknown, subscriber: Subscriber): Promise<Attached> {
      const terminal = terminals.get(id);
      if (!terminal) return Promise.reject(new Error(`no terminal ${id}`));
      terminal.subscribers.add(subscriber);
      const seq = terminal.seq;
      return new Promise((resolve) => {
        terminal.headless.write('', () => {
          const { cols, rows } = terminal.info;
          resolve({ cols, rows, seq, screen: terminal.serializer.serialize() });
        });
      });
    },

    write: (id: unknown, data: string) => withTerminal(id, ({ pty }) => pty.write(data)),

    resize: (id: unknown, cols: number, rows: number) =>
      withTerminal(id, (terminal) => {
        terminal.pty.resize(cols, rows);
        terminal.headless.resize(cols, rows);
        terminal.info.cols = cols;
        terminal.info.rows = rows;
      }),

    kill: (id: unknown) => withTerminal(id, hangUp),

    /** Stops sending to a connection that closed, and ends the `commands` terminals it owns. */
    release(subscriber: Subscriber): void {
      for (const [id, terminal] of terminals) {
        terminal.subscribers.delete(subscriber);
        if (terminal.owner === subscriber) withTerminal(id, hangUp);
      }
    },

    /** Records a session's status; `false` when no terminal runs that session. */
    report(sessionId: string, event: SessionEventName): boolean {
      for (const { info } of terminals.values()) {
        if (info.sessionId !== sessionId) continue;
        info.status = event;
        return true;
      }
      return false;
    },

    killAll: () => {
      for (const id of terminals.keys()) withTerminal(id, hangUp);
    },
  };
}
