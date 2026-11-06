import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { agentSelect, baseSelect, createButton, detectAgain, itemTexts, openComposer, openPopup, promptBox, useAgent, waitForAgent, waitForMessage } from './composer';
import { daemonSocketIn, gonePipe, heldProcess, isAlive, MAIN_PROCESS_ERROR, type Session, startClock, truthy, untilIn, untilRead, versionLabel } from './launch';
import { addRepository, afterIpcAnswers, countIpcCalls, deleteButton, deleteDialog, destructiveColor, dispatchFocus, entryTitles, gitIn, holdWaiter, INVOKE_HANDLERS, ipcCallArgs, ipcCalls, isBelowProjectsHeader, linkedWorktrees, makeRepo, mutedColor, openDeleteDialog, readRecords, removeOptions, removeThroughMenu, setupLabel, setupLinkCount, sidebarLines, startDeletion, startProjectRemoval, stateSnapshot, type TempRepo, untilAnswered, untilFewerOverlays, waitForDialogLine, waitForEntries, waitForEntry, waitForLine, waitForNoEntry, waitForSetupLabel, worktreePath, writeConfig, writeScripts } from './support/projects';
import { addOpenFixture, allSessionLinkIds, childPidsOf, closeMenus, createPlainWorkspace, createWorkspaceWithAgent, expectDot, expectNoErrors, expectSetupSpawnedWithDetectedPath, FIRST_MENU, hookCommandsOf, INHERITED_CONTROL_ENV, launchBuiltWith, makeSessionsFixture, moveMouseAway, OPEN_BUNDLES, type OpenFixture, openRuns, openSessionEntry, openSubmenu, openWorkspaceMenu, openWorkspaceStartMenu, pickInSubmenu, pickTopItem, readSessionLinks, readStub, readStubEnv, rememberedApps, REPOSITORY_CLI, sessionEntries, sessionFoldersIn, sessionIdOf, type SessionLinksArg, type SessionsFixture, sessionsInState, setOpenOutcome, singleQuoted, startApi, STARTED_PROMPT, startForeignSetup, startInWorkspace, startPlusLabel, startRuns, startSession, stubPids, stubRuns, submenuNamed, submenuTexts, trimmed, versionRuns, waitForOpenRuns, waitForSessionEntries, waitForWorkspaceTabs, workspacesApi, workspaceTabs } from './support/sessions';
import { ensurePtyLog, exitCount, focusedPane, focusTerminal, goHome, killPtyHost, openShellTab, outputOf, ptyHostPid, ptyKill, ptyWrite, spawnShell, terminalOfSession, terminalRows, typeLine, untilPtyLog, visiblePanes, waitForExit, waitForOutput, waitForRow } from './support/terminal';

// The full block runs in the built app only (see the split rule in AGENTS.md).

// COCKPIT-69: these assertions are about sessions staying stored; the `open` mark a deletion or a removal clears is not theirs.
const ignoringOpen = (sessions: unknown[]) => sessions.map((entry) => Object.fromEntries(Object.entries(entry as object).filter(([key]) => key !== 'open')));

describe('sessions: built app', () => {
  let fx: SessionsFixture;
  let session: Session;
  // Shared by the tests below, which run in order on one launch.
  const known = {
    claude1: { id: '', pid: 0 },
    claude2: { id: '', pid: 0 },
    codex1: { id: '', pid: 0 },
    claude3: { id: '', pid: 0 },
  };

  // A `cockpit setup` of someone else, running for the whole describe (COCKPIT-81 AC2).
  let foreign: Awaited<ReturnType<typeof startForeignSetup>>;
  // The repository the workspace tests (COCKPIT-28) work in.
  let repo: TempRepo;
  // The stub `open` and the applications folder of the open workspace tests (COCKPIT-33).
  let open: OpenFixture;
  // The workspaces they create, and what runs in them.
  const ws = {
    fix: { path: '', id: '', pid: 0 },
    blank: { path: '', id: '', pid: 0 },
    plus: { path: '', ids: [] as string[], pids: [] as number[] },
  };

  beforeAll(async () => {
    // The stubs log every run, and their `--version` waits for the test to release it (workspace sessions AC13, AC14).
    fx = makeSessionsFixture(['claude', 'codex'], { log: true, slowVersion: true });
    // A stub `open` and fake editor and terminal bundles (open workspace, COCKPIT-33).
    open = addOpenFixture(fx);
    repo = makeRepo('agent-ws');
    foreign = await startForeignSetup(REPOSITORY_CLI);
    // The app itself is launched with the three control variables set, as when it runs from a session's terminal.
    session = await launchBuiltWith({ ...open.env(), ...INHERITED_CONTROL_ENV });
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    await foreign?.stop();
    if (fx) {
      fx.endVersionHolds();
      rmSync(fx.root, { recursive: true, force: true });
    }
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  // A failing test must not leave a menu or a dialog that blocks the tests after it.
  // Escape only while something is open (at most 4 times), and wait for it to close. Never
  // while the keyboard is in a terminal: the Escape would reach its agent.
  afterEach(async () => {
    const { page } = session;
    const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
    for (let attempt = 0; attempt < 4; attempt++) {
      const open = await overlays.count();
      if (open === 0 || (await page.evaluate(() => !!document.activeElement?.closest('.xterm')))) break;
      await page.keyboard.press('Escape');
      await untilFewerOverlays(page, open);
    }
  });

  // The runs of the stubs' `--version` once the detection of the first render and the one "Detect again" ran.
  let detectedRuns: string[] = [];

  test('COCKPIT-66 AC11 — the first render of the New workspace page detects the harnesses: each stub ran `--version` once, none at startup before it, and the agent select shows the first', async () => {
    const { page } = session;
    await addRepository(session, repo);
    await openComposer(page, repo.root);
    fx.releaseVersions();
    await waitForAgent(page, 'Claude Code');

    expect(versionRuns(fx)).toEqual(['claude --version', 'codex --version']);
    expect(startRuns(fx)).toEqual([]);
  });

  // "Detect again" runs the detection again (each `--version` waits for the test). A start the page calls while
  // it runs, then a reload, must start nothing once detection ends: `sessions:start` reads the page's
  // ending count at its entry (the pending-spawn case is `survive AC8` below).
  test('workspace sessions AC13, AC12, COCKPIT-66 AC14 — while "Detect again" runs the agent select says "Detecting…"; a start called and a reload during detection start nothing, no folder, no stored session and no handler error', async () => {
    const { page } = session;
    expect(await sidebarLines(page)).toContain('Sessions');
    const before = {
      state: stateSnapshot(session.dataDir),
      folders: sessionFoldersIn(session.cockpitHome),
      starts: startRuns(fx),
    };

    await detectAgain(page);
    await waitForAgent(page, 'Detecting…');

    // Detection is running: the start waits for it, and the page is reloaded meanwhile.
    await page.evaluate(() => {
      void (
        window as unknown as { api: { sessions: { start(harness: string, size: { cols: number; rows: number }): Promise<unknown> } } }
      ).api.sessions.start('claude-code', { cols: 80, rows: 24 });
    });
    await page.reload();
    await page.getByText(versionLabel).waitFor();

    // The end of AC13: the agent menu lists the harnesses once detection has ended.
    await promptBox(page).waitFor();
    fx.releaseVersions();
    await waitForAgent(page, 'Claude Code');
    const menu = await openPopup(page, agentSelect(page));
    expect(await itemTexts(menu)).toEqual(['Claude Code 9.9.9', 'Codex 9.9.9', 'Terminal', 'Detect again']);
    await page.keyboard.press('Escape');

    // The host answers in order: once it ran a probe shell it has handled a spawn the start would have sent.
    const hostPid = await ptyHostPid(page);
    expect(stubPids(fx)).toEqual([]);
    // The probe shell is gone (its exit was reported), so nothing the daemon runs is left.
    expect(childPidsOf(hostPid)).toEqual([]);
    expect(startRuns(fx)).toEqual(before.starts);
    expect(sessionFoldersIn(session.cockpitHome)).toEqual(before.folders);
    expect(stateSnapshot(session.dataDir)).toEqual(before.state);
    expect(session.output()).not.toContain('Error occurred in handler');
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    detectedRuns = versionRuns(fx);
    expect(detectedRuns).toEqual(['claude --version', 'claude --version', 'codex --version', 'codex --version']);
  });

  test('AC1, workspace sessions AC14, COCKPIT-66 AC12 — the agent menu lists Claude Code then Codex, then Terminal; opening it runs no --version', async () => {
    const { page } = session;
    expect(versionRuns(fx)).toEqual(detectedRuns);

    await countIpcCalls(session, ['sessions:harnesses']);
    const menu = await openPopup(page, agentSelect(page));
    expect((await itemTexts(menu)).slice(0, 3)).toEqual(['Claude Code 9.9.9', 'Codex 9.9.9', 'Terminal']);
    // A run of `--version` comes only from a detection that is asked for again; the page's later answers
    // close the window in which that call would have reached the main process.
    await afterIpcAnswers(page);
    expect((await ipcCallArgs(session, 'sessions:harnesses')).filter(([options]) => (options as { again?: boolean } | undefined)?.again)).toEqual([]);
    expect(versionRuns(fx)).toEqual(detectedRuns);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
  });

  test('AC3 — sending the composer with no project and Claude Code opens its page, runs the stub in a new folder with the prompt as its argument and stores the session', async () => {
    const { page } = session;
    const id = await startSession(page, 'Claude Code', 'Claude Code 1');
    known.claude1.id = id;

    const home = join(session.cockpitHome, 'sessions', id);
    const stub = await readStub(page);
    // The stub prints its physical path (`pwd -P`); the temporary folder may sit behind a symlink.
    expect(stub.cwd).toBe(realpathSync(home));
    expect(stub.argCount).toBe(1);
    expect(stub.args).toBe(STARTED_PROMPT);
    expect(stub.term).toBe('xterm-256color');
    expect(isAlive(stub.pid)).toBe(true);
    known.claude1.pid = stub.pid;
    expect(statSync(home).isDirectory()).toBe(true);

    expect(await waitForSessionEntries(page, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);

    const stored = sessionsInState(session.dataDir);
    expect(stored).toEqual([
      { id, name: 'Claude Code 1', harness: 'claude-code', directory: home, createdAt: expect.any(String) },
    ]);
    expect(new Date(stored[0]!.createdAt).toISOString()).toBe(stored[0]!.createdAt);
  });

  test('control AC8, AC9 — a session outside any project gets its own id and the socket, no workspace path, and not the values the app inherited', async () => {
    const env = await readStubEnv(session.page);
    expect(env.session).toBe(known.claude1.id);
    expect(env.socket).toBe(daemonSocketIn(session.cockpitHome));
    expect(env.workspace).toBe('unset');
    expect(sessionsInState(session.dataDir)[0]!.id).toBe(env.session);
    expect(Object.values(env)).not.toContain(INHERITED_CONTROL_ENV.COCKPIT_SESSION_ID);
    expect(env.socket).not.toBe(INHERITED_CONTROL_ENV.COCKPIT_SOCKET);
  });

  test('control AC9 — a shell of the terminal page gets COCKPIT_SOCKET and neither a session id nor a workspace path, whatever the app inherited', async () => {
    const { page } = session;
    // No `env` in the request: the main process fills in the default environment.
    const id = await spawnShell(page, { command: '/bin/sh', cols: 80, rows: 24 });
    await ptyWrite(page, id, `printf 'sock=<%s> sid=<%s> ws=<%s>\\n' "\${COCKPIT_SOCKET-unset}" "\${COCKPIT_SESSION_ID-unset}" "\${COCKPIT_WORKSPACE_PATH-unset}"\n`);
    await waitForOutput(page, id, /sock=<[^%>][^>]*> sid=<[^>]*> ws=<[^>]*>/);
    const printed = /sock=<([^%>][^>]*)> sid=<([^>]*)> ws=<([^>]*)>/.exec(await outputOf(page, id))!;
    expect(printed.slice(1)).toEqual([daemonSocketIn(session.cockpitHome), 'unset', 'unset']);
    await ptyKill(page, id);
    await waitForExit(page, id);
  });

  test('workspace sessions AC14 — a session start runs no --version', async () => {
    expect(versionRuns(fx)).toEqual(detectedRuns);
    expect(startRuns(fx)).toContain(`claude ${STARTED_PROMPT}`);
  });

  test('AC4 — a line typed in the terminal reaches the harness and its answer shows', async () => {
    const { page } = session;
    await focusTerminal(page);
    await typeLine(page, 'hello');
    await waitForRow(page, 'got:hello');
  });

  test('AC6 — going Home and back keeps the process, its output and its input', async () => {
    const { page } = session;
    await goHome(page);
    expect(isAlive(known.claude1.pid)).toBe(true);

    await openSessionEntry(page, 'Claude Code 1');
    await waitForRow(page, 'got:hello');
    const stub = await readStub(page);
    expect(stub.pid).toBe(known.claude1.pid);
    expect(isAlive(known.claude1.pid)).toBe(true);

    await focusTerminal(page);
    await typeLine(page, 'again');
    await waitForRow(page, 'got:again');
  });

  test('AC5 — the next sessions are numbered per harness, and the list shows the newest first', async () => {
    const { page } = session;
    known.claude2.id = await startSession(page, 'Claude Code', 'Claude Code 2');
    known.claude2.pid = (await readStub(page)).pid;
    known.codex1.id = await startSession(page, 'Codex', 'Codex 1');
    known.codex1.pid = (await readStub(page)).pid;

    expect(await waitForSessionEntries(page, [['Codex 1', false], ['Claude Code 2', false], ['Claude Code 1', false]])).toEqual([
      ['Codex 1', false],
      ['Claude Code 2', false],
      ['Claude Code 1', false],
    ]);
    expect((await sessionEntries(page)).map((entry) => entry.id)).toEqual([known.codex1.id, known.claude2.id, known.claude1.id]);
    expect(new Set([known.claude1.pid, known.claude2.pid, known.codex1.pid]).size).toBe(3);
    expect(sessionsInState(session.dataDir).map((stored) => stored.name)).toEqual(['Claude Code 1', 'Claude Code 2', 'Codex 1']);
    expect(sessionsInState(session.dataDir).map((stored) => stored.harness)).toEqual(['claude-code', 'claude-code', 'codex']);
  });

  test('AC7 — typing exit shows the exit code in the terminal and the "Exited 3" dot on the entry; the other entries keep none', async () => {
    const { page } = session;
    await focusTerminal(page);
    await typeLine(page, 'exit');

    await waitForRow(page, '[Process exited with code 3]');
    expect(
      await waitForSessionEntries(page, [['Codex 1', true], ['Claude Code 2', false], ['Claude Code 1', false]]),
    ).toEqual([
      ['Codex 1', true],
      ['Claude Code 2', false],
      ['Claude Code 1', false],
    ]);
    await expectDot(page, known.codex1.id, 'Exited 3');
    expect((await sessionEntries(page)).map((entry) => entry.status)).toEqual(['Exited 3', null, null]);
    // The terminal's exit shows once its process is gone.
    expect(isAlive(known.codex1.pid)).toBe(false);
    expect(isAlive(known.claude2.pid)).toBe(true);
  });

  test('daemon AC4 — reloading the page keeps the processes: the running session shows no "Ended" dot, its page shows the running agent and a typed line reaches it', async () => {
    const { page } = session;
    await openSessionEntry(page, 'Claude Code 2');
    expect(isAlive(known.claude2.pid)).toBe(true);

    await page.reload();

    // The page shows the stub's output from before the reload: the same process.
    expect((await readStub(page)).pid).toBe(known.claude2.pid);
    expect(sessionIdOf(page)).toBe(known.claude2.id);
    expect(isAlive(known.claude2.pid)).toBe(true);
    expect((await sessionEntries(page)).find((entry) => entry.name === 'Claude Code 2')?.ended).toBe(false);
    expect(await page.getByText('This session has ended.').count()).toBe(0);
    await focusTerminal(page);
    await typeLine(page, 'after-reload');
    await waitForRow(page, 'got:after-reload');
  });

  test('AC14 — with the pty host dead, picking a harness starts the session: its page opens, the stub runs in a new folder under COCKPIT_HOME, and it is listed and stored', async () => {
    const { page } = session;
    await killPtyHost(page);
    const stored = sessionsInState(session.dataDir).length;
    const entriesBefore = await sessionEntries(page);

    const id = await startSession(page, 'Claude Code', 'Claude Code 3');
    known.claude3.id = id;

    const home = join(session.cockpitHome, 'sessions', id);
    const stub = await readStub(page);
    expect(stub.cwd).toBe(realpathSync(home));
    expect(stub.term).toBe('xterm-256color');
    expect(isAlive(stub.pid)).toBe(true);
    known.claude3.pid = stub.pid;
    expect(statSync(home).isDirectory()).toBe(true);

    expect((await sidebarLines(page)).filter((line) => line.startsWith('Could not start'))).toEqual([]);
    const entries = await untilRead(page, readSessionLinks, (list, arg: SessionLinksArg) => list.length === arg.count, { scope: 'sessions', count: entriesBefore.length + 1 });
    expect(entries.map((entry) => [entry.name, entry.ended])).toEqual([['Claude Code 3', false], ...entriesBefore.map((entry) => [entry.name, entry.ended])]);
    const list = sessionsInState(session.dataDir);
    expect(list).toHaveLength(stored + 1);
    expect(list.at(-1)).toEqual({ id, name: 'Claude Code 3', harness: 'claude-code', directory: home, createdAt: expect.any(String) });
    expect(sessionFoldersIn(session.cockpitHome)).toContain(id);
  });

  test('AC15 — a running session shows as ended when the pty host dies: [Process ended] in its terminal, the "Ended" dot on its entry', async () => {
    const { page } = session;
    // The session AC14 started runs on the new host and is open on its page.
    expect(sessionIdOf(page)).toBe(known.claude3.id);
    expect(isAlive(known.claude3.pid)).toBe(true);
    expect((await sessionEntries(page)).find((entry) => entry.id === known.claude3.id)?.ended).toBe(false);

    await killPtyHost(page);

    await waitForRow(page, '[Process ended]');
    expect(
      await waitForSessionEntries(page, [['Claude Code 3', true], ['Codex 1', true], ['Claude Code 2', true], ['Claude Code 1', true]]),
    ).toEqual([
      ['Claude Code 3', true],
      ['Codex 1', true],
      ['Claude Code 2', true],
      ['Claude Code 1', true],
    ]);
    await expectDot(page, known.claude3.id, 'Ended');
    // The same as when the agent exits (AC7): the page keeps its terminal, it does not turn into an error.
    expect(sessionIdOf(page)).toBe(known.claude3.id);
    await page.getByRole('heading', { name: 'Claude Code 3', exact: true }).waitFor();
  });

  // A folder named `state.json.tmp` in the data folder makes `saveState` fail
  // after the spawn succeeded, which runs the whole rollback. (A removed stub
  // would not do: node-pty does not throw on a missing executable.)
  test('AC16 — with a folder named state.json.tmp in the data folder, sending the composer with no project is refused in the composer and changes nothing', async () => {
    const { page } = session;
    // The first render detected the stubs and the page keeps the answer.
    await openComposer(page, 'none');
    await useAgent(page, 'Claude Code');

    // The pty host runs (AC15 killed it, this spawn starts a new one) with no pty of its own.
    const probe = await spawnShell(page);
    await ptyWrite(page, probe, 'echo ppid-$PPID\n');
    await waitForOutput(page, probe, /ppid-\d+/);
    const hostPid = Number(/ppid-(\d+)/.exec(await outputOf(page, probe))![1]);
    await ptyKill(page, probe);
    await waitForExit(page, probe);
    expect(childPidsOf(hostPid)).toEqual([]);

    const entriesBefore = await sessionEntries(page);
    const exitsBefore = await exitCount(page);
    const stateBefore = stateSnapshot(session.dataDir);
    const foldersBefore = sessionFoldersIn(session.cockpitHome);
    const blocker = join(session.dataDir, 'state.json.tmp');
    mkdirSync(blocker);
    try {
      await promptBox(page).fill(STARTED_PROMPT);
      await createButton(page).click();

      const message = await waitForMessage(page);
      expect(message.startsWith('Could not start Claude Code:')).toBe(true);
      expect(new URL(page.url()).pathname).toBe('/');

      // The refusal comes after the rollback: the spawned pty is killed (its exit is reported to the page, which
      // has listened since the probe), the folder removed, no change in the state.
      expect(isAlive(hostPid)).toBe(true);
      await untilPtyLog(page, (log, before: number) => Object.keys(log.exits).length > before, exitsBefore);
      expect(childPidsOf(hostPid)).toEqual([]);
      expect(await sessionEntries(page)).toEqual(entriesBefore);
      expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
      expect(sessionFoldersIn(session.cockpitHome)).toEqual(foldersBefore);
      expect(statSync(blocker).isDirectory()).toBe(true);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  });

  // --- Sessions in a workspace (COCKPIT-28). They run in order on this launch, with the
  // repository added above.

  test('workspace sessions AC5 — sending the composer with Claude Code and the prompt "fix the tests" creates the worktree on the branch fix-the-tests, opens the workspace page with the session as its selected tab and runs the harness there with that one argument', async () => {
    const { page } = session;
    const foldersBefore = sessionFoldersIn(session.cockpitHome);
    const id = await createWorkspaceWithAgent(page, repo, { agent: 'Claude Code', prompt: 'fix the tests' }, 'Claude Code 1');
    const path = worktreePath(session, repo, 'fix-the-tests');
    ws.fix = { path, id, pid: 0 };

    expect(existsSync(join(path, 'README.md'))).toBe(true);
    expect(linkedWorktrees(repo)).toContainEqual({ path, branch: 'fix-the-tests' });
    const stub = await readStub(page);
    expect(stub.cwd).toBe(path);
    expect(stub.argCount).toBe(1);
    expect(stub.args).toBe('fix the tests');
    expect(isAlive(stub.pid)).toBe(true);
    ws.fix.pid = stub.pid;

    expect(await waitForWorkspaceTabs(page, ['Claude Code 1'])).toEqual(['Claude Code 1']);
    expect((await sessionEntries(page)).map((entry) => entry.id)).not.toContain(id);
    const stored = sessionsInState(session.dataDir).find((entry) => entry.id === id);
    expect(stored).toEqual({
      id,
      name: 'Claude Code 1',
      harness: 'claude-code',
      directory: path,
      project: repo.root,
      createdAt: expect.any(String),
      open: true,
    });
    expect(sessionFoldersIn(session.cockpitHome)).toEqual(foldersBefore);
  });

  test('workspace sessions AC6 — a second workspace created through the composer runs its own session, numbered from 1', async () => {
    const { page } = session;
    const id = await createWorkspaceWithAgent(page, repo, { agent: 'Claude Code', prompt: 'second ws' }, 'Claude Code 1');
    const path = worktreePath(session, repo, 'second-ws');
    ws.blank = { path, id, pid: 0 };

    const stub = await readStub(page);
    expect(stub.cwd).toBe(path);
    expect(stub.argCount).toBe(1);
    expect(stub.args).toBe('second ws');
    ws.blank.pid = stub.pid;
    expect(await waitForWorkspaceTabs(page, ['Claude Code 1'])).toEqual(['Claude Code 1']);
  });

  test('workspace sessions AC1 — the "Start session in <workspace>" button shows on hover and on focus next to the "…" button, and opens the harness menu', async () => {
    const { page } = session;
    // A workspace made with git itself, listed when the window gains the focus.
    const path = join(repo.parent, 'wt-plus');
    gitIn(repo.root, 'worktree', 'add', '--quiet', '-b', 'ws-plus', path, 'main');
    await dispatchFocus(page);
    await waitForEntry(page, path);
    ws.plus.path = path;

    const plus = page.getByRole('button', { name: startPlusLabel('ws-plus'), exact: true });
    // The opacity once its transition has ended (`getAnimations` brings the style of the hover up to date first).
    const opacity = () =>
      plus.evaluate(async (button) => {
        await Promise.all(button.getAnimations().map((animation) => animation.finished));
        return getComputedStyle(button).opacity;
      });
    expect(await plus.count()).toBe(1);

    // Pointer away: hidden.
    await moveMouseAway(page);
    expect(await opacity()).toBe('0');
    // Pointer over the row: shown.
    await page.getByTitle(path, { exact: true }).first().hover();
    expect(await opacity()).toBe('1');
    // Next to the "…" button of the row.
    const dots = await page.getByRole('button', { name: 'Actions for ws-plus', exact: true }).boundingBox();
    const box = await plus.boundingBox();
    expect(dots && box).toBeTruthy();
    expect(Math.abs(box!.y - dots!.y)).toBeLessThan(4);
    expect(Math.abs(box!.x - dots!.x)).toBeLessThan(40);

    // Keyboard focus: shown with the pointer elsewhere.
    await moveMouseAway(page);
    expect(await opacity()).toBe('0');
    await page.keyboard.press('Shift');
    await plus.focus();
    expect(await opacity()).toBe('1');
    await plus.blur();

    await openWorkspaceStartMenu(page, path, 'ws-plus');
    expect((await page.getByRole('menuitem').allInnerTexts()).map((text) => text.trim())).toEqual(['Claude Code', 'Codex']);
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem').first().waitFor({ state: 'detached' });
  });

  test('workspace sessions AC2 — picking Claude Code in the menu runs the harness in the worktree with no argument and the login shell PATH, shows it as a tab of the workspace page and stores it with its project, with no session folder', async () => {
    const { page } = session;
    const foldersBefore = sessionFoldersIn(session.cockpitHome);

    const id = await startInWorkspace(page, ws.plus.path, 'ws-plus', 'Claude Code', 'Claude Code 1');
    ws.plus.ids.push(id);

    const stub = await readStub(page);
    expect(stub.cwd).toBe(ws.plus.path);
    expect(stub.argCount).toBe(0);
    expect(stub.term).toBe('xterm-256color');
    // The `cockpit` CLI's folder comes first on the PATH of every terminal the app spawns (COCKPIT-57).
    expect(stub.path).toBe(`${dirname(REPOSITORY_CLI)}:${fx.bin}:/usr/bin:/bin`);
    expect(stub.path).not.toBe(process.env.PATH);
    expect(isAlive(stub.pid)).toBe(true);
    ws.plus.pids.push(stub.pid);

    expect(await waitForWorkspaceTabs(page, ['Claude Code 1'])).toEqual(['Claude Code 1']);
    expect((await sessionEntries(page)).map((entry) => entry.id)).not.toContain(id);
    expect(sessionsInState(session.dataDir).find((entry) => entry.id === id)).toEqual({
      id,
      name: 'Claude Code 1',
      harness: 'claude-code',
      directory: ws.plus.path,
      project: repo.root,
      createdAt: expect.any(String),
      open: true,
    });
    expect(sessionFoldersIn(session.cockpitHome)).toEqual(foldersBefore);
  });

  test('control AC8, AC9 — a session started in a workspace gets its id, the socket and the worktree path stored as its directory', async () => {
    const env = await readStubEnv(session.page);
    const stored = sessionsInState(session.dataDir).find((entry) => entry.id === ws.plus.ids[0])!;
    expect(env.session).toBe(ws.plus.ids[0]);
    expect(env.workspace).toBe(stored.directory);
    expect(env.workspace).toBe(ws.plus.path);
    expect(env.socket).toBe(daemonSocketIn(session.cockpitHome));
  });

  test('workspace sessions AC3 — sessions are numbered per workspace, as tabs of its page, and apart from the Sessions section', async () => {
    const { page } = session;
    const id = await startInWorkspace(page, ws.plus.path, 'ws-plus', 'Claude Code', 'Claude Code 2');
    ws.plus.ids.push(id);
    ws.plus.pids.push((await readStub(page)).pid);

    expect(await waitForWorkspaceTabs(page, ['Claude Code 1', 'Claude Code 2'])).toEqual(['Claude Code 1', 'Claude Code 2']);
    const namesIn = (path: string) => sessionsInState(session.dataDir).filter((entry) => entry.directory === path).map((entry) => entry.name);
    expect(namesIn(ws.plus.path)).toEqual(['Claude Code 1', 'Claude Code 2']);
    // Another workspace keeps its own count.
    expect(namesIn(ws.fix.path)).toEqual(['Claude Code 1']);

    // The Sessions header counts the sessions outside any project only.
    const outside = sessionsInState(session.dataDir).filter((entry) => entry.harness === 'claude-code' && entry.project === undefined);
    const name = `Claude Code ${outside.length + 1}`;
    expect(outside.length).toBeGreaterThan(0);
    const headerId = await startSession(page, 'Claude Code', name);
    expect((await sessionEntries(page))[0]).toMatchObject({ id: headerId, name });
    expect(sessionsInState(session.dataDir).find((entry) => entry.id === headerId)?.project).toBeUndefined();
    expect(namesIn(ws.plus.path)).toEqual(['Claude Code 1', 'Claude Code 2']);
  });

  test('workspace sessions AC7 — a save that fails after the spawn keeps the new workspace and its files, shows "Could not start Claude Code: …" under Projects (COCKPIT-89), leaves no harness process and the sessions unchanged', async () => {
    const { page } = session;
    const before = {
      state: stateSnapshot(session.dataDir),
      sessions: sessionsInState(session.dataDir),
      folders: sessionFoldersIn(session.cockpitHome),
      pids: stubPids(fx),
    };
    const blocker = join(session.dataDir, 'state.json.tmp');
    mkdirSync(blocker);
    try {
      await openComposer(page, repo.root);
      await useAgent(page, 'Claude Code');
      await baseSelect(page).filter({ hasText: /\S/ }).filter({ hasNotText: 'Select a base' }).waitFor();
      await promptBox(page).fill('save fails');
      // The composer is on its page for good now: the log of the page's exits starts here.
      await ensurePtyLog(page);
      const exitsBefore = await exitCount(page);
      await createButton(page).click();

      const path = worktreePath(session, repo, 'save-fails');
      await waitForEntry(page, path);
      expect(await entryTitles(page)).toContain(path);
      expect(existsSync(join(path, 'README.md'))).toBe(true);
      expect(linkedWorktrees(repo)).toContainEqual({ path, branch: 'save-fails' });

      // The workspace page opened with the send; the refusal shows in the sidebar's message slot under Projects.
      const status = page.locator('aside [role="status"]').filter({ hasText: /^\s*Could not start Claude Code:/ }).first();
      await status.waitFor();
      // Only a save after a successful spawn raises it.
      expect(await status.innerText()).toContain('EISDIR');
      expect(new URL(page.url()).pathname).toBe('/workspace');

      // The harness was spawned (the message carries the save error), then killed by the rollback.
      // The rollback kills the spawned harness: its exit is reported to the page, which has logged since the click.
      await untilPtyLog(page, (log, before: number) => Object.keys(log.exits).length > before, exitsBefore);
      expect(stubPids(fx)).toEqual(before.pids);
      expect(sessionsInState(session.dataDir)).toEqual(before.sessions);
      expect(stateSnapshot(session.dataDir)).toEqual(before.state);
      expect(sessionFoldersIn(session.cockpitHome)).toEqual(before.folders);
      expect(statSync(blocker).isDirectory()).toBe(true);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  });

  test('workspace sessions AC8 — sessions.start refuses a workspace of an unknown project or a path that is not a linked worktree, and changes nothing', async () => {
    const { page } = session;
    const before = {
      state: stateSnapshot(session.dataDir),
      folders: sessionFoldersIn(session.cockpitHome),
      pids: stubPids(fx),
      runs: stubRuns(fx),
    };
    const elsewhere = join(repo.parent, 'not-a-worktree');
    mkdirSync(elsewhere);

    expect(await startApi(page, { workspace: { project: '/no/such/project', path: '/no/such/project/ws' } })).toEqual({
      status: 'refused',
      message: '/no/such/project is not a project in Cockpit.',
    });
    expect(await startApi(page, { workspace: { project: repo.root, path: elsewhere } })).toEqual({
      status: 'refused',
      message: `${elsewhere} is not a workspace of ${repo.name}.`,
    });
    // The main working tree is the project, not a workspace.
    expect(await startApi(page, { workspace: { project: repo.root, path: repo.root } })).toEqual({
      status: 'refused',
      message: `${repo.root} is not a workspace of ${repo.name}.`,
    });

    // The daemon answers in order: once it ran a probe shell it has handled any spawn the calls would have sent.
    await ptyHostPid(page);
    expect(stubPids(fx)).toEqual(before.pids);
    expect(stubRuns(fx)).toEqual(before.runs);
    expect(sessionFoldersIn(session.cockpitHome)).toEqual(before.folders);
    expect(stateSnapshot(session.dataDir)).toEqual(before.state);
  });

  test('workspace sessions AC8 — a project whose folder is gone is refused with "<project path> is not a git repository.", nothing is spawned and the state is unchanged', async () => {
    const { page } = session;
    const gone = makeRepo('agent-gone');
    try {
      await addRepository(session, gone);
      // Deleted after it was added: the state still lists it.
      rmSync(gone.parent, { recursive: true, force: true });
      const before = {
        state: stateSnapshot(session.dataDir),
        folders: sessionFoldersIn(session.cockpitHome),
        pids: stubPids(fx),
        runs: stubRuns(fx),
      };

      expect(await startApi(page, { workspace: { project: gone.root, path: join(gone.parent, 'wt') } })).toEqual({
        status: 'refused',
        message: `${gone.root} is not a git repository.`,
      });

      await ptyHostPid(page);
      expect(stubPids(fx)).toEqual(before.pids);
      expect(stubRuns(fx)).toEqual(before.runs);
      expect(sessionFoldersIn(session.cockpitHome)).toEqual(before.folders);
      expect(stateSnapshot(session.dataDir)).toEqual(before.state);

      await removeThroughMenu(page, gone.root);
      await waitForNoEntry(page, gone.root);
    } finally {
      rmSync(gone.parent, { recursive: true, force: true });
    }
  });

  test('workspace sessions AC11 — pty.spawn with a command and no args runs it with no argument; without a command it runs the login shell with -l', async () => {
    const { page } = session;
    const id = await spawnShell(page, { command: join(fx.bin, 'claude'), cols: 80, rows: 24 });
    await waitForOutput(page, id, 'ready');
    expect(await outputOf(page, id)).toContain('args:0:');
    await ptyKill(page, id);
    await waitForExit(page, id);

    const loginShellRuns = () => readFileSync(fx.shellLog, 'utf8').split('\n').filter((line) => line === '-l').length;
    const before = loginShellRuns();
    const shellId = await spawnShell(page, { cols: 80, rows: 24 });
    await waitForExit(page, shellId);
    expect(loginShellRuns()).toBe(before + 1);
  });

  test('workspace sessions AC9, COCKPIT-68 AC14, AC15 — Cancel and Escape on the Delete dialog end nothing; a file that appears after it opened makes the first Delete end nothing and show the warning; the click that follows removes the workspace and ends its running sessions (the entries go, state.json keeps them)', async () => {
    const { page } = session;
    expect(ws.fix.path, 'the AC5 test created the workspace').not.toBe('');
    expect(isAlive(ws.fix.pid)).toBe(true);
    const sessionsBefore = sessionsInState(session.dataDir);
    await ensurePtyLog(page);
    const terminal = await terminalOfSession(page, ws.fix.id);
    await countIpcCalls(session, ['workspaces:remove']);
    const removesBefore = (await removeOptions(session)).length;

    for (const dismiss of ['Cancel', 'Escape'] as const) {
      const closing = await openDeleteDialog(page, ws.fix.path, 'fix-the-tests');
      if (dismiss === 'Cancel') await closing.getByRole('button', { name: 'Cancel', exact: true }).click();
      else await page.keyboard.press('Escape');
      await closing.waitFor({ state: 'hidden' });
      await afterIpcAnswers(page);
      expect((await removeOptions(session)).length).toBe(removesBefore);
      expect(await terminalOfSession(page, ws.fix.id), `the session is still listed after ${dismiss}`).toBe(terminal);
      expect(isAlive(ws.fix.pid), `the harness runs after ${dismiss}`).toBe(true);
      expect(existsSync(ws.fix.path)).toBe(true);
    }

    // The workspace was clean when the dialog read it; a file appears before Delete is clicked.
    const dialog = await openDeleteDialog(page, ws.fix.path, 'fix-the-tests');
    writeFileSync(join(ws.fix.path, 'notes.txt'), 'untracked\n');
    await deleteButton(dialog).click();
    await waitForDialogLine(dialog, /^It has uncommitted changes\. They will be lost\.$/);
    // The warning is the answer of the first removal. Ending a terminal takes it out of the page's list at once,
    // so the list tells whether the sessions were ended at this step.
    expect(await terminalOfSession(page, ws.fix.id), 'the session is still listed').toBe(terminal);
    expect(isAlive(ws.fix.pid), 'the harness runs while the warning is shown').toBe(true);
    expect(existsSync(ws.fix.path)).toBe(true);
    expect(await dialog.isVisible()).toBe(true);

    await deleteButton(dialog).click();
    await dialog.waitFor({ state: 'hidden' });
    await waitForNoEntry(page, ws.fix.path);

    expect(existsSync(ws.fix.path)).toBe(false);
    await waitForExit(page, terminal);
    expect(isAlive(ws.fix.pid)).toBe(false);
    expect(await allSessionLinkIds(page)).not.toContain(ws.fix.id);
    expect(ignoringOpen(sessionsInState(session.dataDir))).toEqual(ignoringOpen(sessionsBefore));
    expect(sessionsInState(session.dataDir).map((entry) => entry.id)).toContain(ws.fix.id);
    const sent = (await removeOptions(session)).slice(removesBefore);
    expect(sent.map((options) => options.force ?? false)).toEqual([false, true]);
  });

  test('workspace sessions AC10, COCKPIT-68 AC5, AC6 — removing the project ends its workspaces\' running sessions; adding it again shows its workspaces with no tab, and state.json held the sessions throughout', async () => {
    const { page } = session;
    const running = [ws.blank.pid, ...ws.plus.pids];
    for (const pid of running) expect(isAlive(pid)).toBe(true);
    const sessionsBefore = sessionsInState(session.dataDir);
    await ensurePtyLog(page);
    const terminals = await Promise.all([ws.blank.id, ...ws.plus.ids].map((id) => terminalOfSession(page, id)));

    // COCKPIT-68 AC5: Cancel and Escape on the dialog end nothing.
    await countIpcCalls(session, ['projects:remove']);
    const removesBefore = await ipcCalls(session, 'projects:remove');
    for (const dismiss of ['Cancel', 'Escape'] as const) {
      const closing = await startProjectRemoval(page, repo.root);
      if (dismiss === 'Cancel') await closing.getByRole('button', { name: 'Cancel', exact: true }).click();
      else await page.keyboard.press('Escape');
      await closing.waitFor({ state: 'hidden' });
      await afterIpcAnswers(page);
      expect(await ipcCalls(session, 'projects:remove'), dismiss).toBe(removesBefore);
      for (const pid of running) expect(isAlive(pid), `${dismiss}: a session keeps running`).toBe(true);
      expect(await entryTitles(page)).toContain(repo.root);
    }

    await removeThroughMenu(page, repo.root);
    await waitForNoEntry(page, repo.root);

    for (const terminal of terminals) await waitForExit(page, terminal);
    for (const pid of running) expect(isAlive(pid)).toBe(false);
    const shown = await allSessionLinkIds(page);
    for (const id of [ws.blank.id, ...ws.plus.ids]) expect(shown).not.toContain(id);
    expect(ignoringOpen(sessionsInState(session.dataDir))).toEqual(ignoringOpen(sessionsBefore));

    // Added again, the workspaces come back with no tab: the processes ended, and a session that ended is not shown.
    await addRepository(session, repo);
    for (const path of [ws.blank.path, ws.plus.path]) {
      await page.getByTitle(path, { exact: true }).first().click();
      await page.getByText('No tab open', { exact: true }).waitFor();
      expect(await workspaceTabs(page)).toEqual([]);
    }
    expect(ignoringOpen(sessionsInState(session.dataDir))).toEqual(ignoringOpen(sessionsBefore));
  });

  // --- Open a workspace in an editor, a terminal or the Finder (COCKPIT-33). They run in
  // order on this launch, with the repository added above and a workspace of their own. The
  // fake bundles are Visual Studio Code, Cursor, Terminal and Ghostty.

  const launcher = { path: '' };
  const bundle = (name: string) => join(open.apps, `${name}.app`);
  const restoreBundles = () => {
    for (const name of OPEN_BUNDLES) mkdirSync(join(open.apps, name), { recursive: true });
  };
  const messagesShown = async (page: Page) =>
    (await sidebarLines(page)).filter((line) => /^Could not (open|reveal) |^Cockpit could not save its data/.test(line));
  // Self-contained for `untilRead`: the sidebar's lines are read again here.
  const waitForMessages = (page: Page) =>
    untilRead(
      page,
      () =>
        ((document.querySelector('aside') as HTMLElement | null)?.innerText ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^Could not (open|reveal) |^Cockpit could not save its data/.test(line)),
      (found) => found.length > 0,
    );
  const waitForNoMessages = (page: Page) =>
    untilRead(
      page,
      () =>
        ((document.querySelector('aside') as HTMLElement | null)?.innerText ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^Could not (open|reveal) |^Cockpit could not save its data/.test(line)),
      (found) => found.length === 0,
    );

  test('open workspace AC1 — the workspace menu lists, above "Delete workspace…", the editor and the terminal shown, "Reveal in Finder" and the two submenus of the detected apps only; opening it runs nothing', async () => {
    const { page } = session;
    launcher.path = await createPlainWorkspace(session, repo, 'open-in');
    const stateBefore = stateSnapshot(session.dataDir);

    // Nothing remembered: the first detected editor and terminal in catalogue order are shown.
    await openWorkspaceMenu(page, launcher.path, FIRST_MENU);
    expect(await submenuTexts(page, 'Open in editor')).toEqual(['Visual Studio Code', 'Cursor']);
    expect(await submenuTexts(page, 'Open in terminal')).toEqual(['Terminal', 'Ghostty']);
    for (const item of await submenuNamed(page, 'Open in terminal').getByRole('menuitem').all()) expect(await item.isDisabled()).toBe(false);

    expect(openRuns(open)).toEqual([]);
    expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
    expect(rememberedApps(session.dataDir)).toEqual({ editor: undefined, terminal: undefined });
  });

  test('open workspace AC3 — "Reveal in Finder" runs open -R <worktree path>', async () => {
    const { page } = session;
    await openWorkspaceMenu(page, launcher.path, FIRST_MENU);
    await untilAnswered(session, 'workspaces:reveal', () => pickTopItem(page, 'Reveal in Finder'));

    // The handler answered after the run: no other run follows it.
    expect(await waitForOpenRuns(open, 1)).toEqual([['-R', launcher.path]]);
    expect(await messagesShown(page)).toEqual([]);
  });

  test('open workspace AC4, AC5 — "Open in <name>" and the submenu items run open -a <bundle path> <worktree path>; an app opened with nothing remembered is remembered', async () => {
    const { page } = session;
    await openWorkspaceMenu(page, launcher.path, FIRST_MENU);
    await untilAnswered(session, 'workspaces:open', () => pickTopItem(page, 'Open in Visual Studio Code'));
    await waitForOpenRuns(open, 2);
    expect(openRuns(open).at(-1)).toEqual(['-a', bundle('Visual Studio Code'), launcher.path]);
    // AC5: nothing was remembered, so the app opened differs from it. (`saveState` ran before the answer.)
    expect(rememberedApps(session.dataDir).editor).toBe('vscode');

    await openWorkspaceMenu(page, launcher.path, ['Open in Visual Studio Code', 'Open in Terminal', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
    await untilAnswered(session, 'workspaces:open', () => pickInSubmenu(page, 'Open in editor', 'Cursor'));
    await waitForOpenRuns(open, 3);
    expect(openRuns(open).at(-1)).toEqual(['-a', bundle('Cursor'), launcher.path]);
    expect(rememberedApps(session.dataDir).editor).toBe('cursor');

    await openWorkspaceMenu(page, launcher.path, ['Open in Cursor', 'Open in Terminal', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
    await untilAnswered(session, 'workspaces:open', () => pickInSubmenu(page, 'Open in terminal', 'Ghostty'));
    await waitForOpenRuns(open, 4);
    expect(openRuns(open).at(-1)).toEqual(['-a', bundle('Ghostty'), launcher.path]);
    expect(rememberedApps(session.dataDir).terminal).toBe('ghostty');
    expect(await messagesShown(page)).toEqual([]);
  });

  test('open workspace AC5 — the apps opened last are in state.json and shown by the next menu; one already remembered writes nothing', async () => {
    const { page } = session;
    expect(rememberedApps(session.dataDir)).toEqual({
      editor: 'cursor',
      terminal: 'ghostty',
    });
    await openWorkspaceMenu(page, launcher.path, ['Open in Cursor', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);

    // A different editor replaces the remembered one, and the menu shows it next.
    await untilAnswered(session, 'workspaces:open', () => pickInSubmenu(page, 'Open in editor', 'Visual Studio Code'));
    await waitForOpenRuns(open, 5);
    expect(rememberedApps(session.dataDir)).toEqual({
      editor: 'vscode',
      terminal: 'ghostty',
    });
    await openWorkspaceMenu(page, launcher.path, ['Open in Visual Studio Code', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);

    // The remembered app again: the run happens, the file is not written.
    const before = stateSnapshot(session.dataDir);
    await untilAnswered(session, 'workspaces:open', () => pickTopItem(page, 'Open in Visual Studio Code'));
    await waitForOpenRuns(open, 6);
    expect(openRuns(open).at(-1)).toEqual(['-a', bundle('Visual Studio Code'), launcher.path]);
    // The handler has answered, after the run and any save.
    expect(stateSnapshot(session.dataDir)).toEqual(before);

    // Back to Cursor for the tests below.
    await openWorkspaceMenu(page, launcher.path, ['Open in Visual Studio Code', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
    await untilAnswered(session, 'workspaces:open', () => pickInSubmenu(page, 'Open in editor', 'Cursor'));
    await waitForOpenRuns(open, 7);
    expect(rememberedApps(session.dataDir)).toEqual({
      editor: 'cursor',
      terminal: 'ghostty',
    });
  });

  test('open workspace AC6 — a remembered editor that is no longer detected is replaced in the menu by the first detected one, absent from its submenu, and stays in state.json', async () => {
    const { page } = session;
    rmSync(bundle('Cursor'), { recursive: true });
    try {
      const before = stateSnapshot(session.dataDir);
      await openWorkspaceMenu(page, launcher.path, ['Open in Visual Studio Code', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
      expect(await submenuTexts(page, 'Open in editor')).toEqual(['Visual Studio Code']);

      expect(stateSnapshot(session.dataDir)).toEqual(before);
      expect(rememberedApps(session.dataDir).editor).toBe('cursor');
    } finally {
      restoreBundles();
    }
    // Detected again, the remembered editor is shown again.
    await closeMenus(page);
    await openWorkspaceMenu(page, launcher.path, ['Open in Cursor', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
  });

  test('open workspace AC2 — with no detected editor (or terminal) the menu has no "Open in <name>" for it and its submenu holds one disabled "No editor found" ("No terminal found"); "Reveal in Finder" stays', async () => {
    const { page } = session;
    try {
      // No editor: the terminal side is untouched.
      rmSync(bundle('Visual Studio Code'), { recursive: true });
      rmSync(bundle('Cursor'), { recursive: true });
      await openWorkspaceMenu(page, launcher.path, ['Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal']);
      const noEditor = await openSubmenu(page, 'Open in editor');
      expect(trimmed(await noEditor.allInnerTexts())).toEqual(['No editor found']);
      expect(await noEditor.first().isDisabled()).toBe(true);
      expect(await submenuTexts(page, 'Open in terminal')).toEqual(['Terminal', 'Ghostty']);
      await closeMenus(page);

      // No terminal either.
      rmSync(bundle('Terminal'), { recursive: true });
      rmSync(bundle('Ghostty'), { recursive: true });
      await openWorkspaceMenu(page, launcher.path, ['Reveal in Finder', 'Open in editor', 'Open in terminal']);
      const noTerminal = await openSubmenu(page, 'Open in terminal');
      expect(trimmed(await noTerminal.allInnerTexts())).toEqual(['No terminal found']);
      expect(await noTerminal.first().isDisabled()).toBe(true);
      // A disabled item: the click does nothing, so no call reaches the main process by the time its later answers come.
      await countIpcCalls(session, ['workspaces:open']);
      const opens = await ipcCalls(session, 'workspaces:open');
      await noTerminal.first().click({ force: true }).catch(() => {});
      await afterIpcAnswers(page);
      expect(await ipcCalls(session, 'workspaces:open')).toBe(opens);
      expect(openRuns(open)).toHaveLength(7);
    } finally {
      restoreBundles();
    }
  });

  test('open workspace AC9 — reveal and open refuse a project that is not in Cockpit, a path that is not a linked worktree and an app that is not detected, run nothing, and reject from another origin', async () => {
    const { page } = session;
    const runs = openRuns(open);
    const stateBefore = stateSnapshot(session.dataDir);
    const elsewhere = join(repo.parent, 'not-a-worktree');
    mkdirSync(elsewhere, { recursive: true });
    const noProject = (project: string) => ({ status: 'refused', message: `${project} is not a project in Cockpit.` });
    const noWorkspace = (path: string) => ({ status: 'refused', message: `${path} is not a workspace of ${repo.name}.` });

    expect(await workspacesApi(page, 'reveal', ['/no/such/project', '/no/such/project/ws'])).toEqual(noProject('/no/such/project'));
    expect(await workspacesApi(page, 'open', ['/no/such/project', '/no/such/project/ws', 'cursor'])).toEqual(noProject('/no/such/project'));
    expect(await workspacesApi(page, 'reveal', [repo.root, elsewhere])).toEqual(noWorkspace(elsewhere));
    expect(await workspacesApi(page, 'open', [repo.root, elsewhere, 'cursor'])).toEqual(noWorkspace(elsewhere));
    // The main working tree is the project, not a workspace.
    expect(await workspacesApi(page, 'reveal', [repo.root, repo.root])).toEqual(noWorkspace(repo.root));
    expect(await workspacesApi(page, 'open', [repo.root, repo.root, 'cursor'])).toEqual(noWorkspace(repo.root));
    // An app of the catalogue that is not detected, and an id outside it.
    expect(await workspacesApi(page, 'open', [repo.root, launcher.path, 'zed'])).toEqual({ status: 'refused', message: 'Zed is not installed.' });
    expect(await workspacesApi(page, 'open', [repo.root, launcher.path, 'nope'])).toEqual({ status: 'refused', message: 'nope is not installed.' });

    // From another origin the handlers reject.
    const origins = await session.evaluateInMain<Record<string, string>>(`(async () => {
      const handlers = ${INVOKE_HANDLERS};
      const calls = {
        'workspaces:apps': [],
        'workspaces:reveal': [${JSON.stringify(repo.root)}, ${JSON.stringify(launcher.path)}],
        'workspaces:open': [${JSON.stringify(repo.root)}, ${JSON.stringify(launcher.path)}, 'cursor'],
      };
      const results = {};
      for (const [channel, args] of Object.entries(calls)) {
        const handler = handlers.get(channel);
        if (!handler) { results[channel] = 'no handler'; continue; }
        try {
          await handler({ senderFrame: { url: 'https://example.com/' }, sender: null }, ...args);
          results[channel] = 'resolved';
        } catch {
          results[channel] = 'rejected';
        }
      }
      return results;
    })()`);
    expect(origins).toEqual({ 'workspaces:apps': 'rejected', 'workspaces:reveal': 'rejected', 'workspaces:open': 'rejected' });

    // Every call above has answered (the refusals come before any run).
    expect(openRuns(open)).toEqual(runs);
    expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
    expect(await messagesShown(page)).toEqual([]);
  });

  test('open workspace AC8 — a run that exits non-zero shows "Could not open … in <app>: <reason>" or "Could not reveal … in the Finder: <reason>" in the Projects message slot, remembers nothing, and the next success clears it', async () => {
    const { page } = session;
    const menu = ['Open in Cursor', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal'];
    const stateBefore = stateSnapshot(session.dataDir);
    expect(rememberedApps(session.dataDir)).toEqual({ editor: 'cursor', terminal: 'ghostty' });

    // The stderr, trimmed. Another editor than the remembered one: it must not be remembered.
    setOpenOutcome(open, { code: 3, stderr: '  Unable to find application\n\n' });
    await openWorkspaceMenu(page, launcher.path, menu);
    await pickInSubmenu(page, 'Open in editor', 'Visual Studio Code');
    const openMessage = `Could not open ${launcher.path} in Visual Studio Code: Unable to find application`;
    // The message is the handler's answer, which came after the run: nothing was remembered by then.
    await waitForLine(page, openMessage);
    expect(await isBelowProjectsHeader(page, { text: openMessage })).toBe(true);
    expect(await messagesShown(page)).toEqual([openMessage]);
    expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
    await openWorkspaceMenu(page, launcher.path, menu);

    // Empty stderr: the exit code. The next refusal replaces the message.
    setOpenOutcome(open, { code: 5 });
    await pickTopItem(page, 'Reveal in Finder');
    const revealMessage = `Could not reveal ${launcher.path} in the Finder: open exited with code 5`;
    await waitForLine(page, revealMessage);
    expect(await messagesShown(page)).toEqual([revealMessage]);

    // A reveal that succeeds clears it.
    setOpenOutcome(open);
    await openWorkspaceMenu(page, launcher.path, menu);
    await pickTopItem(page, 'Reveal in Finder');
    await waitForNoMessages(page);
    expect(await messagesShown(page)).toEqual([]);

    // An open that fails with an empty stderr, then an open that succeeds.
    setOpenOutcome(open, { code: 2 });
    await openWorkspaceMenu(page, launcher.path, menu);
    await pickTopItem(page, 'Open in Ghostty');
    await waitForLine(page, `Could not open ${launcher.path} in Ghostty: open exited with code 2`);
    setOpenOutcome(open);
    await openWorkspaceMenu(page, launcher.path, menu);
    await pickTopItem(page, 'Open in Cursor');
    await waitForNoMessages(page);
    expect(await messagesShown(page)).toEqual([]);

    expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
    expect(rememberedApps(session.dataDir)).toEqual({ editor: 'cursor', terminal: 'ghostty' });
  });

  // A folder named `state.json.tmp` makes `saveState` fail after the run succeeded.
  test('open workspace AC10 — when the run succeeds and the save fails, the Projects message slot shows "Cockpit could not save its data: …", state.json is unchanged and so is the remembered app', async () => {
    const { page } = session;
    const menu = ['Open in Cursor', 'Open in Ghostty', 'Reveal in Finder', 'Open in editor', 'Open in terminal'];
    setOpenOutcome(open);
    const runs = openRuns(open).length;
    const blocker = join(session.dataDir, 'state.json.tmp');
    mkdirSync(blocker);
    try {
      const stateBefore = stateSnapshot(session.dataDir);
      await openWorkspaceMenu(page, launcher.path, menu);
      await pickInSubmenu(page, 'Open in editor', 'Visual Studio Code');

      const lines = await waitForMessages(page);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Cockpit could not save its data: .*EISDIR/);
      expect(await isBelowProjectsHeader(page, { text: lines[0]! })).toBe(true);
      expect(openRuns(open)).toHaveLength(runs + 1);
      expect(stateSnapshot(session.dataDir)).toEqual(stateBefore);
      expect(statSync(blocker).isDirectory()).toBe(true);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }

    // The remembered editor in memory is still Cursor.
    await openWorkspaceMenu(page, launcher.path, menu);
  });

  // --- Setup through the CLI (COCKPIT-57). The composer with an agent starts the session
  // as `cockpit setup --shell --then <agent>` in the one terminal of its page. The stub `claude` logs
  // every run in `fx.runLog`, and `mark.sh <text>` appends a line to the same log, so the order of a
  // setup's last command and the stub's start shows in it. The login shell is interactive for these
  // tests (`interactive` in the fixture's folder): it is where a failed setup or an exited agent
  // leaves the user.

  const storedIn = (directory: string) => sessionsInState(session.dataDir).filter((entry) => entry.directory === directory);

  // Creates a workspace with Claude Code and a prompt through the composer (the branch `name` is the prompt's
  // slug: the prompt is `name` unless given); resolves with its path and with the id of the session whose page opened.
  async function createWorkspaceWithSetup(name: string, prompt = name): Promise<{ path: string; id: string }> {
    const { page } = session;
    writeScripts(repo, {
      'mark.sh': `echo "$1" >> '${fx.runLog}'\n`,
      'check.sh': 'test -f "$COCKPIT_ROOT_PATH/$1" || exit 6\n',
    });
    const id = await createWorkspaceWithAgent(page, repo, { agent: 'Claude Code', prompt }, 'Claude Code 1');
    return { path: worktreePath(session, repo, name), id };
  }

  const loginPrompt = /^login-shell>(\s.*)?$/;

  describe('setup through the CLI', () => {
    beforeAll(() => writeFileSync(join(fx.root, 'interactive'), ''));
    afterAll(() => rmSync(join(fx.root, 'interactive'), { force: true }));

    test('AC1, AC2 — Create opens the session page whose single terminal shows the header, each "$ <command>" line with its output, then "✓ Setup done" and the agent in the worktree with its hooks and the prompt as one argument; the workspace row says "Setting up" (muted, right-aligned) meanwhile and nothing once done, with no line added under it', async () => {
      const { page } = session;
      await removeAllWorkspaces();
      const record = 'sh "$COCKPIT_ROOT_PATH/record.sh" setup-env.txt';
      const wait = 'sh "$COCKPIT_ROOT_PATH/waitfor.sh" go-s1';
      const mark = 'sh "$COCKPIT_ROOT_PATH/mark.sh" setup-done';
      const prompt = `say "hi" $HOME 100% 'q'`;
      writeScripts(repo);
      writeConfig(repo, { setup: [record, wait, mark] });
      const waiter = holdWaiter(repo, 'go-s1');
      const before = { pids: stubPids(fx), runs: startRuns(fx) };

      const { path, id } = await createWorkspaceWithSetup('say-hi-home-100-q', prompt);

      await waitForRow(page, `$ ${wait}`);
      const header = 'cockpit setup · say-hi-home-100-q · .cockpit/config.json';
      const rows = await terminalRows(page);
      expect(rows.indexOf(header)).toBeGreaterThanOrEqual(0);
      expect(rows.indexOf(header)).toBeLessThan(rows.indexOf(`$ ${record}`));
      expect(rows.indexOf(`$ ${record}`)).toBeLessThan(rows.indexOf(`$ ${wait}`));
      expect(await visiblePanes(page)).toHaveLength(1);
      // AC2: the label while it runs, and nothing else under the row.
      const label = await waitForSetupLabel(page, path, 'Setting up');
      expect(label!.color, 'muted').toBe(await mutedColor(page));
      expect(label!.isRightOfTheName).toBe(true);
      expect(label!.rightGap, 'right-aligned in the row').toBeLessThan(80);
      expect(await setupLinkCount(page)).toBe(0);
      expect(await workspaceTabs(page)).toEqual(['Claude Code 1']);
      // The environment the first command saw, and no agent yet.
      // (The command that wrote the record ran before the one the terminal now shows.)
      const [env] = readRecords(repo, 'setup-env.txt');
      expect(env).toMatchObject({ root: repo.root, ws: path, name: 'say-hi-home-100-q', pwd: path });
      await waiter.pid();
      expect(stubPids(fx)).toEqual(before.pids);
      expect(startRuns(fx)).toEqual(before.runs);

      await waiter.release();
      await waitForRow(page, '✓ Setup done');
      const stub = await readStub(page);
      expect(stub.cwd).toBe(path);
      expect(stub.argCount).toBe(1);
      expect(stub.args).toBe(prompt);
      expect(startRuns(fx).slice(before.runs.length)).toEqual(['setup-done', `claude ${prompt}`]);
      expectSetupSpawnedWithDetectedPath(fx, REPOSITORY_CLI, stub.pid);
      expect(isAlive(foreign.pid), 'the foreign `cockpit setup` is still running').toBe(true);
      const done = await terminalRows(page);
      expect(done.indexOf('✓ Setup done')).toBeLessThan(done.indexOf('ready'));
      // The agent runs with its status hooks, which name the CLI.
      expect(hookCommandsOf(fx, 'claude', stub.pid).UserPromptSubmit).toBe(`${singleQuoted(REPOSITORY_CLI)} status working`);
      expect(await waitForSetupLabel(page, path, null)).toBeNull();
      expect(await setupLinkCount(page)).toBe(0);
      expect(storedIn(path)).toEqual([{ id, name: 'Claude Code 1', harness: 'claude-code', directory: path, project: repo.root, createdAt: expect.any(String), open: true }]);
    }, 60_000);

    test('AC3, AC4, AC6, AC10 — a failing command stops the setup (the later ones do not run) with the failure line, the hint and the login shell prompt, no agent, and "Setup failed" (destructive) on the row, which a reload keeps; after fixing the config, "cockpit setup" typed in that shell runs it again ("Setting up", then no label) and returns to the same shell; "--then claude" starts the agent', async () => {
      const { page } = session;
      await removeAllWorkspaces();
      const count = 'echo run >> "$COCKPIT_ROOT_PATH/runs-s2"';
      const check = 'sh "$COCKPIT_ROOT_PATH/check.sh" ok-s2';
      writeScripts(repo);
      writeConfig(repo, { setup: [count, check, 'echo after-failure'] });
      const before = { pids: stubPids(fx), runs: startRuns(fx) };

      const { path, id } = await createWorkspaceWithSetup('setup-fails');

      await waitForRow(page, `✗ Setup failed: ${check} exited with code 6`);
      await waitForRow(page, 'Claude Code was not started. Run `cockpit setup --then claude` to try again.');
      await waitForRow(page, loginPrompt);
      expect(await terminalRows(page)).not.toContain('after-failure');
      const failed = await waitForSetupLabel(page, path, 'Setup failed');
      expect(failed!.color, 'destructive').toBe(await destructiveColor(page));
      expect(stubPids(fx)).toEqual(before.pids);
      expect(startRuns(fx)).toEqual(before.runs);
      expect(linkedWorktrees(repo)).toContainEqual({ path, branch: 'setup-fails' });
      expect(await setupLinkCount(page)).toBe(0);

      // AC6: a reload shows the same label, and the terminal as it was.
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitForSetupLabel(page, path, 'Setup failed');
      await waitForRow(page, `✗ Setup failed: ${check} exited with code 6`);
      await waitForRow(page, loginPrompt);

      // AC4: the config is fixed; the command typed in the shell the failure left runs it again.
      const wait = 'sh "$COCKPIT_ROOT_PATH/waitfor.sh" go-s2';
      writeConfig(repo, { setup: [count, check, wait] });
      const waiter = holdWaiter(repo, 'go-s2');
      writeFileSync(join(repo.root, 'ok-s2'), '');
      await focusTerminal(page);
      await typeLine(page, 'echo level:$SHLVL');
      await waitForRow(page, /^level:\d+$/);
      const level = (await terminalRows(page)).find((row) => /^level:\d+$/.test(row));
      await typeLine(page, 'cockpit setup');
      await waitForSetupLabel(page, path, 'Setting up');
      await waiter.pid();
      await waiter.release();
      // The script runs again with `--then` below: that run passes at once, as it did with a marker file left in place.
      writeFileSync(join(repo.root, 'go-s2.sh'), '');
      await waitForRow(page, '✓ Setup done');
      await waitForSetupLabel(page, path, null);
      await typeLine(page, 'echo level:$SHLVL');
      await untilIn(
        await focusedPane(page),
        (element) =>
          [...element.querySelectorAll('.xterm-rows > div')].filter((row) => /^level:\d+$/.test((row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd())).length === 2,
        truthy,
      );
      expect((await terminalRows(page)).filter((row) => /^level:\d+$/.test(row)), 'no nested shell').toEqual([level, level]);
      expect(readFileSync(join(repo.root, 'runs-s2'), 'utf8').split('\n').filter(Boolean)).toEqual(['run', 'run']);
      expect(stubPids(fx)).toEqual(before.pids);

      // "--then <binary>" starts the agent after the setup, in the same shell's terminal.
      await typeLine(page, 'cockpit setup --then claude');
      await waitForRow(page, 'ready');
      expect((await readStub(page)).cwd).toBe(path);
      expect(storedIn(path).map((entry) => entry.id)).toEqual([id]);
      await typeLine(page, 'quit');
      await waitForRow(page, /^\[Claude Code exited with code 0\]$/);
    }, 90_000);

    test('AC5, AC6, AC7 — with no setup commands the agent starts at once with no setup output or label; when it exits with code 3 the dot turns "Exited 3" at that moment and the terminal shows "[Claude Code exited with code 3]" and the login shell prompt; a reload keeps the dot, and typing exit in that shell leaves it', async () => {
      const { page } = session;
      await removeAllWorkspaces();
      rmSync(join(repo.root, '.cockpit'), { recursive: true, force: true });

      const { path, id } = await createWorkspaceWithSetup('agent-exit');

      const stub = await readStub(page);
      expect(stub.cwd).toBe(path);
      expect(stub.args).toBe('agent-exit');
      expect((await terminalRows(page)).some((row) => row.startsWith('cockpit setup'))).toBe(false);
      expect(await setupLabel(page, path)).toBeNull();
      await expectDot(page, id, null);

      await focusTerminal(page);
      await typeLine(page, 'exit');
      await waitForRow(page, '[Claude Code exited with code 3]');
      await waitForRow(page, loginPrompt);
      await expectDot(page, id, 'Exited 3');

      // AC6: a reload shows the same dot.
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await expectDot(page, id, 'Exited 3', null);
      await waitForRow(page, '[Claude Code exited with code 3]');

      // The shell the agent left exits: the dot stays.
      await focusTerminal(page);
      await typeLine(page, 'exit');
      await waitForRow(page, /^\[Process exited with code \d+\]$/);
      await expectDot(page, id, 'Exited 3');
      expect(await setupLabel(page, path)).toBeNull();
    }, 60_000);

    test('AC10 — "cockpit setup" typed in a shell tab of a workspace page is found and runs as in AC1; the shell is no session, so nothing is reported and no label changes', async () => {
      const { page } = session;
      await removeAllWorkspaces();
      const path = await createPlainWorkspace(session, repo, 'term-setup');
      writeConfig(repo, { setup: ['echo from-terminal'] });

      await openShellTab(page, path);
      await waitForRow(page, loginPrompt);
      await typeLine(page, 'cockpit setup');

      await waitForRow(page, '✓ Setup done');
      const rows = (await terminalRows(page)).filter(Boolean);
      const header = rows.indexOf('cockpit setup · term-setup · .cockpit/config.json');
      expect(header).toBeGreaterThanOrEqual(0);
      expect(rows.slice(header + 1, header + 3)).toEqual(['$ echo from-terminal', 'from-terminal']);
      expect(await setupLabel(page, path)).toBeNull();
      // The app was launched with a sentinel COCKPIT_SESSION_ID that a terminal does not inherit: a report
      // for it would have been refused by the daemon, and nothing was logged.
      await expectNoErrors(session);
    }, 60_000);

    // AC14: what a deleted workspace or a removed project leaves behind. The process tree is read
    // while it is alive (the pids come from the stub's own output and from the shell's `$$`, never from
    // a pattern that also matches the CLI's command line), and every pid of it must be gone 5 s after.
    const processTable = () =>
      execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter((pair) => pair.length === 2 && pair.every(Number.isInteger)) as Array<[pid: number, ppid: number]>;
    const parentOf = (pid: number) => processTable().find(([found]) => found === pid)?.[1];
    const commandOf = (pid: number) => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const descendantsOf = (root: number) => {
      const table = processTable();
      const found: number[] = [];
      for (const queue = [root]; queue.length > 0; ) {
        const parent = queue.shift()!;
        for (const [pid, ppid] of table) {
          if (ppid === parent && !found.includes(pid)) {
            found.push(pid);
            queue.push(pid);
          }
        }
      }
      return found;
    };
    // The `cockpit setup …` process that is the parent of `pid`, and the pids of its whole tree.
    const cliTreeAbove = (pid: number) => {
      const cli = parentOf(pid)!;
      expect(commandOf(cli).startsWith(`${REPOSITORY_CLI} setup `), `the parent of ${pid} is the CLI: ${commandOf(cli)}`).toBe(true);
      return { cli, tree: [cli, ...descendantsOf(cli)] };
    };
    // The pids still running (a process that ended and is not yet reaped is not).
    const stateOf = (pid: number) => {
      try {
        return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    };
    const stillRunning = (pids: number[]) => pids.filter((pid) => isAlive(pid) && stateOf(pid) !== '' && !stateOf(pid).startsWith('Z')).map((pid) => `${pid} ${commandOf(pid)}`);

    test('AC14 — deleting the workspace of a session whose agent runs (and ignores SIGHUP) leaves no process: the CLI and the agent are gone within 5 s', async () => {
      const { page } = session;
      await removeAllWorkspaces();
      writeConfig(repo, { setup: ['echo before-agent'] });
      // The agent ignores SIGHUP, holds a pipe (known when everything it started is gone) and, once its loop ends,
      // blocks until a line that never comes.
      const pipe = gonePipe();
      const held = heldProcess();
      writeFileSync(join(fx.bin, 'claude.early'), `trap '' HUP\n${pipe.snippet}\n`);
      writeFileSync(join(fx.bin, 'claude.late'), `${held.snippet}\n`);
      let tree: number[] = [];
      try {
        const { path, id } = await createWorkspaceWithSetup('kill-agent');
        const stub = await readStub(page);
        await ensurePtyLog(page);
        const terminal = await terminalOfSession(page, id);
        const above = cliTreeAbove(stub.pid);
        const cli = above.cli;
        tree = above.tree;
        expect(tree, 'the agent is under the CLI').toContain(stub.pid);
        expect(isAlive(stub.pid)).toBe(true);

        await startDeletion(page, path);
        const dialog = deleteDialog(page, 'Delete kill-agent?');
        await dialog.waitFor();
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await waitForEntries(page, [repo.root]);

        // The CLI's exit is the terminal's; the agent and what it started are gone when the pipe has no holder left,
        // within 5 s of the workspace leaving the sidebar.
        const within = startClock();
        await Promise.all([waitForExit(page, terminal), pipe.gone]);
        within('the CLI and the agent were gone', 5_000);
        expect(stillRunning(tree).join(' | '), `the CLI ${cli} and everything under it`).toBe('');
      } finally {
        rmSync(join(fx.bin, 'claude.early'), { force: true });
        rmSync(join(fx.bin, 'claude.late'), { force: true });
        // A stub that ignores SIGHUP and outlived the test would run forever.
        for (const pid of tree) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    }, 60_000);

    test('AC14 — removing the project of a session whose setup failed leaves no process: the CLI and the login shell it left (which ignores SIGHUP) are gone within 5 s', async () => {
      const { page } = session;
      await removeAllWorkspaces();
      writeConfig(repo, { setup: ['exit 7'] });
      // The login shell ignores SIGHUP and holds a pipe, known to be free when everything it started is gone.
      const pipe = gonePipe();
      writeFileSync(join(fx.root, 'early'), `trap '' HUP\n${pipe.snippet}\n`);
      let tree: number[] = [];
      try {
        const { path, id } = await createWorkspaceWithSetup('kill-shell');
        await waitForRow(page, '✗ Setup failed: exit 7 exited with code 7');
        await waitForRow(page, loginPrompt);
        await focusTerminal(page);
        await typeLine(page, 'echo shell-pid:$$');
        await waitForRow(page, /^shell-pid:\d+$/);
        const shellPid = Number((await terminalRows(page)).find((row) => /^shell-pid:\d+$/.test(row))!.slice('shell-pid:'.length));
        await ensurePtyLog(page);
        const terminal = await terminalOfSession(page, id);
        const above = cliTreeAbove(shellPid);
        const cli = above.cli;
        tree = above.tree;
        expect(tree, 'the login shell is under the CLI').toContain(shellPid);
        expect(stubPids(fx).filter((pid) => tree.includes(pid)), 'the agent never started').toEqual([]);

        try {
          await removeThroughMenu(page, repo.root);
          await waitForEntries(page, []);

          const within = startClock();
          await Promise.all([waitForExit(page, terminal), pipe.gone]);
          within('the CLI and the login shell were gone', 5_000);
          expect(stillRunning(tree).join(' | '), `the CLI ${cli} and the login shell ${shellPid}`).toBe('');
        } finally {
          await addRepository(session, repo);
        }
        expect(linkedWorktrees(repo).map((worktree) => worktree.path)).toContain(path);
      } finally {
        rmSync(join(fx.root, 'early'), { force: true });
        for (const pid of tree) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    }, 60_000);
  });

  // The sidebar list scrolls once it holds this many rows, and its scrollbar then covers the "…" trigger
  // of the project row (Playwright's click on it hits the list). The tests below open that menu, so they
  // start from a project without workspaces: removed through the API (the sessions stay in state.json,
  // hidden), then the list is read again.
  async function removeAllWorkspaces() {
    const { page } = session;
    await page.evaluate(async (project) => {
      const { api } = globalThis as unknown as {
        api: {
          projects: { list(): Promise<{ path: string; workspaces: { path: string }[] }[]> };
          workspaces: { remove(project: string, path: string, options: { force: boolean }): Promise<unknown> };
        };
      };
      const found = (await api.projects.list()).find((entry) => entry.path === project);
      for (const workspace of found?.workspaces ?? []) await api.workspaces.remove(project, workspace.path, { force: true });
    }, repo.root);
    await dispatchFocus(page);
    await waitForEntries(page, [repo.root]);
  }

  test('logs no error and keeps running', async () => {
    expect(await sidebarLines(session.page)).toContain('Sessions');
    await expectNoErrors(session);
    // The endpoint started: the "off" line belongs to the launch that provokes it.
    expect(session.output()).not.toContain("Cockpit's background service could not start");
  });
});
