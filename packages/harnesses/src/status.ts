import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessId } from './catalogue';

// How each harness is told to report the status of its session. Everything is passed through
// argv and the environment of the spawn, never written in the user's repository or global
// config. Every hook runs the `cockpit` CLI of `apps/cli`, `<cli> status <event>`, which always
// exits 0 and prints nothing; this package does not depend on it: the caller passes in its path.
// The `UserPromptSubmit` hook of Claude Code and Codex (and OpenCode's plugin) also runs
// `<cli> session-id <harness>`, which hands the hook's stdin to the adapter's `sessionIdFrom`.
//
// Every fact below carries its source. Checked on 2026-10-25 against Claude Code 2.1.310,
// Codex 0.163.0 and OpenCode 2.0.31.

/** The states a harness reports; the values of `SESSION_EVENTS` of `@cockpit/daemon`. */
export type StatusEvent = 'working' | 'waiting' | 'finished';

export interface StatusLaunchOptions {
  /** The absolute path of the `cockpit` CLI, which reports an event for the session the process belongs to. */
  cli: string;
  /** Where OpenCode's plugin is written, in `<pluginsDir>/opencode-status/`. */
  pluginsDir: string;
  /** The environment the harness would run with. */
  env: NodeJS.ProcessEnv;
}

export interface StatusLaunch {
  /** Arguments that go before `harness.start(prompt)`. */
  args: string[];
  /** The environment to run the harness with: `env` plus what the status needs. */
  env: NodeJS.ProcessEnv;
}

/**
 * The arguments and environment that make `harnessId` report its status. For OpenCode it
 * writes the plugin (every start). A harness that cannot be configured (an unusable
 * `OPENCODE_CONFIG_CONTENT`) comes back unchanged.
 */
export async function statusLaunch(
  harnessId: HarnessId,
  { cli, pluginsDir, env }: StatusLaunchOptions,
): Promise<StatusLaunch> {
  const command = hookCommand(cli);
  switch (harnessId) {
    case 'claude-code':
      return {
        args: ['--settings', JSON.stringify({ hooks: claudeHooks(command, sessionIdCommand(cli, harnessId)) })],
        env: { ...env },
      };
    case 'codex':
      return {
        args: ['--no-daemon', '-c', `hooks=${codexHooks(command, sessionIdCommand(cli, harnessId))}`],
        env: { ...env },
      };
    case 'opencode':
      return openCodeLaunch(cli, pluginsDir, env);
  }
}

// The shell line of a hook (the harnesses run it by a shell): the CLI's path single-quoted, a `'`
// in it written `'\''`, so a space, a `$(…)` or a quote reaches the CLI as part of one argument.
const quoted = (cli: string) => `'${cli.replaceAll("'", "'\\''")}'`;
const hookCommand = (cli: string) => (event: StatusEvent) => `${quoted(cli)} status ${event}`;
const sessionIdCommand = (cli: string, harnessId: HarnessId) => `${quoted(cli)} session-id ${harnessId}`;

// --- Claude Code ---------------------------------------------------------------------------

// `--settings <file-or-json>` takes a path to a settings JSON file or a JSON string to load
// additional settings from (`claude --help` 2.1.310; https://code.claude.com/docs/en/cli-reference,
// https://code.claude.com/docs/en/settings). The hook events, `command` hooks, `timeout` in
// seconds and the absence of `matcher` meaning every occurrence are those of
// https://code.claude.com/docs/en/hooks.
// - Working: `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `ElicitationResult`.
// - Waiting: `PermissionRequest`, `Elicitation`.
// - Finished: `Stop`, `StopFailure`.
// Not reported (same page; Claude Code 2.1.319, every hook logged in a pty on 2026-11-07): Esc fires no
// hook, before any output, mid-stream or during an auto-allowed tool, and `Stop` does not run on a user
// interrupt; Esc or "No" at a permission prompt fires none after `PermissionRequest`, which stays true
// ("waiting"); an approved tool keeps "waiting" until it ends. The title is the only signal of an Esc
// before any output (the transcript shows nothing): `turnTitles` in `catalogue.ts`, read by the daemon.
// The session id is reported by the second hook of the `UserPromptSubmit` group: every hook gets
// the JSON input with `session_id` on stdin (same page), and a prompt is sent only to a
// conversation that exists, unlike `SessionStart`, which also fires for `/clear` and `/resume`
// before any prompt.
function claudeHooks(command: (event: StatusEvent) => string, sessionId: string) {
  const byEvent: Record<string, StatusEvent> = {
    UserPromptSubmit: 'working',
    PostToolUse: 'working',
    PostToolUseFailure: 'working',
    ElicitationResult: 'working',
    PermissionRequest: 'waiting',
    Elicitation: 'waiting',
    Stop: 'finished',
    StopFailure: 'finished',
  };
  return Object.fromEntries(
    Object.entries(byEvent).map(([name, event]) => [
      name,
      [
        {
          hooks: [
            { type: 'command', command: command(event), timeout: 5 },
            ...(name === 'UserPromptSubmit' ? [{ type: 'command', command: sessionId, timeout: 5 }] : []),
          ],
        },
      ],
    ]),
  );
}

// --- Codex ---------------------------------------------------------------------------------

// `--no-daemon` and `-c key=value` (a config override, the value read as TOML) are Codex's
// own flags (`codex --help` 0.163.0; sources in openai/codex `codex-rs` at `rust-v0.163.0`).
// Hooks are a `hooks` config table of events, each a list of `{ matcher?, hooks: [...] }`
// groups whose hooks are `{ type = "command", command, timeout }`, `timeout` in seconds
// (same source).
// - Working: `UserPromptSubmit`, `PostToolUse`.
// - Waiting: `PermissionRequest`, and `PreToolUse` with the matcher `^request_user_input$`.
// - Finished: `Stop`, `Interrupt`.
// Not reported: a turn that ends on an error fires no `Stop`.
//
// A hook that is not trusted does not run ("Hooks need review"). Trust lives in `hooks.state`,
// keyed `<source>:<event_snake>:<group index>:<hook index>` with `trusted_hash`, the source of
// a `-c` override being `/<session-flags>/config.toml` (source at `rust-v0.163.0`, not in the
// docs). The hash is `sha256:` + hex SHA-256 of the key-sorted JSON of
// `{ event_name, hooks: [{ async, command, timeout, type }], matcher? }`. The fixture of the
// tests is a pair computed and accepted as trusted by the real Codex 0.163.0. A second hook of
// a group has the same formula under the hook index 1 (`hooks/src/engine/discovery.rs`): the
// session-id hook, second of the `UserPromptSubmit` group. Its pair was not run by a real Codex.
const CODEX_TIMEOUT = 3;
const CODEX_EVENTS: ReadonlyArray<{ name: string; snake: string; event: StatusEvent; matcher?: string }> = [
  { name: 'UserPromptSubmit', snake: 'user_prompt_submit', event: 'working' },
  { name: 'PostToolUse', snake: 'post_tool_use', event: 'working' },
  { name: 'PermissionRequest', snake: 'permission_request', event: 'waiting' },
  { name: 'PreToolUse', snake: 'pre_tool_use', event: 'waiting', matcher: '^request_user_input$' },
  { name: 'Stop', snake: 'stop', event: 'finished' },
  { name: 'Interrupt', snake: 'interrupt', event: 'finished' },
];

/** The `trusted_hash` Codex computes for a synchronous command hook with a timeout of 3 s. */
export function codexTrustHash(eventName: string, command: string, matcher?: string): string {
  const identity: Record<string, unknown> = {
    event_name: eventName,
    hooks: [{ async: false, command, timeout: CODEX_TIMEOUT, type: 'command' }],
  };
  if (matcher !== undefined) identity.matcher = matcher;
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

// A JSON string is a TOML basic string.
const toml = (text: string) => JSON.stringify(text);

function codexHooks(command: (event: StatusEvent) => string, sessionId: string): string {
  // The commands of each event's group: its status hook, then (`UserPromptSubmit`) the session-id hook.
  const groups = CODEX_EVENTS.map((entry) => ({
    ...entry,
    commands: [command(entry.event), ...(entry.name === 'UserPromptSubmit' ? [sessionId] : [])],
  }));
  const events = groups.map(({ name, matcher, commands }) => {
    const matching = matcher === undefined ? '' : `matcher=${toml(matcher)},`;
    const hooks = commands.map((line) => `{type="command",command=${toml(line)},timeout=${CODEX_TIMEOUT}}`);
    return `${name}=[{${matching}hooks=[${hooks.join(',')}]}]`;
  });
  const state = groups.flatMap(({ snake, matcher, commands }) =>
    commands.map(
      (line, index) =>
        `${toml(`/<session-flags>/config.toml:${snake}:0:${index}`)}={trusted_hash=${toml(codexTrustHash(snake, line, matcher))}}`,
    ),
  );
  return `{${events.join(',')},state={${state.join(',')}}}`;
}

// --- OpenCode ------------------------------------------------------------------------------

// `--standalone` runs with a private server instead of the background service (`opencode --help`
// 2.0.31), so the session's environment reaches the plugin. `OPENCODE_CONFIG_CONTENT` is a JSON
// config whose `plugins` array lists plugin folders; the legacy `plugin` key is left alone. A
// plugin is an ESM module whose default export is `{ id, setup(ctx) }`, `ctx.event.subscribe()`
// giving an async iterable of `{ type, data }` events (source in `anomalyco/opencode` at
// `v2.0.31`, not in the docs).
async function openCodeLaunch(
  cli: string,
  pluginsDir: string,
  env: NodeJS.ProcessEnv,
): Promise<StatusLaunch> {
  const unchanged = { args: [], env: { ...env } };
  const folder = join(pluginsDir, 'opencode-status');

  let config: Record<string, unknown> = {};
  const given = env.OPENCODE_CONFIG_CONTENT;
  if (given !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(given);
    } catch {
      return unchanged;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return unchanged;
    config = parsed as Record<string, unknown>;
    if (config.plugins !== undefined && !Array.isArray(config.plugins)) return unchanged;
  }

  await writePlugin(folder, cli);
  const plugins = [...((config.plugins as unknown[] | undefined) ?? []), folder];
  return {
    args: ['--standalone'],
    env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugins }) },
  };
}

// A temporary file, then a rename: an OpenCode starting at the same time never reads half of it.
async function writePlugin(folder: string, cli: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'server.js');
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, openCodePlugin(cli));
  await rename(temporary, file);
}

// The events below are OpenCode's (`anomalyco/opencode` at `v2.0.31`):
// - `session.execution.started` / `succeeded` / `failed` / `interrupted`: `data.sessionID`.
// - `permission.asked`: `data.{ id, sessionID }`; `permission.replied`: `data.{ sessionID,
//   requestID }`. OpenCode emits no reply for a permission interrupted while pending, so the
//   end of an execution drops its session's pending ones.
// - `form.created`: `data.form.{ id, sessionID }`; `form.replied` and `form.cancelled`:
//   `data.{ sessionID, id }`.
// Not reported: a plain-text question ends the execution, so it reports `finished`.
// - The session id: `session.execution.started` also fires for subagent sessions; the plugin's
//   `ctx.session.get({ sessionID })` (`packages/plugin/src/promise/session.ts`) gives a
//   `Session.Info`, whose `parentID` marks a subagent. A fork has `fork`, not `parentID`
//   (`core/src/session/projector.ts`), so it counts as a root.

/** The source text of the plugin; the path of the CLI is embedded as a JSON string. */
export function openCodePlugin(cli: string): string {
  return `import { spawn } from 'node:child_process';

const cli = ${JSON.stringify(cli)};

// Pending permissions and forms per session, and the running executions.
const pending = new Map();
const running = new Set();
let ran = false;
let current = null;
let queue = Promise.resolve();
let idQueue = Promise.resolve();
let reportedId = null;

function state() {
  for (const ids of pending.values()) if (ids.size > 0) return 'waiting';
  if (running.size > 0) return 'working';
  return ran ? 'finished' : null;
}

// The CLI is spawned directly, with no shell: its path needs no quoting.
function run(event) {
  return new Promise((resolve) => {
    const child = spawn(cli, ['status', event], { stdio: 'ignore' });
    child.on('error', resolve);
    child.on('close', resolve);
  });
}

// \`<cli> session-id opencode\` with the id on stdin; the CLI is spawned directly, like \`status\`.
function runId(id) {
  return new Promise((resolve) => {
    const child = spawn(cli, ['session-id', 'opencode'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.on('error', () => {});
    child.on('error', resolve);
    child.on('close', resolve);
    child.stdin.end(id);
  });
}

// A root session's id, once per change and one at a time: a subagent's session (a \`parentID\`) is skipped.
function reportId(ctx, sessionID) {
  idQueue = idQueue.then(async () => {
    try {
      if (sessionID === reportedId) return;
      const info = await ctx.session.get({ sessionID });
      if (info.parentID) return;
      reportedId = sessionID;
      await runId(sessionID);
    } catch {
      // A session that cannot be read: not reported.
    }
  });
}

// One report at a time, in the order of the changes, and only when the state changes.
function report() {
  const next = state();
  if (next === null || next === current) return;
  current = next;
  queue = queue.then(() => run(next));
}

function add(sessionID, id) {
  if (!pending.has(sessionID)) pending.set(sessionID, new Set());
  pending.get(sessionID).add(id);
}

function remove(sessionID, id) {
  pending.get(sessionID)?.delete(id);
}

function handle(ctx, { type, data }) {
  switch (type) {
    case 'session.execution.started':
      running.add(data.sessionID);
      ran = true;
      reportId(ctx, data.sessionID);
      break;
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      running.delete(data.sessionID);
      pending.delete(data.sessionID);
      break;
    case 'permission.asked':
      add(data.sessionID, 'permission:' + data.id);
      break;
    case 'permission.replied':
      remove(data.sessionID, 'permission:' + data.requestID);
      break;
    case 'form.created':
      add(data.form.sessionID, 'form:' + data.form.id);
      break;
    case 'form.replied':
    case 'form.cancelled':
      remove(data.sessionID, 'form:' + data.id);
      break;
    default:
      return;
  }
  report();
}

export default {
  id: 'cockpit.session-status',
  setup(ctx) {
    if (!process.env.COCKPIT_SOCKET || !process.env.COCKPIT_SESSION_ID) return;
    (async () => {
      for await (const event of ctx.event.subscribe()) {
        try {
          handle(ctx, event);
        } catch {
          // An event of another shape: ignored.
        }
      }
    })().catch(() => {});
  },
};
`;
}
