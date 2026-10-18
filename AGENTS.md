# AGENTS.md — cockpit

**cockpit** is a provisional working name. It appears in the binary name (`cockpit-mcp`), in the data directory (`~/.cockpit`) and in the desktop app (`Cockpit`, `com.cockpit.desktop`).

## Rule #1: no over-engineering

Do not add any abstraction, package or app beyond what this file describes. When in doubt, do the simplest thing.

## Technical choices: long-term viability first

When choosing a tool, library or framework, the criterion is long-term viability: who maintains it (an organization or a single person), release activity, real adoption, compatibility with the rest of the stack, and the cost of leaving it. Setup speed and amount of configuration are not arguments. Back the choice with verified facts.

## Language

Everything in this repository is written in English: code, identifiers, comments, documentation, branch names, commit messages, and pull request titles and descriptions.

## Product

A desktop application that drives agent CLIs (Claude Code, Codex, OpenCode, Kimi, Mistral, Cursor CLI…) through node-pty, following Superset's projects / workspaces model.

Differentiators:
- sessions outside any project (multi-agent exploration without a repository);
- **memory shared across harnesses**;
- artifacts on storage you own;
- usage statistics.

The repository is built in steps. In scope so far:
- the **cross-harness memory**, as a regular local MCP server usable with the stock `claude`;
- the **desktop app shell** (`apps/desktop`): a window, a router, a typed bridge to the main process, and the UI foundation (styling, light and dark themes, sidebar layout). No product feature yet.

Daemon, pty, product UI, artifacts, stats, real cloud backend, embeddings, web app, mobile: create none of these without an explicit request.

## Memory architecture

```
Claude Code / OpenCode / Codex ──stdio──▶ cockpit-mcp (MCP server) ──▶ MemoryService ──▶ LocalStore (~/.cockpit: markdown files)
                                                                                    └─▶ CloudStore (stub)
```

- `cockpit-mcp` is a standard **stdio** MCP server, **launched automatically by the harness**. The user never starts anything by hand.
- **Nothing is injected at session start** apart from the MCP server instructions. The agent fetches what it needs with `memory_search` as the conversation goes. What an agent must always know belongs in the user's own `AGENTS.md` / `CLAUDE.md`, not in this server.
- **No daemon.** The MCP process embeds `packages/memory` directly. Several MCP processes may run at once on the same files, which atomic per-file writes handle.
- **Do not assume one MCP process per session.** Claude Code starts one per session, but OpenCode keeps long-lived MCP processes in its resident service and shares them across sessions.

### Principles to follow

1. **MCP tools independent of the transport.** `packages/mcp-server` exports `createMcpServer(service, options)`. `apps/mcp` mounts it over stdio; the same server must be mountable over HTTP without a rewrite, so no stdio-specific code in `packages/mcp-server`.
2. **Storage behind a single interface** (`MemoryStore`). The local / cloud choice is made **only** in `apps/mcp/src/main.ts`, from the config.

## Monorepo

- **No business logic in `apps/`.** Everything lives in `packages/`; apps only wire things together.
- **Bun** (package manager, workspaces, script runner) + **Turborepo**, TypeScript.
- Runtime: **Node 22+** for `cockpit-mcp`, the oldest supported LTS line; the desktop app runs on the Node bundled with Electron (24 in Electron 44). `cockpit-mcp` has no native module; a native module (later `node-pty`) must be built for the runtime that loads it.
- Set up by hand, without the `create-turbo` template:
  - root `package.json`: `apps/*` and `packages/*` workspaces, scripts that delegate to Turbo;
  - `turbo.json`: `build`, `dev`, `test`, `typecheck`, `lint` tasks;
  - `tsconfig.base.json`, extended by every package.
- Internal dependencies declared as `"workspace:*"`.

```
apps/
  desktop/           # Electron app: main process, preload, React renderer
  mcp/               # `cockpit-mcp` bin: stdio MCP server
packages/
  memory/            # types, scopes, MemoryStore interface, MemoryService, LocalStore, CloudStore (stub)
  mcp-server/        # MCP tool definitions and context resolution, depends only on MemoryService
scripts/
  install-claude.ts  # global install for Claude Code (+ uninstall)
```

- No other app (daemon, web, cloud) without an explicit request.
- **Internal packages consumed as TS source**, with no separate per-package build.
- **`apps/mcp`** is bundled with `rolldown` 1.x into a single ESM file with a shebang, workspace packages included; the build script sets the exec bit. Rolldown has a stable semver API and a full-time team.
- **Tests** with `vitest`, **validation** with `zod` 4 (`^4.2`, required by the MCP SDK).
- **MCP** with `@modelcontextprotocol/server` 2.x, served with `serveStdio` from `@modelcontextprotocol/server/stdio`, which accepts both 2025-era clients (up to 2025-11-25) and 2026-07-28 clients. The v1 SDK is the maintenance line and will not get 2026-07-28.

### Commands

```sh
bun install
bun run build       # turbo run build
bun run test        # turbo run test; launches the desktop app, so it needs a desktop session
bun run typecheck   # turbo run typecheck
bun run lint        # turbo run lint
bun turbo run build test typecheck   # several tasks in one pass

bun run --filter @cockpit/desktop dev       # desktop app with hot reload
bun run --filter @cockpit/desktop package   # Cockpit.app in apps/desktop/release/
bun run --filter @cockpit/desktop test      # packages, then launches dev, built and packaged app
```

## Desktop app (`apps/desktop`)

- **Stack**: Electron 44, electron-vite (dev server and build), electron-builder (packaging), React 19, TanStack Router with file-based routes.
  - electron-builder rather than Electron Forge: Forge does not support Bun, and its Vite plugin leaves `node_modules` out of the package, which breaks native modules such as node-pty.
  - electron-vite has a single maintainer. It is a thin layer over Vite: if it is abandoned, replace it with Vite and a dev script. Packaging does not depend on it.
- **UI**: Tailwind CSS 4, shadcn/ui components on Base UI (`base-mira` style, made for dense interfaces), lucide icons, the system font.
  - Tailwind is a build-time tool maintained by Tailwind Labs. Its team shrank in January 2026 but releases continue; a frozen version keeps working.
  - shadcn/ui is not a runtime dependency: its CLI copies component source into the repo, which we own and edit. Base UI is maintained by the MUI company and is shadcn's default since July 2026.
  - Components import `cn`, shadcn's class merger, still young (0.x since September 2026). If it is abandoned, replace it with `clsx` + `tailwind-merge`, which have the same API.

```
src/
  main/       # main process: window, `app://` protocol, IPC handlers
  preload/    # exposes `window.api`, nothing else
  shared/     # the `Api` contract, types only
  renderer/   # React app
    routes/         # file-based routes; `__root.tsx` holds the sidebar layout
    components/     # app components
      ui/           # shadcn/ui components, added by the CLI
    styles.css      # Tailwind entry and theme tokens
```

- **Renderer boundary.** The renderer never imports `electron` or Node modules. It reaches the main process only through `window.api`, typed by `Api` in `src/shared/api.ts`. A future web app (TanStack Start) implements the same `Api` over HTTP and reuses the routes.
- **No web app or shared UI package** until a web target exists. When it does, move the renderer into a package consumed by both apps.
- **Security**:
  - `contextIsolation` and `sandbox` on, `nodeIntegration` off. A sandboxed preload cannot be an ES module, so it is bundled as CommonJS (`index.cjs`).
  - The built renderer is served from the `app://renderer` protocol, never `file://`, with a CSP in `index.html`. The router therefore uses real URLs, as on the web.
  - New windows are denied (`https` links open in the system browser), and navigation away from the app origin is blocked.
- **Dependencies**: everything the bundles import goes in `devDependencies`, and electron-vite bundles it. Only modules that cannot be bundled (native modules such as node-pty) go in `dependencies`, so electron-builder ships them and rebuilds them for Electron.
- **Styling**:
  - Tailwind utilities with the semantic tokens defined in `styles.css` (`bg-background`, `text-muted-foreground`, `bg-sidebar`…), never raw colors or `dark:` color overrides.
  - Use a shadcn/ui component before writing custom markup. Add one with `bunx --bun shadcn add <name>` from `apps/desktop` (`components.json` lives there, and `tsconfig.json` carries the `@/` alias only for the CLI). The CLI adds packages to `dependencies`: move them to `devDependencies`.
  - Add a component when a feature uses it, not ahead of time.
- **Theme**: follows the system through `prefers-color-scheme`, which Electron drives from `nativeTheme`. Dark tokens live under `@media (prefers-color-scheme: dark)`, not a `.dark` class; if the shadcn CLI adds a `.dark` block, move its variables there. A theme setting, when requested, sets `nativeTheme.themeSource` in the main process, which switches the page and the native window chrome together.
- **Window chrome**: on macOS the title bar is hidden and the window controls sit in the sidebar's top strip. The top strips of the sidebar and of each page header drag the window (`app-drag`); an interactive element inside one needs `app-no-drag`. Other platforms keep the native frame.
- **Generated route tree**: `src/renderer/routeTree.gen.ts` is generated by the router plugin on `dev` and `build`, and committed so `typecheck` works on a fresh checkout.
- **Output**: electron-vite builds to `dist/` (the Turbo `build` output), electron-builder packages to `release/`.
- **Packaging**: `package` builds an ad-hoc signed `Cockpit.app` for the current platform. Developer ID signing, notarization, installers and auto-update come later, on request.
- **Electron binary**: since Electron 42 the `electron` package no longer downloads its binary on install; it does so the first time `require('electron')` runs. electron-vite reads the binary path without triggering that download, so `dev` runs `install-electron` first (a no-op once the binary is there).
- **Terminals** (not built yet): node-pty will run in an Electron `utilityProcess`, not a daemon, so a pty crash does not take the app down. Sessions therefore end when the app quits. Any update flow must warn the user, before restarting, that the running sessions will be terminated.
- **Runtime tests**: no version ships with a risk of crashing at runtime. `build` and `typecheck` are not enough: `test` (vitest + Playwright, in `test/`) launches the app the three ways it runs, the `dev` script, the built app and the packaged `Cockpit.app`, and checks that each one renders, keeps Node out of the renderer, logs no error and keeps running. Every change to the desktop app extends these tests to cover what it adds.
  - Playwright is maintained by Microsoft and widely adopted; its Electron support is labelled experimental. It drives the app through Electron's inspector, so never disable the `EnableNodeCliInspectArguments` fuse in test builds.

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
  - markdown files with frontmatter in `~/.cockpit/memory/{global,projects/<projectId>}/<id>.md`;
  - one file per memory, written to a temporary file then renamed, so concurrent processes never see a partial file;
  - **no index, no database**: `search` reads the files at each call. 10,000 memories scan in about 125 ms; an index is added only once a real need is measured.
- **Keep the storage replaceable** (an index, embeddings or the cloud can come later without migrating data):
  - the frontmatter format is stable and carries every field of the entry;
  - `memory_search` takes free text, with no query operator syntax;
  - ranking is "most relevant first", never a guaranteed order.
- **`CloudStore`**: stub that throws "not implemented".
- **Config** in `~/.cockpit/config.json`:
  ```json
  { "memory": { "backend": "local" } }
  { "memory": { "backend": "cloud", "url": "https://…", "token": "…" } }
  ```
- No local ↔ cloud sync: it is one or the other.

## Data model

- **Scopes**: `global`, `project`.
- **Entry**: `id`, `scope`, `projectId?`, `content` (markdown), `tags[]`, `source` (harness), `createdAt`, `updatedAt`.
- Visibility: a `project` memory only appears in its project; a `global` memory appears everywhere.

## Context resolution (`packages/mcp-server`)

The agent never passes the project or the harness itself: the server resolves them.

- **Project directory**: passed by the app to `createMcpServer`. `apps/mcp` passes `process.cwd()`: Claude Code, OpenCode and Codex all start a stdio server in the project (or launch) directory.
  - Do not use MCP roots: they are deprecated since protocol version 2026-07-28, and Codex does not support them.
  - Do not rely on harness environment variables such as `CLAUDE_PROJECT_DIR`: they leak into child processes. An OpenCode started from a Claude Code terminal passes the parent Claude session's variables to its MCP servers.
- **`projectId`**: hash of the `realpath` of `git rev-parse --path-format=absolute --git-common-dir`, run from the project directory. Every worktree and subdirectory of a repository therefore shares one `projectId`, like Claude Code's own auto memory. Without git, hash of the project directory, which covers sessions outside any project.
- **`source`**: the client name the harness sends when it connects (`claude-code`, `opencode`…).

### Harness behavior

Claude Code 2.1.302 and OpenCode 2.0.31 verified in practice; Codex from its docs and source only, not tested.

| | Claude Code | OpenCode | Codex |
|---|---|---|---|
| `roots/list` | launch directory (even a subdirectory) | project directory | not supported |
| `process.cwd()` | launch directory | project directory | Codex process cwd, unless `cwd` is set |
| Environment | full parent env, plus `CLAUDE_PROJECT_DIR` and `CLAUDE_CODE_SESSION_ID` | full parent env, including `CLAUDE_*` variables leaked from a parent Claude session | allowlist only (`HOME`, `PATH`, `USER`…) plus `env` / `env_vars` |
| MCP process lifetime | one per session | long-lived, shared across sessions by the resident `opencode serve` service | not documented |
| Server `instructions` injected | yes, cut at 4,096 characters | yes, only when the server exposes at least one tool | yes, no documented cap; keep the first 512 characters self-contained |

## MCP tools and instructions (`packages/mcp-server`)

| Tool | Input | Notes |
|---|---|---|
| `memory_search` | `query`, `scope?` (defaults to `all`), `limit?` | scan of the files, sorted by relevance then recency |
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

Distribution target, once cockpit is published: an npm package launched with `npx -y <package>@latest`, as Playwright MCP and Chrome DevTools MCP do, so the user needs Node and nothing else. The package name waits for the final product name. Until then, the script registers the local build.

## Other harnesses

- **Codex**: same binary, declared in `~/.codex/config.toml` (`mcp_servers`).
- **OpenCode**: same binary, declared in the `mcp` section of the OpenCode config (`type: "local"`).
- **Never** modify the `AGENTS.md` of the user's repository.

## Tests and validation

- **CI** (`.github/workflows/ci.yml`): on every pull request and every push to `main`, one macOS job runs `bun turbo run build typecheck lint test`. macOS because the desktop app is packaged for macOS and its tests open windows. The repository is public, so GitHub-hosted runners cost nothing.
- **`main` is protected** by a ruleset: changes go through a pull request, the CI `check` job must pass on a branch up to date with `main`, and force pushes and deletion are blocked. The rule applies to administrators too.

- `packages/memory` (vitest): CRUD, search, scope filtering, concurrent writes from 2 processes.
- `packages/mcp-server` (vitest): context resolution; a git worktree and a subdirectory resolve to the same `projectId` as the main checkout, and a directory outside git gets its own.
- `apps/mcp`: the binary responds over stdio (test with MCP Inspector).
- `apps/desktop` (vitest + Playwright): the `dev` script, the built app and the packaged `Cockpit.app` each start, show the home page and the app version returned by the main process, keep Node out of the renderer, follow the system color scheme, reload, and log no error.
- End to end, after `install-claude`, with the stock `claude` in a real repository:
  - "Remember that X" → Claude calls `memory_write` (scope `project`);
  - new session in the same repository, then in one of its worktrees → asked about X, Claude calls `memory_search` and finds X;
  - in another repository, X is absent; a `global` memory is found everywhere;
  - existing MCP servers still work, and uninstalling restores the initial state.
