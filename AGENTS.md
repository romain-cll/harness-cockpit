# AGENTS.md — cockpit

**cockpit** is a provisional working name. It appears in the binary name (`cockpit-mcp`) and in the data directory (`~/.cockpit`).

## Rule #1: no over-engineering

Do not add any abstraction, package or app beyond what this file describes. When in doubt, do the simplest thing.

## Language

Everything in this repository is written in English: code, identifiers, comments, documentation, branch names, commit messages, and pull request titles and descriptions.

## Product

A desktop application that drives agent CLIs (Claude Code, Codex, OpenCode, Kimi, Mistral, Cursor CLI…) through node-pty, following Superset's projects / workspaces model.

Differentiators:
- sessions outside any project (multi-agent exploration without a repository);
- **memory shared across harnesses**;
- artifacts on storage you own;
- usage statistics.

Today the repository covers **only the cross-harness memory**, as a regular local MCP server usable with the stock `claude`. Daemon, Electron, pty, UI, artifacts, stats, real cloud backend, embeddings, mobile: create none of these without an explicit request.

## Architecture

```
Claude Code ──stdio──▶ cockpit-mcp (MCP server) ──────────▶ MemoryService ──▶ LocalStore (~/.cockpit: md + SQLite FTS)
            ──hook───▶ cockpit-mcp hook session-start ──┘                 └─▶ CloudStore (stub)
```

- `cockpit-mcp` is a standard **stdio** MCP server, **launched automatically by Claude Code**. The user never starts anything by hand.
- The same binary acts as the `SessionStart` hook (`hook session-start` subcommand): it injects the memory context when the session starts.
- **No daemon.** The MCP process embeds `packages/memory` directly. Several parallel sessions mean several processes on the same files, which SQLite in WAL mode handles.
- **Current project** = git root of `process.cwd()`. No header, port or token.

### Principles to follow

1. **MCP tools independent of the transport.** `packages/mcp-server` exports `createMcpServer(service, context)`. `apps/mcp` mounts it over stdio; the same server must be mountable over HTTP without a rewrite, so no stdio-specific code in `packages/mcp-server`.
2. **Storage behind a single interface** (`MemoryStore`). The local / cloud choice is made **only** in `apps/mcp/src/main.ts`, from the config.
3. **No business logic in `apps/`.** Everything lives in `packages/`; apps only wire things together.

## Monorepo

- **Bun** (package manager, workspaces, script runner) + **Turborepo**, TypeScript.
- Binary runtime: **Node 22+**. `better-sqlite3` is a native Node module.
- Set up by hand, without the `create-turbo` template:
  - root `package.json`: `apps/*` and `packages/*` workspaces, scripts that delegate to Turbo;
  - `turbo.json`: `build`, `dev`, `test`, `typecheck`, `lint` tasks;
  - `tsconfig.base.json`, extended by every package.
- Internal dependencies declared as `"workspace:*"`.

```
apps/
  mcp/               # `cockpit-mcp` bin: stdio MCP server + `hook session-start` subcommand
packages/
  memory/            # types, scopes, MemoryStore interface, MemoryService, LocalStore, CloudStore (stub)
  mcp-server/        # MCP tool definitions, depends only on MemoryService
scripts/
  install-claude.ts  # global install for Claude Code (+ uninstall)
```

- No other app (daemon, desktop, cloud) without an explicit request.
- **Internal packages consumed as TS source**, with no separate per-package build.
- **`apps/mcp`** is bundled with `tsup` into a single binary. `better-sqlite3` stays an external dependency because it is a native module.
- **Tests** with `vitest`, **validation** with `zod`.

### Commands

```sh
bun install
bun run build       # turbo run build
bun run test        # turbo run test
bun run typecheck   # turbo run typecheck
bun run lint        # turbo run lint
bun turbo run build test typecheck   # several tasks in one pass
```

## Storage

```ts
// packages/memory
interface MemoryStore {
  write(entry: NewMemory): Promise<Memory>;
  update(id: string, patch: Partial<NewMemory>): Promise<Memory>;
  delete(id: string): Promise<void>;
  search(q: SearchQuery): Promise<Memory[]>;
  list(filter: ListFilter): Promise<Memory[]>;
}
```

- **`LocalStore`**:
  - markdown files with frontmatter in `~/.cockpit/memory/{global,projects/<projectId>,sessions/<sessionId>}/<id>.md`;
  - SQLite FTS5 index in `~/.cockpit/index.db`, WAL mode;
  - **the files are the source of truth**; the index can be rebuilt from them.
- **`CloudStore`**: stub that throws "not implemented".
- **Config** in `~/.cockpit/config.json`:
  ```json
  { "memory": { "backend": "local" } }
  { "memory": { "backend": "cloud", "url": "https://…", "token": "…" } }
  ```
- No local ↔ cloud sync: it is one or the other.

## Data model

- **Scopes**: `global`, `project`, `session`.
- **`projectId`**: hash of the git root path of the cwd. Without git, hash of the cwd, which covers sessions outside any project.
- **`sessionId`**: generated when the MCP process starts (one process per Claude session). Session resume (`--resume`) is not handled.
- **Entry**: `id`, `scope`, `projectId?`, `sessionId?`, `content` (markdown), `tags[]`, `pinned`, `source` (harness), `createdAt`, `updatedAt`.
- Visibility: a `project` memory only appears in its project; a `global` memory appears everywhere.

## MCP tools (`packages/mcp-server`)

| Tool | Input | Notes |
|---|---|---|
| `memory_search` | `query`, `scope?` (defaults to `all`), `limit?` | FTS, sorted by relevance then recency |
| `memory_write` | `content`, `scope`, `tags?`, `pinned?` | returns the `id` |
| `memory_update` | `id`, `content?`, `tags?`, `pinned?` | |
| `memory_delete` | `id` | |

The project and session come from the `context` passed to `createMcpServer`. The agent never passes them itself.

## `SessionStart` hook (`cockpit-mcp hook session-start`)

1. Reads the JSON received on stdin (`cwd`, `session_id`…).
2. Builds a markdown block from the store:
   - usage instructions (when to call `memory_search` / `memory_write`);
   - all `global` memories;
   - pinned `project` memories, then the most recent ones;
   - all within a fixed budget (~2k tokens, configurable).
3. Prints it to stdout so it gets injected into the context.

### To verify in the docs and in practice, without relying on memory

- Is the cwd of a stdio MCP server launched by Claude Code really the project directory? If not, look for a provided env variable (e.g. `CLAUDE_PROJECT_DIR`).
- The input format of `SessionStart` hooks and how their stdout is injected into the context.

## Installation (`scripts/install-claude.ts`)

Idempotent:
- `claude mcp add --scope user cockpit -- <path to the cockpit-mcp binary>`;
- adds the `SessionStart` hook to `~/.claude/settings.json`: merge, **backup before writing**, no change if the hook is already present;
- symmetric uninstall script that restores the initial state.

MCP servers and hooks the user has already configured must keep working.

## Other harnesses

- **Codex**: same binary, declared in `~/.codex/config.toml` (`mcp_servers`).
- To inject context when a harness starts, **never** modify the `AGENTS.md` of the user's repository.

## Tests and validation

- `packages/memory` (vitest): CRUD, FTS, scope filtering, rebuilding the index from the files, concurrent writes from 2 processes.
- `apps/mcp`: the binary responds over stdio (test with MCP Inspector); the hook prints the expected context block.
- End to end, after `install-claude`, with the stock `claude` in a real repository:
  - "Remember that X" → Claude calls `memory_write` (scope `project`);
  - new session in the same repository → X is present **without** a `memory_search` call (injected by the hook);
  - in another repository, X is absent; a `global` memory is present everywhere;
  - existing MCP servers and hooks still work, and uninstalling restores the initial state.
