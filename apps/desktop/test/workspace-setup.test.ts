import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { launchSpawned, versionLabel, type Session } from './launch';
import { makeTestDir } from './run-root';
import {
  agentSelect,
  baseSelect,
  chooseBase,
  createButton,
  messageOf,
  norm,
  openComposer,
  openComposerFromSidebar,
  pickAgent,
  projectSelect,
  promptBox,
  sendFromComposer,
  storedSessions,
  textOf,
  useAgent,
  waitForAgent,
  waitForBase,
  waitForMessage,
  waitForSelectedTab,
  waitForWorkspacePage,
} from './composer';
import { afterIpcAnswers, ipcAnswered, removeThroughMenu, waitForSetupLabel } from './support/projects';
import { daemonPidIn } from './support/panes';
import { locationsSeen, recordLocations, watchStarts } from './support/sessions';
import { activePane, goHome, type PtyWindow } from './support/terminal';
import {
  entryOf,
  git,
  holdGit,
  installStub,
  loadingText,
  localBranches,
  makeClone,
  makeFixture,
  makeLight,
  removeStub,
  sessionsInState,
  startsOf,
  tabs,
  waitForRow,
  worktreeIn,
  worktreesDirIn,
  type Fixture,
  type Repo,
} from './support/composer-fixture';

// COCKPIT-89: a new workspace exists at once, with a setting-up status and a loading page. One built-app launch
// with a fake login shell whose `PATH` holds a stub `claude` and a `git` that holds the calls a test asks it to
// (`holdGit`): the worktree of a send, or the branch listing its name is reserved from. The project `clone` has a
// setup command, `refuse` has none and a second local branch, `side`. Each test builds its own state; the
// no-project tests need the daemon, which the first sends start.

const backToComposer = (page: Page, where: 'main' | 'aside') => page.locator(where).getByRole('button', { name: 'Back to composer', exact: true });
const mainText = async (page: Page) => norm(await page.locator('main').innerText());
// The `li` of the workspace row titled `path` (the innermost one: a project's `li` holds it too).
const rowItem = (page: Page, path: string) => page.locator('aside li').filter({ has: page.locator(`[title="${path}"]`) }).last();
const rightBar = (page: Page) => page.getByRole('complementary', { name: 'Right bar' });
// The sidebar's message under Projects.
const projectsMessage = (page: Page) => page.locator('aside [role="status"]').filter({ hasText: /\S/ });
// The reason the main process kept for the refusal of the workspace at `path` (`api.workspaces.failedSetups()`).
const refusalOf = async (page: Page, path: string) => {
  const failed = await page.evaluate(
    () => (window as unknown as { api: { workspaces: { failedSetups(): Promise<Array<{ path: string; message: string }>> } } }).api.workspaces.failedSetups(),
  );
  const found = failed.find((each) => each.path === path);
  expect(found, `a refusal kept for ${path}`).toBeTruthy();
  return found!.message;
};
// Waits for the next `workspaces:settled` event of the main process (a setup ended, whatever its outcome) from the
// moment this is called; `await` the result after the action that settles. The api name is the IPC's: `api.workspaces.onSettled`.
const watchSettled = async (page: Page) => {
  await page.evaluate(() => {
    const win = window as unknown as { __settled?: Promise<void>; api: { workspaces: { onSettled(listener: () => void): () => void } } };
    win.__settled = new Promise<void>((resolve) => {
      const stop = win.api.workspaces.onSettled(() => {
        stop();
        resolve();
      });
    });
  });
  return () => page.evaluate(() => (window as unknown as { __settled: Promise<void> }).__settled);
};

describe('workspace setup status: built app', () => {
  let fx: Fixture;
  let session: Session;
  let dataDir: string;
  let clone: Repo;
  let refuse: Repo;
  let doomed: Repo;
  let home: string;

  const worktreeOf = (repo: Repo, branch: string) => worktreeIn(home, repo, branch);
  const worktreesDirOf = (repo: Repo) => worktreesDirIn(home, repo);

  beforeAll(async () => {
    fx = makeFixture();
    installStub(fx, 'claude');
    clone = makeClone('wss-clone');
    mkdirSync(join(clone.root, '.cockpit'));
    writeFileSync(join(clone.root, '.cockpit', 'config.json'), JSON.stringify({ setup: ['echo setup-ran >> "$COCKPIT_ROOT_PATH/setup.log"'] }));
    refuse = makeLight('wss-refuse');
    git(refuse.root, 'branch', 'side');
    doomed = makeLight('wss-doomed');
    dataDir = makeTestDir('d-');
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, projects: [clone, refuse, doomed].map((repo) => ({ path: repo.root })) }));
    session = await launchSpawned(createRequire(import.meta.url)('electron') as string, ['.'], true, dataDir, fx.env());
    home = join(realpathSync(dataDir), 'h');
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    for (const folder of [dataDir, fx?.root, clone?.parent, refuse?.parent, doomed?.parent]) {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  test('COCKPIT-89 AC11 — while a send is running (the reservation of its name still reading the branches) the button is disabled and Enter sends nothing more; the send ends with one workspace and one session', async () => {
    const { page } = session;
    const addsLog = join(fx.root, 'git-adds.log');
    const adds = () => (existsSync(addsLog) ? readFileSync(addsLog, 'utf8').split('\n').filter(Boolean).length : 0);
    const before = { adds: adds(), sessions: sessionsInState(dataDir).length, starts: startsOf(fx, 'claude').length };
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill('Blocked send');
    const held = await holdGit(fx, 'read');
    try {
      await createButton(page).click();
      await held.reached();
      expect(await createButton(page).isDisabled(), 'the button is disabled while the send is under way').toBe(true);
      await promptBox(page).press('Enter');
      await createButton(page).click({ force: true }).catch(() => {});
      expect(new URL(page.url()).pathname, 'the page has not opened and nothing was sent meanwhile').toBe('/');
    } finally {
      await held.release();
    }
    await waitForWorkspacePage(page, worktreeOf(clone, 'blocked-send'));
    await waitForSelectedTab(page);
    // The workspace's setup runs in this session's terminal: let it end so it does not write setup.log later.
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect(adds(), 'a single worktree was made').toBe(before.adds + 1);
    expect(localBranches(clone)).toContain('blocked-send');
    expect(localBranches(clone)).not.toContain('blocked-send-2');
    expect(sessionsInState(dataDir)).toHaveLength(before.sessions + 1);
    expect(startsOf(fx, 'claude')).toHaveLength(before.starts + 1);
  }, 60_000);

  const worktreeCount = (path: string) => git(clone.root, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line === `worktree ${path}`).length;
  // Fills the composer for `repo` with the default agent and base and sends `prompt` with the button.
  const sendFrom = async (repo: Repo, prompt: string, base: string) => {
    const { page } = session;
    await openComposerFromSidebar(page, repo.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, base);
    await promptBox(page).fill(prompt);
    await createButton(page).click();
  };

  test('COCKPIT-89 AC1, AC2 — with `git worktree add` held the workspace page opens on "Setting up workspace…" under the workspace\'s name, its row says "Setting up" with no menu and no start button and no right bar shows; once released the page shows the session as its one selected tab holding the keyboard, with no navigation and no reload, and the row has its actions back', async () => {
    const { page } = session;
    const prompt = 'Hold the send';
    const branch = 'hold-the-send';
    const path = worktreeOf(clone, branch);
    const startsBefore = startsOf(fx, 'claude').length;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill(prompt);
    const held = await holdGit(fx, 'git');
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();
      expect(existsSync(path), 'the worktree does not exist yet').toBe(false);
      expect(await mainText(page)).toMatch(new RegExp(`${branch}.*Setting up workspace…`));
      await entryOf(page, path).waitFor();
      await waitForSetupLabel(page, path, 'Setting up');
      expect(await rowItem(page, path).getByRole('button').count(), 'no "…" menu and no start button on the row').toBe(0);
      expect(await rightBar(page).count(), 'no right bar and no rail').toBe(0);
      await recordLocations(page);
      await page.evaluate(() => void ((window as unknown as { __kept?: boolean }).__kept = true));
    } finally {
      await held.release();
    }

    await waitForSelectedTab(page);
    expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept), 'the page was not reloaded').toBe(true);
    expect(await locationsSeen(page), 'nothing navigated').toEqual([]);
    expect(await loadingText(page).count()).toBe(0);
    await page.locator('.xterm-helper-textarea:focus').waitFor({ state: 'attached' });
    expect(await activePane(page), 'the selected tab\'s terminal holds the keyboard').not.toBeNull();
    const shown = await tabs(page);
    expect(shown.labels).toHaveLength(1);
    expect(shown.selected[0]).toMatch(/Claude Code/);
    await page.getByRole('button', { name: `Actions for ${branch}`, exact: true }).waitFor();
    expect(await page.getByRole('button', { name: `Start session in ${branch}`, exact: true }).count()).toBe(1);
    expect(existsSync(path)).toBe(true);
    expect(sessionsInState(dataDir).find((each) => each.directory === path)).toMatchObject({ harness: 'claude-code', project: clone.root });
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect(startsOf(fx, 'claude').slice(startsBefore)).toEqual([{ cwd: path, args: [prompt] }]);
  }, 60_000);

  test('COCKPIT-89 AC9 — a workspace setting up, the same task sent again: the second workspace gets the "-2" branch and both end set up', async () => {
    const { page } = session;
    const first = worktreeOf(clone, 'twice-the-same');
    const second = worktreeOf(clone, 'twice-the-same-2');
    const startsBefore = startsOf(fx, 'claude').length;
    const held = await holdGit(fx, 'git');
    try {
      await sendFrom(clone, 'Twice the same', 'origin/main');
      await held.reached();
      await waitForWorkspacePage(page, first);
      await loadingText(page).waitFor();

      await sendFrom(clone, 'Twice the same!', 'origin/main');
      await waitForWorkspacePage(page, second);
      await loadingText(page).waitFor();
      await waitForSetupLabel(page, first, 'Setting up');
      await waitForSetupLabel(page, second, 'Setting up');
    } finally {
      await held.release();
    }

    await waitForSelectedTab(page);
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    await entryOf(page, first).click();
    await waitForWorkspacePage(page, first);
    await waitForSelectedTab(page);
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect(localBranches(clone)).toEqual(expect.arrayContaining(['twice-the-same', 'twice-the-same-2']));
    expect(worktreeCount(first)).toBe(1);
    expect(worktreeCount(second)).toBe(1);
    expect(sessionsInState(dataDir).filter((each) => each.directory === first || each.directory === second)).toHaveLength(2);
    expect(startsOf(fx, 'claude').slice(startsBefore).map((start) => start.cwd).sort()).toEqual([first, second]);
  }, 60_000);

  test('COCKPIT-89 AC3, AC4 — going to another page and back during the hold shows the loading page again; the user clicking elsewhere when the hold is released stays on the page they went to, with no entry added to the history, and the session runs and is stored; back on the workspace after the release its tab shows', async () => {
    const { page } = session;
    const prompt = 'Go elsewhere';
    const path = worktreeOf(clone, 'go-elsewhere');
    const startsBefore = startsOf(fx, 'claude').length;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill(prompt);
    const held = await holdGit(fx, 'git');
    let settled!: () => Promise<void>;
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();

      await goHome(page);
      await entryOf(page, path).click();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();

      await goHome(page);
      await recordLocations(page);
      settled = await watchSettled(page);
    } finally {
      await held.release();
    }
    await settled();
    await afterIpcAnswers(page);

    expect(await page.evaluate(() => location.pathname + location.search), 'the page the user went to stays').toBe('/');
    expect(await locationsSeen(page), 'no entry was added to the history').toEqual([]);
    expect(sessionsInState(dataDir).find((each) => each.directory === path), 'the session is stored').toMatchObject({ harness: 'claude-code', project: clone.root });

    await entryOf(page, path).click();
    await waitForWorkspacePage(page, path);
    await waitForSelectedTab(page);
    expect((await tabs(page)).selected[0]).toMatch(/Claude Code/);
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect(startsOf(fx, 'claude').slice(startsBefore)).toEqual([{ cwd: path, args: [prompt] }]);
  }, 60_000);

  test('COCKPIT-89 AC5 — a reload during the hold shows the loading page again; once released the workspace shows with one tab, and there is one worktree and one stored session, whose agent got the prompt', async () => {
    const { page } = session;
    const prompt = 'Reload during setup';
    const path = worktreeOf(clone, 'reload-during-setup');
    const startsBefore = startsOf(fx, 'claude').length;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill(prompt);
    const held = await holdGit(fx, 'git');
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();

      await page.reload();
      await loadingText(page).waitFor();
      expect(existsSync(path), 'the worktree does not exist yet').toBe(false);
    } finally {
      await held.release();
    }

    await waitForSelectedTab(page);
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect((await tabs(page)).labels).toHaveLength(1);
    expect(worktreeCount(path)).toBe(1);
    expect(sessionsInState(dataDir).filter((each) => each.directory === path)).toHaveLength(1);
    expect(startsOf(fx, 'claude').slice(startsBefore)).toEqual([{ cwd: path, args: [prompt] }]);
  }, 60_000);

  test('COCKPIT-89 AC6 — a refused creation while the user is on the loading page removes the row and shows the refusal in the page only, with its reason and "Back to composer" (kept by a reload); the button opens the composer with the send\'s text, project, agent and base and no refusal, and a new send works', async () => {
    const { page } = session;
    const branch = 'cannot-be-created';
    const path = worktreeOf(refuse, branch);
    const before = { branches: localBranches(refuse), sessions: sessionsInState(dataDir).length };

    await openComposer(page, refuse.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'main');
    await pickAgent(page, 'Terminal');
    await chooseBase(page, 'side');
    await promptBox(page).fill('Cannot be created');
    const held = await holdGit(fx, 'git');
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();
      // The base is gone when git runs: the creation is refused, naming it.
      git(refuse.root, 'branch', '-D', 'side');
    } finally {
      await held.release();
    }
    try {
      await backToComposer(page, 'main').waitFor();
    } finally {
      git(refuse.root, 'branch', '-f', 'side', 'main');
    }

    await entryOf(page, path).waitFor({ state: 'detached' });
    expect(await loadingText(page).count()).toBe(0);
    const reason = await refusalOf(page, path);
    expect(reason, 'the reason names the base git could not find').toMatch(/\bside\b/);
    expect(await mainText(page), 'the page shows the reason itself').toContain(norm(reason));
    expect(await backToComposer(page, 'aside').count(), 'not under Projects').toBe(0);
    expect(await projectsMessage(page).count(), 'nothing under Projects').toBe(0);
    expect(localBranches(refuse)).toEqual(before.branches);
    expect(sessionsInState(dataDir)).toHaveLength(before.sessions);
    expect(existsSync(path)).toBe(false);

    await page.reload();
    await backToComposer(page, 'main').waitFor();
    expect(new URL(page.url()).pathname).toBe('/workspace');
    expect(await mainText(page)).toContain(norm(reason));
    expect(await backToComposer(page, 'aside').count()).toBe(0);

    await backToComposer(page, 'main').click();
    await promptBox(page).waitFor();
    expect(await promptBox(page).inputValue()).toBe('Cannot be created');
    expect(await textOf(projectSelect(page))).toContain(refuse.name);
    expect(await textOf(agentSelect(page))).toBe('Terminal');
    await waitForBase(page, 'side');
    expect(await messageOf(page)).toBe('');
    expect(await backToComposer(page, 'main').count() + (await backToComposer(page, 'aside').count()), 'no refusal is left').toBe(0);

    await createButton(page).click();
    await waitForWorkspacePage(page, path);
    await waitForSelectedTab(page);
    expect(localBranches(refuse)).toContain(branch);
    expect(existsSync(path)).toBe(true);
  }, 60_000);

  test('COCKPIT-89 AC7 — a refused creation after the user left the page removes the row and shows the refusal under Projects with its reason and "Back to composer", kept by a reload until clicked; the button opens the composer as in AC6 and removes the refusal', async () => {
    const { page } = session;
    const branch = 'refused-later';
    const path = worktreeOf(refuse, branch);
    // The page the user goes to: a workspace of the same project made with git itself (listed once the page loads).
    const other = worktreeOf(refuse, 'elsewhere');
    mkdirSync(worktreesDirOf(refuse), { recursive: true });
    git(refuse.root, 'worktree', 'add', '--quiet', '-b', 'elsewhere', other, 'main');
    const before = { branches: localBranches(refuse), sessions: sessionsInState(dataDir).length };

    await openComposer(page, refuse.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'main');
    await chooseBase(page, 'side');
    await promptBox(page).fill('Refused later');
    const held = await holdGit(fx, 'git');
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();

      await entryOf(page, other).click();
      await waitForWorkspacePage(page, other);
      await page.getByRole('button', { name: 'New tab', exact: true }).first().waitFor();
      // The base is gone when git runs: the creation is refused, naming it.
      git(refuse.root, 'branch', '-D', 'side');
    } finally {
      await held.release();
    }
    try {
      await backToComposer(page, 'aside').waitFor();
    } finally {
      git(refuse.root, 'branch', '-f', 'side', 'main');
    }

    await entryOf(page, path).waitFor({ state: 'detached' });
    expect(new URL(page.url()).searchParams.get('path'), 'the user stays where they went').toBe(other);
    expect(await backToComposer(page, 'main').count()).toBe(0);
    const reason = await refusalOf(page, path);
    expect(reason, 'the reason names the base git could not find').toMatch(/\bside\b/);
    // Under Projects the refusal names the workspace, then says why, above its button.
    expect(norm(await backToComposer(page, 'aside').locator('xpath=..').innerText())).toBe(`Could not create ${branch}: ${norm(reason)} Back to composer`);
    expect(localBranches(refuse)).toEqual(before.branches);
    expect(sessionsInState(dataDir)).toHaveLength(before.sessions);

    await page.reload();
    await backToComposer(page, 'aside').waitFor();

    await backToComposer(page, 'aside').click();
    await promptBox(page).waitFor();
    expect(await promptBox(page).inputValue()).toBe('Refused later');
    expect(await textOf(projectSelect(page))).toContain(refuse.name);
    expect(await textOf(agentSelect(page))).toBe('Claude Code');
    await waitForBase(page, 'side');
    expect(await messageOf(page)).toBe('');
    await backToComposer(page, 'aside').waitFor({ state: 'detached' });
  }, 60_000);

  test('COCKPIT-89 AC8 — a worktree created while its agent cannot start keeps the workspace in the sidebar without "Setting up", its page shows its panes, "Could not start Claude Code: …" shows under Projects, and an agent started from the New tab menu works in that workspace', async () => {
    const { page } = session;
    const path = worktreeOf(refuse, 'start-fails');
    await openComposer(page, refuse.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'main');
    // Removed after it was detected: the start finds it gone.
    removeStub(fx, 'claude');
    try {
      await promptBox(page).fill('Start fails');
      await createButton(page).click();

      await waitForWorkspacePage(page, path);
      await projectsMessage(page).filter({ hasText: /^\s*Could not start Claude Code: / }).first().waitFor();
    } finally {
      installStub(fx, 'claude');
    }
    expect(existsSync(path)).toBe(true);
    expect(localBranches(refuse)).toContain('start-fails');
    await entryOf(page, path).waitFor();
    await waitForSetupLabel(page, path, null);
    expect(await loadingText(page).count()).toBe(0);
    await page.getByRole('button', { name: 'New tab', exact: true }).first().waitFor();
    expect(new URL(page.url()).searchParams.get('path')).toBe(path);

    const startsBefore = startsOf(fx, 'claude').length;
    await page.getByRole('button', { name: 'New tab', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'Claude Code', exact: true }).click();
    await waitForSelectedTab(page);
    expect((await tabs(page)).selected[0]).toMatch(/Claude Code/);
    await waitForRow(page, 'ready');
    expect(startsOf(fx, 'claude').slice(startsBefore).map((start) => start.cwd)).toEqual([path]);
  }, 60_000);

  test('COCKPIT-89 AC10 — a worktrees folder that cannot be created refuses the send before any workspace is reserved: the composer stays with its message, text and selections and no row ever appears', async () => {
    const { page } = session;
    const root = join(home, 'worktrees');
    const aside = `${root}.aside`;
    const path = worktreeOf(clone, 'no-root');
    mkdirSync(root, { recursive: true });
    renameSync(root, aside);
    writeFileSync(root, 'not a folder');
    try {
      await openComposer(page, clone.root);
      await waitForAgent(page, 'Claude Code');
      await pickAgent(page, 'Terminal');
      await waitForBase(page, 'origin/main');
      await chooseBase(page, 'origin/develop');
      await promptBox(page).fill('no root');
      // Any row titled with the new path, however briefly, is recorded.
      await page.evaluate((title) => {
        const win = window as unknown as { __rowSeen?: boolean };
        win.__rowSeen = false;
        new MutationObserver(() => {
          if (document.querySelector(`aside [title="${title}"]`)) win.__rowSeen = true;
        }).observe(document, { subtree: true, childList: true, attributes: true });
      }, path);
      await createButton(page).click();

      expect(await waitForMessage(page)).toMatch(/^Cockpit could not create its worktrees folder .*: EEXIST\.$/);
      await createButton(page).and(page.locator('button:enabled')).waitFor();
      expect(new URL(page.url()).pathname).toBe('/');
      expect(await promptBox(page).inputValue()).toBe('no root');
      expect(await textOf(projectSelect(page))).toContain(clone.name);
      expect(await textOf(agentSelect(page))).toBe('Terminal');
      expect(await textOf(baseSelect(page))).toBe('origin/develop');
      expect(await page.evaluate(() => (window as unknown as { __rowSeen: boolean }).__rowSeen), 'no row appeared').toBe(false);
      expect(await entryOf(page, path).count()).toBe(0);
      expect(localBranches(clone)).not.toContain('no-root');
    } finally {
      rmSync(root, { force: true });
      renameSync(aside, root);
    }
  }, 60_000);

  // The terminals the app lists whose folder is `path`, a shell started in the workspace or a session in it.
  const terminalsIn = (page: Page, path: string) =>
    page.evaluate(
      async (path) =>
        (await (window as unknown as PtyWindow).api.pty.list()).filter((terminal) => {
          const listed = terminal as { cwd?: string; workspace?: string };
          return listed.cwd === path || listed.workspace === path;
        }).length,
      path,
    );

  test('COCKPIT-89 — removing the project while its "Terminal" workspace is setting up starts no terminal in that workspace once the creation ends, also after a reload', async () => {
    const { page } = session;
    const path = worktreeOf(doomed, 'remove-during-setup');
    await openComposer(page, doomed.root);
    await waitForAgent(page, 'Claude Code');
    await pickAgent(page, 'Terminal');
    await waitForBase(page, 'main');
    await promptBox(page).fill('Remove during setup');
    const held = await holdGit(fx, 'git');
    const ended = await held.watchEnd();
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();
      await removeThroughMenu(page, doomed.root);
    } finally {
      await held.release();
    }
    await ended();

    // Another send, begun after the creation ended, comes through the same steps and ends with a terminal on the
    // page: whatever the first one was going to do after its creation has been done or dropped by then.
    await sendFromComposer(page, refuse, { prompt: 'After the removal' });
    expect(await terminalsIn(page, path), 'no terminal runs in the removed project\'s workspace').toBe(0);
    await page.reload();
    await page.getByText(versionLabel).waitFor();
    expect(await terminalsIn(page, path), 'none after a reload either').toBe(0);
  }, 60_000);

  test('COCKPIT-89 AC10 — a reservation refused after the user left the composer (the worktrees folder cannot be created, the branch listing still held) shows its message under Projects and leaves the page they went to alone', async () => {
    const { page } = session;
    const root = join(home, 'worktrees');
    const aside = `${root}.aside`;
    mkdirSync(root, { recursive: true });
    renameSync(root, aside);
    writeFileSync(root, 'not a folder');
    try {
      await openComposer(page, clone.root);
      await waitForAgent(page, 'Claude Code');
      await pickAgent(page, 'Terminal');
      await waitForBase(page, 'origin/main');
      await promptBox(page).fill('Reservation refused later');
      const held = await holdGit(fx, 'read');
      try {
        await createButton(page).click();
        await held.reached();
        await recordLocations(page);
        await goHome(page);
      } finally {
        await held.release();
      }
      const message = projectsMessage(page).filter({ hasText: /^\s*Cockpit could not create its worktrees folder .*: EEXIST\.\s*$/ });
      await message.first().waitFor();
      await afterIpcAnswers(page);
      expect(new URL(page.url()).pathname, 'the page the user went to stays').toBe('/');
      expect((await locationsSeen(page)).filter((href) => href.startsWith('/workspace'))).toEqual([]);
      expect(await messageOf(page), 'nothing in the composer they went to').toBe('');
      expect(await entryOf(page, worktreeOf(clone, 'reservation-refused-later')).count()).toBe(0);
    } finally {
      rmSync(root, { force: true });
      renameSync(aside, root);
    }
  }, 60_000);

  // --- A send with no project whose start has not answered (COCKPIT-89 AC12) -------------------------

  // The daemon is stopped, so the start the send asked for has not answered (COCKPIT-86's technique); `during` runs
  // with it pending, then the daemon resumes and the start answers. With `refused` the save of the session fails
  // once the agent is spawned (a folder where the state's temporary file goes, as the sessions tests do): the start
  // is refused only when it answers.
  async function stalledStart(prompt: string, during: () => Promise<void>, { refused = false } = {}) {
    const { page } = session;
    const blocker = join(dataDir, 'state.json.tmp');
    const starts = await watchStarts(session);
    await openComposerFromSidebar(page, 'none');
    await useAgent(page, 'Claude Code');
    await promptBox(page).fill(prompt);
    const daemon = daemonPidIn(session.cockpitHome);
    if (refused) mkdirSync(blocker);
    process.kill(daemon, 'SIGSTOP');
    try {
      try {
        await createButton(page).click();
        await during();
      } finally {
        process.kill(daemon, 'SIGCONT');
      }
      await ipcAnswered(session, 'sessions:start', starts + 1);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  }
  const hereNow = (page: Page) => page.evaluate(() => location.pathname + location.search);

  test('COCKPIT-89 AC12 — a send with no project refused after the daemon resumes, the user still on the composer: today\'s behaviour, the message shows in the composer', async () => {
    const { page } = session;
    await stalledStart('Stay here', async () => {}, { refused: true });
    expect(await waitForMessage(page)).toMatch(/^Could not start Claude Code: /);
    expect(await hereNow(page)).toBe('/?project=none');
    expect(await promptBox(page).inputValue()).toBe('Stay here');
  }, 60_000);

  test('COCKPIT-89 AC12 — a send with no project refused after the user left shows the refusal under Projects and leaves the page they went to alone', async () => {
    const { page } = session;
    const known = new Set((await storedSessions(page)).map((each) => each.id));
    await stalledStart(
      'Refused after leaving',
      async () => {
        await recordLocations(page);
        await goHome(page);
      },
      { refused: true },
    );
    await projectsMessage(page).filter({ hasText: /^\s*Could not start Claude Code: / }).first().waitFor();
    await afterIpcAnswers(page);
    expect(await hereNow(page)).toBe('/');
    expect((await locationsSeen(page)).filter((href) => href.startsWith('/sessions'))).toEqual([]);
    expect(await messageOf(page)).toBe('');
    expect((await storedSessions(page)).map((each) => each.id).sort()).toEqual([...known].sort());
  }, 60_000);

  test('COCKPIT-89 AC12 — a send with no project whose start answers after the user left keeps the page they went to, and the session is stored', async () => {
    const { page } = session;
    const known = new Set((await storedSessions(page)).map((each) => each.id));
    await stalledStart('Answered after leaving', async () => {
      await recordLocations(page);
      await goHome(page);
    });
    const stored = (await storedSessions(page)).find((each) => !known.has(each.id));
    expect(stored, 'the session is stored').toBeTruthy();
    expect(stored!.project).toBeUndefined();
    await page.locator(`aside a[href$="/sessions/${stored!.id}"]`).first().waitFor();
    await afterIpcAnswers(page);
    expect(await hereNow(page), 'the page the user went to stays').toBe('/');
    expect((await locationsSeen(page)).filter((href) => href.startsWith('/sessions')), 'the page never went to the session').toEqual([]);
  }, 60_000);
});
