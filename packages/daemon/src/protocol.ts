/** The protocol this build speaks; a daemon's files are named after it. */
export const PROTOCOL_VERSION = 1;

export { SCROLLBACK } from './scrollback';

/** Upgrade token of the stream: `cockpit-<protocol>`. */
export const UPGRADE = `cockpit-${PROTOCOL_VERSION}`;

/** `shell`: the terminal page. `session`: an agent. `commands`: setup or teardown, bound to the connection that spawned it. */
export type TerminalKind = 'shell' | 'session' | 'commands';

export interface SpawnOptions {
  kind: TerminalKind;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** The session a `session` terminal belongs to; its status reports are looked up by it. */
  sessionId?: string;
  /** The worktree a terminal runs in, when it runs in a workspace. */
  workspace?: string;
}

export type SessionEventName = 'working' | 'waiting' | 'finished';

export interface TerminalInfo {
  id: number;
  kind: TerminalKind;
  cwd: string;
  cols: number;
  rows: number;
  sessionId?: string;
  workspace?: string;
  /** The last status the session reported. */
  status?: SessionEventName;
}

export interface Hello {
  protocol: number;
  build: string;
  pid: number;
}

/** `screen` is the serialized terminal (scrollback included) up to and including the chunk `seq`. */
export interface Attached {
  cols: number;
  rows: number;
  screen: string;
  seq: number;
}

/** `null` / `null` when the daemon died while the terminal was open. */
export interface TerminalExit {
  exitCode: number | null;
  signal: number | null;
}

/**
 * Client to daemon, one JSON object per line. `write`, `resize` and `kill` get no answer. A
 * `terminal` is an id `spawn` answered; the daemon ignores one it does not hold.
 */
export type Request =
  | { id: number; type: 'hello'; build: string }
  | { id: number; type: 'spawn'; options: SpawnOptions }
  | { id: number; type: 'list' }
  | { id: number; type: 'attach'; terminal: unknown }
  | { type: 'write'; terminal: unknown; data: string }
  | { type: 'resize'; terminal: unknown; cols: number; rows: number }
  | { type: 'kill'; terminal: unknown };

/** Daemon to client, one JSON object per line. */
export type Message =
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { type: 'data'; terminal: number; seq: number; data: string }
  | ({ type: 'exit'; terminal: number } & TerminalExit)
  | { type: 'status'; sessionId: string; event: SessionEventName };

/** Splits a stream into its JSON lines. A line that does not parse is dropped. */
export function lineReader(onMessage: (message: unknown) => void): (chunk: Buffer | string) => void {
  let buffered = '';
  return (chunk) => {
    buffered += chunk.toString();
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line === '') continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // Not JSON: nothing to act on.
      }
    }
  };
}

export const encode = (message: Request | Message): string => `${JSON.stringify(message)}\n`;
