# AGENTS.md — cockpit

**cockpit** is a provisional working name. It appears in the desktop app (`Cockpit`, `com.cockpit.desktop`).

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
- artifacts on storage you own;
- usage statistics.

The repository is built in steps. So far, the parts in scope are the **desktop app shell** (`apps/desktop`): a window, a router, a typed bridge to the main process, and the UI foundation (styling, light and dark themes, sidebar layout); and the **pty host** (`packages/pty`), which runs node-pty in a utility process and exposes it as `window.api.pty`; the **login-shell environment** (`packages/shell-env`), which the main process resolves at startup for the child processes it will spawn; and the **state store** (`packages/state`), which keeps the app state in a JSON file. The only product UI is the **terminal page** (`/terminal`): xterm.js connected to a shell through `window.api.pty`.

Daemon, artifacts, stats, cloud backend, web app, mobile: create none of these without an explicit request.

## Monorepo

- **No business logic in `apps/`.** Everything lives in `packages/`; apps only wire things together.
- **Bun** (package manager, workspaces, script runner) + **Turborepo**, TypeScript.
- Runtime: **Node 22+** for the tooling, the oldest supported LTS line; the desktop app runs on the Node bundled with Electron (24 in Electron 44). A native module (`node-pty`) must be built for the runtime that loads it.
- Set up by hand, without the `create-turbo` template:
  - root `package.json`: `apps/*` and `packages/*` workspaces, scripts that delegate to Turbo;
  - `turbo.json`: `build`, `dev`, `test`, `typecheck`, `lint` tasks. `test` is never cached: its result depends on the machine (the Electron binary, the user's login shell), not only on the files, and Turbo shares its local cache across git worktrees;
  - `tsconfig.base.json`, extended by every package.
- Internal dependencies declared as `"workspace:*"`.

```
apps/
  desktop/           # Electron app: main process, preload, React renderer
packages/
  pty/               # node-pty host (utility process side) and client (main process side)
  shell-env/         # resolves the environment of the user's login shell
  state/             # app state kept in a JSON file in userData
```

- No other app (daemon, web, cloud) without an explicit request.
- **Internal packages consumed as TS source**, with no separate per-package build.
- **Tests** with `vitest`.

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
  - Every privileged IPC handler in the main process (`pty:*`, `get-shell-path`) ignores a message whose sender frame is not the app's own page (`app://renderer`, or the dev server origin in dev); an invoke handler rejects.
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
- **Login-shell environment**: an app started from the Finder or the Dock gets launchd's minimal `PATH`, so the main process resolves the environment of the user's login shell once per launch (`resolveShellEnv` from `@cockpit/shell-env`, exported as `shellEnv` by `src/main/shell-env.ts`). Anything that spawns a child process (git, harness detection) must spawn with `await shellEnv`. A pty's `env` defaults to it (see Spawn defaults), and the shell it runs is the one that environment's `SHELL` names. The renderer only gets `PATH`, through `window.api.getShellPath()`.
- **Terminals**: node-pty runs in an Electron `utilityProcess`, not a daemon, so a pty crash does not take the app down. Sessions therefore end when the app quits. Any update flow must warn the user, before restarting, that the running sessions will be terminated.
  - `packages/pty` holds the logic and does not import `electron`: `runPtyHost(port)` runs in the utility process and owns the node-pty sessions, `createPtyClient(child)` runs in the main process (numbered sessions, spawn request and ack, data and exit fan-out). `apps/desktop` only wires them: `src/main/pty-host.ts` is the utility process entry (forked through electron-vite's `?modulePath` import), `src/main/index.ts` forwards the `pty:*` IPC and sends data and exit events to the window that spawned the session, and the preload exposes `window.api.pty`.
  - If the utility process dies, its open sessions end with `exitCode: null` and `spawn` rejects with `pty host is not running`. Nothing restarts it yet.
  - **Terminal page** (`src/renderer/components/terminal.tsx`, route `/terminal`): xterm.js with the fit addon, one shell per visit, killed when the page is left. Colors come from the page tokens (the 16 `--terminal-*` ANSI tokens, light and dark; background, foreground, cursor and selection reuse existing tokens) and are read again when the color scheme changes. Copy and paste use Electron's default macOS Edit menu, which fires the DOM events xterm.js handles.
  - **Spawn defaults**: `window.api.pty.spawn` only needs `cols` and `rows`. The main process fills in the rest (`withSpawnDefaults` in `src/main/index.ts`): the `SHELL` of `await shellEnv` (`/bin/zsh` when unset) as a login shell (`-l`), the home directory, and `await shellEnv` as the environment with `TERM=xterm-256color` and `COLORTERM=truecolor`. Options the renderer passes win.
  - **Sessions end with their page**: the main process kills a window's sessions when its main frame loads another document (a reload included) or the window is destroyed. Route changes are same-document and kill nothing; the terminal component kills its own shell when it unmounts.
  - **Transport: IPC, not a `MessagePort`.** Each output chunk goes host, then main (`parentPort`), then renderer (`webContents.send`). Electron can transfer a `MessagePortMain` to a utility process and to a renderer, and the `window.api.pty` contract is the same either way, so moving later stays inside `packages/pty`, `main` and `preload`. No measurement shows IPC as a bottleneck for one terminal. **Trigger to move**: a measurement showing typing latency, or a saturated main process, with several terminals active at once (agent sessions).
  - **xterm.js** (`@xterm/xterm` `^6.0.0`, `@xterm/addon-fit` `^0.11.0`, stable releases rather than the 6.1 beta line VS Code tracks): repository `xtermjs/xterm.js` (organization), MIT, 21,285 stars, last push 2026-10-13; npm maintainer tyriar (Daniel Imms, VS Code terminal); VS Code depends on `@xterm/xterm` and its addons. About 3.9 million downloads a week for `@xterm/xterm` and 3.4 million for `@xterm/addon-fit` (week of 2026-10-12). Stable releases are rare (5.4.0 2024-03-01, 5.5.0 2024-04-05, 6.0.0 2025-12-22) but the 6.1.0 beta line is published continuously. Figures checked against npm and the GitHub API on 2026-10-20. Exit cost: contained in one component.
  - **node-pty** is maintained by Microsoft (`microsoft/node-pty`, the terminal backend of VS Code; npm maintainers tyriar, alexr00 and microsoft1es). Adoption: about 2.5 million downloads a week on npm (week of 2026-10-12) and 2,050 GitHub stars. The last push was on 2026-10-15. Release activity in 2026: nine 1.2.0 betas in January, then about one every one to two months, the last (`1.2.0-beta.15`) on 2026-08-03; the latest stable, 1.1.0, is older. Figures checked against npm and the GitHub API on 2026-10-19.
  - **Pin**: exactly `1.2.0-beta.15`, with no `^`. 1.1.0 ships a macOS `spawn-helper` without the execute bit, so every spawn fails with `posix_spawnp failed`; the 1.2.0 line fixes it, and VS Code builds on it, so it is the de facto stable one. Move to 1.2.0 once it is published. The pin appears in `apps/desktop` (shipped by electron-builder) and in `packages/pty` (Bun's isolated linker resolves each workspace's own dependencies).
  - **No rebuild**: `npmRebuild: false` in `electron-builder.yml`. node-pty is N-API, so its macOS prebuilds load under Electron as they are, with no Xcode needed. A rebuild compiled node-pty in place in the shared Bun store (`node_modules/.bun/`), where its `build/` directory then took precedence over the prebuilds for every later run, in dev as well. If a rebuilt `build/` shows up there, delete it.
  - `asarUnpack: node_modules/node-pty/**` keeps `pty.node` and `spawn-helper` outside the asar, where they can run.
  - `spawn` rejects a message from another origin (the sender-frame rule above). The host guards each per-session node-pty call, so a bad size or a call racing a session's exit cannot kill it.
- **State**: the app state lives in one JSON file, `state.json`, in `app.getPath('userData')` (so `COCKPIT_USER_DATA_DIR` isolates it in tests). Only `version` exists so far; a feature that stores a field adds it, with a write API.
  - `packages/state` holds the logic and does not import `electron`: `loadState(dir)` reads `<dir>/state.json`, creates the folder and writes `{ "version": 1 }` when the file is missing, and `NewerStateError` is what it throws for a newer file. The main process calls it first thing in `whenReady`, before the pty host and the window, with `userData`.
  - **Atomic write**: every write goes to `state.json.tmp`, is flushed with `fsync`, then renamed over `state.json`, with synchronous `node:fs` (tiny file, read once at startup). A crash leaves the previous `state.json` intact; a leftover `.tmp` is ignored and overwritten.
  - **Corrupted file** (not JSON, or not an object whose `version` is a positive integer): renamed to `state.json.corrupt-<timestamp>` with its original bytes, a fresh `state.json` is written, and a warning names the backup.
  - **Newer version** (`version` above the one the app reads): the file is left untouched, no window opens, the message "written by a newer version of Cockpit" goes to stderr (and to an error dialog outside background mode), and the app exits with code 1.
  - **Unreadable file** (a read fails for a reason other than the content: a folder named `state.json` gives `EISDIR`, a file without read permission gives `EACCES`): `loadState` throws the original error and touches nothing. The main process quits as for a newer version (nothing set aside, no window, stderr, error dialog outside background mode, exit code 1) with a message that starts "Cockpit cannot read its data", then names the path of `state.json` and the error message.
  - **Git is the source of truth for worktrees**: the state never stores what `git worktree list` can tell.
  - **Why JSON files rather than SQLite** (facts checked on 2026-10-20): the state is a handful of small records written by one process, and a JSON file has nothing to maintain or leave; leaving it later costs one migration driven by `version`.
    - `node:sqlite` in Node 24.22.0 (bundled by Electron 44.9.0 and 44.9.1): "Stability: 1.2 - Release candidate" since v24.15.0, unflagged since v22.13.0, no `ExperimentalWarning` on load (SQLite 3.53.4). Built in, no native build, but not Stable: its API can still change, and it moves with the Node that Electron bundles.
    - `better-sqlite3` 13.0.3 (2026-08-05): a single npm maintainer (joshuawise), about 1,184 commits from him against 88 for the next contributor, 7.2 million downloads a week (2026-10-12 to 18), 7,522 GitHub stars, last push 2026-08-10. N-API with prebuilds shipped in the package since 13.0.0 (2026-07-21), but still a native module: the `asarUnpack` and shared Bun store concerns already met with node-pty.
- **Runtime tests**: no version ships with a risk of crashing at runtime. `build` and `typecheck` are not enough: `test` (vitest + Playwright, in `test/`) launches the app the four ways it runs, the `dev` script, the built app, the packaged `Cockpit.app` and the packaged app launched with launchd's minimal environment (as from the Finder or the Dock; `open` would pass on the caller's environment), and checks that each one renders, keeps Node out of the renderer, logs no error and keeps running. Every change to the desktop app extends these tests to cover what it adds.
  - Test launches stay unnoticed. Two variables, read by the main process before `ready` and honoured in the packaged app too: `COCKPIT_TEST_BACKGROUND=1` (macOS accessory policy, so no Dock icon and never the frontmost app; windows are never shown and keep rendering as if visible) and `COCKPIT_USER_DATA_DIR=<dir>` (sets `userData`). The tests set both on every launch, with a fresh `mkdtemp` folder removed after the app closes. The app's own data must therefore live under `app.getPath('userData')`, so the variable isolates it.
  - The launch without the switch (visible window, `Foreground` app) runs only in CI, where no one's focus is at stake: `CI` reaches the tests through `turbo.json`. Do not set `CI` locally to run it.
  - Playwright is maintained by Microsoft and widely adopted. The tests do not use its Electron launcher (`_electron.launch()`, labelled experimental): it runs the app's main script before it returns, so output written during startup never reaches the test. They spawn the app themselves with `--remote-debugging-port=0`, attach the output listeners at once, read the port from Chromium's `DevTools listening on ws://127.0.0.1:<port>` line on stderr, and attach with `chromium.connectOverCDP`. The session's `output()` therefore holds everything the app wrote from its first line. The attach goes through Chromium's remote debugging port, so never disable it in test builds.

## Tests and validation

- **CI** (`.github/workflows/ci.yml`): on every pull request and every push to `main`, one macOS job runs `bun turbo run build typecheck lint test`. macOS because the desktop app is packaged for macOS and its tests open windows. The repository is public, so GitHub-hosted runners cost nothing.
- **`main` is protected** by a ruleset: changes go through a pull request, the CI `check` job must pass on a branch up to date with `main`, and force pushes and deletion are blocked. The rule applies to administrators too.
- `apps/desktop` (vitest + Playwright, the app spawned and attached over CDP, its output captured from the first line): the `dev` script, the built app, the packaged `Cockpit.app` and the packaged app with launchd's minimal environment each start, show the home page and the app version returned by the main process, keep Node out of the renderer, follow the system color scheme, reload, and log no error, checking the whole output since the first line (each mode shows Chromium's `DevTools listening on` line). They stay in the background (no Dock icon, never frontmost), use their own data folder, and, in CI only, show a visible window without the switch. The launchd-environment mode also checks that `getShellPath()` returns the `PATH` printed by the user's login shell. They also spawn, write to, resize and kill a shell through `window.api.pty`, then kill the pty host and check that the app survives and that `spawn` rejects. Each mode finds `state.json` with `{ "version": 1 }` in its data folder; the packaged app also restarts on the same folder (`state.json` unchanged, nothing set aside), sets a corrupted file aside and starts, exits with code 1 and no window on a newer-version file, and does the same on an unreadable one (a folder named `state.json`), leaving the file alone. "No window" is checked through the window traces Chromium writes in the data folder (`Preferences`, `Local Storage`, `Session Storage`, `Cache`), absent after those exits; a guard checks that a normal packaged start does create them, so an Electron that stops writing them fails the guard instead of passing the check silently. On the terminal page they type a command and read its output, resize the viewport, exit the shell, copy and paste through synthetic clipboard events, follow the color scheme, and check that a shell ends when its page is left or reloaded and that the terminal shows `[Process ended]` when the host dies. Tests set `SHELL=/bin/sh`, except in the launchd-environment mode.
- `packages/pty` (vitest, plain Node): the host and the client wired through in-memory ports, with the real node-pty.
- `packages/shell-env` (vitest, plain Node): `resolveShellEnv` against fake shells (startup noise, multi-line values, timeout, missing or failing shell, no passwd entry and no shell found, an unreadable home directory, a background process holding stdout, injected and removed variables).
- `packages/state` (vitest, plain Node): `loadState` on a fresh folder per case: missing file and folder, read back without a rewrite, each corrupted shape set aside, newer version, unreadable file (`EISDIR` for a folder, `EACCES` for a file without read permission, nothing renamed, created or removed), leftover `.tmp`.
