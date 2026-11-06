import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type FileHandle } from 'node:fs/promises';
import { type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MAIN_PROCESS_ERROR, launchSpawned, quitApp, versionLabel, type Session } from './launch';
import { makeTestDir } from './run-root';
import {
  agentSelect,
  baseSelect,
  chooseBase,
  createButton,
  openComposer,
  openComposerFromSidebar,
  projectSelect,
  promptBox,
  sendFromComposer,
  textOf,
  useAgent,
  waitForAgent,
  waitForBase,
  waitForWorkspacePage,
  waitForWorktree,
  worktreeSwitch,
  norm,
} from './composer';
import {
  git,
  gitOrNull,
  installStub,
  localBranches,
  makeClone,
  makeFixture,
  makeLight,
  openFifo,
  removeStub,
  sessionsInState,
  signalled,
  startsOf,
  tabs,
  waitForRow,
  worktreesDirIn,
  type Fixture,
  type Repo,
} from './support/composer-fixture';
import { afterIpcAnswers, afterRender, countIpcCalls, deleteButton, dispatchFocus, gitIn, ipcAnswered, ipcCalls, makeClone as makeProjectClone, openDialogs, sidebarEntries, untilDeleteReady } from './support/projects';
import { addGhFixture, commitField, expectListed, GIT_APP_ENV, prJson, prLink, selectBarTab, setChangesOpen, setGh, shipButton, waitForShipText, type GhFixture } from './support/right-bar';
import { type SessionsFixture } from './support/sessions';
import { type PtyWindow } from './support/terminal';
import { untilEvents, watchEvents } from './support/daemon';
import {
  mainRowIcon,
  mainRowLink,
  mainRowsOf,
  readSwitchLook,
  startMainDeletion,
  storedProjects,
  storedSessionsOf,
  tokenColour,
  waitForMainRow,
  waitForMainRowText,
  waitForNoMainRow,
} from './support/main-workspace';

// COCKPIT-71: a new workspace without a worktree (the composer's Worktree switch off) runs in the project's folder, on the
// branch checked out. One built-app launch (a relaunch for AC11) with a fake login shell whose `PATH` holds a stub `claude`
// and a stub `gh`, and five projects, one per concern: `ui` (the composer), `nodef` (detached HEAD, "Terminal"), `life`
// (agent sessions, the row, deleting; it has a setup and a teardown command), `refuse` (an agent that cannot start) and
// `bar` (the right bar). The tests run in order on that launch. Nothing here runs a real agent CLI or `gh`.

const electron = () => createRequire(import.meta.url)('electron') as string;

// The rows of the terminal on the page that shows.
const visibleRows = (page: Page) =>
  page.evaluate(() => {
    const terminal = [...document.querySelectorAll('.xterm-rows')].find((element) => {
      const { width, height } = element.getBoundingClientRect();
      return width > 0 && height > 0 && getComputedStyle(element).visibility !== 'hidden';
    });
    return terminal ? [...terminal.children].map((row) => (row.textContent ?? '').replace(/ /g, ' ').trimEnd()) : [];
  });

// Types a line on the keyboard of the visible terminal, as a user does.
const typeLine = async (page: Page, text: string) => {
  await page.locator('.xterm:visible').first().click();
  await page.locator('.xterm:visible .xterm-helper-textarea').first().focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

// The main process has answered everything the page asked so far, `projects:list` on the per-repository chain included.
const settleMain = (page: Page) => page.evaluate(() => (globalThis as unknown as { api: { projects: { list(): Promise<unknown> } } }).api.projects.list());

// The terminals the daemon lists in `path`.
const terminalsIn = (page: Page, path: string) =>
  page.evaluate(
    async (path) =>
      (await (window as unknown as PtyWindow).api.pty.list()).filter((terminal) => {
        const listed = terminal as { cwd?: string; workspace?: string };
        return listed.cwd === path || listed.workspace === path;
      }).length,
    path,
  );

// Waits for every CSS transition and animation of the page to end: a colour is read once it is final.
const settled = (page: Page) =>
  page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });

// The sidebar's message under Projects.
const projectsMessage = (page: Page) => page.locator('aside [role="status"]').filter({ hasText: /\S/ });

// What a send with no worktree must leave alone in the repository.
const gitFacts = (repo: { root: string }) => ({
  branches: git(repo.root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
  worktrees: git(repo.root, 'worktree', 'list', '--porcelain'),
  head: `${git(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD')} ${git(repo.root, 'rev-parse', 'HEAD')}`,
});

describe('main workspace: built app', () => {
  let fx: Fixture;
  let gh: GhFixture;
  let session: Session;
  let dataDir: string;
  let home: string;
  let ui: Repo;
  let nodef: Repo;
  let life: Repo;
  let refuse: Repo;
  let bar: ReturnType<typeof makeProjectClone>;
  // The FIFO the stub of `mw-life` writes to once it printed its title (AC5 opens it, AC9 reads it).
  const titlesDone: FileHandle[] = [];

  const appEnv = () => ({ ...fx.env(), ...GIT_APP_ENV });
  const setupLog = (repo: Repo) => join(repo.root, 'setup.log');
  const teardownLog = (repo: Repo) => join(repo.root, 'teardown.log');
  const worktreesFolder = (repo: Repo) => worktreesDirIn(home, repo);
  const titlesFile = () => join(fx.bin, `claude.titles.${life.name}`);

  beforeAll(async () => {
    fx = makeFixture();
    installStub(fx, 'claude');
    gh = addGhFixture(fx as SessionsFixture);
    ui = makeClone('mw-ui');
    nodef = makeLight('mw-nodef');
    git(nodef.root, 'checkout', '--detach');
    life = makeClone('mw-life');
    refuse = makeLight('mw-refuse');
    bar = makeProjectClone('mw-bar');
    // A setup and a teardown command that leave a trace: a main workspace runs neither.
    for (const repo of [nodef, life]) {
      mkdirSync(join(repo.root, '.cockpit'));
      writeFileSync(
        join(repo.root, '.cockpit', 'config.json'),
        JSON.stringify({ setup: [`echo setup-ran >> '${setupLog(repo)}'`], teardown: [`echo torn-down >> '${teardownLog(repo)}'`] }),
      );
    }
    dataDir = realpathSync(makeTestDir('d-'));
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, projects: [ui, nodef, life, refuse, bar].map((repo) => ({ path: repo.root })) }));
    session = await launchSpawned(electron(), ['.'], true, dataDir, appEnv());
    home = join(dataDir, 'h');
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    for (const folder of [dataDir, fx?.root, ui?.parent, nodef?.parent, life?.parent, refuse?.parent, bar?.parent, bar?.upstream.parent]) {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  // --- The composer -----------------------------------------------------------------------------------

  test('AC1 — with a project the composer shows a "Worktree" switch, on, between the agent select and the base select, which shows; its look follows the frame in both color schemes, on and off', async () => {
    const { page } = session;
    await openComposer(page, ui.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    expect(await worktreeSwitch(page).count()).toBe(1);
    expect(await worktreeSwitch(page).getAttribute('aria-checked')).toBe('true');
    expect(await baseSelect(page).count()).toBe(1);

    const agent = (await agentSelect(page).boundingBox())!;
    const base = (await baseSelect(page).boundingBox())!;
    const first = (await page.evaluate(readSwitchLook))!;
    expect(first.control, 'the switch has a control').not.toBeNull();
    expect(first.control!.left, 'after the agent select').toBeGreaterThanOrEqual(agent.x + agent.width - 0.5);
    expect(first.control!.right, 'before the base select').toBeLessThanOrEqual(base.x + 0.5);

    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await settled(page);
      const expected = {
        brand: await tokenColour(page, '--brand', 'backgroundColor'),
        accent: await tokenColour(page, '--sidebar-accent', 'backgroundColor'),
        foreground: await tokenColour(page, '--foreground'),
        muted: await tokenColour(page, '--muted-foreground'),
        mutedFill: await tokenColour(page, '--muted-foreground', 'backgroundColor'),
      };
      for (const on of [true, false]) {
        if (!on) {
          await worktreeSwitch(page).click();
          await waitForWorktree(page, false);
          await settled(page);
        }
        const look = (await page.evaluate(readSwitchLook))!;
        const where = `${scheme}, ${on ? 'on' : 'off'}`;
        expect(look.on, where).toBe(on);
        expect(look.control!.height, `control height, ${where}`).toBeCloseTo(24, 0);
        expect([look.control!.paddingLeft, look.control!.paddingRight], `control padding, ${where}`).toEqual(['8px', '8px']);
        expect(look.label.left - look.track.right, `gap, ${where}`).toBeCloseTo(6, 0);
        expect([look.track.width, look.track.height], `track, ${where}`).toEqual([28, 16]);
        expect(look.thumb, `knob, ${where}`).not.toBeNull();
        expect([look.thumb!.width, look.thumb!.height], `knob size, ${where}`).toEqual([12, 12]);
        expect([look.label.fontSize, look.label.fontWeight], `label, ${where}`).toEqual(['12px', '400']);
        const middle = (look.track.left + look.track.right) / 2;
        const knob = (look.thumb!.left + look.thumb!.right) / 2;
        if (on) {
          expect(look.track.background, where).toBe(expected.brand);
          expect(look.thumb!.background, where).toBe('rgb(255, 255, 255)');
          expect(knob, `knob at the right, ${where}`).toBeGreaterThan(middle);
          expect(look.label.color, where).toBe(expected.foreground);
        } else {
          expect(look.track.background, where).toBe(expected.accent);
          expect(look.thumb!.background, where).toBe(expected.mutedFill);
          expect(knob, `knob at the left, ${where}`).toBeLessThan(middle);
          expect(look.label.color, where).toBe(expected.muted);
        }
      }
      await worktreeSwitch(page).click();
      await waitForWorktree(page, true);
    }
    await page.emulateMedia({ colorScheme: null });
  });

  test('AC2 — turning the switch off removes the base select; turning it on again brings it back with the base picked before', async () => {
    const { page } = session;
    await openComposer(page, ui.root);
    await waitForBase(page, 'origin/main');
    await chooseBase(page, 'origin/develop');

    await worktreeSwitch(page).click();
    await waitForWorktree(page, false);
    await baseSelect(page).waitFor({ state: 'detached' });
    expect(await baseSelect(page).count()).toBe(0);

    await worktreeSwitch(page).click();
    await waitForWorktree(page, true);
    await waitForBase(page, 'origin/develop');
  });

  test('AC3 — "No project" has no Worktree switch; the switch off, once the composer is left and opened again, is on', async () => {
    const { page } = session;
    await openComposer(page, ui.root);
    await waitForBase(page, 'origin/main');
    await worktreeSwitch(page).click();
    await waitForWorktree(page, false);

    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('project') === 'none');
    expect(await textOf(projectSelect(page))).toBe('No project');
    expect(await worktreeSwitch(page).count()).toBe(0);

    await openComposerFromSidebar(page, ui.root);
    await waitForBase(page, 'origin/main');
    await waitForWorktree(page, true);
  });

  test('AC4 — with no default base (detached HEAD, no origin/HEAD) and a prompt typed, the send button is disabled with the switch on and enabled with it off', async () => {
    const { page } = session;
    await openComposer(page, nodef.root);
    await useAgent(page, 'Claude Code');
    await waitForBase(page, 'Select a base');
    await promptBox(page).fill('Look around');
    await createButton(page).and(page.locator('button:disabled')).waitFor();

    await worktreeSwitch(page).click();
    await waitForWorktree(page, false);
    await createButton(page).and(page.locator('button:enabled')).waitFor();

    await worktreeSwitch(page).click();
    await waitForWorktree(page, true);
    await waitForBase(page, 'Select a base');
    await createButton(page).and(page.locator('button:disabled')).waitFor();
  });

  // --- Sending ------------------------------------------------------------------------------------------

  test('AC6, AC10 — with the switch off and "Terminal" a login shell runs in the project\'s folder as the one tab of the workspace page: no branch, no worktree, no setup, no stored session; the project is marked and its row is named after the folder on a detached HEAD', async () => {
    const { page } = session;
    const before = gitFacts(nodef);
    const sessionsBefore = sessionsInState(dataDir).length;

    const sent = await sendFromComposer(page, nodef, { prompt: 'Look around', worktree: false });

    expect(sent.path).toBe(nodef.root);
    expect((await tabs(page)).labels).toHaveLength(1);
    await waitForRow(page, 'login-shell>');
    await typeLine(page, 'pwd -P');
    await waitForRow(page, nodef.root);
    expect(gitFacts(nodef)).toEqual(before);
    expect(localBranches(nodef)).toEqual(['main']);
    expect(existsSync(worktreesFolder(nodef)), 'no worktrees folder').toBe(false);
    expect(existsSync(join(fx.root, 'git-adds.log')), 'git never added a worktree').toBe(false);
    expect(existsSync(setupLog(nodef)), 'no setup ran').toBe(false);
    expect(await visibleRows(page)).not.toContain('✓ Setup done');
    expect(sessionsInState(dataDir)).toHaveLength(sessionsBefore);
    expect(storedProjects(dataDir).find((project) => project.path === nodef.root)?.mainWorkspace).toBe(true);

    await waitForMainRowText(page, nodef.root, nodef.name);
    expect(await mainRowsOf(page, nodef.root)).toHaveLength(1);
  });

  test('AC5 — with the switch off and a detected agent no branch and no worktree are made and no setup runs; the agent starts in the project\'s folder with the trimmed prompt as one argument, the session is stored with the project\'s path, the project is marked and the page opens with the session as its one selected tab', async () => {
    const { page } = session;
    // The stub prints a prompt-derived title in its folder (`mw-life`) and tells the test (AC9, below).
    writeFileSync(titlesFile(), '✳ Fix the login redirect loop\n');
    await openFifo(`${titlesFile()}.done`).then((fifo) => titlesDone.push(fifo));
    const before = gitFacts(life);
    const startsBefore = startsOf(fx, 'claude').length;

    const sent = await sendFromComposer(page, life, { prompt: '  Look at the failing build  ', agent: 'Claude Code', worktree: false });

    expect(sent.path).toBe(life.root);
    await waitForRow(page, 'ready');
    expect(startsOf(fx, 'claude').slice(startsBefore)).toEqual([{ cwd: life.root, args: ['Look at the failing build'] }]);
    expect(gitFacts(life)).toEqual(before);
    expect(existsSync(worktreesFolder(life)), 'no worktrees folder').toBe(false);
    expect(existsSync(join(fx.root, 'git-adds.log')), 'git never added a worktree').toBe(false);
    expect(existsSync(setupLog(life)), 'no setup ran').toBe(false);
    expect(await visibleRows(page)).not.toContain('✓ Setup done');

    const stored = sessionsInState(dataDir).filter((each) => each.directory === life.root);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: sent.id, harness: 'claude-code', project: life.root, directory: life.root });
    expect(storedProjects(dataDir).find((project) => project.path === life.root)?.mainWorkspace).toBe(true);
    const shown = await tabs(page);
    expect(shown.labels).toHaveLength(1);
    expect(shown.selected[0]).toMatch(/Claude Code/);
  });

  test('AC9 — a prompt-derived title set by the agent of the main workspace leaves the branch its name and writes no cockpitName', async () => {
    const { page } = session;
    const [done] = titlesDone;
    // AC5's agent started: the stub writes to the FIFO only then, so a send that never reached it fails here, not by waiting.
    expect(startsOf(fx, 'claude').filter((start) => start.cwd === life.root)).toHaveLength(1);
    // The stub has printed its title once it writes to the FIFO; the main process has read it once its list answers.
    await signalled(done!);
    await settleMain(page);

    expect(git(life.root, 'branch', '--show-current')).toBe('main');
    expect(localBranches(life)).toEqual(['local-topic', 'main', 'topic/nested']);
    expect(gitOrNull(life.root, 'config', '--get-regexp', 'cockpitName')).toBeNull();
    await done!.close();
    rmSync(`${titlesFile()}.done`, { force: true });
    rmSync(titlesFile(), { force: true });
  });

  test('AC8 — a second send with the switch off adds no row: the page opens with a second agent tab, both running in the project\'s folder', async () => {
    const { page } = session;
    const startsBefore = startsOf(fx, 'claude').length;
    await openComposerFromSidebar(page, life.root);
    await useAgent(page, 'Claude Code');
    await worktreeSwitch(page).click();
    await waitForWorktree(page, false);
    await promptBox(page).fill('Look at the second thing');
    await createButton(page).click();

    await waitForWorkspacePage(page, life.root);
    await page.getByRole('tab').nth(1).click();
    // The second tab's own terminal shows the stub's output: the agent started.
    await waitForRow(page, 'ready');
    const shown = await tabs(page);
    expect(shown.labels).toHaveLength(2);
    expect(shown.labels.every((label) => /Claude Code/.test(label))).toBe(true);
    expect(await mainRowsOf(page, life.root)).toHaveLength(1);
    expect(startsOf(fx, 'claude').slice(startsBefore)).toEqual([{ cwd: life.root, args: ['Look at the second thing'] }]);
    expect(startsOf(fx, 'claude').filter((start) => start.cwd === life.root)).toHaveLength(2);
    expect(sessionsInState(dataDir).filter((each) => each.directory === life.root)).toHaveLength(2);
    expect(existsSync(setupLog(life))).toBe(false);
  });

  test('AC7 — with the switch off and a start that is refused (the binary removed since the detection) the workspace stays, its page opens with no tab and the refusal shows under Projects', async () => {
    const { page } = session;
    await openComposerFromSidebar(page, refuse.root);
    await useAgent(page, 'Claude Code');
    await worktreeSwitch(page).click();
    await waitForWorktree(page, false);
    // Removed after it was detected: the start finds it gone.
    removeStub(fx, 'claude');
    try {
      await promptBox(page).fill('Start fails');
      await createButton(page).click();
      await waitForWorkspacePage(page, refuse.root);
      await projectsMessage(page).filter({ hasText: /^\s*Could not start Claude Code: / }).first().waitFor();
    } finally {
      installStub(fx, 'claude');
    }

    await waitForMainRow(page, refuse.root);
    await mainRowLink(page, refuse.root).filter({ hasNotText: 'Setting up' }).waitFor();
    await page.getByRole('button', { name: 'New tab', exact: true }).first().waitFor();
    expect(await page.getByRole('tab').count()).toBe(0);
    expect(new URL(page.url()).searchParams.get('path')).toBe(refuse.root);
    expect(sessionsInState(dataDir).filter((each) => each.directory === refuse.root)).toHaveLength(0);
    expect(storedProjects(dataDir).find((project) => project.path === refuse.root)?.mainWorkspace).toBe(true);
  });

  // --- The row ----------------------------------------------------------------------------------------

  test('AC10 — the main workspace row comes first under its project and is named after the branch checked out; after `git switch -c other` and a window focus it says `other`; a project without one lists no such row', async () => {
    const { page } = session;
    const side = join(worktreesFolder(life), 'side');
    mkdirSync(worktreesFolder(life), { recursive: true });
    git(life.root, 'worktree', 'add', '--quiet', '-b', 'side', side, 'main');
    await dispatchFocus(page);
    await page.locator(`aside a[title="${side}"]`).waitFor();

    const titles = (await sidebarEntries(page)).map((entry) => entry.title);
    const project = titles.indexOf(life.root);
    expect(titles.slice(project, project + 3), 'the project, its main workspace, then its worktree').toEqual([life.root, life.root, side]);
    expect(norm((await mainRowsOf(page, life.root))[0]!)).toContain('main');
    expect(await mainRowsOf(page, ui.root), 'a project without one lists no such row').toEqual([]);

    git(life.root, 'switch', '--quiet', '-c', 'other');
    await dispatchFocus(page);
    await waitForMainRowText(page, life.root, 'other');
    expect(norm((await mainRowsOf(page, life.root))[0]!)).not.toContain('main');
  });

  test('AC11 — after the app restarts the main workspace row is still listed and its running terminals come back as tabs of its page', async () => {
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    await quitApp(session);
    session = await launchSpawned(electron(), ['.'], true, dataDir, appEnv());
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    await waitForMainRowText(page, life.root, 'other');
    expect(await mainRowsOf(page, life.root)).toHaveLength(1);
    await mainRowLink(page, life.root).click();
    await waitForWorkspacePage(page, life.root);
    await page.getByRole('tab').nth(1).waitFor();
    expect((await tabs(page)).labels).toHaveLength(2);
    expect(await terminalsIn(page, life.root)).toBe(2);
  });

  // --- Deleting -------------------------------------------------------------------------------------------

  test('AC15 — Delete workspace… of a main workspace says its sessions end and nothing is removed from the disk, with no uncommitted-changes warning and no branch box; confirmed, the sessions end, the row and the mark go, the sessions stay stored and closed, no teardown ran, and the folder, the uncommitted file and the branch are unchanged', async () => {
    const { page } = session;
    writeFileSync(join(life.root, 'notes.txt'), 'keep me\n');
    const kept = { branch: git(life.root, 'branch', '--show-current'), branches: localBranches(life), head: git(life.root, 'rev-parse', 'HEAD'), status: git(life.root, 'status', '--porcelain') };
    expect(kept.status, 'the uncommitted file is there').toContain('notes.txt');
    const ids = sessionsInState(dataDir).filter((each) => each.directory === life.root).map((each) => each.id).sort();
    expect(ids).toHaveLength(2);

    await watchEvents(page);
    await startMainDeletion(page, life.root, kept.branch);
    const dialog = openDialogs(page).filter({ hasText: `Delete ${kept.branch}?` });
    await dialog.waitFor();
    await untilDeleteReady(dialog);
    const text = norm(await dialog.innerText());
    expect(text, 'its sessions end').toMatch(/sessions? end|ends? (its|the|all) (running )?sessions/i);
    expect(text, 'nothing is removed from the disk').toMatch(/nothing is (removed|deleted) from (the|your) disk|nothing is (removed|deleted) from this Mac/i);
    expect(text, 'no uncommitted-changes warning').not.toMatch(/uncommitted/i);
    expect(await dialog.getByRole('checkbox').count(), 'no branch box').toBe(0);

    await deleteButton(dialog).click();
    await dialog.waitFor({ state: 'hidden' });
    // The two agents' processes ended: the main process heard both exit.
    await untilEvents(page, 'exits', 2);
    await waitForNoMainRow(page, life.root);
    expect(await terminalsIn(page, life.root), 'no terminal left in the folder').toBe(0);

    expect(storedProjects(dataDir).find((project) => project.path === life.root)?.mainWorkspace, 'the mark is gone').not.toBe(true);
    const stored = storedSessionsOf(dataDir).filter((each) => each.directory === life.root);
    expect(stored.map((each) => each.id).sort(), 'the sessions stay stored').toEqual(ids);
    expect(stored.every((each) => each.open !== true), 'and closed').toBe(true);
    expect(existsSync(teardownLog(life)), 'no teardown ran').toBe(false);
    expect(existsSync(setupLog(life)), 'no setup ran').toBe(false);
    expect(existsSync(life.root)).toBe(true);
    expect(readFileSync(join(life.root, 'notes.txt'), 'utf8')).toBe('keep me\n');
    expect({
      branch: git(life.root, 'branch', '--show-current'),
      branches: localBranches(life),
      head: git(life.root, 'rev-parse', 'HEAD'),
      status: git(life.root, 'status', '--porcelain'),
    }).toEqual(kept);
  });

  test('AC16 — after a main workspace was deleted a send with the switch off brings its row back with one tab', async () => {
    const { page } = session;
    const sent = await sendFromComposer(page, life, { prompt: 'Back again', agent: 'Claude Code', worktree: false });

    expect(sent.path).toBe(life.root);
    await waitForMainRow(page, life.root);
    expect(await mainRowsOf(page, life.root)).toHaveLength(1);
    expect((await tabs(page)).labels).toHaveLength(1);
    expect(storedProjects(dataDir).find((project) => project.path === life.root)?.mainWorkspace).toBe(true);
    expect(sessionsInState(dataDir).find((each) => each.id === sent.id)).toMatchObject({ directory: life.root, project: life.root });
  });

  // --- The right bar ----------------------------------------------------------------------------------------

  const BAR_FILES = ['README.md', 'feature.txt', 'scratch.txt'];
  // The gh answers, then a focus, then everything the main process answered is shown.
  const settlePullRequest = async (page: Page) => {
    await dispatchFocus(page);
    await afterIpcAnswers(page);
    await ipcAnswered(session, 'workspaces:pull-request', await ipcCalls(session, 'workspaces:pull-request'));
    await afterRender(page);
  };

  test('AC12 — a main workspace on the default branch lists its uncommitted edit and its untracked file in the Diff tab; on a feature branch with one commit it lists that commit\'s file against the default base', async () => {
    const { page } = session;
    await countIpcCalls(session, ['workspaces:pull-request']);
    await sendFromComposer(page, bar, { prompt: 'Look at the bar', worktree: false });
    await waitForWorkspacePage(page, bar.root);

    appendFileSync(join(bar.root, 'README.md'), 'edited\n');
    writeFileSync(join(bar.root, 'scratch.txt'), 'scratch\n');
    await setChangesOpen(page, true, 'Diff');
    await expectListed(page, BAR_FILES, ['README.md', 'scratch.txt']);

    gitIn(bar.root, 'checkout', '--quiet', '--', 'README.md');
    rmSync(join(bar.root, 'scratch.txt'));
    gitIn(bar.root, 'switch', '--quiet', '-c', 'feat');
    writeFileSync(join(bar.root, 'feature.txt'), 'feature\n');
    gitIn(bar.root, 'add', 'feature.txt');
    gitIn(bar.root, 'commit', '--quiet', '-m', 'Add the feature');
    await expectListed(page, BAR_FILES, ['feature.txt']);
  });

  test('AC13 — a main workspace on a feature branch with a pull request shows it in the Pull request tab and its icon on the row; pushed with no pull request it offers "Create pull request"', async () => {
    const { page } = session;
    setGh(gh, { list: prJson(), states: { feat: 'OPEN' } });
    await selectBarTab(page, 'Pull request');
    await dispatchFocus(page);
    await prLink(page).waitFor();
    await waitForShipText(page, (text) => text.includes('#7 · romain-cll'));
    await mainRowIcon(page, bar.root, 'Pull request open').waitFor();

    gitIn(bar.root, 'push', '--quiet', '-u', 'origin', 'feat');
    setGh(gh);
    await dispatchFocus(page);
    const create = shipButton(page, 'Create pull request');
    await create.and(page.locator('button:enabled')).waitFor();
    expect(await prLink(page).count()).toBe(0);
  });

  test('AC14 — a main workspace on the branch the changes are compared with does not offer "Create pull request", and "Commit" commits on that branch in the project\'s folder', async () => {
    const { page } = session;
    gitIn(bar.root, 'switch', '--quiet', 'main');
    appendFileSync(join(bar.root, 'README.md'), 'committed on main\n');
    setGh(gh);
    await selectBarTab(page, 'Pull request');
    // "Commit" is enabled once the bar read the branch's state, uncommitted file included: the branch is known.
    await commitField(page).fill('Commit on the default branch');
    await shipButton(page, 'Commit').and(page.locator('button:enabled')).waitFor();
    await settlePullRequest(page);
    expect(await shipButton(page, 'Create pull request').count()).toBe(0);

    await shipButton(page, 'Commit').click();
    await waitForShipText(page, (text) => /(^|\s)2 commits to push(\s|$)/.test(text));
    expect(gitIn(bar.root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(gitIn(bar.root, 'log', '-1', '--format=%s')).toBe('Commit on the default branch');
    expect(gitIn(bar.root, 'status', '--porcelain')).toBe('');
  });

  test('logs no error and keeps running', async () => {
    const { page } = session;
    expect(session.isRunning()).toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(await page.pageErrors({ filter: 'all' })).toEqual([]);
  });
});
