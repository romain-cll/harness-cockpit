import { realpathSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { statusLaunch } from '@cockpit/harnesses';
import { type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { daemonSocketIn, killDaemonsIn, MAIN_PROCESS_ERROR, quitApp, type Session, untilRead, versionLabel } from './launch';
import { endedIconOf, expectTabCount, killDaemon, makeDataDir, newShellTab, tabNamed, tabNames, uniqueBuild } from './support/daemon';
import { projectsMessage, waitForRowStatus } from './support/panes';
import { addRepository, countIpcCalls, ipcAnswered, ipcCalls, makeRepo, type TempRepo } from './support/projects';
import {
  controlTokenIn,
  createPlainWorkspace,
  expectDot,
  harnessIdOf,
  ipcReceived,
  launchBuiltWith,
  launchFiles,
  makeSessionsFixture,
  newTerminalButton,
  ODD_HARNESS_ID,
  postSessionEvent,
  readLaunch,
  readStub,
  REPOSITORY_CLI,
  resumeButton,
  type SessionsFixture,
  sessionsInState,
  startInWorkspace,
  untilState,
} from './support/sessions';
import { focusTerminal, typeLine, waitForRow } from './support/terminal';

// COCKPIT-30: an ended tab of a session whose harness gave its conversation id offers "Resume last session". The built
// app runs the feature's full block (the dev server, the packaged app and the launchd environment run one smoke path
// each, `expectResumeSmoke` in `support/sessions.ts`). The stub `claude` of `makeSessionsFixture` has a `session-hook
// <id>` line: it pipes `{"session_id":"<id>"}` to the second hook of UserPromptSubmit its `--settings` hold, as Claude
// Code does, so the real CLI, daemon and main process carry the id; the daemon is lost with SIGKILL and the page
// reloads, as COCKPIT-69 shows an ended tab.
//
// Two sessions share one workspace page: "Claude Code 1" never reports an id (a harness that gave none, or a session
// stored before this ticket), "Claude Code 2" does.

const WS = 'resume-ws';
const NO_ID = 'Claude Code 1';
const WITH_ID = 'Claude Code 2';
const FIRST_ID = 'first-conversation';
const AFTER_RESUME_ID = 'conversation-after-resume';
const UNSEEN_ID = 'conversation-reported-while-closed';

const endedView = (page: Page) => page.getByText('This terminal ended', { exact: true });
// The page is on a workspace page whose terminals the daemon lost: wait for its two ended tabs after a reload.
const reloadToEndedTabs = async (page: Page, names: string[]) => {
  await page.reload();
  await expectTabCount(page, names.length);
  for (const name of names) await endedIconOf(tabNamed(page, name)).waitFor();
};

describe('resume sessions: built app', () => {
  let fx: SessionsFixture;
  let repo: TempRepo;
  let dataDir: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let session: Session;
  let workspace: string;
  const ids = { noId: '', withId: '' };
  // What the stub was started with, before the daemon is lost.
  let launchesBeforeLoss: string[] = [];

  const expectedStatusArgs = async () => (await statusLaunch('claude-code', { cli: REPOSITORY_CLI, pluginsDir: join(fx.root, 'expected-plugins'), env: {} })).args;
  const storedIdOf = (sessionId: string) => harnessIdOf({ sessions: sessionsInState(dataDir) }, sessionId);

  beforeAll(async () => {
    // The `--version` of the stub waits for the test (AC14's held start): the first detection is let through here,
    // the one AC14 holds is its own.
    fx = makeSessionsFixture(['claude'], { slowVersion: true });
    fx.releaseVersions();
    repo = makeRepo('resume-repo');
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    env = { ...fx.env(), COCKPIT_TEST_DAEMON_BUILD: uniqueBuild() };
    delete env.OPENCODE_CONFIG_CONTENT;
    session = await launchBuiltWith(env, dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
    await addRepository(session, repo);
    workspace = await createPlainWorkspace(session, repo, WS);
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    fx?.endVersionHolds();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  test('AC1, AC4, AC5 — the UserPromptSubmit hook of a session stores the id it holds in state.json; a later report replaces it, an id that looks like no harness\'s included, byte for byte; a session that reported none has none', async () => {
    const { page } = session;
    ids.noId = await startInWorkspace(page, workspace, WS, 'Claude Code', NO_ID);
    await readStub(page);
    ids.withId = await startInWorkspace(page, workspace, WS, 'Claude Code', WITH_ID);
    await readStub(page);
    await focusTerminal(page);
    expect(sessionsInState(dataDir).map((stored) => stored.harnessSessionId)).toEqual([undefined, undefined]);

    await untilState(dataDir, (state) => harnessIdOf(state, ids.withId) === FIRST_ID, () => typeLine(page, `session-hook ${FIRST_ID}`));
    await waitForRow(page, `session-hooked:${FIRST_ID}`);
    // AC4: with no report since, the id stays.
    expect(storedIdOf(ids.withId)).toBe(FIRST_ID);

    await untilState(dataDir, (state) => harnessIdOf(state, ids.withId) === ODD_HARNESS_ID, () => typeLine(page, `session-hook ${ODD_HARNESS_ID}`));
    await waitForRow(page, `session-hooked:${ODD_HARNESS_ID}`);

    expect(storedIdOf(ids.withId)).toBe(ODD_HARNESS_ID);
    expect(storedIdOf(ids.noId)).toBeUndefined();
    expect(sessionsInState(dataDir).find((stored) => stored.id === ids.noId)).not.toHaveProperty('harnessSessionId');
  });

  test('AC9, AC10 — after the daemon is lost and the page reloads, the tab with a stored id offers "Resume last session" (filled) left of "New terminal here" (outlined) with `claude --resume <id>` in the mono caption under them; the tab with none offers "New terminal here" only, and nothing runs', async () => {
    const { page } = session;
    launchesBeforeLoss = launchFiles(fx);
    expect(launchesBeforeLoss).toHaveLength(2);

    await killDaemon(home);
    await reloadToEndedTabs(page, [NO_ID, WITH_ID]);

    // AC10: no stored id.
    await tabNamed(page, NO_ID).click();
    await endedView(page).waitFor();
    await newTerminalButton(page).waitFor();
    expect(await resumeButton(page).count()).toBe(0);
    expect(await page.getByText(/--resume|--continue/).count()).toBe(0);

    // AC9: a stored id.
    await tabNamed(page, WITH_ID).click();
    await endedView(page).waitFor();
    await resumeButton(page).waitFor();
    await newTerminalButton(page).waitFor();
    const caption = page.getByText(`claude --resume ${ODD_HARNESS_ID}`, { exact: true });
    await caption.waitFor();
    const look = await page.evaluate(() => {
      const named = (text: string) => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === text)!;
      const resume = named('Resume last session');
      const fresh = named('New terminal here');
      const caption = [...document.querySelectorAll('*')].find((element) => element.children.length === 0 && (element.textContent ?? '').startsWith('claude --resume'))!;
      const box = (element: Element) => element.getBoundingClientRect();
      const style = (element: Element) => getComputedStyle(element);
      return {
        resumeLeftOfNew: box(resume).right <= box(fresh).left,
        sameRow: Math.abs(box(resume).top - box(fresh).top) < 2,
        resumeFill: style(resume).backgroundColor,
        newFill: style(fresh).backgroundColor,
        newBorder: style(fresh).borderTopWidth,
        captionBelow: box(caption).top >= Math.max(box(resume).bottom, box(fresh).bottom) - 1,
        captionFamily: style(caption).fontFamily,
        captionSize: style(caption).fontSize,
      };
    });
    expect(look.resumeLeftOfNew, 'Resume last session is to the left of New terminal here').toBe(true);
    expect(look.sameRow).toBe(true);
    expect(look.resumeFill, 'primary: filled').not.toBe('rgba(0, 0, 0, 0)');
    expect(look.resumeFill, 'primary, not the outlined fill').not.toBe(look.newFill);
    expect(look.newBorder, 'outlined').not.toBe('0px');
    expect(look.captionBelow, 'the caption sits under the buttons').toBe(true);
    expect(look.captionFamily).toMatch(/monospace/i);
    expect(look.captionSize).toBe('12px');
    expect(launchFiles(fx), 'nothing was started').toEqual(launchesBeforeLoss);
  });

  test('AC11, AC14, AC4, AC5 — a double click on "Resume last session" starts exactly one agent, `statusLaunch`\'s arguments then `--resume <id>` with the newest id byte for byte, in the worktree, in the same tab: same name, pane and position, selected, holding the keyboard, no "Ended" icon; state.json gains no session and the session stays open', async () => {
    const { page } = session;
    const storedBefore = sessionsInState(dataDir);
    await countIpcCalls(session, ['sessions:resume']);

    await resumeButton(page).dblclick();

    const facts = await readStub(page);
    // Every `sessions:resume` the double click sent has answered: a second start would have a launch file by now.
    await ipcAnswered(session, 'sessions:resume', await ipcCalls(session, 'sessions:resume'));
    expect(launchFiles(fx)).toHaveLength(launchesBeforeLoss.length + 1);
    expect(readLaunch(fx, 'claude', facts.pid).args).toEqual([...(await expectedStatusArgs()), '--resume', ODD_HARNESS_ID]);
    expect(facts.cwd).toBe(realpathSync(workspace));

    expect(await tabNames(page)).toEqual([NO_ID, WITH_ID]);
    expect(await page.getByRole('tablist').count(), 'the same pane').toBe(1);
    expect(await tabNamed(page, WITH_ID).getAttribute('aria-selected')).toBe('true');
    expect(await endedIconOf(tabNamed(page, WITH_ID)).count()).toBe(0);
    expect(await endedIconOf(tabNamed(page, NO_ID)).count()).toBe(1);
    expect(await endedView(page).count()).toBe(0);
    await untilRead(page, () => !!document.activeElement?.closest('.xterm'), (held) => held);
    expect(sessionsInState(dataDir)).toEqual(storedBefore);
    expect(sessionsInState(dataDir).find((stored) => stored.id === ids.withId)).toMatchObject({ open: true, name: WITH_ID });

    // The row's "Ended" status goes with the last ended tab: the one that never reported is closed, asking nothing.
    await page.getByRole('button', { name: `Close ${NO_ID}`, exact: true }).click();
    await expectTabCount(page, 1);
    expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBe(0);
    await waitForRowStatus(page, WS, null);
  });

  test('AC12 — a resumed session reports a status and a new id: its dot shows the status and state.json holds the new id; when its daemon dies and the page reloads, its ended tab offers "Resume last session" again with the new id', async () => {
    const { page } = session;
    await focusTerminal(page);

    await typeLine(page, 'hook UserPromptSubmit');
    await waitForRow(page, 'hooked:UserPromptSubmit');
    await expectDot(page, ids.withId, 'Working');
    await untilState(dataDir, (state) => harnessIdOf(state, ids.withId) === AFTER_RESUME_ID, () => typeLine(page, `session-hook ${AFTER_RESUME_ID}`));
    await waitForRow(page, `session-hooked:${AFTER_RESUME_ID}`);
    expect(storedIdOf(ids.withId)).toBe(AFTER_RESUME_ID);

    await killDaemon(home);
    await reloadToEndedTabs(page, [WITH_ID]);

    await endedView(page).waitFor();
    await resumeButton(page).waitFor();
    await page.getByText(`claude --resume ${AFTER_RESUME_ID}`, { exact: true }).waitFor();
  });

  test('AC13, AC12 — with the harness gone, "Resume last session" shows the refusal in the Projects message slot, spawns nothing, leaves the tab ended and can be clicked again, which then resumes with the stored id, clears the refusal and shows the status the agent reports again', async () => {
    const { page } = session;
    const binary = join(fx.bin, 'claude');
    const launches = launchFiles(fx);

    renameSync(binary, `${binary}.gone`);
    try {
      await resumeButton(page).click();

      await projectsMessage(page).filter({ hasText: /Claude Code/ }).first().waitFor();
      expect(await projectsMessage(page).first().innerText()).toContain('not found');
      expect(launchFiles(fx)).toEqual(launches);
      expect(await endedIconOf(tabNamed(page, WITH_ID)).count()).toBe(1);
      await endedView(page).waitFor();
      // The message is set before the start settles: the button is enabled once it has.
      await untilRead(
        page,
        () => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Resume last session')?.disabled === false,
        (enabled) => enabled,
      );
      expect(await resumeButton(page).isEnabled(), 'the button can be clicked again').toBe(true);
    } finally {
      renameSync(`${binary}.gone`, binary);
    }

    await resumeButton(page).click();

    const facts = await readStub(page);
    expect(readLaunch(fx, 'claude', facts.pid).args).toEqual([...(await expectedStatusArgs()), '--resume', AFTER_RESUME_ID]);
    expect(launchFiles(fx)).toHaveLength(launches.length + 1);
    expect(await endedIconOf(tabNamed(page, WITH_ID)).count()).toBe(0);
    // A later success clears the refusal the slot showed.
    await projectsMessage(page).filter({ hasText: /Claude Code/ }).waitFor({ state: 'detached' });
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);

    // The session reported `working` before its loss (AC12): the resumed agent reports it again and the dot shows it,
    // which a status kept from before the loss would swallow as no change.
    await focusTerminal(page);
    await typeLine(page, 'hook UserPromptSubmit');
    await waitForRow(page, 'hooked:UserPromptSubmit');
    await expectDot(page, ids.withId, 'Working');
  });

  test('AC14 — a start under way is held in the main process: after a tab switch and back the button is still disabled, `sessions:resume` refuses the session, and once the start ends exactly one agent runs', async () => {
    const { page } = session;
    type Api = { api: { sessions: { harnesses(options: { again: boolean }): Promise<unknown>; resume(id: string, size: { cols: number; rows: number }): Promise<unknown>; ended(): Promise<unknown> } } };

    await killDaemon(home);
    await reloadToEndedTabs(page, [WITH_ID]);
    // A second tab to switch to, made before the detection is held.
    await newShellTab(page);
    await expectTabCount(page, 2);
    await tabNamed(page, WITH_ID).click();
    await resumeButton(page).waitFor();
    const launches = launchFiles(fx);
    const calls = await ipcCalls(session, 'sessions:resume');

    // Detection runs again and its `--version` waits for the test: the start parks in it, the main process holding it.
    await page.evaluate(() => void (window as unknown as Api).api.sessions.harnesses({ again: true }));
    await resumeButton(page).click();
    await ipcReceived(session, 'sessions:resume', calls + 1);

    await page.getByRole('tab').nth(1).click();
    await tabNamed(page, WITH_ID).click();
    await resumeButton(page).waitFor();
    const disabledAfterSwitch = await resumeButton(page).isDisabled();

    // The answer of a call the main process refuses comes before the answer of the one sent after it; a call it holds has none.
    const direct = await page.evaluate(async (sessionId) => {
      const { api } = window as unknown as Api;
      let answer: unknown;
      void api.sessions.resume(sessionId, { cols: 80, rows: 24 }).then((result) => (answer = result));
      await api.sessions.ended();
      return answer ?? null;
    }, ids.withId);

    fx.releaseVersions();
    await ipcAnswered(session, 'sessions:resume', calls + 2);
    const facts = await readStub(page);
    // The start has ended and its agent runs: the session is held by the daemon, no longer by a start under way.
    const whileRunning = await page.evaluate(
      (sessionId) => (window as unknown as Api).api.sessions.resume(sessionId, { cols: 80, rows: 24 }),
      ids.withId,
    );
    const terminalsOfSession = await page.evaluate(
      async (sessionId) => (await (window as unknown as { api: { pty: { list(): Promise<Array<{ sessionId?: string }>> } } }).api.pty.list()).filter((terminal) => terminal.sessionId === sessionId).length,
      ids.withId,
    );

    expect(disabledAfterSwitch, 'the button stays disabled across a tab switch').toBe(true);
    expect(direct, 'the session whose start is under way is refused').toMatchObject({ status: 'refused' });
    expect(whileRunning, 'the session a daemon holds is refused').toMatchObject({ status: 'refused' });
    expect(await ipcCalls(session, 'sessions:resume')).toBe(calls + 3);
    expect(terminalsOfSession, 'one terminal for the session').toBe(1);
    expect(launchFiles(fx)).toHaveLength(launches.length + 1);
    expect(readLaunch(fx, 'claude', facts.pid).args.slice(-2)).toEqual(['--resume', AFTER_RESUME_ID]);
    expect(await endedIconOf(tabNamed(page, WITH_ID)).count()).toBe(0);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });

  test('AC8 — an id a session reports while no app is connected is stored by the daemon at once, and still there when the app is launched again', async () => {
    expect(storedIdOf(ids.withId)).toBe(AFTER_RESUME_ID);
    await quitApp(session);
    expect(storedIdOf(ids.withId)).toBe(AFTER_RESUME_ID);

    const answer = await postSessionEvent(daemonSocketIn(home), {
      authorization: `Bearer ${controlTokenIn(home)}`,
      body: { sessionId: ids.withId, event: 'harness-session', harnessSessionId: UNSEEN_ID },
    });
    expect(answer.status).toBe(204);
    // The daemon writes state.json itself: nothing needs to be connected to hear it.
    expect(storedIdOf(ids.withId)).toBe(UNSEEN_ID);

    session = await launchBuiltWith(env, dataDir, home);
    expect(storedIdOf(ids.withId)).toBe(UNSEEN_ID);
    await session.page.getByText(versionLabel).waitFor();
  });
});
