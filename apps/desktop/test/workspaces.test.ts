import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { baseSelect, chooseBase, createButton, openComposer, projectSelect, promptBox, sendFromComposer, textOf, useAgent, waitForBase, waitForMessage } from './composer';
import { launchBuilt, type Session, untilRead, versionLabel } from './launch';
import { addProject, addRepository, afterIpcAnswers, branchBox, countIpcCalls, deleteButton, deleteDialog, dismissDialogs, dispatchFocus, entryTitles, errorMark, expectNoNewErrors, gitIn, gitState, INVOKE_HANDLERS, ipcCalls, isBelowProjectsHeader, linesOf, linkedWorktrees, localBranches, makeClone, makeLightRepo, missingFolderBlock, mutedColor, openDeleteDialog, openDialogs, openMenu, projectsInState, readBaseOptions, readSidebarLines, removeOptions, removeProjectDialog, removeThroughMenu, sha8, sidebarEntries, sidebarLines, stateSnapshot, stubPicker, type TempClone, type TempRepo, tokenColor, untilAnswered, untilFewerOverlays, waitForDialogLine, waitForEntries, waitForEntry, waitForLine, waitForNoEntry, worktreePath } from './support/projects';
import { expectNoErrors, workspacesApi } from './support/sessions';
import { dropTerminalWorkspace, goHome, type PtyWindow, watchFrontmost } from './support/terminal';

describe('built app', () => {
  let session: Session;
  let front: Awaited<ReturnType<typeof watchFrontmost>>;

  beforeAll(async () => {
    front = await watchFrontmost();
    session = await launchBuilt();
    await session.page.getByText(versionLabel).waitFor();
  });

  // What `logs no error and keeps running` checks on the modes' own launch, for this file's.
  afterAll(async () => {
    try {
      await expectNoErrors(session);
      expect(await front.activated(session.pid)).toBe(false);
    } finally {
      await front?.stop();
      await session?.close();
    }
    if (session) expect(existsSync(session.dataDir)).toBe(false);
  });

  // The repository `openTerminal` made goes after each test, so the tests that follow list only their own projects.
  afterEach(async () => {
    if (session) await dropTerminalWorkspace(session);
  });

  // Workspaces: the picker is stubbed as in `projects`, and the tests share the
  // session and run in order. `ws-clone` stays in the list from the first test
  // to the "delete" tests, and the workspaces `feature/login` and
  // `second-by-enter`, created by the AC5 test, are the ones the delete tests
  // delete. Worktrees the app creates land under the launch's COCKPIT_HOME.
  describe('workspaces', () => {
    let clone: TempClone;
    const folders: TempRepo[] = [];
    const loginBranch = 'feature-login';
    const enterBranch = 'second-by-enter';

    beforeAll(() => {
      clone = makeClone('ws-clone');
      folders.push(clone, clone.upstream);
    });

    // A failing test must not leave a menu or a dialog that blocks the tests after it.
    // Escape only while something is open (at most 4 times), and wait for it to close.
    afterEach(async () => {
      const { page } = session;
      const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
      for (let attempt = 0; attempt < 4; attempt++) {
        const open = await overlays.count();
        if (open === 0) break;
        await page.keyboard.press('Escape');
        await untilFewerOverlays(page, open);
      }
    });

    afterAll(async () => {
      try {
        await clearProjects();
      } finally {
        for (const folder of folders) rmSync(folder.parent, { recursive: true, force: true });
      }
    });

    const projectWorktrees = (repo: TempRepo) => dirname(worktreePath(session, repo, 'x'));
    // Everything under the worktrees folder of `repo`, so "nothing was created" is checkable.
    const worktreeListing = (repo: TempRepo) => {
      const dir = projectWorktrees(repo);
      return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];
    };
    const isListed = async (path: string) => (await entryTitles(session.page)).includes(path);
    const waitListed = (path: string) => waitForEntry(session.page, path);
    const waitUnlisted = (path: string) => waitForNoEntry(session.page, path);

    test('AC1, COCKPIT-66 AC3, COCKPIT-68 AC3 — the project menu holds "New workspace" above "Remove project…", and "New workspace" goes to the composer for that project, with no dialog', async () => {
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      await addRepository(session, clone);

      await openMenu(page, clone.root);
      const items = await page.getByRole('menuitem').allInnerTexts();
      expect(items.map((item) => item.trim())).toEqual(['New workspace', 'Remove project…']);
      await page.getByRole('menuitem', { name: 'New workspace', exact: true }).click();

      await page.waitForURL((url) => url.searchParams.get('project') === clone.root);
      expect(await textOf(projectSelect(page))).toContain(clone.name);
      expect(await openDialogs(page).count()).toBe(0);
    });

    test('AC2 — the base select lists local branches under "Local" and origin/* branches under "Remote" (no origin/HEAD), preselects origin/main and runs no fetch', async () => {
      const { page } = session;
      // A commit only a fetch would bring in.
      gitIn(clone.upstream.root, 'commit', '--allow-empty', '-m', 'newer on origin');
      const originMain = gitIn(clone.root, 'rev-parse', 'refs/remotes/origin/main');
      const fetchHead = join(clone.root, '.git', 'FETCH_HEAD');
      const fetchHeadBefore = existsSync(fetchHead);

      await openComposer(page, clone.root);
      await waitForBase(page, 'origin/main');
      const groups = await readBaseOptions(page);

      expect(Object.keys(groups)).toEqual(['Local', 'Remote']);
      expect([...groups.Local!].sort()).toEqual(['local-topic', 'main', 'topic/nested']);
      expect([...groups.Remote!].sort()).toEqual(['origin/develop', 'origin/feature/x', 'origin/main', 'origin/release/1.0']);
      expect(await textOf(baseSelect(page))).toBe('origin/main');
      expect(gitIn(clone.root, 'rev-parse', 'refs/remotes/origin/main')).toBe(originMain);
      expect(existsSync(fetchHead)).toBe(fetchHeadBefore);
    });

    test('AC5 — sending the composer creates the branch (the prompt\'s slug) from origin/main and the worktree under $COCKPIT_HOME, lists the workspace and opens its workspace page; Enter does the same', async () => {
      const { page } = session;
      const originMain = gitIn(clone.root, 'rev-parse', 'origin/main');
      expect(gitIn(clone.root, 'rev-parse', 'main'), 'local main differs from origin/main').not.toBe(originMain);
      // The launch's COCKPIT_HOME is inside its temporary folder.
      expect(await session.evaluateInMain<string>('process.env.COCKPIT_HOME')).toBe(session.cockpitHome);
      expect(session.cockpitHome.startsWith(`${session.dataDir}/`)).toBe(true);

      await sendFromComposer(page, clone, { prompt: '  Feature login  ' });

      const path = worktreePath(session, clone, loginBranch);
      expect(existsSync(join(path, 'README.md'))).toBe(true);
      expect(linkedWorktrees(clone)).toContainEqual({ path, branch: loginBranch });
      expect(gitIn(clone.root, 'rev-parse', loginBranch)).toBe(originMain);
      expect(localBranches(clone)).toContain(loginBranch);
      expect(existsSync(join(homedir(), '.cockpit', 'worktrees', `${clone.name}-${sha8(clone.root)}`))).toBe(false);
      await waitListed(path);
      const row = (await sidebarEntries(page)).find((entry) => entry.title === path);
      expect(row!.text).toContain(loginBranch);
      expect(await isBelowProjectsHeader(page, { title: path })).toBe(true);

      // Enter in the prompt does the same.
      await sendFromComposer(page, clone, { prompt: 'Second by enter', enter: true });

      const secondPath = worktreePath(session, clone, enterBranch);
      expect(existsSync(join(secondPath, 'README.md'))).toBe(true);
      expect(linkedWorktrees(clone)).toContainEqual({ path: secondPath, branch: enterBranch });
      expect(gitIn(clone.root, 'rev-parse', enterBranch)).toBe(originMain);
      await waitListed(secondPath);
      // Under their project, in `git worktree list` order.
      expect(linkedWorktrees(clone).map((worktree) => worktree.path).sort()).toEqual([path, secondPath].sort());
      await waitForEntries(page, [clone.root, ...linkedWorktrees(clone).map((worktree) => worktree.path)]);
    });

    test('AC8, COCKPIT-89 AC6 — a base deleted after the composer opened is refused on the workspace page ("Back to composer", the message naming the base), the row is gone and nothing is created', async () => {
      const { page } = session;
      const develop = gitIn(clone.root, 'rev-parse', 'refs/remotes/origin/develop');
      const before = { git: gitState(clone), listing: worktreeListing(clone) };

      await openComposer(page, clone.root);
      await useAgent(page, 'Terminal');
      await chooseBase(page, 'origin/develop');
      await promptBox(page).fill('orphan base');
      gitIn(clone.root, 'update-ref', '-d', 'refs/remotes/origin/develop');
      try {
        await createButton(page).click();
        // The page of the workspace opens first, then the refusal replaces its loading text.
        const back = page.locator('main').getByRole('button', { name: 'Back to composer', exact: true });
        await back.waitFor();
        // A message that names the base git could not find.
        expect(await page.locator('main').innerText()).toContain('origin/develop');

        expect(new URL(page.url()).pathname).toBe('/workspace');
        expect(await entryTitles(page)).not.toContain(worktreePath(session, clone, 'orphan-base'));
        expect(localBranches(clone)).not.toContain('orphan-base');
        expect(worktreeListing(clone)).toEqual(before.listing);
      } finally {
        gitIn(clone.root, 'update-ref', 'refs/remotes/origin/develop', develop);
      }
      expect(gitState(clone)).toEqual(before.git);
    });

    // COCKPIT-42: the composer words a worktrees folder that cannot be created.
    // `git worktree list --porcelain` marks the worktrees under a folder that is moved aside as `prunable`:
    // those lines only reflect that folder, every other line of the git state is compared.
    const gitStateWithoutPrunable = (repo: TempRepo) => {
      const state = gitState(repo);
      return { ...state, worktrees: state.worktrees.split('\n').filter((line) => !line.startsWith('prunable ')).join('\n') };
    };

    test('workspaces COCKPIT-42 AC3 — a worktrees folder that is a regular file keeps the composer open with "Cockpit could not create its worktrees folder <root>: EEXIST.", lists no workspace, leaves state.json as it was and logs no error', async () => {
      const { page } = session;
      const root = join(session.cockpitHome, 'worktrees');
      const aside = `${root}.aside`;
      const titlesBefore = await entryTitles(page);
      const git = gitStateWithoutPrunable(clone);
      const state = stateSnapshot(session.dataDir);
      const mark = await errorMark(session);
      expect(existsSync(root), 'earlier tests created workspaces under the root').toBe(true);

      renameSync(root, aside);
      writeFileSync(root, 'not a folder');
      try {
        await openComposer(page, clone.root);
        await useAgent(page, 'Terminal');
        await waitForBase(page, 'origin/main');
        await promptBox(page).fill('no root');
        await createButton(page).click();
        // The fresh composer shows no message before this one.
        const message = await waitForMessage(page);
        // The request is settled once "Create workspace" is enabled again.
        await createButton(page).and(page.locator('button:enabled')).waitFor();

        expect(message).toBe(`Cockpit could not create its worktrees folder ${root}: EEXIST.`);
        expect(new URL(page.url()).pathname).toBe('/');
        expect(await entryTitles(page)).toEqual(titlesBefore);
        expect(gitStateWithoutPrunable(clone)).toEqual(git);
        expect(localBranches(clone)).not.toContain('no-root');
        expect(stateSnapshot(session.dataDir)).toEqual(state);
        await expectNoNewErrors(session, mark);
      } finally {
        rmSync(root, { force: true });
        renameSync(aside, root);
      }
    });

    test('workspaces COCKPIT-42 AC7 — branches, create and remove refuse a project that is not in Cockpit with "<path> is not a project in Cockpit.", creating and changing nothing', async () => {
      const { page } = session;
      const root = join(session.cockpitHome, 'worktrees');
      const listing = () => (existsSync(root) ? readdirSync(root, { recursive: true }).map(String).sort() : []);
      const before = { listing: listing(), git: gitState(clone), state: stateSnapshot(session.dataDir), titles: await entryTitles(page) };
      const project = '/no/such/project';
      const refusal = { status: 'refused', message: `${project} is not a project in Cockpit.` };

      expect(await workspacesApi(page, 'branches', [project])).toEqual(refusal);
      expect(await workspacesApi(page, 'create', [project, 'orphan', 'main'])).toEqual(refusal);
      expect(await workspacesApi(page, 'remove', [project, join(project, 'ws')])).toEqual(refusal);

      expect(listing()).toEqual(before.listing);
      expect(existsSync(join(root, basename(project)))).toBe(false);
      expect(gitState(clone)).toEqual(before.git);
      expect(stateSnapshot(session.dataDir)).toEqual(before.state);
      expect(await entryTitles(page)).toEqual(before.titles);
    });

    test('workspaces COCKPIT-42 AC8 — the handlers of branches, create, remove, changes, diff, watch and teardown reject a sender frame from another origin', async () => {
      const path = worktreePath(session, clone, loginBranch);
      const file = { path: 'README.md', status: 'modified', additions: 0, deletions: 0 };
      const origins = await session.evaluateInMain<Record<string, string>>(`(async () => {
        const handlers = ${INVOKE_HANDLERS};
        const calls = {
          'workspaces:branches': [${JSON.stringify(clone.root)}],
          'workspaces:create': [${JSON.stringify(clone.root)}, 'from-elsewhere', 'main'],
          'workspaces:remove': [${JSON.stringify(clone.root)}, ${JSON.stringify(path)}],
          'workspaces:changes': [${JSON.stringify(clone.root)}, ${JSON.stringify(path)}],
          'workspaces:diff': [${JSON.stringify(clone.root)}, ${JSON.stringify(path)}, ${JSON.stringify(file)}],
          'workspaces:watch': [${JSON.stringify(clone.root)}, ${JSON.stringify(path)}],
          'workspaces:teardown': [${JSON.stringify(clone.root)}, ${JSON.stringify(path)}, { cols: 80, rows: 24 }],
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

      expect(origins).toEqual({
        'workspaces:branches': 'rejected',
        'workspaces:create': 'rejected',
        'workspaces:remove': 'rejected',
        'workspaces:changes': 'rejected',
        'workspaces:diff': 'rejected',
        'workspaces:watch': 'rejected',
        'workspaces:teardown': 'rejected',
      });
      expect(localBranches(clone)).not.toContain('from-elsewhere');
      expect(existsSync(path)).toBe(true);
    });

    test('COCKPIT-89 AC13 — the handlers of compose, the failed setups and their dismissal reject a sender frame from another origin and create nothing', async () => {
      const { page } = session;
      const path = worktreePath(session, clone, 'from-elsewhere');
      const before = { git: gitState(clone), listing: worktreeListing(clone), titles: await entryTitles(page) };
      // The compose handler is `workspaces:compose`; the other two new ones are found by their channels
      // (`workspaces:<...>setup<...>`), whatever the spelling.
      const results = await session.evaluateInMain<Record<string, string>>(`(async () => {
        const handlers = ${INVOKE_HANDLERS};
        const channels = ['workspaces:compose', ...[...handlers.keys()].filter((channel) => /^workspaces:.*setup/.test(channel))];
        const results = {};
        for (const channel of channels) {
          const handler = handlers.get(channel);
          if (!handler) { results[channel] = 'no handler'; continue; }
          try {
            await handler({ senderFrame: { url: 'https://example.com/' }, sender: null }, ${JSON.stringify(clone.root)}, 'from elsewhere', 'main', ${JSON.stringify(path)}, { harness: 'terminal', size: { cols: 80, rows: 24 } });
            results[channel] = 'resolved';
          } catch {
            results[channel] = 'rejected';
          }
        }
        return results;
      })()`);

      expect(Object.keys(results), 'compose, the failed setups and the dismissal').toHaveLength(3);
      expect(results['workspaces:compose']).toBe('rejected');
      expect(Object.values(results)).toEqual(['rejected', 'rejected', 'rejected']);
      expect(localBranches(clone)).not.toContain('from-elsewhere');
      expect(existsSync(path)).toBe(false);
      expect(worktreeListing(clone)).toEqual(before.listing);
      expect(gitState(clone)).toEqual(before.git);
      expect(await entryTitles(page)).toEqual(before.titles);
    });

    // The FSEvents watchers the main process holds.
    const fsEventWatchers = () => session.evaluateInMain<number>("process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length");

    test('workspaces COCKPIT-42 AC14 — a same-origin navigation that fails to load (an error page) closes the watchers of the workspace the window was watching', async () => {
      const { page } = session;
      const path = worktreePath(session, clone, loginBranch);
      const appUrl = await page.evaluate(() => location.href);
      const before = await fsEventWatchers();

      try {
        await page.evaluate(
          ([project, workspace]) =>
            (window as unknown as { api: { workspaces: { watch(project: string, path: string, listener: () => void): Promise<() => void> } } }).api.workspaces
              .watch(project!, workspace!, () => {})
              .then(() => undefined),
          [clone.root, path] as const,
        );
        expect(await fsEventWatchers(), 'the watch holds FSEvents watchers').toBeGreaterThan(before);

        // The main process tells when the main frame failed to load: the app's own listener, added when the
        // window was created, has run by then. The promise settles on a later turn of the event loop, so the
        // closed handles are gone when the count is read.
        await session.evaluateInMain(`(() => {
          const contents = require('electron').webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith('app://'));
          globalThis.__mainFrameFailed = new Promise((resolve) => {
            const onFail = (_event, errorCode, _description, _url, isMainFrame) => {
              if (!isMainFrame || errorCode === -3) return;
              contents.removeListener('did-fail-load', onFail);
              setImmediate(resolve);
            };
            contents.on('did-fail-load', onFail);
          });
        })()`);
        // `did-fail-load` fires before Chromium commits its error page (`chrome-error://chromewebdata/`), and
        // a `goto` started in between is interrupted by that commit: the page's own navigation event tells
        // when the error page is there.
        const errorPage = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame() && frame.url() === 'chrome-error://chromewebdata/');
        await page
          .evaluate(() => {
            location.href = new URL('/%', location.href).href;
          })
          .catch(() => {});
        await session.evaluateInMain('globalThis.__mainFrameFailed');
        await errorPage;

        expect(await fsEventWatchers()).toBe(before);
      } finally {
        // Load the app page again, so the pending navigation is gone and the next test can click.
        await page.goto(appUrl);
        await page.getByText(versionLabel).waitFor();
      }
    });

    // A workspace added with git itself (on a new branch from origin/main), listed after a reload.
    async function addExternalWorkspace(name: string): Promise<string> {
      const path = join(clone.parent, `wt-${name}`);
      gitIn(clone.root, 'worktree', 'add', '--quiet', '-b', name, path, 'origin/main');
      await session.page.reload();
      await session.page.getByText(versionLabel).waitFor();
      await waitListed(path);
      return path;
    }

    // Leaves the session with no project.
    async function clearProjects() {
      const { page } = session;
      await page.evaluate(async () => {
        const { projects } = (globalThis as unknown as { api: { projects: { list(): Promise<{ path: string }[]>; remove(path: string): Promise<void> } } }).api;
        for (const project of await projects.list()) await projects.remove(project.path);
      });
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitForEntries(page, []);
    }

    // The dialog's lines, and what it says of the workspace it read.
    const WARNING = 'It has uncommitted changes. They will be lost.';
    const HINT = 'Not merged: its commits will be lost.';
    const KEPT = (branch: string) => `Branch ${branch} was kept: it is not merged.`;
    const keptLines = async () => (await sidebarLines(session.page)).filter((line) => line.startsWith('Branch '));

    test('COCKPIT-68 AC14 — the workspace menu holds "Delete workspace…", which opens "Delete <name>?" with the folder; Cancel and Escape change nothing and send no removal', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('review-ws');
      const before = { git: gitState(clone), listing: worktreeListing(clone) };
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = await ipcCalls(session, 'workspaces:remove');

      await openMenu(page, path);
      const items = await page.getByRole('menuitem').allInnerTexts();
      expect(items.map((item) => item.trim())).toContain('Delete workspace…');
      await page.keyboard.press('Escape');
      await page.getByRole('menuitem').first().waitFor({ state: 'hidden' });

      for (const dismiss of ['Cancel', 'Escape'] as const) {
        const dialog = await openDeleteDialog(page, path, 'review-ws');
        expect(await dialog.innerText()).toContain(path);
        expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(1);
        expect(await deleteButton(dialog).count()).toBe(1);

        if (dismiss === 'Cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        else await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        // Nothing was asked of the main process: no removal reached it by the time its later answers came.
        await afterIpcAnswers(page);
        expect(await ipcCalls(session, 'workspaces:remove')).toBe(removesBefore);

        expect(existsSync(join(path, 'README.md'))).toBe(true);
        expect(gitState(clone)).toEqual(before.git);
        expect(worktreeListing(clone)).toEqual(before.listing);
        expect(await isListed(path)).toBe(true);
      }
    });

    test('COCKPIT-68 AC8 — a clean workspace on a merged branch: the dialog says what is deleted with the folder in a box, the branch box is checked, no warning and no hint; Delete removes the worktree and the branch and shows no "was kept" line', async () => {
      const { page } = session;
      const path = worktreePath(session, clone, loginBranch);
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = (await removeOptions(session)).length;

      const dialog = await openDeleteDialog(page, path, loginBranch);
      const text = await dialog.innerText();
      expect(text).toContain("This deletes the worktree, the workspace's folder on this Mac, and ends its running sessions.");
      expect(await dialog.getByText(path, { exact: true }).count(), 'the path in a box of its own').toBe(1);
      expect(await branchBox(dialog, loginBranch).count()).toBe(1);
      expect(await branchBox(dialog, loginBranch).isChecked()).toBe(true);
      expect(text).not.toContain('uncommitted');
      expect(text).not.toContain('Not merged');

      await deleteButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(clone)).not.toContain(loginBranch);
      expect(await keptLines()).toEqual([]);
      // Nothing is forced that the dialog did not show.
      const sent = (await removeOptions(session)).slice(removesBefore);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.deleteBranch).toBe(true);
      expect(sent[0]!.force ?? false).toBe(false);
      expect(sent[0]!.forceBranch, 'no branch is forced').toBeUndefined();
    });

    test('COCKPIT-68 AC9 — a workspace with uncommitted changes shows the warning at opening and a "Delete" button; one click removes the worktree with its changes, with no second step', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('dirty-ws');
      writeFileSync(join(path, 'README.md'), 'changed\n');
      writeFileSync(join(path, 'notes.txt'), 'untracked\n');
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = (await removeOptions(session)).length;

      const dialog = await openDeleteDialog(page, path, 'dirty-ws');
      expect(await dialog.innerText()).toContain(WARNING);
      expect(await deleteButton(dialog, 'Delete anyway').count()).toBe(0);
      expect(existsSync(path)).toBe(true);

      await deleteButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(await deleteDialog(page, 'has uncommitted changes').count(), 'no second step').toBe(0);
      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      // The branch was merged and its box checked: it goes too.
      expect(localBranches(clone)).not.toContain('dirty-ws');
      const sent = (await removeOptions(session)).slice(removesBefore);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.force).toBe(true);
    });

    test('COCKPIT-68 AC10 — an unmerged branch: the box is unchecked with the hint "Not merged: its commits will be lost."; Delete removes the worktree, keeps the branch and shows no "was kept" line', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('unmerged-ws');
      gitIn(path, 'commit', '--allow-empty', '-m', 'work in progress');
      const commit = gitIn(path, 'rev-parse', 'HEAD');
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = (await removeOptions(session)).length;

      const dialog = await openDeleteDialog(page, path, 'unmerged-ws');
      expect(await branchBox(dialog, 'unmerged-ws').isChecked()).toBe(false);
      const text = await dialog.innerText();
      expect(text).toContain(HINT);
      expect(text).not.toContain('uncommitted');

      await deleteButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(clone)).toContain('unmerged-ws');
      expect(gitIn(clone.root, 'rev-parse', 'unmerged-ws')).toBe(commit);
      expect(await keptLines()).toEqual([]);
      const sent = (await removeOptions(session)).slice(removesBefore);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.forceBranch, 'no branch is forced').toBeUndefined();
    });

    test('COCKPIT-68 AC11 — the same workspace with the box checked: Delete removes the worktree and the branch, its commits included', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('unmerged-forced');
      gitIn(path, 'commit', '--allow-empty', '-m', 'work to throw away');
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = (await removeOptions(session)).length;

      const dialog = await openDeleteDialog(page, path, 'unmerged-forced');
      expect(await branchBox(dialog, 'unmerged-forced').isChecked()).toBe(false);
      await branchBox(dialog, 'unmerged-forced').click();
      expect(await branchBox(dialog, 'unmerged-forced').isChecked()).toBe(true);
      await deleteButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(clone)).not.toContain('unmerged-forced');
      expect(await keptLines()).toEqual([]);
      const sent = (await removeOptions(session)).slice(removesBefore);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.deleteBranch).toBe(true);
      expect(sent[0]!.forceBranch, 'the branch the dialog showed').toBe('unmerged-forced');
    });

    test('COCKPIT-68 AC12 — a merged branch with the box unchecked by the user: Delete removes the worktree and the branch stays', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('merged-kept');

      const dialog = await openDeleteDialog(page, path, 'merged-kept');
      expect(await branchBox(dialog, 'merged-kept').isChecked()).toBe(true);
      await branchBox(dialog, 'merged-kept').click();
      expect(await branchBox(dialog, 'merged-kept').isChecked()).toBe(false);
      await deleteButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(clone)).toContain('merged-kept');
      expect(await keptLines()).toEqual([]);
    });

    test('COCKPIT-68 AC13 — a worktree with no branch (detached HEAD): the dialog shows no checkbox and Delete removes the worktree', async () => {
      const { page } = session;
      const path = join(clone.parent, 'detached-ws');
      gitIn(clone.root, 'worktree', 'add', '--quiet', '--detach', path, 'origin/main');
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitListed(path);
      const branchesBefore = localBranches(clone);

      const dialog = await openDeleteDialog(page, path, 'detached-ws');
      expect(await dialog.getByRole('checkbox').count()).toBe(0);
      await deleteButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(clone)).toEqual(branchesBefore);
    });

    test('COCKPIT-68 AC15 — a file that appears in a clean worktree after the dialog opened: the first Delete removes nothing, the dialog stays open with the warning, and a further click removes the worktree', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('late-dirty');
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = (await removeOptions(session)).length;

      const dialog = await openDeleteDialog(page, path, 'late-dirty');
      expect(await dialog.innerText()).not.toContain(WARNING);
      writeFileSync(join(path, 'late.txt'), 'appeared after the dialog opened\n');
      await deleteButton(dialog).click();
      await waitForDialogLine(dialog, /^It has uncommitted changes\. They will be lost\.$/);

      expect(await dialog.isVisible()).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(await isListed(path)).toBe(true);
      expect(readFileSync(join(path, 'late.txt'), 'utf8')).toBe('appeared after the dialog opened\n');
      let sent = (await removeOptions(session)).slice(removesBefore);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.force ?? false, 'nothing is forced before the warning is shown').toBe(false);

      await deleteButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      sent = (await removeOptions(session)).slice(removesBefore);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.force).toBe(true);
    });

    test('COCKPIT-68 AC16 — a commit that lands on a merged branch after the dialog opened (box checked): the worktree goes, the branch stays and "Branch <branch> was kept: it is not merged." shows under the Projects header', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('raced-ws');
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = (await removeOptions(session)).length;

      const dialog = await openDeleteDialog(page, path, 'raced-ws');
      expect(await branchBox(dialog, 'raced-ws').isChecked()).toBe(true);
      gitIn(path, 'commit', '--allow-empty', '-m', 'landed after the dialog opened');
      const commit = gitIn(path, 'rev-parse', 'HEAD');
      await deleteButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });
      const message = KEPT('raced-ws');
      await waitForLine(page, message);
      await waitUnlisted(path);

      expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(localBranches(clone)).toContain('raced-ws');
      expect(gitIn(clone.root, 'rev-parse', 'raced-ws')).toBe(commit);
      const sent = (await removeOptions(session)).slice(removesBefore);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.forceBranch, 'the hint was not on screen').toBeUndefined();
    });

    test('COCKPIT-68 AC22 — a dialog naming branch A while the worktree is now on an unmerged branch B (the sidebar not caught up): Delete forces A, not B; the worktree goes, A and B both stay with their commits, and "Branch A was kept: it is not merged." shows under the Projects header', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('switched-a');
      gitIn(path, 'commit', '--allow-empty', '-m', 'work on A');
      const commitA = gitIn(path, 'rev-parse', 'HEAD');
      // Switched with git itself and no focus event: the sidebar still names the worktree after A.
      gitIn(path, 'switch', '--create', 'switched-b');
      gitIn(path, 'commit', '--allow-empty', '-m', 'work on B');
      const commitB = gitIn(path, 'rev-parse', 'HEAD');
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = (await removeOptions(session)).length;

      const dialog = await openDeleteDialog(page, path, 'switched-a');
      expect(await dialog.innerText()).toContain(HINT);
      expect(await branchBox(dialog, 'switched-a').isChecked()).toBe(false);
      await branchBox(dialog, 'switched-a').click();
      expect(await branchBox(dialog, 'switched-a').isChecked()).toBe(true);
      await deleteButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });
      const message = KEPT('switched-a');
      await waitForLine(page, message);
      await waitUnlisted(path);

      expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(gitIn(clone.root, 'rev-parse', 'switched-a')).toBe(commitA);
      expect(gitIn(clone.root, 'rev-parse', 'switched-b')).toBe(commitB);
      const sent = (await removeOptions(session)).slice(removesBefore);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.deleteBranch).toBe(true);
      expect(sent[0]!.forceBranch, 'the branch the dialog named').toBe('switched-a');
    });

    test('COCKPIT-68 AC23 — a workspace listed with no branch whose worktree is now on a merged branch: the dialog shows no checkbox, and Delete removes the worktree and sends neither deleteBranch nor forceBranch, so that branch stays', async () => {
      const { page } = session;
      const path = join(clone.parent, 'listed-detached');
      gitIn(clone.root, 'worktree', 'add', '--quiet', '--detach', path, 'origin/main');
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitListed(path);
      // A branch taken in the worktree with git itself, no focus event: the sidebar still lists it with no branch.
      gitIn(path, 'switch', '--create', 'taken-later');
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = (await removeOptions(session)).length;

      const dialog = await openDeleteDialog(page, path, 'listed-detached');
      expect(await dialog.getByRole('checkbox').count()).toBe(0);
      await deleteButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(clone)).toContain('taken-later');
      const sent = (await removeOptions(session)).slice(removesBefore);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.deleteBranch ?? false, 'no box was on screen').toBe(false);
      expect(sent[0]!.forceBranch, 'no box was on screen').toBeUndefined();
    });

    test('COCKPIT-68 AC24 — a workspace whose folder was deleted by hand (git still lists it): the dialog shows the refused read\'s message, Delete is enabled and sends neither force nor forceBranch', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('gone-folder');
      rmSync(path, { recursive: true, force: true });
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = (await removeOptions(session)).length;

      try {
        const dialog = await openDeleteDialog(page, path, 'gone-folder');
        const message = dialog.getByRole('status');
        await message.waitFor();
        expect((await message.innerText()).trim().length, 'the message of the refused read').toBeGreaterThan(0);
        expect(await dialog.innerText()).not.toContain(WARNING);
        expect(await deleteButton(dialog).isEnabled()).toBe(true);

        await untilAnswered(session, 'workspaces:remove', () => deleteButton(dialog).click());

        const sent = (await removeOptions(session)).slice(removesBefore);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.force ?? false, 'the warning was not on screen').toBe(false);
        expect(sent[0]!.forceBranch, 'the hint was not on screen').toBeUndefined();
      } finally {
        gitIn(clone.root, 'worktree', 'prune');
      }
    });

    test('AC19 — a deletion git refuses (locked worktree) keeps the dialog open with the error message and the workspace listed', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('locked-ws');
      gitIn(clone.root, 'worktree', 'lock', '--reason', 'kept for a test', path);
      const before = gitState(clone);

      try {
        const dialog = await openDeleteDialog(page, path, 'locked-ws');
        const linesBefore = await linesOf(dialog);
        await deleteButton(dialog).click();
        const message = await waitForDialogLine(dialog, /lock/i, linesBefore);
        expect(message.length).toBeGreaterThan(0);

        expect(await dialog.isVisible()).toBe(true);
        expect(await dialog.innerText()).toContain('Delete locked-ws?');
        expect(existsSync(path)).toBe(true);
        expect(gitState(clone)).toEqual(before);
        expect(await isListed(path)).toBe(true);
        await dismissDialogs(page);
      } finally {
        gitIn(clone.root, 'worktree', 'unlock', path);
      }
    });

    test('AC10, AC11 — workspaces added outside the app are listed under their project in git order, by branch or folder name, titled with their path; a focus event or a reload lists new ones', async () => {
      const { page } = session;
      await clearProjects();

      const external = makeLightRepo('ws-external');
      folders.push(external);
      const add = (...args: string[]) => gitIn(external.root, 'worktree', 'add', '--quiet', ...args);
      add('-b', 'topic-a', join(external.parent, 'wt-a'));
      add('--detach', join(external.parent, 'detached-folder'));
      add('-b', 'topic/b', join(external.parent, 'wt-b'));
      const expectedRows = () => linkedWorktrees(external).map((worktree) => ({ title: worktree.path, name: worktree.branch ?? basename(worktree.path) }));
      expect(expectedRows()).toHaveLength(3);
      expect(expectedRows().map((row) => row.name).sort()).toEqual(['detached-folder', 'topic-a', 'topic/b']);

      await addRepository(session, external);
      await waitForEntries(page, [external.root, ...expectedRows().map((row) => row.title)]);
      const entries = await sidebarEntries(page);
      expect(entries[0]!.text).toContain(external.name);
      expectedRows().forEach((row, index) => {
        expect(entries[index + 1]!.title).toBe(row.title);
        expect(entries[index + 1]!.text).toContain(row.name);
      });
      expect(await isBelowProjectsHeader(page, { title: expectedRows()[0]!.title })).toBe(true);

      // AC11: the focus event.
      const lateFocus = join(external.parent, 'late-focus');
      await countIpcCalls(session, ['projects:list']);
      const listsBefore = await ipcCalls(session, 'projects:list');
      add('-b', 'late-focus', lateFocus);
      // Nothing watches the repository: the sidebar's list is read again only by a call to the main process,
      // and none came by the time its later answers (another channel's) did.
      await page.evaluate(() => (window as unknown as PtyWindow).api.pty.list());
      expect(await ipcCalls(session, 'projects:list'), 'the list does not refresh by itself').toBe(listsBefore);
      expect(await isListed(lateFocus), 'the list does not refresh by itself').toBe(false);
      await dispatchFocus(page);
      await waitForEntries(page, [external.root, ...expectedRows().map((row) => row.title)]);
      expect(await isListed(lateFocus)).toBe(true);

      // AC11: a reload.
      const lateReload = join(external.parent, 'late-reload');
      add('-b', 'late-reload', lateReload);
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitForEntries(page, [external.root, ...expectedRows().map((row) => row.title)]);
      expect(await isListed(lateReload)).toBe(true);

      await removeThroughMenu(page, external.root);
      await waitForEntries(page, []);
      expect(existsSync(lateReload), 'removing a project deletes no worktree').toBe(true);
    });

    test('AC12, AC8, COCKPIT-65 AC11, COCKPIT-68 AC7 — a project whose folder is gone stays listed with a red alert icon after its name, a red "Folder not found" line, its path in muted text and no workspace, logs no error, offers an unusable composer and is removed, after the dialog, by its "Remove from Cockpit" button', async () => {
      const { page } = session;
      await clearProjects();
      const vanishing = makeLightRepo('ws-vanishing');
      folders.push(vanishing);
      await addRepository(session, vanishing);
      const mark = await errorMark(session);

      rmSync(vanishing.parent, { recursive: true, force: true });
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitForLine(page, 'Folder not found');

      expect(await entryTitles(page)).toEqual([vanishing.root]);
      expect((await sidebarEntries(page))[0]!.text).toContain(vanishing.name);
      const lines = await sidebarLines(page);
      expect(lines).toContain(vanishing.root);
      expect(lines.filter((line) => line.endsWith('is not a git repository.'))).toEqual([]);
      expect(await isBelowProjectsHeader(page, { text: 'Folder not found' })).toBe(true);
      const missing = await missingFolderBlock(page, vanishing.root, vanishing.name);
      expect(missing.icon, 'a triangle-alert icon after the name').toBe(true);
      expect(missing.iconColor, 'the icon is red').toBe(await tokenColor(page, '--destructive'));
      expect(missing.lineColor, 'the line is red').toBe(await tokenColor(page, '--destructive'));
      expect(missing.pathColor, 'the path is muted').toBe(await mutedColor(page));
      expect(projectsInState(session.dataDir)).toContainEqual({ path: vanishing.root });

      // AC8: listing the branches fails, the composer says so and "Create workspace" stays disabled.
      await openComposer(page, vanishing.root);
      await promptBox(page).fill('anything');
      expect(await waitForMessage(page)).not.toBe('');
      expect(await createButton(page).isDisabled()).toBe(true);
      await goHome(page);

      // COCKPIT-68 AC7: the button opens the same dialog as the "…" menu; Remove takes the entry and the state's
      // entry away, the disk is untouched.
      await page.locator('aside').getByRole('button', { name: 'Remove from Cockpit', exact: true }).click();
      const removal = removeProjectDialog(page, vanishing.name);
      await removal.waitFor();
      expect(await removal.innerText()).toContain('This removes the project from Cockpit. The repository stays on disk, and the sessions running in its workspaces end.');
      expect(projectsInState(session.dataDir)).toContainEqual({ path: vanishing.root });
      await removal.getByRole('button', { name: 'Remove', exact: true }).click();
      await waitForEntries(page, []);
      expect(projectsInState(session.dataDir)).toEqual([]);
      expect(existsSync(vanishing.parent)).toBe(false);
      await expectNoNewErrors(session, mark);
    });

    test('COCKPIT-65 AC11 — a project whose folder exists but cannot be listed keeps the muted "<path> is not a git repository." line, with no "Folder not found", no error screen and the other projects still listed', async () => {
      const { page } = session;
      await clearProjects();
      const other = makeLightRepo('ws-listable');
      const unreadable = makeLightRepo('ws-unreadable');
      folders.push(other, unreadable);
      await addRepository(session, other);
      await addRepository(session, unreadable);
      const mark = await errorMark(session);

      // The folder is still there, but nothing under its parent can be reached any more.
      chmodSync(unreadable.parent, 0o000);
      try {
        await page.reload();
        await page.getByText(versionLabel).waitFor();
        const message = `${unreadable.root} is not a git repository.`;
        await waitForLine(page, message);

        const lines = await sidebarLines(page);
        expect(lines).not.toContain('Folder not found');
        expect(lines).toContain('Projects');
        expect(await entryTitles(page)).toEqual(expect.arrayContaining([other.root, unreadable.root]));
        expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
        expect(projectsInState(session.dataDir)).toContainEqual({ path: unreadable.root });
        await expectNoNewErrors(session, mark);
      } finally {
        chmodSync(unreadable.parent, 0o755);
      }
    });

    test('AC13 — with 30 projects the Projects header and the footer stay in the window and the list scrolls to its last entry', async () => {
      const { page } = session;
      await clearProjects();
      const repos = Array.from({ length: 30 }, (_, index) => makeLightRepo(`crowded-${String(index).padStart(2, '0')}`));
      folders.push(...repos);
      const last = repos[29]!;
      // A workspace under the last project: the list ends with its row once workspaces are listed.
      gitIn(last.root, 'worktree', 'add', '--quiet', '-b', 'last-workspace', join(last.parent, 'last-workspace'));
      const addApi = () =>
        page.evaluate(() => (globalThis as unknown as { api: { projects: { add(): Promise<unknown> } } }).api.projects.add());
      for (const repo of repos) {
        await stubPicker(session, repo.root);
        await addApi();
      }
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitForEntry(page, last.root);
      expect((await entryTitles(page)).filter((title) => repos.some((repo) => repo.root === title))).toHaveLength(30);

      const layout = await page.evaluate(
        ({ footerText }) => {
          const all = [...document.querySelectorAll('aside *')] as HTMLElement[];
          const deepest = (matches: (element: HTMLElement) => boolean) =>
            all.filter(matches).filter((element) => !all.some((other) => other !== element && element.contains(other) && matches(other)))[0];
          const header = deepest((element) => (element.textContent ?? '').trim() === 'Projects');
          const footer = deepest((element) => (element.textContent ?? '').trim() === footerText);
          // The last entry of the list, a workspace row when there is one.
          const lastEntry = all.filter((element) => element.hasAttribute('title')).at(-1);
          if (!header || !footer || !lastEntry) return null;
          let scroller: HTMLElement | null = lastEntry.parentElement;
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
            scroller = scroller.parentElement;
          }
          const rect = (element: Element) => {
            const { top, bottom } = element.getBoundingClientRect();
            return { top, bottom };
          };
          const before = { header: rect(header), footer: rect(footer), last: rect(lastEntry) };
          lastEntry.scrollIntoView({ block: 'end' });
          const after = { header: rect(header), footer: rect(footer), last: rect(lastEntry) };
          return {
            innerHeight: window.innerHeight,
            scrollable: scroller ? { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollTop: scroller.scrollTop } : null,
            before,
            after,
          };
        },
        { footerText: versionLabel },
      );

      expect(layout, 'the header, the footer and the last entry are in the sidebar').not.toBeNull();
      const { innerHeight, scrollable, before, after } = layout!;
      for (const [name, rects] of Object.entries({ before, after })) {
        expect(rects.header.top, `${name}: header top`).toBeGreaterThanOrEqual(0);
        expect(rects.header.bottom, `${name}: header bottom`).toBeLessThanOrEqual(innerHeight);
        expect(rects.footer.top, `${name}: footer top`).toBeGreaterThanOrEqual(0);
        expect(rects.footer.bottom, `${name}: footer bottom`).toBeLessThanOrEqual(innerHeight);
      }
      expect(scrollable, 'a scrollable container holds the list').not.toBeNull();
      expect(scrollable!.scrollHeight).toBeGreaterThan(scrollable!.clientHeight);
      expect(scrollable!.scrollTop, 'the list scrolled to its last entry').toBeGreaterThan(0);
      expect(after.last.bottom).toBeLessThanOrEqual(after.footer.top + 1);
      expect(after.last.top).toBeGreaterThanOrEqual(after.header.bottom - 1);

      // Leaves the session as it was.
      for (const repo of repos) {
        await page.evaluate(
          (path) => (globalThis as unknown as { api: { projects: { remove(path: string): Promise<void> } } }).api.projects.remove(path),
          repo.root,
        );
      }
      await page.reload();
      await page.getByText(versionLabel).waitFor();
      await waitForEntries(page, []);
    }, 120_000);
  });

  test('workspaces AC20 — a failing save refuses the add with "Cockpit could not save its data: <error>", lists nothing, leaves state.json as it was and logs no error', async () => {
    const { page } = session;
    const repo = makeLightRepo('ws-save');
    try {
      await page.getByText(versionLabel).waitFor();
      expect(await entryTitles(page)).toEqual([]);
      const mark = await errorMark(session);
      const before = stateSnapshot(session.dataDir);
      const blocker = join(session.dataDir, 'state.json.tmp');
      mkdirSync(blocker);

      try {
        await addProject(session, repo.root);
        const [message] = (
          await untilRead(page, readSidebarLines, (lines) => lines.some((line) => line.startsWith('Cockpit could not save its data: ')))
        ).filter((line) => line.startsWith('Cockpit could not save its data: '));

        expect(message).toBeDefined();
        expect(message!.length).toBeGreaterThan('Cockpit could not save its data: '.length);
        expect(message).toContain('EISDIR');
        expect(await isBelowProjectsHeader(page, { text: message! })).toBe(true);
        expect(await entryTitles(page)).toEqual([]);
        expect(stateSnapshot(session.dataDir)).toEqual(before);
        await expectNoNewErrors(session, mark);
      } finally {
        rmSync(blocker, { recursive: true, force: true });
      }

      // Nothing was kept in memory either: the same add works once the folder is gone.
      await addProject(session, repo.root);
      await waitForEntries(page, [repo.root]);
      expect(projectsInState(session.dataDir)).toEqual([{ path: repo.root }]);
      expect((await sidebarLines(page)).filter((line) => line.startsWith('Cockpit could not save'))).toEqual([]);
      await removeThroughMenu(page, repo.root);
      await waitForEntries(page, []);
    } finally {
      rmSync(repo.parent, { recursive: true, force: true });
    }
  });
});
