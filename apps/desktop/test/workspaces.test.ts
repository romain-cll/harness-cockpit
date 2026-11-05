import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { baseSelect, chooseBase, createButton, openComposer, projectSelect, promptBox, sendFromComposer, textOf, useAgent, waitForBase, waitForMessage } from './composer';
import { launchBuilt, type Session, untilRead, versionLabel } from './launch';
import { addProject, addRepository, afterIpcAnswers, countIpcCalls, deleteDialog, dismissDialogs, dispatchFocus, entryTitles, errorMark, expectNoNewErrors, gitIn, gitState, INVOKE_HANDLERS, ipcCalls, isBelowProjectsHeader, linesOf, linkedWorktrees, localBranches, makeClone, makeLightRepo, missingFolderBlock, mutedColor, openDialogs, openMenu, projectsInState, readBaseOptions, readSidebarLines, removeThroughMenu, sha8, sidebarEntries, sidebarLines, startDeletion, stateSnapshot, stubPicker, type TempClone, type TempRepo, tokenColor, untilFewerOverlays, waitForDialogLine, waitForEntries, waitForEntry, waitForLine, waitForNoEntry, worktreePath } from './support/projects';
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

    test('AC1, COCKPIT-66 AC3 — the project menu holds "New workspace…" above "Remove from Cockpit", and "New workspace…" goes to the composer for that project, with no dialog', async () => {
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      await addRepository(session, clone);

      await openMenu(page, clone.root);
      const items = await page.getByRole('menuitem').allInnerTexts();
      expect(items).toHaveLength(2);
      expect(items[0]!.trim()).toBe('New workspace…');
      expect(items[1]!.split('\n')[0]!.trim()).toBe('Remove from Cockpit');
      await page.getByRole('menuitem', { name: 'New workspace…' }).click();

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

    test('AC8 — a base deleted after the composer opened shows the error message in the composer and creates nothing', async () => {
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
        // A message that names the base git could not find.
        const message = await waitForMessage(page);
        expect(message).toContain('origin/develop');

        expect(new URL(page.url()).pathname).toBe('/');
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

    test('AC14, AC15 — the workspace menu holds "Delete workspace…", which opens "Delete <name>?" naming the folder; Cancel and Escape change nothing', async () => {
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
        await startDeletion(page, path);
        const dialog = deleteDialog(page, 'Delete review-ws?');
        await dialog.waitFor();
        const text = await dialog.innerText();
        expect(text).toContain(path);
        expect(text).toMatch(/deleted/);
        expect(text).toMatch(/merged/);
        expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(1);
        expect(await dialog.getByRole('button', { name: 'Delete', exact: true }).count()).toBe(1);

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

    test('AC16 — confirming the deletion of a clean workspace with no new commit removes the folder, the worktree, the branch and the row', async () => {
      const { page } = session;
      const path = worktreePath(session, clone, loginBranch);

      await startDeletion(page, path);
      const dialog = deleteDialog(page, `Delete ${loginBranch}?`);
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(clone)).not.toContain(loginBranch);
      expect((await sidebarLines(page)).filter((line) => line.startsWith('Branch '))).toEqual([]);
    });

    test('AC17 — an unmerged branch is kept: the worktree is removed and "Branch <branch> was kept: it is not merged." shows under the Projects header', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('unmerged-ws');
      gitIn(path, 'commit', '--allow-empty', '-m', 'work in progress');
      const commit = gitIn(path, 'rev-parse', 'HEAD');

      await startDeletion(page, path);
      const dialog = deleteDialog(page, 'Delete unmerged-ws?');
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const message = 'Branch unmerged-ws was kept: it is not merged.';
      await waitForLine(page, message);
      await waitUnlisted(path);

      expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(clone)).toContain('unmerged-ws');
      expect(gitIn(clone.root, 'rev-parse', 'unmerged-ws')).toBe(commit);
    });

    test('AC18 — a workspace with uncommitted changes shows a warning first; Cancel keeps everything; "Delete anyway" removes it, changes included, and applies the branch rule', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('dirty-ws');
      writeFileSync(join(path, 'README.md'), 'changed\n');
      writeFileSync(join(path, 'notes.txt'), 'untracked\n');
      const before = gitState(clone);

      await startDeletion(page, path);
      const dialog = deleteDialog(page, 'Delete dirty-ws?');
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      const warning = deleteDialog(page, 'dirty-ws has uncommitted changes');
      await warning.waitFor();
      expect(await warning.innerText()).toMatch(/lost/i);
      expect(await warning.getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(1);
      expect(await warning.getByRole('button', { name: 'Delete anyway', exact: true }).count()).toBe(1);
      // The warning is the answer of the removal the first Delete asked for: nothing is deleted yet.
      expect(existsSync(path)).toBe(true);
      expect(gitState(clone)).toEqual(before);

      await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
      await warning.waitFor({ state: 'hidden' });
      expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('changed\n');
      expect(readFileSync(join(path, 'notes.txt'), 'utf8')).toBe('untracked\n');
      expect(gitState(clone)).toEqual(before);
      expect(await isListed(path)).toBe(true);

      await startDeletion(page, path);
      await deleteDialog(page, 'Delete dirty-ws?').getByRole('button', { name: 'Delete', exact: true }).click();
      const again = deleteDialog(page, 'dirty-ws has uncommitted changes');
      await again.waitFor();
      await again.getByRole('button', { name: 'Delete anyway', exact: true }).click();
      await again.waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(clone).map((worktree) => worktree.path)).not.toContain(path);
      // No commit outside its base: the branch goes too (AC16).
      expect(localBranches(clone)).not.toContain('dirty-ws');
    });

    test('AC18 — "Delete anyway" on a workspace whose branch has unmerged commits removes the worktree, keeps the branch and says so (AC17)', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('dirty-kept');
      gitIn(path, 'commit', '--allow-empty', '-m', 'unmerged work');
      writeFileSync(join(path, 'notes.txt'), 'untracked\n');
      const commit = gitIn(path, 'rev-parse', 'HEAD');

      await startDeletion(page, path);
      await deleteDialog(page, 'Delete dirty-kept?').getByRole('button', { name: 'Delete', exact: true }).click();
      const warning = deleteDialog(page, 'dirty-kept has uncommitted changes');
      await warning.waitFor();
      await warning.getByRole('button', { name: 'Delete anyway', exact: true }).click();
      await warning.waitFor({ state: 'hidden' });
      const message = 'Branch dirty-kept was kept: it is not merged.';
      await waitForLine(page, message);
      await waitUnlisted(path);

      expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(localBranches(clone)).toContain('dirty-kept');
      expect(gitIn(clone.root, 'rev-parse', 'dirty-kept')).toBe(commit);
    });

    test('AC19 — a deletion git refuses (locked worktree) keeps the dialog open with the error message and the workspace listed', async () => {
      const { page } = session;
      const path = await addExternalWorkspace('locked-ws');
      gitIn(clone.root, 'worktree', 'lock', '--reason', 'kept for a test', path);
      const before = gitState(clone);

      try {
        await startDeletion(page, path);
        const dialog = deleteDialog(page, 'Delete locked-ws?');
        await dialog.waitFor();
        const linesBefore = await linesOf(dialog);
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
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

    test('AC12, AC8, COCKPIT-65 AC11 — a project whose folder is gone stays listed with a red alert icon after its name, a red "Folder not found" line, its path in muted text and no workspace, logs no error, offers an unusable composer and is removed by its "Remove from Cockpit" button', async () => {
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

      // The button removes it as the "…" menu does: the entry and the state's entry go, the disk is untouched.
      await page.locator('aside').getByRole('button', { name: 'Remove from Cockpit', exact: true }).click();
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
