import { accessSync, constants, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { statusLaunch } from '@cockpit/harnesses';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createButton, openComposer, promptBox, useAgent, waitForMessage } from './composer';
import { MAIN_PROCESS_ERROR, type Session, versionLabel } from './launch';
import { addRepository, makeRepo, sidebarLines, stateSnapshot, type TempRepo } from './support/projects';
import { clearNotifications, closeOverlays, createPlainWorkspace, expectDot, hookCommandsOf, launchBuiltWith, launchFiles, makeSessionsFixture, notifications, openSessionEntry, readLaunch, readStub, reportStatus, REPOSITORY_CLI, sessionEntries, sessionFoldersIn, sessionIdOf, type SessionsFixture, setWindowFocused, singleQuoted, STARTED_PROMPT, startInWorkspace, startRuns, startSession, stubNotifications } from './support/sessions';
import { focusTerminal, goHome, killPtyHost, typeLine, waitForRow } from './support/terminal';

describe('session status: built app', () => {
  let fx: SessionsFixture;
  let session: Session;
  let repo: TempRepo;
  const known = {
    claude: { id: '', pid: 0 },
    codex: { id: '', pid: 0 },
    opencode: { id: '', pid: 0 },
    second: { id: '', pid: 0 },
    workspace: { id: '', path: '' },
    notified: { id: '', name: '' },
  };

  beforeAll(async () => {
    fx = makeSessionsFixture(['claude', 'codex', 'opencode'], { log: true });
    repo = makeRepo('status-ws');
    // The user's own OpenCode config is none: the tests of the merge are the package's.
    const env = fx.env();
    delete env.OPENCODE_CONFIG_CONTENT;
    session = await launchBuiltWith(env);
    await session.page.getByText(versionLabel).waitFor();
    await stubNotifications(session);
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  afterEach(() => closeOverlays(session.page));

  test('AC2, AC3, AC4, AC9, single instance AC8, cli-status AC7 — Claude Code, Codex and OpenCode are started with the arguments statusLaunch gives, OpenCode with its config variable and the plugin written under COCKPIT_HOME; none shows a dot before it reports', async () => {
    const { page } = session;
    // Every session is started before anything is checked: the tests after this one need them.
    for (const [menuName, id] of [
      ['Claude Code', 'claude'],
      ['Codex', 'codex'],
      ['OpenCode', 'opencode'],
    ] as const) {
      known[id].id = await startSession(page, menuName, `${menuName} 1`);
      known[id].pid = (await readStub(page)).pid;
    }

    // The plugin of the expected launch goes to a folder of the test's own.
    const expectedPlugins = join(fx.root, 'expected-plugins');
    const expected = (id: 'claude-code' | 'codex' | 'opencode') => statusLaunch(id, { cli: REPOSITORY_CLI, pluginsDir: expectedPlugins, env: {} });

    const claude = readLaunch(fx, 'claude', known.claude.pid);
    // The status arguments first, then the prompt the composer was given.
    expect(claude.args.length).toBe(3);
    expect(claude.args).toEqual([...(await expected('claude-code')).args, STARTED_PROMPT]);
    expect(claude.openCodeConfig).toBe('unset');
    // COCKPIT-56 AC7: the hooks name the compiled CLI of the repository, which exists, and no curl.
    accessSync(REPOSITORY_CLI, constants.X_OK);
    const hooks = hookCommandsOf(fx, 'claude', known.claude.pid);
    expect(Object.keys(hooks).length).toBeGreaterThan(0);
    for (const command of Object.values(hooks)) expect(command.startsWith(`${singleQuoted(REPOSITORY_CLI)} status `), command).toBe(true);

    const codex = readLaunch(fx, 'codex', known.codex.pid);
    expect(codex.args.slice(0, 2)).toEqual(['--no-daemon', '-c']);
    expect(codex.args).toEqual([...(await expected('codex')).args, STARTED_PROMPT]);

    const opencode = readLaunch(fx, 'opencode', known.opencode.pid);
    const folder = join(session.cockpitHome, 'plugins', 'opencode-status');
    expect(opencode.args).toEqual(['--standalone', '--prompt', STARTED_PROMPT]);
    expect(JSON.parse(opencode.openCodeConfig)).toEqual({ plugins: [folder] });
    // The plugin the app wrote is the one statusLaunch writes for the same commands.
    const written = readFileSync(join(folder, 'server.js'), 'utf8');
    await expected('opencode');
    expect(written).toBe(readFileSync(join(expectedPlugins, 'opencode-status', 'server.js'), 'utf8'));
    // AC7: it names the compiled CLI too, and nothing the apps start holds curl.
    expect(written).toContain(REPOSITORY_CLI);
    expect(JSON.stringify([claude.args, codex.args, opencode.args, written])).not.toContain('curl');

    // AC9: running, nothing reported yet.
    expect((await sessionEntries(page)).map((entry) => [entry.name, entry.status])).toEqual([
      ['OpenCode 1', null],
      ['Codex 1', null],
      ['Claude Code 1', null],
    ]);
    // The daemon is up: nothing says status is off.
    expect((await sidebarLines(page)).filter((line) => line.startsWith('Session status is off'))).toEqual([]);
  });

  test('AC7 — Claude Code hooks turn the row to "Working", "Needs input", "Working", "Ready" within 2 s of each report, another row is unchanged, and exiting with code 3 shows "Exited 3"', async () => {
    const { page } = session;
    // A second Claude Code session, which stays silent while the first one reports.
    known.second.id = await startSession(page, 'Claude Code', 'Claude Code 2');
    await readStub(page);
    await openSessionEntry(page, 'Claude Code 1');
    await focusTerminal(page);
    const silent = [known.second.id, known.codex.id, known.opencode.id];

    for (const [hook, dot] of [
      ['UserPromptSubmit', 'Working'],
      ['PermissionRequest', 'Needs input'],
      ['PostToolUse', 'Working'],
      ['Stop', 'Ready'],
    ] as const) {
      await typeLine(page, `hook ${hook}`);
      await waitForRow(page, `hooked:${hook}`);
      await expectDot(page, known.claude.id, dot);
      for (const id of silent) await expectDot(page, id, null, 'now');
    }

    await typeLine(page, 'exit');
    await waitForRow(page, '[Process exited with code 3]');
    await expectDot(page, known.claude.id, 'Exited 3');
    for (const id of silent) await expectDot(page, id, null, 'now');
  });

  test('AC7 — the same under a workspace: the icon shows on the workspace row', async () => {
    const { page } = session;
    await addRepository(session, repo);
    const path = await createPlainWorkspace(session, repo, 'status-ws');
    known.workspace.path = path;
    known.workspace.id = await startInWorkspace(page, path, 'status-ws', 'Claude Code', 'Claude Code 1');
    await readStub(page);
    await focusTerminal(page);

    await typeLine(page, 'hook UserPromptSubmit');
    await waitForRow(page, 'hooked:UserPromptSubmit');

    await expectDot(page, known.workspace.id, 'Working');
    // The sessions of the Sessions section are not touched.
    expect((await sessionEntries(page)).find((entry) => entry.id === known.second.id)?.status).toBe(null);
  });

  test('AC8 — an agent that exits with code 0 shows the "Ended" dot, whatever it reported before', async () => {
    const { page } = session;
    await openSessionEntry(page, 'Claude Code 2');
    await focusTerminal(page);
    await typeLine(page, 'hook Stop');
    await waitForRow(page, 'hooked:Stop');
    await expectDot(page, known.second.id, 'Ready');

    await typeLine(page, 'quit');
    await waitForRow(page, '[Process exited with code 0]');

    await expectDot(page, known.second.id, 'Ended');
  });

  test('AC11 — with no Cockpit window focused, a change to "Needs input" or "Ready" shows one notification titled with the session name; a repeat, a change to "Working" and any report while a window is focused show none', async () => {
    const { page } = session;
    known.notified.id = await startSession(page, 'Claude Code', 'Claude Code 3');
    known.notified.name = 'Claude Code 3';
    await readStub(page);
    await clearNotifications(session);
    const { id, name } = known.notified;

    await reportStatus(session, id, 'working');
    await expectDot(page, id, 'Working');
    expect(await notifications(session)).toEqual([]);

    await reportStatus(session, id, 'waiting');
    await expectDot(page, id, 'Needs input');
    expect(await notifications(session)).toEqual([{ title: name, body: 'Needs input' }]);

    await reportStatus(session, id, 'waiting');
    await expectDot(page, id, 'Needs input');
    expect(await notifications(session)).toHaveLength(1);

    await reportStatus(session, id, 'finished');
    await expectDot(page, id, 'Ready');
    expect(await notifications(session)).toEqual([
      { title: name, body: 'Needs input' },
      { title: name, body: 'Ready' },
    ]);

    await reportStatus(session, id, 'working');
    await expectDot(page, id, 'Working');
    expect(await notifications(session)).toHaveLength(2);

    await setWindowFocused(session, true);
    await reportStatus(session, id, 'waiting');
    await expectDot(page, id, 'Needs input');
    expect(await notifications(session)).toHaveLength(2);
    await setWindowFocused(session, false);

    await reportStatus(session, id, 'finished');
    await expectDot(page, id, 'Ready');
    expect(await notifications(session)).toHaveLength(3);
    expect((await notifications(session)).at(-1)).toEqual({ title: name, body: 'Ready' });
  });

  test("AC12 — clicking the notification shows and focuses the session's window and opens the session's page", async () => {
    const { page } = session;
    expect((await notifications(session)).length, 'the notification of the previous test').toBeGreaterThan(0);
    await goHome(page);
    expect(sessionIdOf(page)).toBeUndefined();
    // The window must not really be shown nor focused: the test records the calls.
    await session.evaluateInMain(`(() => {
      const { BrowserWindow } = require('electron');
      const window = BrowserWindow.getAllWindows()[0];
      globalThis.__windowCalls = [];
      window.show = () => globalThis.__windowCalls.push('show');
      window.focus = () => globalThis.__windowCalls.push('focus');
      globalThis.__notified.at(-1).notification.emit('click');
    })()`);

    await page.getByRole('heading', { name: known.notified.name, exact: true }).waitFor();
    expect(sessionIdOf(page)).toBe(known.notified.id);
    const calls = await session.evaluateInMain<string[]>('globalThis.__windowCalls');
    expect(calls).toContain('show');
    expect(calls).toContain('focus');
  });

  test('COCKPIT-50 AC1, AC2 — an interrupted Claude Code turn (busy title, then idle title, no hook) turns the row from "Working" to "Ready" and raises no notification with no window focused', async () => {
    const { page } = session;
    const id = await startSession(page, 'Claude Code', 'Claude Code 4');
    await readStub(page);
    await focusTerminal(page);
    await setWindowFocused(session, false);
    await clearNotifications(session);

    await typeLine(page, 'hook UserPromptSubmit');
    await waitForRow(page, 'hooked:UserPromptSubmit');
    await expectDot(page, id, 'Working');
    await typeLine(page, 'title ◐ Greeting');
    await waitForRow(page, 'titled:◐ Greeting');
    await expectDot(page, id, 'Working', 'now');

    await typeLine(page, 'title ✳ Greeting');
    await waitForRow(page, 'titled:✳ Greeting');

    await expectDot(page, id, 'Ready');
    expect(await notifications(session)).toEqual([]);
  });

  test('AC13 — a harness whose binary was removed after detection is refused under the Sessions header: "Could not start Claude Code: <path> not found.", no folder, nothing spawned, state.json unchanged', async () => {
    const { page } = session;
    const binary = join(fx.bin, 'claude');
    // A full page load resets the live store (the dots), so the entries are read after one, as the
    // refused start's own page load will leave them.
    await openComposer(page, 'none');
    // The menu detected the stubs at the first start and keeps the answer.
    const before = {
      state: stateSnapshot(session.dataDir),
      folders: sessionFoldersIn(session.cockpitHome),
      runs: startRuns(fx),
      launches: launchFiles(fx),
      entries: await sessionEntries(page),
    };

    renameSync(binary, `${binary}.gone`);
    try {
      await openComposer(page, 'none');
      await useAgent(page, 'Claude Code');
      await promptBox(page).fill(STARTED_PROMPT);
      await createButton(page).click();

      const message = `Could not start Claude Code: ${binary} not found.`;
      expect(await waitForMessage(page)).toBe(message);
      expect(new URL(page.url()).pathname).toBe('/');
      expect(sessionFoldersIn(session.cockpitHome)).toEqual(before.folders);
      expect(startRuns(fx)).toEqual(before.runs);
      expect(launchFiles(fx)).toEqual(before.launches);
      expect(stateSnapshot(session.dataDir)).toEqual(before.state);
      expect(await sessionEntries(page)).toEqual(before.entries);
    } finally {
      renameSync(`${binary}.gone`, binary);
    }
  });

  test('AC8 — when the pty host dies, every running session shows the "Ended" dot, the ones that had reported included', async () => {
    const { page } = session;
    await reportStatus(session, known.codex.id, 'working');
    await expectDot(page, known.codex.id, 'Working');

    await killPtyHost(page);

    for (const id of [known.codex.id, known.opencode.id, known.workspace.id, known.notified.id]) await expectDot(page, id, 'Ended', null);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});
