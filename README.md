# Cockpit

A macOS desktop app to run coding agent CLIs (Claude Code, Codex, OpenCode) side by side, each in its own git worktree, with sessions that keep running when the app closes.

## Status

Early stage. macOS only. There is no signed release yet: build it from source (see [Getting started](#getting-started)). "Cockpit" is a provisional name.

## What it does

- **Projects and workspaces.** Add a git repository as a project; each workspace is a git worktree on its own branch. Optional `setup` and `teardown` commands come from the project's `.cockpit/config.json`.
- **Sessions and shells as tabs of split panes.** A workspace page holds its agent sessions and shells as tabs, in panes you can split.
- **Sessions outside any project.** Start an agent in a folder of its own, without a project.
- **Sessions that outlive the app.** A background daemon owns every agent and shell, so they keep running when you quit, reload or update the app.
- **Session status.** Each session shows Working, Needs input or Ready, reported by the agent's hooks. A notification is raised for Needs input and Ready when no Cockpit window is focused.
- **Right bar.** The diff of the workspace, a commit, a push, and the pull request with its CI checks, read through `gh`.
- **Open in your tools.** Open a workspace in a detected editor (Visual Studio Code, Cursor, Zed) or terminal app (Terminal, iTerm2, Ghostty, Warp).

## Supported agents

Claude Code, Codex and OpenCode. Cockpit lists the ones it finds on your `PATH`.

Left out: Cursor CLI (its session storage is undocumented and the CLI is closed source), Kimi (the archived `kimi-cli` runs no agent, and its successor takes no initial prompt interactively) and Mistral Vibe (left out by decision: 3.0 is a recent Rust rewrite and its session layout is only in the source).

## How it works

- An Electron app (`apps/desktop`): React renderer, main process, `window.api` between them.
- A daemon (`packages/daemon`) owns every pty and talks to the app over a Unix socket. It outlives the app.
- The `cockpit` CLI (`apps/cli`) is what the agents' hooks call to report a status, and what runs a workspace's setup and teardown commands.
- One package per concern:
  - `packages/daemon`: the pty-owning daemon and the CLI's logic.
  - `packages/workspaces`: git worktrees, changes, diffs and `.cockpit/config.json`.
  - `packages/harnesses`: the agent CLIs (detection, how to start and resume them, status hooks).
  - `packages/launchers`: editors and terminal apps.
  - `packages/github`: pull requests and their checks through `gh`.
  - `packages/state`: the app state, one JSON file.
  - `packages/shell-env`: the login shell's environment.

## Getting started

Requirements:

- macOS
- [Bun](https://bun.sh) 1.4.2
- Node 22 or later
- git 2.36 or later
- [`gh`](https://cli.github.com), optional: needed only for pull requests

```sh
bun install
bun run --filter @cockpit/desktop dev      # hot reload
bun run --filter @cockpit/desktop package  # Cockpit.app in apps/desktop/release/
```

A project can run commands when a workspace is created (`setup`) or deleted (`teardown`). Put them in `.cockpit/config.json` at the root of the project's main working tree; `COCKPIT_ROOT_PATH` is that folder:

```json
{
  "setup": ["bun install", "cp \"$COCKPIT_ROOT_PATH/.env\" .env"],
  "teardown": ["rm -rf node_modules"]
}
```

## Development

```sh
bun run build
bun run test
bun run typecheck
bun run lint
```

The tests launch the app in four modes: the dev script, the built app, the packaged app, and the packaged app with launchd's minimal environment. They need a macOS desktop session.

[AGENTS.md](AGENTS.md) holds the conventions and the technical decisions.

## Contributing

This is a personal project. Issues and ideas are welcome; pull requests are not accepted for now.

## Roadmap

No promises and no dates. Things that may come:

- Linux and Windows
- Signed releases
- Resuming sessions
- Multi-agent exploration
- Usage statistics

## License

[MIT](LICENSE)
