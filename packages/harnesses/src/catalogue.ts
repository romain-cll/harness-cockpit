import { homedir } from 'node:os';
import { join } from 'node:path';

export type HarnessId = 'claude-code' | 'codex' | 'opencode';

export interface SessionStore {
  /** A folder of session files (`jsonl`) or the database file itself (`sqlite`). */
  path: string;
  format: 'jsonl' | 'sqlite';
}

export interface Harness {
  id: HarnessId;
  name: string;
  binary: string;
  /** Arguments that start an interactive session in the spawn's cwd, with an optional initial prompt. */
  start(prompt?: string): string[];
  /** Arguments that continue the most recent session of the cwd. */
  continueLast: readonly string[];
  /** Arguments that resume the session with this id. */
  resume(sessionId: string): string[];
  /** Where the harness keeps its sessions, given the environment it runs with. */
  sessions(env: NodeJS.ProcessEnv): SessionStore;
  /**
   * The name to give a workspace from a terminal title the harness set (OSC 0 or 2), or `null` when
   * the title is not derived from the user's prompt (the idle title, an unrelated title, `""`).
   */
  promptTitle(title: string): string | null;
  /**
   * The conversation id in what the harness's hook (or plugin) pipes to `cockpit session-id <harness>`, or
   * `null` when the input holds none. The id is an opaque string to everything but this adapter.
   */
  sessionIdFrom(input: string): string | null;
}

// Every fact below was checked on 2026-10-20 against the source named next to it. The flags and
// events that make a harness report its status are in `status.ts`, with their sources.

// An empty variable counts as unset.
function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir();
}

// Claude Code and Codex hooks get JSON on stdin with the conversation id as a string `session_id`
// (https://code.claude.com/docs/en/hooks, Claude Code 2.1.319; Codex: `UserPromptSubmitCommandInput` in
// `hooks/src/events/user_prompt_submit.rs`, `rust-v0.163.0`).
function hookSessionId(input: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const id = (parsed as Record<string, unknown>).session_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

// Callers share one catalogue and none may change it for the others: it is frozen
// below, with its entries and their `continueLast` lists.
const catalogue: Harness[] = [
  // Claude Code 2.1.304
  {
    id: 'claude-code',
    name: 'Claude Code',
    // Binary and version: `claude --version` prints `2.1.304 (Claude Code)`.
    binary: 'claude',
    // Directory: the spawn's cwd (`claude --help`).
    // Prompt: positional `claude "<prompt>"`, interactive; `-p` is print mode (`claude --help`).
    start: (prompt) => (prompt === undefined ? [] : [prompt]),
    // `-c, --continue` continues the most recent session of the cwd (`claude --help`).
    continueLast: ['--continue'],
    // `-r, --resume <id>` (`claude --help`).
    resume: (sessionId) => ['--resume', sessionId],
    // `~/.claude/projects/<project>/<session>.jsonl`, under `CLAUDE_CONFIG_DIR` when set
    // (https://code.claude.com/docs/en/claude-directory).
    sessions: (env) => ({
      path: join(env.CLAUDE_CONFIG_DIR || join(home(env), '.claude'), 'projects'),
      format: 'jsonl',
    }),
    // Claude Code 2.1.316 sets OSC 0 by default; `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` turns it off
    // (shipped binary). The idle title is `✳ Claude Code`. The prompt-derived title is `<glyph> <title>`,
    // the glyph `◐`/`◑` (alternating every 960 ms while busy) or `✳` when idle, a 2 to 5 word phrase from
    // a separate small-model call at the first turn (a prompt of at least 10 characters).
    promptTitle: (title) => {
      const name = /^[◐◑✳] (.+)$/.exec(title)?.[1];
      return name === undefined || name === 'Claude Code' ? null : name;
    },
    // A subagent's hook carries the main session's id plus `agent_id` (same docs page), so the id read is
    // always the main conversation's.
    sessionIdFrom: hookSessionId,
  },
  // Codex 0.163.0 (2026-10-15), sources in openai/codex `codex-rs` at `rust-v0.163.0`
  {
    id: 'codex',
    name: 'Codex',
    // Binary and version: `codex --version` prints `codex-cli 0.163.0` (`cli`).
    binary: 'codex',
    // Directory: the cwd by default; `-C/--cd` exists and is not used
    // (`utils/cli/src/shared_options.rs`; https://learn.chatgpt.com/docs/developer-commands?surface=cli).
    // Prompt: positional `codex [PROMPT]` (`tui/src/cli.rs`; same docs page).
    start: (prompt) => (prompt === undefined ? [] : [prompt]),
    // `codex resume --last` resumes the most recent session of the cwd
    // (`cli/src/main.rs` `ResumeCommand`; same docs page).
    continueLast: ['resume', '--last'],
    // `codex resume <SESSION_ID>` (same sources).
    resume: (sessionId) => ['resume', sessionId],
    // `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, `CODEX_HOME` defaulting to
    // `~/.codex`. Source code only, not in the docs (`rollout/src/recorder.rs`,
    // `utils/home-dir/src/lib.rs`).
    sessions: (env) => ({
      path: join(env.CODEX_HOME || join(home(env), '.codex'), 'sessions'),
      format: 'jsonl',
    }),
    // Codex 0.163.0 sets OSC 0 by default (`tui/src/terminal_title.rs`). The default items are
    // `activity`, `thread-name` and `project-name`, separated by `" "` after the spinner and by
    // `" | "` between the others. The idle title is the project alone; while the name is generated the
    // name slot shows a spinner. A title asking for action starts with `[ ! ] Action Required | ` or
    // `[ . ] …`, and there may be a `● ` prefix. The thread name is cut at 48 characters and comes from
    // a hidden thread after the first user message.
    promptTitle: (title) => {
      const rest = title.replace(/^(● )?(\[ [!.] \] Action Required \| )?([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] )*/, '');
      const segments = rest.split(' | ');
      if (segments.length < 2) return null;
      const name = segments.slice(0, -1).join(' | ');
      return /^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]*$/.test(name) ? null : name;
    },
    // `Session::session_id()` is "the identity shared by the root thread and all descendant threads", equal to
    // the root thread's id, so a subagent's hook gives the id `codex resume` takes (`core/src/session/session.rs`).
    sessionIdFrom: hookSessionId,
  },
  // OpenCode 2.0.31
  {
    id: 'opencode',
    name: 'OpenCode',
    // Binary and version: `opencode --version` prints `opencode v2.0.31`.
    binary: 'opencode',
    // Directory: the cwd; the optional `[<directory>]` positional is not used (`opencode --help`).
    // Prompt: `--prompt <text>`, interactive; `opencode run` is non-interactive
    // (`opencode --help`; https://opencode.ai/docs/cli/).
    start: (prompt) => (prompt === undefined ? [] : ['--prompt', prompt]),
    // `-c, --continue` (`opencode --help`).
    continueLast: ['--continue'],
    // `-s, --session <id>` (`opencode --help`).
    resume: (sessionId) => ['--session', sessionId],
    // SQLite `opencode.db` in the data dir `$XDG_DATA_HOME/opencode`, default
    // `~/.local/share/opencode` (`opencode debug paths`, run with and without `XDG_DATA_HOME`;
    // the docs' troubleshooting page still describes the 1.x `project/` layout).
    sessions: (env) => ({
      path: join(
        env.XDG_DATA_HOME || join(home(env), '.local', 'share'),
        'opencode',
        'opencode.db',
      ),
      format: 'sqlite',
    }),
    // OpenCode 2.0.31 sets OSC 0 by default (`packages/tui/src/app.tsx:578`, through OpenTUI). The idle
    // and untitled title is `OpenCode`, and it clears the title to `""` on exit. The prompt-derived title
    // is `OC | <title>`, cut to 37 characters plus `…` above 40, from a separate LLM call at the first
    // user message; a `--prompt` start goes through the normal submit path.
    promptTitle: (title) => {
      const name = /^OC \| (.+)$/.exec(title)?.[1]?.replace(/…$/, '');
      return name === undefined || name === '' ? null : name;
    },
    // Its plugin (`status.ts`) pipes the plain id of the session.
    sessionIdFrom: (input) => input.trim() || null,
  },
];

for (const harness of catalogue) {
  Object.freeze(harness.continueLast);
  Object.freeze(harness);
}

export const harnesses: readonly Harness[] = Object.freeze(catalogue);
