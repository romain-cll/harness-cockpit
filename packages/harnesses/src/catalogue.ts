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
}

// Every fact below was checked on 2026-10-20 against the source named next to it.

// An empty variable counts as unset.
function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir();
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
  },
];

for (const harness of catalogue) {
  Object.freeze(harness.continueLast);
  Object.freeze(harness);
}

export const harnesses: readonly Harness[] = Object.freeze(catalogue);
