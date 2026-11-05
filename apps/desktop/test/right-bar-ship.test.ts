import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { type Session, startClock, versionLabel } from './launch';
import { makeTestDir } from './run-root';
import { addRepository, afterIpcAnswers, afterRender, countIpcCalls, deleteDialog, dispatchFocus, gitIn, INVOKE_HANDLERS, ipcAnswered, ipcCalls, localBranches, mutedColor, sidebarLines, type TempRepo, tokenColor, untilAnswered, untilFewerOverlays, waitForDialogLine, waitForNoEntry, worktreePath } from './support/projects';
import { addGhFixture, addOrigin, type ChangesWindow, commitField, commitThroughPanel, commonAncestor, expectListed, fillIsTokenAt14, fsEventWatchersOf, type GhFixture, ghRuns, GIT_APP_ENV, gitRunsIn, iconIn, type Locator, lookOf, lookOfHandle, makeChangesRepo, markChangesPanel, near, openShip, PANEL, panelText, PR_URL, prDialog, prJson, prLink, remoteRef, rightBar, selectBarTab, setChangesOpen, setGh, shipButton, showRightBar, untilUnwatches, unwatchesSeen, waitForShipText, watchUnwatches } from './support/right-bar';
import { allSessionLinkIds, createWorkspaceWithAgent, expectNoErrors, launchBuiltWith, makeSessionsFixture, type SessionsFixture } from './support/sessions';
import { goHome } from './support/terminal';

describe('changes sidebar: built app', () => {
  let fx: SessionsFixture;
  let gh: GhFixture;
  let session: Session;

  beforeAll(async () => {
    fx = makeSessionsFixture(['claude'], { gitLog: true });
    gh = addGhFixture(fx);
    session = await launchBuiltWith({ ...fx.env(), ...GIT_APP_ENV });
    await session.page.getByText(versionLabel).waitFor();
  });

  // What `logs no error and keeps running` checks in `right-bar.test.ts`, for this file's launch.
  afterAll(async () => {
    try {
      await expectNoErrors(session);
    } finally {
      await session?.close();
      if (fx) rmSync(fx.root, { recursive: true, force: true });
    }
  });

  // COCKPIT-38: the ship section of the sidebar. It runs on a project of its own with a local bare
  // `origin`, a workspace per story, and the stub `gh` of the launch.
  describe('ship section', () => {
    let ship: TempRepo;
    let origin: string;
    // The workspaces: a pull request opened outside Cockpit, the commit, push and pull request flow, and a
    // rejected push.
    const W1 = { path: '', id: '' };
    const W2 = { path: '', id: '' };
    const W3 = { path: '', id: '' };
    // A workspace whose commit and push are made outside the section (AC13).
    const W4 = { path: '', id: '' };

    beforeAll(async () => {
      ship = makeChangesRepo('ship-ws');
      writeFileSync(join(ship.root, '.gitignore'), '*.log\n');
      gitIn(ship.root, 'add', '.gitignore');
      gitIn(ship.root, 'commit', '-m', 'ignore logs');
      origin = addOrigin(ship);
      await addRepository(session, ship);
      for (const [workspace, name] of [[W1, 'ship-pr'], [W2, 'ship-flow'], [W3, 'ship-reject'], [W4, 'ship-outside']] as const) {
        workspace.id = await createWorkspaceWithAgent(session.page, ship, { agent: 'Claude Code', prompt: name }, 'Claude Code 1');
        workspace.path = worktreePath(session, ship, name);
      }
      setGh(gh);
    });

    afterAll(() => {
      if (ship) rmSync(ship.parent, { recursive: true, force: true });
    });

    // A failing test must not leave a menu or a dialog that blocks the tests after it.
    afterEach(async () => {
      const { page } = session;
      const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
      for (let attempt = 0; attempt < 4; attempt++) {
        const shown = await overlays.count();
        if (shown === 0 || (await page.evaluate(() => !!document.activeElement?.closest('.xterm')))) break;
        await page.keyboard.press('Escape');
        await untilFewerOverlays(page, shown);
      }
    });

    const waitForText = <A = undefined>(matches: (text: string, arg: A) => boolean, arg?: A) => waitForShipText(session.page, matches, arg);

    test('ship AC1, right bar AC11 — a pull request opened outside Cockpit shows "#7 · Checks pending", its state and an "Open on GitHub" link to its URL, and no "Create pull request" button; each summary follows the answer; the meta row (24 px) holds the state pill (20 px, radius 10, 12 px icon, 11 px text, its token at 14 %), "#7" and the link; the title (13 px on 18 px, not a link) and "<branch> → <base>" follow; only a merged pull request offers "Delete workspace…"', async () => {
      const { page } = session;
      setGh(gh, { list: prJson({ checks: 'pending' }) });
      await openShip(page, W1.id);

      const link = prLink(page);
      await link.waitFor();
      expect(await link.getAttribute('href')).toBe(PR_URL);
      const text = await waitForText((shown) => shown.includes('#7 · Checks pending'));
      expect(await page.locator(PANEL).getByText('Open', { exact: true }).count(), 'the state pill').toBe(1);
      expect(text).toContain('Fix the bug');
      // Nothing to commit and nothing to push in a fresh workspace.
      expect(await shipButton(page, 'Push').count()).toBe(0);

      for (const [checks, label] of [['unknown', '#7 · Checks unknown'], ['failing', '#7 · Checks failing'], ['passing', '#7 · Checks passing']] as const) {
        setGh(gh, { list: prJson({ checks }) });
        await dispatchFocus(page);
        await waitForText((shown, wanted) => shown.includes(wanted), label);
      }
      // No check: no summary at all.
      setGh(gh, { list: prJson({ checks: 'none' }) });
      await dispatchFocus(page);
      await waitForText((shown) => !shown.includes('Checks '));
      expect(await page.locator(PANEL).getByText('Open', { exact: true }).count()).toBe(1);

      const states = [
        ['OPEN', 'Open', /lucide-git-pull-request(\s|$)/, '--status-ready'],
        ['MERGED', 'Merged', /lucide-git-merge(\s|$)/, '--status-merged'],
        ['CLOSED', 'Closed', /lucide-git-pull-request-closed(\s|$)/, '--status-exited'],
      ] as const;
      for (const [state, label, icon, token] of states) {
        setGh(gh, { list: prJson({ state, checks: state === 'OPEN' ? 'passing' : 'none' }) });
        await dispatchFocus(page);
        const bar = page.locator(PANEL);
        const pillText = bar.getByText(label, { exact: true });
        await pillText.waitFor();
        // The previous answer was an open pull request with no check: wait for the one just set.
        if (state === 'OPEN') await waitForText((shown) => shown.includes('#7 · Checks passing'));
        // The pill is the smallest element around the label that also holds its icon.
        const pillElement = await pillText.evaluateHandle((text) => {
          for (let node: Element | null = text; node; node = node.parentElement) if (node.querySelector('svg')) return node;
          return text;
        });
        const look = await lookOfHandle(pillElement);
        expect([near(look.height, 20), look.radius], `${label}: a 20 px pill with radius 10`).toEqual([true, '10px']);
        expect((await lookOf(pillText)).fontSize, `${label}: 11 px text`).toBe('11px');
        const svg = await iconIn(pillText.locator('xpath=ancestor-or-self::*[.//*[name()="svg"]][1]'));
        expect(svg.className, `${label}: icon`).toMatch(icon);
        expect([svg.width, svg.height, svg.stroke]).toEqual([12, 12, 1.25]);
        expect(svg.color, `${label}: the color of ${token}`).toBe(await tokenColor(page, token));
        expect(await fillIsTokenAt14(pillElement as unknown as Locator, token), `${label}: ${token} at 14 %`).toBe(true);

        const number = bar.getByText(/^#7\b/);
        const numberLook = await lookOf(number);
        expect([numberLook.fontSize, numberLook.color], '#7: 11 px muted').toEqual(['11px', await mutedColor(page)]);
        const shown = (await panelText(page)).replace(/\s+/g, ' ');
        if (state === 'OPEN') expect(shown).toContain('#7 · Checks passing');
        else expect(shown, 'no checks once merged or closed').not.toContain('Checks ');
        const linkLook = await lookOf(prLink(page));
        expect([near(linkLook.width, 24), near(linkLook.height, 24)], '"Open on GitHub": 24 px').toEqual([true, true]);
        expect((await iconIn(prLink(page))).className).toMatch(/lucide-external-link(\s|$)/);
        const metaRow = await lookOfHandle(await commonAncestor(page, pillText, number, prLink(page)));
        expect(near(metaRow.height, 24), `the meta row is 24 px: ${metaRow.height}`).toBe(true);

        const title = bar.getByText('Fix the bug', { exact: true });
        const titleLook = await lookOf(title);
        expect([titleLook.fontSize, titleLook.lineHeight, titleLook.color], 'the title: 13 px on 18 px').toEqual(['13px', '18px', await tokenColor(page, '--foreground')]);
        expect(await bar.getByRole('link', { name: /Fix the bug/ }).count(), 'the title is not a link').toBe(0);
        const branch = await lookOf(bar.getByText('ship-pr → main', { exact: true }));
        expect([branch.fontSize, /mono/.test(branch.fontFamily), branch.color], 'the branch line: 11 px monospace muted').toEqual(['11px', true, await mutedColor(page)]);
        expect(await shipButton(page, 'Delete workspace…').count(), `${label}: "Delete workspace…"`).toBe(state === 'MERGED' ? 1 : 0);
        // AC12: a branch with only closed pull requests can have a new one, its block above the button.
        expect(await shipButton(page, 'Create pull request').count(), `${label}: "Create pull request"`).toBe(state === 'CLOSED' ? 1 : 0);
        if (state === 'CLOSED') {
          expect(look.top, 'the closed pull request shows above "Create pull request"').toBeLessThan((await lookOf(shipButton(page, 'Create pull request'))).top);
        }
      }
      setGh(gh);
    });

    test('ship AC2, right bar AC11 — clicking "Open on GitHub" opens its URL in the system browser and the window stays on its page', async () => {
      const { page } = session;
      await session.evaluateInMain(`(() => {
        const { shell } = require('electron');
        const opened = (globalThis.__openedExternally = []);
        const stub = async (url) => {
          opened.push(url);
          globalThis.__onOpenedExternally?.();
        };
        shell.openExternal = stub;
        if (shell.openExternal !== stub) throw new Error('shell.openExternal cannot be replaced');
      })()`);
      setGh(gh, { list: prJson({ checks: 'passing' }) });
      await openShip(page, W1.id);
      await dispatchFocus(page);
      const link = prLink(page);
      await link.waitFor();
      const url = page.url();

      await link.click();

      const opened = await session.evaluateInMain<string[]>(`new Promise((resolve) => {
        const done = () => resolve(globalThis.__openedExternally.slice());
        if (globalThis.__openedExternally.length > 0) done();
        else globalThis.__onOpenedExternally = done;
      })`);
      expect(opened).toEqual([PR_URL]);
      expect(page.url()).toBe(url);
      expect(await markChangesPanel(page)).toBe(true);
    });

    test('ship AC3, AC4, right bar AC15 — a change in the worktree reads no pull request, the window gaining focus does (within 5 s, on either tab), and no gh runs while the rail shows (the bar closed or reloaded), on a write or on a window focus', async () => {
      const { page } = session;
      const leftovers = ['tick.txt', 'closed.txt', 'reloaded.txt'];
      try {
        // The previous test left "Checks passing" on screen, so each wait below is for an answer the
        // page does not show yet. Once the newest read shows "pending", an earlier read (the page
        // opening, the first focus) has returned or was dropped, and the log holds every run of them.
        await countIpcCalls(session, ['workspaces:pull-request']);
        await watchUnwatches(session);
        setGh(gh, { list: prJson({ checks: 'failing' }) });
        await openShip(page, W1.id);
        await dispatchFocus(page);
        await waitForText((shown) => shown.includes('Checks failing'));
        setGh(gh, { list: prJson({ checks: 'pending' }) });
        await dispatchFocus(page);
        await waitForText((shown) => shown.includes('Checks pending'));

        // A read queued behind the newest one is asked in the turn that shows the newest: it has reached the main
        // process after the page's next answer, and every read so far is over once the handler has answered them.
        await afterIpcAnswers(page);
        const reads = await ipcCalls(session, 'workspaces:pull-request');
        await ipcAnswered(session, 'workspaces:pull-request', reads);
        // The pull request merged meanwhile; a file written in the worktree must not read it.
        setGh(gh, { list: prJson({ state: 'MERGED', checks: 'passing' }) });
        const before = ghRuns(gh).length;
        await selectBarTab(page, 'Diff');
        writeFileSync(join(W1.path, 'tick.txt'), 'x\n');
        await expectListed(page, ['tick.txt'], ['tick.txt']);
        // The list is the answer of the read the write caused. A pull request read that write started would have
        // been asked in the same turn, so it has reached the main process by the time that answer, and the later
        // answers of the page, came.
        await afterIpcAnswers(page);
        expect(await ipcCalls(session, 'workspaces:pull-request'), 'a write reads no pull request').toBe(reads);
        expect(ghRuns(gh)).toHaveLength(before);
        await selectBarTab(page, 'Pull request');
        await page.locator(PANEL).getByText('Open', { exact: true }).waitFor();
        expect(await page.locator(PANEL).getByText('Merged', { exact: true }).count(), 'still the open pull request').toBe(0);

        // A window focus reads it, with the other tab showing: the Pull request panel stays mounted.
        await selectBarTab(page, 'Diff');
        const within = startClock();
        await untilAnswered(session, 'workspaces:pull-request', () => dispatchFocus(page));
        within('the focus read the pull request', 5_000);
        expect(ghRuns(gh).length, 'a focus reads the pull request whichever tab shows').toBeGreaterThan(before);
        await selectBarTab(page, 'Pull request');
        await waitForText((shown) => /\bMerged\b/.test(shown));
        rmSync(join(W1.path, 'tick.txt'));

        // The rail shows (the bar closed), then the page reloaded: a write or a focus starts no gh run. A write is
        // noticed by the watcher only the open bar holds; a focus is heard by the bar's panel only.
        const watchersOpen = await fsEventWatchersOf(session);
        const unwatches = await unwatchesSeen(session);
        await setChangesOpen(page, false);
        await untilUnwatches(session, unwatches + 1);
        expect(await fsEventWatchersOf(session), 'no watcher on the worktree').toBeLessThan(watchersOpen);
        const reads2 = await ipcCalls(session, 'workspaces:pull-request');
        await ipcAnswered(session, 'workspaces:pull-request', reads2);
        const runs = ghRuns(gh).length;
        writeFileSync(join(W1.path, 'closed.txt'), 'x\n');
        await dispatchFocus(page);
        await afterIpcAnswers(page);
        expect(await ipcCalls(session, 'workspaces:pull-request'), 'a focus with the rail shown reads no pull request').toBe(reads2);
        expect(ghRuns(gh), 'a focus with the rail shown runs no gh').toHaveLength(runs);

        await page.reload();
        await page.getByText(versionLabel).waitFor();
        await showRightBar(page).waitFor();
        expect(await markChangesPanel(page)).toBe(false);
        expect(await fsEventWatchersOf(session), 'no watcher on the worktree after a reload').toBeLessThan(watchersOpen);
        writeFileSync(join(W1.path, 'reloaded.txt'), 'x\n');
        await dispatchFocus(page);
        await afterIpcAnswers(page);
        expect(await ipcCalls(session, 'workspaces:pull-request')).toBe(reads2);
        expect(ghRuns(gh)).toHaveLength(runs);
      } finally {
        // A failure must leave neither a file in the worktree nor an answer of this test to the next one.
        for (const name of leftovers) rmSync(join(W1.path, name), { force: true });
        setGh(gh);
      }
    });

    test('ship AC5 — gh not installed, not logged in or failing shows its message and no "Create pull request" button', async () => {
      const { page } = session;
      setGh(gh, { code: 4, stderr: 'authentication required\n' });
      await openShip(page, W1.id);
      await waitForText((shown) => shown.includes('gh is not logged in. Run gh auth login in a terminal.'));
      expect(await shipButton(page, 'Create pull request').count()).toBe(0);

      setGh(gh, { code: 1, stderr: '  boom\n\n' });
      await dispatchFocus(page);
      await waitForText((shown) => shown.includes('Could not read the pull request: boom'));
      expect(await shipButton(page, 'Create pull request').count()).toBe(0);

      const stub = join(fx.bin, 'gh');
      renameSync(stub, `${stub}.away`);
      try {
        setGh(gh);
        await dispatchFocus(page);
        await waitForText((shown) => shown.includes('The GitHub CLI (gh) is not installed.'));
        expect(await shipButton(page, 'Create pull request').count()).toBe(0);
      } finally {
        renameSync(`${stub}.away`, stub);
      }

      await dispatchFocus(page);
      await waitForText((shown) => !shown.includes('gh)') && !shown.includes('Could not read'));
    });

    test('ship AC3 — after a commit and after a push succeed, the pull request is read again and the section shows its new state within 5 s, with no window focus', async () => {
      const { page } = session;
      try {
        setGh(gh);
        await openShip(page, W1.id);
        await shipButton(page, 'Create pull request').waitFor();
        writeFileSync(join(W1.path, 'after-actions.txt'), 'x\n');
        await expectListed(page, ['after-actions.txt'], ['after-actions.txt']);

        // A pull request opens meanwhile: nothing reads it until the commit succeeds.
        setGh(gh, { list: prJson({ title: 'After the commit', checks: 'pending' }) });
        await commitThroughPanel(page, 'Commit then read');
        await waitForText((shown) => shown.includes('After the commit') && shown.includes('#7 · Checks pending'));

        // It merges meanwhile: nothing reads it until the push succeeds.
        setGh(gh, { list: prJson({ title: 'After the commit', state: 'MERGED', checks: 'passing' }) });
        await shipButton(page, 'Push').click();
        await waitForText((shown) => /\bMerged\b/.test(shown));
        expect(await shipButton(page, 'Delete workspace…').count()).toBe(1);
      } finally {
        setGh(gh);
      }
    });

    test('ship AC6, AC5 — Commit puts every change in one commit with the trimmed message, clears the field and is disabled while the message is blank or nothing is uncommitted, with gh failing', async () => {
      const { page } = session;
      setGh(gh, { code: 1, stderr: 'boom' });
      await openShip(page, W2.id);
      await waitForText((shown) => shown.includes('Could not read the pull request: boom'));
      const head = gitIn(W2.path, 'rev-parse', 'HEAD');
      writeFileSync(join(W2.path, 'a.txt'), 'edited\n');
      rmSync(join(W2.path, 'c.txt'));
      writeFileSync(join(W2.path, 'new.txt'), 'new\n');
      writeFileSync(join(W2.path, 'ignored.log'), 'ignored\n');
      await expectListed(page, ['new.txt'], ['new.txt']);

      const commit = shipButton(page, 'Commit');
      expect(await commit.isDisabled()).toBe(true);
      await commitField(page).fill('   ');
      expect(await commit.isDisabled()).toBe(true);

      await commitThroughPanel(page, '  Edit, delete and add  ');

      // The section shows the commit to push once the commit succeeded (and the field is clear by then).
      await waitForText((shown) => /(^|\s)1 commit to push(\s|$)/.test(shown));
      expect(gitIn(W2.path, 'rev-list', '--count', `${head}..HEAD`)).toBe('1');
      expect(gitIn(W2.path, 'log', '-1', '--format=%B')).toBe('Edit, delete and add');
      expect(gitIn(W2.path, 'status', '--porcelain')).toBe('');
      expect(gitIn(W2.path, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort()).toEqual(['A\tnew.txt', 'D\tc.txt', 'M\ta.txt']);
      expect(gitIn(W2.path, 'ls-files', 'ignored.log')).toBe('');
      expect(await commitField(page).inputValue()).toBe('');
      // Nothing is uncommitted any more: a message does not enable the button.
      await commitField(page).fill('Nothing left');
      await afterRender(page);
      expect(await commit.isDisabled()).toBe(true);
      await commitField(page).fill('');
    });

    test('ship AC7 — a failing pre-commit hook shows "Could not commit: …" with git\'s message, creates no commit and keeps the message in the field', async () => {
      const { page } = session;
      const hook = join(ship.root, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
      chmodSync(hook, 0o755);
      try {
        const head = gitIn(W2.path, 'rev-parse', 'HEAD');
        writeFileSync(join(W2.path, 'second.txt'), 'second\n');
        await expectListed(page, ['second.txt'], ['second.txt']);

        await commitThroughPanel(page, 'Add the second file');

        const text = await waitForText((shown) => /Could not commit: [\s\S]*hook says no/.test(shown));
        expect(text).toMatch(/Could not commit: [\s\S]*hook says no/);
        // The failure shows under the section, in --destructive.
        const failure = page.locator(PANEL).getByText(/Could not commit: /).first();
        expect((await lookOf(failure)).color, 'the failure is --destructive').toBe(await tokenColor(page, '--destructive'));
        expect((await lookOf(failure)).top, 'under the Commit button').toBeGreaterThan((await lookOf(shipButton(page, 'Commit'))).bottom - 1);
        expect(gitIn(W2.path, 'rev-parse', 'HEAD')).toBe(head);
        expect(await commitField(page).inputValue()).toBe('Add the second file');
      } finally {
        rmSync(hook, { force: true });
      }
      // The message was kept: pressing Commit again, the hook gone, commits.
      await shipButton(page, 'Commit').click();
      await waitForText((shown) => /(^|\s)2 commits to push(\s|$)/.test(shown));
      expect(gitIn(W2.path, 'log', '-1', '--format=%B')).toBe('Add the second file');
      expect(gitIn(W2.path, 'status', '--porcelain')).toBe('');
    });

    test('ship AC10 — with gh ready and no pull request, "Create pull request" is disabled with "Push the branch first." while the branch is not pushed', async () => {
      const { page } = session;
      setGh(gh);
      await dispatchFocus(page);
      const create = shipButton(page, 'Create pull request');
      await create.waitFor();
      expect(await create.isDisabled()).toBe(true);
      expect(await panelText(page)).toContain('Push the branch first.');
      await shipButton(page, 'Push').waitFor();
      // AC12: "Create pull request" and the hint show at the top of the tab, above "Commit & push".
      const section = await lookOf(page.locator(PANEL).getByText('Commit & push', { exact: true }));
      expect((await lookOf(create)).top, '"Create pull request" is above "Commit & push"').toBeLessThan(section.top);
      expect((await lookOf(page.locator(PANEL).getByText('Push the branch first.'))).top).toBeLessThan(section.top);
    });

    test('right bar AC13 — "Commit & push" (11 px --subtle, a top border) holds the 32 px "Commit message" field (radius 8) and an outline "Commit"; "2 commits to push" (11 px muted) has an arrow-up "Push" button at its right, and the row goes once pushed', async () => {
      const { page } = session;
      const bar = page.locator(PANEL);
      const heading = bar.getByText('Commit & push', { exact: true });
      const headingLook = await lookOf(heading);
      expect([headingLook.fontSize, headingLook.color]).toEqual(['11px', await tokenColor(page, '--subtle')]);
      const borders = await heading.evaluate((element) => {
        for (let node = element.parentElement; node && node.getAttribute('role') !== 'complementary'; node = node.parentElement) {
          if (getComputedStyle(node).borderTopWidth === '1px') return getComputedStyle(node).borderTopColor;
        }
        return null;
      });
      expect(borders, 'the section has a top border in --border').toBe(await tokenColor(page, '--border'));

      const field = await lookOf(commitField(page));
      expect([near(field.height, 32), field.radius], 'the field: 32 px, radius 8').toEqual([true, '8px']);
      const commit = await lookOf(shipButton(page, 'Commit'));
      expect(commit.borderTop, 'an outline button has a border').toBe('1px');

      const count = bar.getByText('2 commits to push', { exact: true });
      await count.waitFor();
      const countLook = await lookOf(count);
      expect([countLook.fontSize, countLook.color]).toEqual(['11px', await mutedColor(page)]);
      const push = shipButton(page, 'Push');
      expect((await iconIn(push)).className).toMatch(/lucide-arrow-up(\s|$)/);
      const pushLook = await lookOf(push);
      expect(pushLook.left, '"Push" is at the right of the count').toBeGreaterThan(countLook.right);
      expect(near((pushLook.top + pushLook.bottom) / 2, (countLook.top + countLook.bottom) / 2, 8), 'on the same row').toBe(true);
    });

    test('ship AC8 — Push runs git push --set-upstream origin <branch> (never forced), origin has the branch at HEAD, the upstream is origin/<branch> and the button goes', async () => {
      const { page } = session;
      expect(remoteRef(origin, 'ship-flow')).toBe('');

      // The origin's post-receive hook holds the push after the remote ref has moved, and before the pushing git
      // writes the upstream: it tells the test through the FIFO `moved`, then waits for the FIFO `release`.
      const gates = realpathSync(makeTestDir('g-'));
      const [moved, release] = [join(gates, 'moved'), join(gates, 'release')];
      execFileSync('mkfifo', [moved, release]);
      const hook = join(origin, 'hooks', 'post-receive');
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, `#!/bin/sh\necho moved > '${moved}'\nread -r _ < '${release}'\n`);
      chmodSync(hook, 0o755);
      let released = false;
      try {
        await shipButton(page, 'Push').click();
        await readFile(moved);

        const head = gitIn(W2.path, 'rev-parse', 'HEAD');
        expect(remoteRef(origin, 'ship-flow'), 'origin has the branch at HEAD').toBe(head);
        expect(gitIn(W2.path, 'rev-parse', '--abbrev-ref', 'ship-flow@{upstream}'), 'the upstream is not written yet').toBe('origin/main');
        expect(await shipButton(page, 'Push').count(), 'the Push button is still shown').toBe(1);

        released = true;
        await writeFile(release, 'go\n');
        await shipButton(page, 'Push').waitFor({ state: 'detached' });
      } finally {
        rmSync(hook, { force: true });
        if (!released) {
          // A failed test must not leave the push held: a read side that is already waiting gets the line.
          const fd = openSync(release, constants.O_RDWR);
          writeSync(fd, 'go\n');
          closeSync(fd);
        }
        rmSync(gates, { recursive: true, force: true });
      }
      expect(gitIn(W2.path, 'rev-parse', '--abbrev-ref', 'ship-flow@{upstream}')).toBe('origin/ship-flow');
      expect(await shipButton(page, 'Push').count()).toBe(0);
      expect(await panelText(page), 'the "commits to push" row goes').not.toMatch(/commits? to push/);
      const pushes = gitRunsIn(fx, W2.path).filter((line) => line.startsWith(`${W2.path} push`));
      expect(pushes).toEqual([`${W2.path} push --set-upstream origin ship-flow`]);
      // Whatever git ran in the whole launch: no push is forced.
      const everyPush = readFileSync(fx.gitLog, 'utf8').split('\n').filter((line) => / push( |$)/.test(line));
      expect(everyPush.length).toBeGreaterThan(0);
      for (const line of everyPush) expect(line).not.toMatch(/--force|--force-with-lease| -f( |$)| \+/);
    });

    test('ship AC10 — "Create pull request" opens a dialog into the base with the title of HEAD\'s commit focused; a failing gh shows its message and keeps it open; Create runs gh pr create and shows the pull request', async () => {
      const { page } = session;
      const create = shipButton(page, 'Create pull request');
      await create.and(page.locator('button:enabled')).waitFor();
      expect(await panelText(page)).not.toContain('Push the branch first.');

      await create.click();
      const dialog = prDialog(page);
      await dialog.waitFor();
      expect(await dialog.innerText()).toContain('into main');
      const title = dialog.getByRole('textbox', { name: 'Title', exact: true });
      const description = dialog.getByRole('textbox', { name: 'Description', exact: true });
      const createButtonOfDialog = dialog.getByRole('button', { name: 'Create', exact: true });
      expect(await title.inputValue()).toBe('Add the second file');
      await title.and(page.locator(':focus')).waitFor();
      expect(await description.inputValue()).toBe('');

      await title.fill('   ');
      expect(await createButtonOfDialog.isDisabled()).toBe(true);
      await title.fill('  Ship the flow  ');
      await description.fill('Line 1\nLine 2');
      expect(await createButtonOfDialog.isDisabled()).toBe(false);

      setGh(gh, { createStderr: '  gh: GraphQL: boom\n\n' });
      await createButtonOfDialog.click();
      expect(await waitForDialogLine(dialog, /^Could not create the pull request: gh: GraphQL: boom$/)).toHaveLength(1);
      expect(await dialog.isVisible()).toBe(true);

      setGh(gh, { afterCreate: prJson({ title: 'Ship the flow', checks: 'pending' }) });
      await createButtonOfDialog.click();
      await dialog.waitFor({ state: 'hidden' });

      const link = prLink(page);
      const within = startClock();
      await link.waitFor();
      within('the pull request link showed', 5_000);
      expect(await link.getAttribute('href')).toBe(PR_URL);
      await waitForText((shown) => shown.includes('Ship the flow') && shown.includes('#7 · Checks pending'));
      expect(await shipButton(page, 'Create pull request').count()).toBe(0);
      const creates = ghRuns(gh).filter((run) => run.args[0] === 'pr' && run.args[1] === 'create');
      const args = ['pr', 'create', '--base', 'main', '--head', 'ship-flow', '--title', 'Ship the flow', '--body', 'Line 1\nLine 2'];
      expect(creates).toEqual([
        { cwd: W2.path, prompt: '1', args },
        { cwd: W2.path, prompt: '1', args },
      ]);
    });

    test('ship AC11 — once the pull request is merged, "Delete workspace…" opens the Delete dialog; confirming removes the worktree, the branch and the row, and the page of the deleted workspace has no right column', async () => {
      const { page } = session;
      setGh(gh, { list: prJson({ title: 'Ship the flow', state: 'MERGED', checks: 'passing' }) });
      await dispatchFocus(page);
      await waitForText((shown) => /\bMerged\b/.test(shown));

      await shipButton(page, 'Delete workspace…').click();
      const dialog = deleteDialog(page, 'Delete ship-flow?');
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

      // The dialog goes with the answer of the removal, the folder and then the branch included.
      await dialog.waitFor({ state: 'hidden' });
      await waitForNoEntry(page, W2.path);
      expect(existsSync(W2.path)).toBe(false);
      expect(localBranches(ship)).not.toContain('ship-flow');
      expect(await sidebarLines(page)).not.toContain('Branch ship-flow was kept: it is not merged.');
      expect(await allSessionLinkIds(page)).not.toContain(W2.id);
      await rightBar(page).waitFor({ state: 'detached' });
      expect(await rightBar(page).count(), 'no right column on the page of the deleted workspace').toBe(0);
      expect(await showRightBar(page).count()).toBe(0);
      expect(await markChangesPanel(page)).toBe(false);
    });

    test('ship AC9 — a push git refuses (origin has a commit the worktree lacks) shows "Could not push <branch>: …", leaves origin as it was and keeps "Push"', async () => {
      const { page } = session;
      const git = (cwd: string, ...args: string[]) => gitIn(cwd, ...args);
      writeFileSync(join(W3.path, 'one.txt'), 'one\n');
      git(W3.path, 'add', 'one.txt');
      git(W3.path, 'commit', '-m', 'one');
      git(W3.path, 'push', '--quiet', '--set-upstream', 'origin', 'ship-reject');
      // Someone else pushes to origin/ship-reject, then the worktree commits on its own.
      const other = join(ship.parent, 'other-clone');
      git(ship.parent, 'clone', '--quiet', origin, other);
      git(other, 'switch', '--quiet', 'ship-reject');
      writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
      git(other, 'add', 'theirs.txt');
      git(other, 'commit', '-m', 'theirs');
      git(other, 'push', '--quiet', 'origin', 'ship-reject');
      const theirs = remoteRef(origin, 'ship-reject');
      writeFileSync(join(W3.path, 'two.txt'), 'two\n');
      git(W3.path, 'add', 'two.txt');
      git(W3.path, 'commit', '-m', 'two');

      setGh(gh);
      await openShip(page, W3.id);
      await shipButton(page, 'Push').click();

      const text = await waitForText((shown) => /Could not push ship-reject: [\s\S]*rejected/.test(shown));
      expect(text).toMatch(/Could not push ship-reject: /);
      expect(remoteRef(origin, 'ship-reject')).toBe(theirs);
      expect(await shipButton(page, 'Push').count()).toBe(1);
    });

    test('ship AC13 — a commit then a push made outside the section (in the worktree, as its terminal would) update it within 5 s with no window focus, and once it settled no git runs in the worktree', async () => {
      const { page } = session;
      setGh(gh);
      writeFileSync(join(W4.path, 'a.txt'), 'edited outside\n');
      await openShip(page, W4.id);
      await expectListed(page, ['a.txt'], ['a.txt']);
      const create = shipButton(page, 'Create pull request');
      await create.waitFor();
      const commit = shipButton(page, 'Commit');
      await commitField(page).fill('Typed, not pressed');
      await commit.and(page.locator('button:enabled')).waitFor();
      expect(await shipButton(page, 'Push').count()).toBe(0);

      // The commit: "Push" shows and "Commit" is disabled (nothing is uncommitted any more), each within 5 s.
      gitIn(W4.path, 'commit', '-q', '-am', 'Committed in the terminal');
      let within = startClock();
      await shipButton(page, 'Push').waitFor();
      within('"Push" showed', 5_000);
      within = startClock();
      await commit.and(page.locator('button:disabled')).waitFor();
      within('"Commit" was disabled', 5_000);
      expect(await create.isDisabled()).toBe(true);

      // The push: "Push" goes and "Create pull request" is enabled, each within 5 s.
      gitIn(W4.path, 'push', '-q', '-u', 'origin', 'ship-outside');
      within = startClock();
      await shipButton(page, 'Push').waitFor({ state: 'detached' });
      within('"Push" went', 5_000);
      within = startClock();
      await create.and(page.locator('button:enabled')).waitFor();
      within('"Create pull request" was enabled', 5_000);
      expect(await panelText(page)).not.toContain('Push the branch first.');

      // Reading the state writes nothing under the gitdir, so it does not start itself again. The cause of a loop
      // would be a read that writes there (or a watcher that does): the files of the worktree's gitdir and of the
      // repository's own are the same after everything the app does on its own as they were before. That is its
      // status, its changes and the selected file's diff (called here), and the start of a watcher (the bar closed and
      // opened again, answered), which touches the folders it watches, not their files.
      const gitdirs = [gitIn(W4.path, 'rev-parse', '--absolute-git-dir'), gitIn(W4.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')];
      const gitdirState = () =>
        gitdirs.map((dir) =>
          readdirSync(dir, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => `${join(entry.parentPath, entry.name)} ${statSync(join(entry.parentPath, entry.name)).mtimeMs}`)
            .sort(),
        );
      await countIpcCalls(session, ['workspaces:watch']);
      const watches = await ipcCalls(session, 'workspaces:watch');
      const settled = gitdirState();
      await page.evaluate(
        ([project, path]) => {
          const { workspaces } = (window as unknown as ChangesWindow & { api: { workspaces: { status(project: string, path: string): Promise<unknown> } } }).api;
          return Promise.all([
            workspaces.status(project!, path!),
            workspaces.changes(project!, path!),
            workspaces.diff(project!, path!, { path: 'a.txt', status: 'modified', additions: 1, deletions: 1 }),
          ]);
        },
        [ship.root, W4.path] as const,
      );
      await setChangesOpen(page, false);
      await setChangesOpen(page, true, 'Pull request');
      await ipcAnswered(session, 'workspaces:watch', watches + 1);
      expect(gitdirState(), 'reading the state and starting a watcher write nothing under the gitdir').toEqual(settled);
    });

    test('ship AC12 — the new window.api.workspaces calls refuse an unknown project, a path that is not a linked worktree, a blank message or title, and a detached HEAD with the messages of the spec, run nothing, and reject from another origin', async () => {
      const { page } = session;
      await setChangesOpen(page, false);
      await goHome(page);
      setGh(gh);
      const branch = join(ship.parent, 'wt-api');
      const clean = join(ship.parent, 'wt-api-clean');
      const detached = join(ship.parent, 'wt-api-detached');
      gitIn(ship.root, 'worktree', 'add', '--quiet', '-b', 'ship-api', branch, 'main');
      gitIn(ship.root, 'worktree', 'add', '--quiet', '-b', 'ship-api-clean', clean, 'main');
      gitIn(ship.root, 'worktree', 'add', '--quiet', '--detach', detached, 'main');
      writeFileSync(join(branch, 'dirty.txt'), 'dirty\n');
      const elsewhere = join(ship.parent, 'not-a-worktree');
      mkdirSync(elsewhere);

      const call = (method: string, args: unknown[]) =>
        page.evaluate(
          ([method, args]) =>
            (window as unknown as { api: { workspaces: Record<string, (...args: unknown[]) => Promise<unknown>> } }).api.workspaces[method as string]!(
              ...(args as unknown[]),
            ),
          [method, args] as const,
        );
      const refused = (message: string) => ({ status: 'refused', message });
      const gitLines = () => readFileSync(fx.gitLog, 'utf8').split('\n').filter(Boolean).length;
      const headsBefore = [branch, clean, detached].map((path) => gitIn(path, 'rev-parse', 'HEAD'));
      const originBefore = gitIn(origin, 'for-each-ref');
      const ghBefore = ghRuns(gh).length;
      const gitBefore = gitLines();

      const extra: Record<string, unknown[]> = { status: [], commit: ['A message'], push: [], pullRequest: [], createPullRequest: ['A title', 'A body'] };
      for (const [method, args] of Object.entries(extra)) {
        expect(await call(method, ['/no/such/project', '/no/such/project/ws', ...args]), `${method}: unknown project`).toEqual(
          refused('/no/such/project is not a project in Cockpit.'),
        );
        expect(await call(method, [ship.root, elsewhere, ...args]), `${method}: not a worktree`).toEqual(refused(`${elsewhere} is not a workspace of ${ship.name}.`));
        expect(await call(method, [ship.root, ship.root, ...args]), `${method}: main working tree`).toEqual(refused(`${ship.root} is not a workspace of ${ship.name}.`));
      }
      expect(await call('commit', [ship.root, branch, '   '])).toEqual(refused('Write a commit message.'));
      expect(await call('commit', [ship.root, clean, 'A message'])).toEqual(refused('Nothing to commit.'));
      expect(await call('createPullRequest', [ship.root, clean, '   ', ''])).toEqual(refused('Write a title.'));
      expect(await call('push', [ship.root, detached])).toEqual(refused('wt-api-detached has no branch.'));
      expect(await call('createPullRequest', [ship.root, detached, 'A title', ''])).toEqual(refused('wt-api-detached has no branch.'));

      // Nothing ran: no commit, push or pull request, no gh run, the dirty file still uncommitted.
      expect(ghRuns(gh)).toHaveLength(ghBefore);
      const ran = readFileSync(fx.gitLog, 'utf8').split('\n').filter(Boolean).slice(gitBefore);
      expect(ran.filter((line) => ['add', 'commit', 'push'].includes(line.split(' ')[1]!))).toEqual([]);
      expect([branch, clean, detached].map((path) => gitIn(path, 'rev-parse', 'HEAD'))).toEqual(headsBefore);
      expect(gitIn(branch, 'status', '--porcelain')).toBe('?? dirty.txt');
      expect(gitIn(origin, 'for-each-ref')).toBe(originBefore);

      // From another origin the handlers reject.
      const origins = await session.evaluateInMain<Record<string, string>>(`(async () => {
        const handlers = ${INVOKE_HANDLERS};
        const calls = {
          'workspaces:status': [${JSON.stringify(ship.root)}, ${JSON.stringify(clean)}],
          'workspaces:commit': [${JSON.stringify(ship.root)}, ${JSON.stringify(branch)}, 'A message'],
          'workspaces:push': [${JSON.stringify(ship.root)}, ${JSON.stringify(clean)}],
          'workspaces:pull-request': [${JSON.stringify(ship.root)}, ${JSON.stringify(clean)}],
          'workspaces:create-pull-request': [${JSON.stringify(ship.root)}, ${JSON.stringify(clean)}, 'A title', ''],
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
        'workspaces:status': 'rejected',
        'workspaces:commit': 'rejected',
        'workspaces:push': 'rejected',
        'workspaces:pull-request': 'rejected',
        'workspaces:create-pull-request': 'rejected',
      });
      expect(ghRuns(gh)).toHaveLength(ghBefore);
      expect(gitIn(branch, 'status', '--porcelain')).toBe('?? dirty.txt');
      expect(gitIn(origin, 'for-each-ref')).toBe(originBefore);
    });
  });
});
