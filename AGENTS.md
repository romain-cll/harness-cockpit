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
Claude Code / OpenCode / Codex ──stdio──▶ cockpit-mcp (MCP server) ──▶ MemoryService ──▶ LocalStore (~/.cockpit: md + SQLite FTS)
                                                                                    └─▶ CloudStore (stub)
```

- `cockpit-mcp` is a standard **stdio** MCP server, **launched automatically by the harness**. The user never starts anything by hand.
- **Nothing is injected at session start** apart from the MCP server instructions. The agent fetches what it needs with `memory_search` as the conversation goes. What an agent must always know belongs in the user's own `AGENTS.md` / `CLAUDE.md`, not in this server.
- **No daemon.** The MCP process embeds `packages/memory` directly. Several MCP processes may run at once on the same files, which SQLite in WAL mode handles.
- **Do not assume one MCP process per session.** Claude Code starts one per session, but OpenCode keeps long-lived MCP processes in its resident service and shares them across sessions.

### Principles to follow

1. **MCP tools independent of the transport.** `packages/mcp-server` exports `createMcpServer(service, options)`. `apps/mcp` mounts it over stdio; the same server must be mountable over HTTP without a rewrite, so no stdio-specific code in `packages/mcp-server`.
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
  mcp/               # `cockpit-mcp` bin: stdio MCP server
packages/
  memory/            # types, scopes, MemoryStore interface, MemoryService, LocalStore, CloudStore (stub)
  mcp-server/        # MCP tool definitions and context resolution, depends only on MemoryService
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
- **Entry**: `id`, `scope`, `projectId?`, `sessionId?`, `content` (markdown), `tags[]`, `source` (harness), `createdAt`, `updatedAt`.
- Visibility: a `project` memory only appears in its project; a `global` memory appears everywhere.

## Context resolution (`packages/mcp-server`)

The agent never passes the project, the session or the harness itself: the server resolves them.

- **Project directory**: passed by the app to `createMcpServer`. `apps/mcp` passes `process.cwd()`: Claude Code, OpenCode and Codex all start a stdio server in the project (or launch) directory.
  - Do not use MCP roots: they are deprecated since protocol version 2026-07-28, and Codex does not support them.
  - Do not rely on harness environment variables such as `CLAUDE_PROJECT_DIR`: they leak into child processes. An OpenCode started from a Claude Code terminal passes the parent Claude session's variables to its MCP servers.
- **`projectId`**: hash of the `realpath` of `git rev-parse --path-format=absolute --git-common-dir`, run from the project directory. Every worktree and subdirectory of a repository therefore shares one `projectId`, like Claude Code's own auto memory. Without git, hash of the project directory, which covers sessions outside any project.
- **`source`**: the client name the harness sends when it connects (`claude-code`, `opencode`…).
- **`sessionId`**: `CLAUDE_CODE_SESSION_ID` when the client is Claude Code; otherwise an id generated when the MCP process starts. Session resume (`--resume`) is not handled.

### Harness behavior

Claude Code 2.1.302 and OpenCode 2.0.31 verified in practice; Codex from its docs and source only, not tested.

| | Claude Code | OpenCode | Codex |
|---|---|---|---|
| `roots/list` | launch directory (even a subdirectory) | project directory | not supported |
| `process.cwd()` | launch directory | project directory | Codex process cwd, unless `cwd` is set |
| Environment | full parent env, plus `CLAUDE_PROJECT_DIR` and `CLAUDE_CODE_SESSION_ID` | full parent env, including `CLAUDE_*` variables leaked from a parent Claude session | allowlist only (`HOME`, `PATH`, `USER`…) plus `env` / `env_vars` |
| MCP process lifetime | one per session | long-lived, shared across sessions by the resident `opencode serve` service | not documented |
| Server `instructions` injected | yes, cut at 4,096 characters | yes, only when the server exposes at least one tool | yes, no documented cap; keep the first 512 characters self-contained |
| Session id available | `CLAUDE_CODE_SESSION_ID` | no | no |

## MCP tools and instructions (`packages/mcp-server`)

| Tool | Input | Notes |
|---|---|---|
| `memory_search` | `query`, `scope?` (defaults to `all`), `limit?` | FTS, sorted by relevance then recency |
| `memory_write` | `content`, `scope`, `tags?` | returns the `id` |
| `memory_update` | `id`, `content?`, `tags?` | |
| `memory_delete` | `id` | |

- **Server instructions** (returned by `initialize`): short, under 500 characters, written as factual statements. They say when to call `memory_search` and `memory_write`.
- Keep tool results small: return only the matching entries, within `limit`.

## Installation (`scripts/install-claude.ts`)

Idempotent:
- `claude mcp add --scope user cockpit -- <path to the cockpit-mcp binary>`, no change if `cockpit` is already registered;
- symmetric uninstall script that restores the initial state.

MCP servers the user has already configured must keep working.

## Other harnesses

- **Codex**: same binary, declared in `~/.codex/config.toml` (`mcp_servers`).
- **OpenCode**: same binary, declared in the `mcp` section of the OpenCode config (`type: "local"`).
- **Never** modify the `AGENTS.md` of the user's repository.

## Tests and validation

- `packages/memory` (vitest): CRUD, FTS, scope filtering, rebuilding the index from the files, concurrent writes from 2 processes.
- `packages/mcp-server` (vitest): context resolution; a git worktree and a subdirectory resolve to the same `projectId` as the main checkout, and a directory outside git gets its own.
- `apps/mcp`: the binary responds over stdio (test with MCP Inspector).
- End to end, after `install-claude`, with the stock `claude` in a real repository:
  - "Remember that X" → Claude calls `memory_write` (scope `project`);
  - new session in the same repository, then in one of its worktrees → asked about X, Claude calls `memory_search` and finds X;
  - in another repository, X is absent; a `global` memory is found everywhere;
  - existing MCP servers still work, and uninstalling restores the initial state.
