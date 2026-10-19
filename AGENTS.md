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

The repository is built in steps. So far, the only part in scope is the **desktop app shell** (`apps/desktop`): a window, a router, a typed bridge to the main process, and the UI foundation (styling, light and dark themes, sidebar layout). No product feature yet.

Daemon, pty, product UI, artifacts, stats, cloud backend, web app, mobile: create none of these without an explicit request.

## Monorepo

- **No business logic in `apps/`.** Everything lives in `packages/`; apps only wire things together.
- **Bun** (package manager, workspaces, script runner) + **Turborepo**, TypeScript.
- Runtime: **Node 22+** for the tooling, the oldest supported LTS line; the desktop app runs on the Node bundled with Electron (24 in Electron 44). A native module (later `node-pty`) must be built for the runtime that loads it.
- Set up by hand, without the `create-turbo` template:
  - root `package.json`: `apps/*` and `packages/*` workspaces, scripts that delegate to Turbo;
  - `turbo.json`: `build`, `dev`, `test`, `typecheck`, `lint` tasks;
  - `tsconfig.base.json`, extended by every package.
- Internal dependencies declared as `"workspace:*"`.

```
apps/
  desktop/           # Electron app: main process, preload, React renderer
packages/            # shared code, empty for now
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
  - Test launches stay unnoticed. Two variables, read by the main process before `ready` and honoured in the packaged app too: `COCKPIT_TEST_BACKGROUND=1` (macOS accessory policy, so no Dock icon and never the frontmost app; windows are never shown and keep rendering as if visible) and `COCKPIT_USER_DATA_DIR=<dir>` (sets `userData`). The tests set both on every launch, with a fresh `mkdtemp` folder removed after the app closes. The app's own data must therefore live under `app.getPath('userData')`, so the variable isolates it.
  - The launch without the switch (visible window, `Foreground` app) runs only in CI, where no one's focus is at stake: `CI` reaches the tests through `turbo.json`. Do not set `CI` locally to run it.
  - Playwright is maintained by Microsoft and widely adopted; its Electron support is labelled experimental. It drives the app through Electron's inspector, so never disable the `EnableNodeCliInspectArguments` fuse in test builds.

## Tests and validation

- **CI** (`.github/workflows/ci.yml`): on every pull request and every push to `main`, one macOS job runs `bun turbo run build typecheck lint test`. macOS because the desktop app is packaged for macOS and its tests open windows. The repository is public, so GitHub-hosted runners cost nothing.
- **`main` is protected** by a ruleset: changes go through a pull request, the CI `check` job must pass on a branch up to date with `main`, and force pushes and deletion are blocked. The rule applies to administrators too.
- `apps/desktop` (vitest + Playwright): the `dev` script, the built app and the packaged `Cockpit.app` each start, show the home page and the app version returned by the main process, keep Node out of the renderer, follow the system color scheme, reload, and log no error. They stay in the background (no Dock icon, never frontmost), use their own data folder, and, in CI only, show a visible window without the switch.
