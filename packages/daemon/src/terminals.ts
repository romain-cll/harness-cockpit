import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as Headless } from '@xterm/headless';
import { spawn, type IPty } from 'node-pty';
import { AGENT_MARKER_OSC, SCROLLBACK, type Attached, type SessionEventName, type SessionReport, type SetupState, type SpawnOptions, type TerminalExit, type TerminalInfo } from './protocol';

/** Who receives what a terminal produces: one connection. */
export interface Subscriber {
  data(terminal: number, seq: number, data: string): void;
  /** The pty's size changed; numbered like a chunk of output, in the same sequence. */
  resize(terminal: number, seq: number, cols: number, rows: number): void;
  exit(terminal: number, exit: TerminalExit): void;
  /** The title a `session` terminal's program set (OSC 0 or 2), once per change. */
  title(sessionId: string, title: string): void;
}

interface Terminal {
  info: TerminalInfo;
  pty: IPty;
  headless: Headless;
  serializer: SerializeAddon;
  /** The sequence number of the last chunk the pty produced or size change it took. */
  seq: number;
  subscribers: Set<Subscriber>;
  /** The connection a `commands` terminal ends with. */
  owner?: Subscriber;
  /** The pending SIGKILL of a terminal that was hung up, cleared when it exits. */
  killTimer?: NodeJS.Timeout;
  /** The status in `info` was recorded from the title (an interrupted turn), not reported: a busy title undoes it. */
  fromTitle?: boolean;
}

/** How long a hung-up process has to end before it is killed. */
const HANGUP_GRACE_MS = 1000;

/**
 * The terminals the daemon owns: node-pty sessions, each mirrored by a headless terminal that
 * follows the pty's size, so that a client attaching later gets the screen as it is. Every chunk
 * of output carries a sequence number, per terminal.
 */
export function createTerminals(onEnd: () => void, onTitleStatus: (report: SessionReport) => void) {
  const terminals = new Map<unknown, Terminal>();
  let lastId = 0;
  // Who waits for the last terminal to end.
  const emptied: Array<() => void> = [];

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
      const { kind, command, args, cwd, env, cols, rows, sessionId, workspace, agentTitles } = options;
      const pty = spawn(command, args, { name: env.TERM ?? 'xterm-256color', cwd, env, cols, rows });
      const headless = new Headless({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
      const serializer = new SerializeAddon();
      headless.loadAddon(serializer);

      const id = ++lastId;
      const info: TerminalInfo = { id, kind, command, cwd, cols, rows, ...(sessionId !== undefined && { sessionId }), ...(workspace !== undefined && { workspace }) };
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

      if (kind === 'session' && sessionId !== undefined) {
        // Titles count only between the markers `cockpit setup` writes around the agent (in the stream, so
        // the parser meets them in the order the program wrote them): the setup's and the login shell's
        // never name a workspace.
        let forwarding = false;
        let lastTitle: string | undefined;
        // The turn titles of a harness that fires no hook on an interrupt (COCKPIT-50), read in the same
        // window as the markers; with no markers the agent is the whole terminal. `busySeen`: a busy title
        // came since the last idle one.
        const turn = agentTitles && { busy: new RegExp(agentTitles.busy), idle: new RegExp(agentTitles.idle) };
        let inAgent = !agentTitles?.marked;
        let busySeen = false;
        headless.parser.registerOscHandler(AGENT_MARKER_OSC, (data) => {
          forwarding = data === 'agent-started';
          lastTitle = undefined;
          inAgent = forwarding;
          busySeen = false;
          return true;
        });
        const setStatusFromTitle = (event: SessionEventName, fromTitle: boolean) => {
          info.status = event;
          terminal.fromTitle = fromTitle;
          onTitleStatus({ sessionId, event, ...(fromTitle && { fromTitle: true as const }) });
        };
        headless.onTitleChange((title) => {
          if (turn && inAgent) {
            // Busy then idle while working is a turn that ended with no `Stop`; a busy title after that is a new turn.
            if (turn.busy.test(title)) {
              busySeen = true;
              if (terminal.fromTitle) setStatusFromTitle('working', false);
            } else if (turn.idle.test(title)) {
              if (busySeen && info.status === 'working') setStatusFromTitle('finished', true);
              busySeen = false;
            }
          }
          if (!forwarding || title === lastTitle) return;
          lastTitle = title;
          for (const each of terminal.subscribers) each.title(sessionId, title);
        });
      }
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
        if (terminals.size === 0) for (const resolve of emptied.splice(0)) resolve();
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
          // The headless size, not the pty's: a resize queued after this write is not applied yet.
          const { cols, rows } = terminal.headless;
          resolve({ cols, rows, seq, screen: terminal.serializer.serialize() });
        });
      });
    },

    write: (id: unknown, data: string) => withTerminal(id, ({ pty }) => pty.write(data)),

    resize: (id: unknown, cols: number, rows: number) =>
      withTerminal(id, (terminal) => {
        const { info, headless } = terminal;
        if (cols === info.cols && rows === info.rows) return;
        terminal.pty.resize(cols, rows);
        info.cols = cols;
        info.rows = rows;
        const seq = ++terminal.seq;
        // After the chunks written before: the headless terminal takes the size at the place of the event.
        headless.write('', () => headless.resize(cols, rows));
        for (const each of terminal.subscribers) each.resize(info.id, seq, cols, rows);
      }),

    kill: (id: unknown) => withTerminal(id, hangUp),

    /** Stops sending to a connection that closed, and ends the `commands` terminals it owns. */
    release(subscriber: Subscriber): void {
      for (const [id, terminal] of terminals) {
        terminal.subscribers.delete(subscriber);
        if (terminal.owner === subscriber) withTerminal(id, hangUp);
      }
    },

    /** Records what a session reported; `false` when no terminal runs that session. */
    report(report: SessionReport): boolean {
      for (const terminal of terminals.values()) {
        const { info } = terminal;
        if (info.sessionId !== report.sessionId) continue;
        terminal.fromTitle = false;
        if (report.event === 'exited') info.exitCode = report.exitCode;
        else if (report.event === 'harness-session') info.harnessSessionId = report.harnessSessionId;
        else if (report.event.startsWith('setup-')) info.setup = report.event.slice('setup-'.length) as SetupState;
        else info.status = report.event as SessionEventName;
        return true;
      }
      return false;
    },

    /** Settles once no terminal runs: after `killAll`, when each has exited (a hang-up ignored is followed by SIGKILL). */
    whenEmpty: (): Promise<void> => (terminals.size === 0 ? Promise.resolve() : new Promise((resolve) => emptied.push(resolve))),

    killAll: () => {
      for (const id of terminals.keys()) withTerminal(id, hangUp);
    },
  };
}
