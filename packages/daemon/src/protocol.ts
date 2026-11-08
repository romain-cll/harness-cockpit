/** The protocol this build speaks; a daemon's files are named after it. */
export const PROTOCOL_VERSION = 1;

/** What a daemon another build superseded answers to a write. */
export const WRONG_BUILD = 'this background service belongs to another build of Cockpit';

import type { Session, State } from '@cockpit/state';

export { SCROLLBACK } from './scrollback';

/**
 * The private OSC sequence `cockpit setup` writes around the agent: `agent-started` right before it
 * spawns it, `agent-exited` right after it ends. In the terminal's own byte stream, so the daemon
 * reads it in order with what the program prints, with no timing involved.
 */
export const AGENT_MARKER_OSC = 6973;
export const agentMarker = (what: 'started' | 'exited') => `\u001b]${AGENT_MARKER_OSC};agent-${what}\u0007`;

/** The file descriptor a daemon's starter gives it to say it is ready: the `stdio` pipe at index 3. */
export const READY_FD = 3;

/** Upgrade token of the stream: `cockpit-<protocol>`. */
export const UPGRADE = `cockpit-${PROTOCOL_VERSION}`;

/** The header of the upgrade answer that says the daemon sends `resize` events; an earlier build of protocol 1 sends none. */
export const RESIZE_EVENTS_HEADER = 'cockpit-resize-events';

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
  /**
   * The titles a harness shows while a turn runs and between turns (regular expression sources), for a harness that
   * fires no hook on an interrupt. `marked`: the agent runs between the private markers `cockpit setup` writes.
   */
  agentTitles?: { busy: string; idle: string; marked: boolean };
}

export type SessionEventName = 'working' | 'waiting' | 'finished';

/** What `cockpit setup` reports of a setup run. */
export type SetupEventName = 'setup-running' | 'setup-done' | 'setup-failed';

/** The last setup event a session reported, as `list` gives it. */
export type SetupState = 'running' | 'done' | 'failed';

/**
 * What a client of the status endpoint sends: a status, a setup event, the agent's exit (`null` for a signal) or the
 * harness's own id for the conversation, an opaque string to the daemon.
 */
export type SessionReport =
  | { sessionId: string; event: SessionEventName | SetupEventName; fromTitle?: true }
  | { sessionId: string; event: 'exited'; exitCode: number | null }
  | { sessionId: string; event: 'harness-session'; harnessSessionId: string };

export interface TerminalInfo {
  id: number;
  kind: TerminalKind;
  /** The program the terminal was spawned with. */
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  sessionId?: string;
  workspace?: string;
  /** The last status the session reported. */
  status?: SessionEventName;
  /** The last setup event the session reported. */
  setup?: SetupState;
  /** The exit code of the agent, once the session reported `exited` (`null` for a signal). */
  exitCode?: number | null;
  /** The last conversation id the harness reported. */
  harnessSessionId?: string;
}

export interface Hello {
  protocol: number;
  build: string;
  pid: number;
}

/** `screen` is the serialized terminal (scrollback included) up to and including the chunk or size change `seq`, at `cols` x `rows`. */
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

/** A refusal carries the message to show the user. */
export interface Refused {
  status: 'refused';
  message: string;
}

/** A linked git worktree of a project, or its main working tree (`main`). */
export interface Workspace {
  path: string;
  name: string;
  branch: string | null;
  main?: true;
  /** The daemon is still setting it up (its worktree, then its session). */
  settingUp?: true;
}

/** A project with the workspaces git tells; `error` says why git could not list them, `missing` that its folder is gone. */
export interface Project {
  path: string;
  name: string;
  workspaces: Workspace[];
  error?: string;
  missing?: true;
}

export type AddProjectResult =
  | { status: 'added'; project: Project }
  /** The folder is in no repository. */
  | { status: 'not-a-repository'; folder: string }
  | Refused;

export type UpdatePathResult = { status: 'updated' } | Refused;

export type CreateWorkspaceResult = { status: 'created'; workspace: Workspace } | Refused;

/** `reserved`: the workspace exists as a row at `path` (a branch `name`) while the daemon makes it. */
export type ComposeResult = { status: 'reserved'; path: string; name: string } | Refused;

/** `dirty`: the workspace has uncommitted changes and was not removed. `branchKept`: its branch is not merged. */
export type RemoveWorkspaceResult = { status: 'removed'; branchKept: boolean } | { status: 'dirty' } | Refused;

/** A workspace the composer sent that the daemon is still making (by worktree path). */
export interface Setup {
  project: string;
  path: string;
  branch: string;
  /** `null`: no worktree, the workspace opens the project's folder (the main workspace). */
  base: string | null;
  /** A harness id, or `terminal` for the setup shell. */
  harness: string;
  task: string;
}

/** A send whose worktree could not be created, kept until dismissed. */
export interface FailedSetup {
  id: string;
  project: string;
  path: string;
  name: string;
  message: string;
  prompt: string;
  agent: string;
  base: string;
}

/** A workspace stopped setting up; `message` says why its agent could not start (the workspace stays). */
export interface SettledSetup {
  path: string;
  message?: string;
}

/** What the daemon keeps of the app's state: `state.json`, the workspaces being set up and the sends that failed. */
export interface StateSnapshot {
  state: State;
  setups: Setup[];
  failedSetups: FailedSetup[];
}

export interface StartSessionOptions {
  workspace?: { project: string; path: string };
  prompt?: string;
  /** Run `cockpit setup` in the workspace first, then the agent, then the login shell. */
  setup?: boolean;
  /** Name the workspace after the first title the agent derives from the prompt (with `workspace`). */
  nameFromTitle?: boolean;
}

export interface AvailableHarness {
  id: string;
  name: string;
  version: string | null;
  /** Where detection found it. */
  path: string;
}

/**
 * `terminal` is the session's terminal, which the requesting connection is subscribed to when it asked. A refusal
 * after the spawn names the terminal it killed, whose exit follows.
 */
export type StartSessionResult = { status: 'started'; session: Session; terminal: TerminalInfo } | (Refused & { terminal?: TerminalInfo });

export interface RemoveOptions {
  /** Run the repository's teardown first, as the app's dialog does in a terminal; one that fails refuses, unless `force`. */
  teardown?: boolean;
  force?: boolean;
  deleteBranch?: boolean;
  forceBranch?: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * What a `call` request runs in the daemon, by method name. Reads answer from any build; a write is refused by a
 * daemon another build superseded (`WRITES`).
 */
export interface Calls {
  state: { params: Record<string, never>; result: StateSnapshot };
  'project-list': { params: Record<string, never>; result: Project[] };
  /** The detected harnesses. `again` detects again; `known` is the app's own detection, which the daemon then uses. */
  harnesses: { params: { again?: boolean; known?: AvailableHarness[] }; result: AvailableHarness[] };
  'project-add': { params: { folder: string }; result: AddProjectResult };
  'project-remove': { params: { path: string }; result: void };
  'project-update-path': { params: { from: string; folder: string }; result: UpdatePathResult };
  'workspace-create': { params: { project: string; task: string; base?: string }; result: CreateWorkspaceResult };
  'workspace-compose': { params: { project: string; task: string; base: string | null; harness: string }; result: ComposeResult };
  'workspace-remove': { params: { project: string; path: string; options: RemoveOptions }; result: RemoveWorkspaceResult };
  'dismiss-setup': { params: { id: string }; result: void };
  'session-start': {
    params: { harness: string; size: TerminalSize; options?: StartSessionOptions; subscribe?: boolean };
    result: StartSessionResult;
  };
  'session-resume': { params: { sessionId: string; size: TerminalSize; subscribe?: boolean }; result: StartSessionResult };
  /** Clears the open mark of a session. */
  'session-dismiss': { params: { sessionId: string }; result: void };
  'remember-app': { params: { kind: 'editor' | 'terminal'; id: string }; result: void };
  /** The conversation id a session of an older build's daemon reported. */
  'harness-session': { params: { sessionId: string; harnessSessionId: string }; result: void };
}

export type CallMethod = keyof Calls;

/** The calls that change `state.json` or start something: refused by a daemon another build superseded. */
export const WRITES: ReadonlySet<CallMethod> = new Set<CallMethod>([
  'project-add',
  'project-remove',
  'project-update-path',
  'workspace-create',
  'workspace-compose',
  'workspace-remove',
  'dismiss-setup',
  'session-start',
  'session-resume',
  'session-dismiss',
  'remember-app',
  'harness-session',
]);

/**
 * Client to daemon, one JSON object per line. `write`, `resize` and `kill` get no answer (a resize is
 * announced to the subscribers by a `resize` event). A
 * `terminal` is an id `spawn` answered; the daemon ignores one it does not hold.
 */
export type Request =
  | { id: number; type: 'hello'; build: string }
  | { id: number; type: 'call'; method: CallMethod; params: unknown }
  | { id: number; type: 'spawn'; options: SpawnOptions }
  | { id: number; type: 'list' }
  | { id: number; type: 'attach'; terminal: unknown }
  | { type: 'write'; terminal: unknown; data: string }
  | { type: 'resize'; terminal: unknown; cols: number; rows: number }
  | { type: 'kill'; terminal: unknown };

/** Daemon to client, one JSON object per line. `exit` goes to every connection. */
export type Message =
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { type: 'data'; terminal: number; seq: number; data: string }
  | { type: 'resize'; terminal: number; seq: number; cols: number; rows: number }
  | ({ type: 'exit'; terminal: number } & TerminalExit)
  | ({ type: 'status' } & SessionReport)
  | { type: 'title'; sessionId: string; title: string }
  /** The state after a change, to every connection. */
  | ({ type: 'state' } & StateSnapshot)
  /** A terminal another connection, or the daemon, spawned. */
  | { type: 'spawned'; terminal: TerminalInfo }
  | ({ type: 'settled' } & SettledSetup);

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
