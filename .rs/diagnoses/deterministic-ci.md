---
kind: problem
owner: Romain C
created: 2026-11-02
updated: 2026-11-03
branch: main
commit: 3e525c3   # the path:line references hold at this commit, unless another commit is named
---

# Recurring CI test failures that the failing tests' code does not explain

## Subject and scope
CI fails at random on tests the change under test does not touch: `apps/cli/test/setup.test.ts` AC1/AC5 (family A), `apps/desktop/test/workspace-panes.test.ts` "New tab" and "2 menus" (family B), plus two older one-offs (ship AC8, survive m2-22).
- Occurs: GitHub Actions `macos-latest` (macOS 26 arm64 image 20261021.0445), the `check` job of `ci.yml`. Family A: runs [41357804473](https://github.com/romain-cll/harness-cockpit/actions/runs/41357804473) (main), [41472154015](https://github.com/romain-cll/harness-cockpit/actions/runs/41472154015) (cockpit-45). Family B: [41437321251](https://github.com/romain-cll/harness-cockpit/actions/runs/41437321251) (main), [41463977596](https://github.com/romain-cll/harness-cockpit/actions/runs/41463977596) (cockpit-66). ship AC8: [40859019290](https://github.com/romain-cll/harness-cockpit/actions/runs/40859019290). survive m2-22: [40862322164](https://github.com/romain-cll/harness-cockpit/actions/runs/40862322164). About 20–30 % of recent runs.
- Doesn't occur: locally (Romain's machine); in most CI runs.
- In: the causes of those six failures.
- Out: the fixes (COCKPIT-80's plan); speeding up CI (COCKPIT-62); the lost first resize (COCKPIT-77); ship AC3–AC5 failures seen on COCKPIT-66's branch (they stay with COCKPIT-66).
- Sources: Plane COCKPIT-80; the runs above; diagnosis runs [41478364783](https://github.com/romain-cll/harness-cockpit/actions/runs/41478364783) (main + traces, 5 jobs) and [41482601419](https://github.com/romain-cll/harness-cockpit/actions/runs/41482601419) (cockpit-66 + menu traces, 5 jobs, git probe).

## Summary
- **A**: the CLI under test is given `/usr/bin/git` (the Xcode `xcrun` shim) while nothing warmed `xcrun` on the runner; its first lookup takes 3.4–4.8 s under the suite's load, so AC1 runs 3.6–5.0 s against vitest's 5 s guard. When it overruns, the CLI keeps running and its reports land in AC5's shared `reports` list.
- **B "New tab"**: the router pushes the URL before it renders the page; the test treats the URL as "page open" and marks the "New tab" buttons once. Marking before the render marks nothing (main) or marks the previous page's button, then detached (cockpit-66).
- **B "2 menus"**: the project "Actions" menu stays in the DOM for its ~110 ms exit animation; the test opens the agent menu ~30 ms later and asks for the only `menu` on the page.
- **ship AC8**: `git push --set-upstream` updates the remote ref before it writes the upstream; the test reads the upstream as soon as the ref moves.
- **survive m2-22**: the failing assertion no longer exists.
- **daemon AC7/AC8** (local, found 2026-11-03): AC7 takes the first `sleep 300` of the whole machine as its setup; a foreign one (another workspace's suite) never ends with the page, AC7 fails before killing its app, and AC8's launch loses the single-instance lock. Predates COCKPIT-80 (COCKPIT-55).

## Findings

### F1 — `cockpit setup` AC1 overruns the 5 s guard on the first `xcrun` lookup, and its late reports leak into AC5
- What happens: AC1 fails with "Test timed out in 5000ms"; AC5 (code 3) then sees six events instead of three, or AC1's `exited` (code 0) as its last report.
- Cause: `apps/cli/test/setup.test.ts:152` → `packages/daemon/src/setup.ts:138` → `packages/workspaces/src/index.ts:293` → `packages/workspaces/src/git.ts:72`:
  1. The test spawns the compiled CLI with `PATH=<stubs>:/usr/bin:/bin` (`setup.test.ts:152`), so its `git` is `/usr/bin/git`, the Xcode shim that runs through `xcrun`.
  2. The test's own git calls (`beforeAll`) use the runner's `PATH`, where `/opt/homebrew/bin/git` comes first: nothing has gone through `xcrun` for git before AC1.
  3. AC1 is the first test to run the CLI; `readWorkspaceConfig` → `checkGit` → `git --version` pays `xcrun`'s cold lookup.
  4. Under the load of the whole suite (turbo runs every workspace's tests at once, with Electron launches) the lookup takes 3.4–4.8 s; AC1 totals 3.6–5.0 s against vitest's default 5 s `testTimeout` (`apps/cli` has no vitest config).
  5. When AC1 overruns, vitest fails it but does not stop the CLI it spawned. `afterEach` empties the module-level `reports` (`setup.test.ts:44`, `:47–49`) while the CLI is still in step 3.
  6. AC5 starts; AC1's CLI finishes and posts its three reports to the same fake daemon, into AC5's list: six events, or AC1's `exited` with code 0 last.
- Evidence:
  - Run 41478364783, 4 jobs, CLI trace (`CK80_TRACE`): first `git --version` 3429 / 3825 / 4455 / 4782 ms; AC1 3637 / 4056 / 4824 / 4975 ms; load average at AC1's start 61–98; every later `git --version` in the file 23–106 ms. In job 1: `git --version start` at …685619, `done in 3825 ms`; `rev-parse` 42 ms; `worktree list` 39 ms; reports settled in 5–49 ms each.
  - Run 41482601419, probe job on a fresh runner (load average 85): Xcode's git binary called directly `55 ms`, again `24 ms`; `xcrun --find git` `957 ms`; then `env -i PATH=/usr/bin:/bin /usr/bin/git --version` `119 ms`. The cost is `xcrun`'s, not git's.
  - Run 41478364783, probe job (load average 52 at 1 min uptime): `env -i PATH=/usr/bin:/bin /usr/bin/git --version` 733 ms, then 32 ms, 20 ms; with `HOME` and `TMPDIR` 24 ms; the runner's `/usr/bin/git` 19 ms. `which -a git` → `/opt/homebrew/bin/git`, `/usr/bin/git`.
  - Failing runs: 41472154015 `expected [ 'setup-running', 'setup-done', …(4) ] to deeply equal [ 'setup-running', 'setup-done', …(1) ]`; 41357804473 `expected { event: 'exited', exitCode: +0, …(1) } to deeply equal { sessionId: 'session-1', …(2) }` (AC5 expects code 3).
  - Passing runs before the diagnosis: AC1 2073–4713 ms (41094377782, 41356362918, 41356992104, 41433905047, 41437321251, 41442561669, 41463977596), other CLI tests 130–600 ms.
- Why it shows in CI: a fresh runner whose `xcrun` never served git, under a load average of 60–100 when the CLI tests start. Not locally: the `xcrun` lookup was served long ago on a developer machine, and its load is lower.
- Confidence: **proven** for the overrun (steps 1–4) and the leak (steps 5–6, from the code and both failing runs' reports). **Likely** for why AC5's own run was slow in the failing runs (3739 / 4381 ms): its CLI's `git --version` overlapped AC1's cold `xcrun` lookup — missing: a trace of a failing run.

### F2 — "New tab" not found: the test marks the panes when the URL changes, before the page is rendered
- What happens: `locator.click: Timeout 10000ms exceeded` on `[data-test-new="0"]`, the first New tab click after `openWorkspace`. On main (smoke and AC19 of the packaged app, run 41437321251) the call log is only "waiting for locator" (never resolved).
- Cause: `apps/desktop/test/workspace-panes.test.ts:230` → `:227` → `:496` → `:242` → `:475`:
  1. `openWorkspace` clicks the sidebar row and waits for the URL (`onWorkspacePage`, `waitForURL`).
  2. TanStack Router pushes the URL first, then loads and renders (`@tanstack/router-core` 1.171.38, `src/router.ts:2313–2322`: `this.history.push(…)`, the load follows through the history subscription). At the first visit of `/workspace` in a launch the route's code is also fetched (`apps/desktop/electron.vite.config.ts:24`, `autoCodeSplitting: true`).
  3. `newTab` → `markPanes` stamps `data-test-new` on the "New tab" buttons visible at that instant, once (`:242–264`); `openNewTabMenu` marks again, then clicks `[data-test-new="0"]` (`:475–478`).
  4. When both marks run before the workspace page is committed, no button carries the mark; the button that appears next has none, and the click waits until its 10 s timeout.
- Evidence: run 41478364783, renderer and test traces, dev smoke path: `test openWorkspace smoke click` …165438; router `pending` on `/workspace` …165512; `URL reached` …165529; `markPanes: 0 tablists, marked New tab ;` …165532; `WorkspacePanes mount` …165571; second `markPanes` …165602 marked `base-ui-_r_n_`, so that run passed by 31 ms. Click-to-mount gaps across the four jobs: up to 516 ms. Run 41437321251: both failures at `openNewTabMenu workspace-panes.test.ts:477`, call log `waiting for locator('[data-test-new="0"]')` only.
- Why it shows in CI: the gap between the URL and the render grows with the route chunk's first fetch and with CPU load (load average 60–100 at the suite's start); the test spends only a few CDP round trips between the URL and its last mark. Locally the render lands before the second mark.
- Confidence: **proven** for the mechanism (observed in a trace, router source). **Likely** for the two main failures — missing: a trace of a failing run (the two failures were first visits of `/workspace` in a freshly launched packaged app, consistent with a longer gap).

### F3 — "New tab" detached (COCKPIT-66 branch): the previous workspace page's button is marked, then replaced
- What happens: run 41463977596 and run 41482601419 (3 of 4 jobs), `cockpit-66-new-workspace-page`, AC20: `locator resolved to <button … data-test-new="0" id="base-ui-_r_bs_" …>`, then `element was detached from the DOM, retrying`, until the 10 s timeout.
- Cause: same steps as F2, with the previous page being another workspace page (omega, from the test before) whose "New tab" button is visible: step 3 marks it, the switch to alpha removes it (`WorkspacePanes key={path}`), and alpha's button has no mark.
- Evidence: the call logs above; run 41478364783 traces show the marked button's container removed on each workspace-to-workspace switch (`DOM removed DIV#.relative -m-2 min-h-0 flex-1 holding a marked New tab button`, 12 times after `openWorkspace alpha`). The branch's head (`8e9dd37`, "reload loaders blocking") makes loaders block the navigation, which lengthens the URL-to-render gap.
- Why it shows in CI: as F2; on that branch nearly every run.
- Confidence: **likely** — missing: `markPanes` and loader timings on that branch (not run, by decision of 2026-11-03).

### F4 — "2 menus": the project "Actions" menu is still in its exit animation when the agent menu opens
- What happens: `locator.waitFor: strict mode violation: getByRole('menu') resolved to 2 elements`, AC22 of the COCKPIT-66 branch (`apps/desktop/test/composer.ts:32` at `8e9dd37`, `openPopup`). Menu 1 carries `data-closed`, `data-ending-style`, `data-align="end"`; menu 2 `data-open`.
- Cause:
  1. `openComposerFromSidebar` opens the project's "Actions" menu (`apps/desktop/src/renderer/components/projects.tsx:100`, `align="end"`) and clicks "New workspace…".
  2. The menu closes with shadcn's exit animation (`components/ui/dropdown-menu.tsx:41`, `data-closed:animate-out … duration-100`); Base UI keeps the popup in the DOM until its animations finish.
  3. The prompt box is already there; the test clicks the agent select ~30 ms later; the agent menu is added while the Actions menu is still in the DOM.
  4. `openPopup` waits on `page.getByRole('menu')`, a strict locator: two elements fail it.
- Evidence: run 41482601419, job `check (3)`, menu observer: Actions menu `data-closed set` …604579, `data-ending-style set` …604580; `test clicked New workspace…` …604593; `prompt box visible` …604602; `openPopup click` …604609 (1 menu in DOM); agent menu added …604673 (2 in DOM); `MENU REMOVED base-ui-_r_1_ … 119 ms after data-closed` …604698. Other closing menus: 107–119 ms. The New tab menu avoids this by design (`workspace-panes.tsx:310`, no exit animation).
- Why it shows in CI: an ordering race between a ~110 ms animation and the test's next step, not a slowness; it failed in 3 of 4 jobs of run 41482601419 on that branch. Not seen locally so far — unknown whether the local test is slower between the two steps.
- Confidence: **proven**.

### F5 — ship AC8: the upstream is read between the remote ref update and the upstream write
- What happens: run 40859019290, `expected 'origin/main' to be 'origin/ship-flow'` at `apps/desktop/test/app.test.ts:6707` (6808 at that run's commit).
- Cause:
  1. The Push button runs `git push --set-upstream origin <branch>` (`packages/workspaces/src/changes.ts:203`); the worktree's branch was created from `origin/main`, so its upstream starts as `origin/main`.
  2. git updates the remote's ref (receive-pack ends), then, in the pushing process, writes `branch.<name>.merge` / `remote` (set-upstream).
  3. The test polls the remote ref (`app.test.ts:6706`) and reads `ship-flow@{upstream}` as soon as the ref equals HEAD (`:6707`): a poll landing between steps 2's two writes reads `origin/main`.
- Evidence: local single run, git 2.50.1: a `post-receive` hook in the bare origin printed `origin has ship-flow at 5278a16, local upstream still origin/main`; after the push returned, `origin/ship-flow`.
- Why it shows in CI: the window between the two writes widens under load; locally it is a few milliseconds and the 100 ms poll rarely lands in it.
- Confidence: **proven**.

### F6 — survive m2-22: the failing assertion was removed by COCKPIT-70
- What happens: run 40862322164, `expected [ '', '', … ] to include 'm2-22'`.
- Cause: the test read the terminal's rows at once on return (`expect(await rowsOf(two)).toContain('m2-22')`, `app.test.ts:1863` at `71c5a18`), before the re-attached terminal had redrawn (AGENTS.md: a re-attached terminal draws first, then fits).
- Evidence: the assertion is gone since `daea1b0` (COCKPIT-70); `m2-22` is now awaited (`workspace-panes.test.ts:1199`, `:1225`, `waitForRow`).
- Confidence: **proven** that the assertion is gone; **likely** for its cause (read before redraw) — missing: nothing worth running, the code is gone.

### F7 — daemon AC7: the test picks another process's `sleep 300` as its setup, then AC8 loses the single-instance lock
- What happens: in local full runs on `cockpit-80-deterministic-ci` (2026-11-03, three runs, two of them, plus the reviewer's), `daemon.test.ts` › "daemon: built app" › AC7 fails with `the setup ends with its page: expected true to be false` (`apps/desktop/test/daemon.test.ts:526`), then AC8 with `the app exited with code 0` (`launch.ts:326`).
- Cause: `startSetup` (`apps/desktop/test/daemon.test.ts:304`) finds "the setup" as the first line of the whole machine's `ps -axo pid=,command=` whose command ends with `sleep 300` (`:324–330`), not a process of its own terminal. The order of events:
  1. Any other process whose command ends with `sleep 300` and has a lower pid is running: another workspace's suite (its own daemon AC7 setup, or `packages/harnesses/test/detect.test.ts:142`'s `/bin/sleep 300 &`, alive ~2 s), or anything else on the machine.
  2. `startSetup` returns that process's pid as `first`.
  3. The page reloads; the real setup ends (the daemon ends `commands` terminals with their page), the foreign process does not.
  4. `poll(() => isAlive(first), …, 5_000)` (`:525`) runs out, the assertion at `:526` fails, and the test stops before `killApp(session)` (`:532`).
  5. AC8 launches an app on the same `dataDir` (`:542`); the AC7 app still holds the single-instance lock (`app.requestSingleInstanceLock()` is tied to `userData`), so the new app exits 0 as the losing instance.
- Evidence:
  - Isolated runs of the describe (`bunx vitest run test/daemon.test.ts -t "daemon: built app > "`, one run each, load average ~2): clean `origin/main` (67d0999) 9/9 passed; this branch 9/9 passed.
  - Forcing run on clean `origin/main`: `/bin/sleep 300 &` started first, then the same command: AC7 `the setup ends with its page: expected true to be false`, AC8 `Error: the app exited with code 0` — the same two failures as the branch's full runs.
  - The selector predates COCKPIT-80: `endsWith('sleep 300')` came with `75a519e` (COCKPIT-55, 2026-10-28); `-t AC7` alone cannot run it (`TypeError … reading 'output'` at `:264`: the describe's tests share one session).
- Why it shows where it does: only when a foreign `sleep 300` with a lower pid lives during AC7. This machine runs other workspaces' suites in parallel (COCKPIT-66, COCKPIT-70 test apps were alive during these runs), which carry the same `daemon.test.ts` AC7 and `detect.test.ts` AC11. Load is not the trigger: the forcing run failed at the same load (~2) as the passing ones. Not in CI: one job per runner, and `detect.test.ts`'s sleep is killed within ~2 s, minutes before the desktop suite reaches AC7.
- Confidence: **proven** for the mechanism (forcing run on main); **likely** for which foreign process it was in the failing runs — missing: the `ps` line seen at the time, not recorded.
- Also: the 5 s deadlines at `:525` and `:535` are fixed waits on a non-child pid; the terminal's own exit (the daemon's `exit` event for that terminal id) is the event to wait on.

## Ruled out
- H1 — the compiled 68 MB Bun binary's first launch (macOS scan) makes AC1 slow — ruled out: the CLI reached `runCli` 34 ms after its start in every trace (run 41478364783), the time is inside `git --version`.
- H2 — the reports' HTTP requests to the fake daemon hit the CLI's 2 s timeout — ruled out: every report settled in 0–49 ms, no `TIMEOUT_MS fired` line (run 41478364783).
- H3 — a missing `HOME` / `TMPDIR` in the CLI's environment makes `xcrun` slow on every call — ruled out: once warmed, `env -i PATH=/usr/bin:/bin /usr/bin/git --version` takes 20–32 ms (probe, run 41478364783).
- H4 — the workspace page remounts by itself after opening (router pending state, right bar, daemon status, `restoreFromDaemon`) — ruled out on main: no `WorkspacePage renders not-found` nor `WorkspacePanes unmount` without a test navigation after a sidebar open, in 4 jobs (run 41478364783); the five `not-found` renders per job follow a workspace the test had just created through the New workspace dialog (dagent, dnone, dplain) or just deleted or removed (gamma, omega), and those tests pass.
- H6 — machine load makes daemon AC7's setup outlive its page (F7) — ruled out as the trigger: at the same load (~2) the describe passed on main and on this branch, and failed only with a foreign `sleep 300` running.
- H7 — COCKPIT-80 caused daemon AC7/AC8 (F7) — ruled out: the same failure on clean `origin/main` (67d0999) with a foreign `sleep 300`; the branch passes without one.
- H5 — COCKPIT-67 (right bar) brought family B — ruled out as a cause: the mechanism (F2) is in the test and the router; no right-bar code is on the path.

## Unknowns
- Which foreign `sleep 300` was running in the failing local runs of 2026-11-03 (F7) — to resolve: record `ps` at AC7's start in a failing run.
- The first local full run of 2026-11-03 also failed 13 other desktop tests (navigation, single instance, daemon AC18, dev smoke; "Target page … closed", click timeouts) at load 7.3, not reproduced in the next two runs — to resolve: a run that fails them again, with its trace.
- Why AC5's own CLI run was slow in the two failing runs (F1, likely) — to resolve: a CLI trace of a failing run.
- F3 on COCKPIT-66's branch — to resolve: `markPanes` and loader timings on that branch (one CI wave, ~12 min); not run, by decision.
- Whether F4 can fail locally — to resolve: the agent menu's opening time relative to the Actions menu's removal on a local run.

## Options for /rs-plan
Settled by Romain on 2026-11-03:
- A — the CLI tests give the CLI the same git as the rest of the test (no `xcrun` shim on a cold path); each test waits for its own CLI to exit and keeps its own reports — addresses F1.
- B — wait for the target page's own content, not the URL; let Playwright's auto-wait find the element instead of a one-shot mark; never pick up an element of the previous page — addresses F2, F3.
- C — find a menu by its accessible name (`getByRole('menu', { name: … })`), so a closing menu does not count — addresses F4.
- D — wait for the push's IPC answer before reading the upstream — addresses F5.
- F6: nothing left to fix.
- For a later ticket: the first git call through `/usr/bin/git` costs about 1 s on a cold `xcrun` for users without Homebrew git (probe: 957 ms for `xcrun --find git`).

## Instrumentation
- Main, run [41478364783](https://github.com/romain-cll/harness-cockpit/actions/runs/41478364783): CLI trace (`CK80_TRACE`: start, each git call, each command, each report), per-test timings and load average in `setup.test.ts`, renderer traces (root loader and its IPCs, router state, mounts of `WorkspacePage` / `WorkspacePanes` / `PaneView` / `NewTabMenu`), a DOM observer on marked buttons, five identical jobs, a git probe — patch: `deterministic-ci.main.patch` (on `3e525c3`).
- COCKPIT-66 branch, run [41482601419](https://github.com/romain-cll/harness-cockpit/actions/runs/41482601419): menu lifecycle observer (added, `data-closed`, `data-ending-style`, removal), test step timestamps in `composer.ts`, five identical jobs, a git probe in two orders — patch: `deterministic-ci.cockpit-66.patch` (on `8e9dd37`).
- Branches deleted, draft PRs #49 and #50 closed.
