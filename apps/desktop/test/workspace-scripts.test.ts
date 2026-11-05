import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { launchBuilt, type Session, untilRead, versionLabel } from './launch';
import { addRepository, branchBox, collectedPtyData, collectPtyData, countIpcCalls, deleteButton, dialogTerminal, dispatchFocus, entryTitles, gitIn, holdWaiter, linkedWorktrees, localBranches, makeLightRepo, openDeleteDialog, openDialogs, readRecords, removeOptions, sidebarLines, teardownApi, type TempRepo, untilFewerOverlays, waiters, waitForDialogLine, waitForEntries, waitForEntry, waitForNoEntry, writeConfig, writeScripts } from './support/projects';
import { expectNoErrors } from './support/sessions';
import { dropTerminalWorkspace, focusPane, getShellPath, normalizeFnm, ptyHostPid, rowsOf, waitForRow, watchFrontmost } from './support/terminal';

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

  // Setup and teardown scripts of a workspace (COCKPIT-32): the repository's `.cockpit/config.json`
  // is rewritten by each test. The commands call the scripts `writeScripts` keeps in the main
  // working tree and wait on marker files the test creates, so a test decides when a command ends.
  // The tests share the session, with no agent (the setup that starts one is in `sessions: built app`).
  describe('workspace scripts', () => {
    let repo: TempRepo;
    const folders: TempRepo[] = [];

    beforeAll(async () => {
      repo = makeLightRepo('ws-scripts');
      folders.push(repo);
      writeScripts(repo);
      await session.page.getByText(versionLabel).waitFor();
      await addRepository(session, repo);
    });

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
        await session.page.evaluate(async () => {
          const { projects } = (globalThis as unknown as { api: { projects: { list(): Promise<{ path: string }[]>; remove(path: string): Promise<void> } } }).api;
          for (const project of await projects.list()) await projects.remove(project.path);
        });
        await session.page.reload();
        await session.page.getByText(versionLabel).waitFor();
        await waitForEntries(session.page, []);
      } finally {
        for (const folder of folders) rmSync(folder.parent, { recursive: true, force: true });
      }
    });

    const isListed = async (path: string) => (await entryTitles(session.page)).includes(path);
    const waitListed = (path: string) => waitForEntry(session.page, path);
    const waitUnlisted = (path: string) => waitForNoEntry(session.page, path);

    // A workspace made with git itself (no setup), listed once the window gains the focus.
    async function addExternal(name: string): Promise<string> {
      const path = join(repo.parent, `wt-${name}`);
      gitIn(repo.root, 'worktree', 'add', '--quiet', '-b', name, path, 'main');
      await dispatchFocus(session.page);
      await waitListed(path);
      return path;
    }

    // Opens the deletion dialog of a workspace (`addExternal`'s `wt-<name>` folder holds the branch `<name>`), waits
    // until it has read the workspace, and confirms it.
    async function confirmDeletion(path: string) {
      const { page } = session;
      const dialog = await openDeleteDialog(page, path, basename(path).slice('wt-'.length));
      await deleteButton(dialog).click();
      return openDialogs(page);
    }

    // COCKPIT-68 AC17: what the dialog looks like while the teardown runs. Self-contained, for `untilRead`.
    const readTeardownBlock = () => {
      const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement | null;
      const xterm = dialog?.querySelector('.xterm') as HTMLElement | null;
      if (!dialog || !xterm) return null;
      let box: HTMLElement | null = xterm.parentElement;
      while (box && box !== dialog && box.offsetHeight !== 120) box = box.parentElement;
      // The element whose own text is the label (it may hold an icon besides).
      const ownText = (element: Element) =>
        [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').trim();
      const label = [...dialog.querySelectorAll('*')].find((element) => /^(Running teardown…|Teardown)$/.test(ownText(element)));
      const del = [...dialog.querySelectorAll('button')].find((button) => /^\s*Delete\s*$/.test(button.textContent ?? ''));
      return {
        width: dialog.offsetWidth,
        boxHeight: box && box !== dialog ? box.offsetHeight : null,
        boxTop: box && box !== dialog ? box.getBoundingClientRect().top : null,
        label: label ? ownText(label) : null,
        labelBottom: label ? label.getBoundingClientRect().bottom : null,
        deleteDisabled: !!del && (del.disabled || del.getAttribute('aria-disabled') === 'true'),
        spinner: !!del?.querySelector('svg'),
      };
    };

    const records = (file: string) => readRecords(repo, file);
    const linesIn = (file: string) => {
      const path = join(repo.root, file);
      return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
    };

    test('AC13, AC17, setup through the CLI AC11, COCKPIT-68 AC17 — Delete runs `cockpit teardown` in a terminal of the dialog (header, "$ <command>" lines in order with their output, "✓ Teardown done", environment, worktree as cwd), and once it exits 0 the folder, the worktree, the branch and the row go', async () => {
      const { page } = session;
      const record = 'sh "$COCKPIT_ROOT_PATH/record.sh" teardown-env.txt';
      const wait = 'sh "$COCKPIT_ROOT_PATH/waitfor.sh" go-td';
      writeConfig(repo, { teardown: [record, 'echo teardown-second', wait] });
      const waiter = holdWaiter(repo, 'go-td');
      const path = await addExternal('td-ok');
      await collectPtyData(page);

      const opened = await openDeleteDialog(page, path, 'td-ok');
      expect(await opened.evaluate((element) => (element as HTMLElement).offsetWidth), 'before Delete').toBe(420);
      await deleteButton(opened).click();
      const dialog = openDialogs(page);
      const pane = await dialogTerminal(page);
      await waitForRow(page, `$ ${wait}`, pane);
      const rows = await rowsOf(pane);
      const at = (row: string) => rows.indexOf(row);
      expect(at('cockpit teardown · td-ok · .cockpit/config.json')).toBeGreaterThanOrEqual(0);
      expect(at('cockpit teardown · td-ok · .cockpit/config.json')).toBeLessThan(at(`$ ${record}`));
      expect(at(`$ ${record}`)).toBeGreaterThanOrEqual(0);
      expect(at(`$ ${record}`)).toBeLessThan(at('$ echo teardown-second'));
      expect(rows[at('$ echo teardown-second') + 1]).toBe('teardown-second');
      expect(at('$ echo teardown-second')).toBeLessThan(at(`$ ${wait}`));
      await waiter.pid();
      // COCKPIT-68 AC17: the dialog grew to 460 px, "Running teardown…" sits above a 120 px terminal box, and Delete is
      // disabled with a spinner.
      const running = (await untilRead(page, readTeardownBlock, (found) => found !== null && found.width === 460))!;
      expect(running.label).toBe('Running teardown…');
      expect(running.boxHeight, 'the terminal box').toBe(120);
      expect(running.labelBottom!, 'the label is above the box').toBeLessThanOrEqual(running.boxTop! + 1);
      expect(running.deleteDisabled, 'Delete is disabled').toBe(true);
      expect(running.spinner, 'Delete shows a spinner').toBe(true);
      // Nothing is removed while the teardown runs.
      expect(existsSync(path)).toBe(true);
      expect(await isListed(path)).toBe(true);
      expect(await dialog.first().isVisible()).toBe(true);

      await waiter.release();
      await dialog.first().waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      // The dialog is gone by now: the terminal's whole output was collected from the pty.
      const printed = await collectedPtyData(page);
      expect(printed.indexOf('✓ Teardown done')).toBeGreaterThan(printed.indexOf('teardown-second'));
      expect(printed).not.toContain('Teardown failed');
      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(repo).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(repo)).not.toContain('td-ok');
      const found = records('teardown-env.txt');
      expect(found).toHaveLength(1);
      expect(found[0]!.root).toBe(repo.root);
      expect(found[0]!.ws).toBe(path);
      expect(found[0]!.name).toBe('td-ok');
      expect(found[0]!.term).toBe('xterm-256color');
      expect(found[0]!.pwd).toBe(path);
      // The CLI's folder may come first (it is on the PATH of every terminal): the login shell's PATH ends it.
      expect(normalizeFnm(found[0]!.path!).endsWith(normalizeFnm(await getShellPath(page)))).toBe(true);
    }, 60_000);

    test('AC14, setup through the CLI AC11, COCKPIT-68 AC17 — a failing teardown keeps the worktree and the row, labels the terminal "Teardown" and shows its output, the CLI\'s "✗ Teardown failed" line, "Teardown failed with exit code N" and "Delete anyway", which removes the worktree and keeps the unchecked branch without a "was kept" line and without running the teardown again', async () => {
      const { page } = session;
      writeConfig(repo, { teardown: ['echo td-fail-output', 'echo ran >> "$COCKPIT_ROOT_PATH/td14.log"; exit 5'] });
      const path = await addExternal('td-fail');
      const commit = (gitIn(path, 'commit', '--allow-empty', '-m', 'unmerged work'), gitIn(path, 'rev-parse', 'HEAD'));
      await collectPtyData(page);

      const dialog = await confirmDeletion(path);
      await dialog.getByText('Teardown failed with exit code 5').waitFor();
      expect(await rowsOf(await dialogTerminal(page))).toContain('td-fail-output');
      // COCKPIT-57 AC11: the CLI's own line names the command that failed.
      const printed = await collectedPtyData(page);
      expect(printed).toContain('cockpit teardown · td-fail · .cockpit/config.json');
      expect(printed).toContain('✗ Teardown failed: echo ran >> "$COCKPIT_ROOT_PATH/td14.log"; exit 5 exited with code 5');
      expect((await untilRead(page, readTeardownBlock, (found) => found?.label === 'Teardown'))!.label).toBe('Teardown');
      expect(await deleteButton(dialog, 'Delete anyway').count()).toBe(1);
      expect(await branchBox(dialog, 'td-fail').isChecked(), 'the box stays as it was shown').toBe(false);
      expect(existsSync(path)).toBe(true);
      expect(await isListed(path)).toBe(true);
      expect(linesIn('td14.log')).toHaveLength(1);

      await deleteButton(dialog, 'Delete anyway').click();
      await dialog.first().waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(repo).map((worktree) => worktree.path)).not.toContain(path);
      expect(localBranches(repo)).toContain('td-fail');
      expect(gitIn(repo.root, 'rev-parse', 'td-fail')).toBe(commit);
      expect((await entryTitles(page)).includes(path)).toBe(false);
      expect((await sidebarLines(page)).filter((line) => line.startsWith('Branch '))).toEqual([]);
      expect(linesIn('td14.log')).toHaveLength(1);
    }, 60_000);

    test('COCKPIT-68 AC15 — a teardown that writes a file into a worktree that was clean: nothing is removed, the dialog stays open with the warning, and the next Delete removes the worktree without running the teardown again', async () => {
      writeConfig(repo, { teardown: ['echo ran >> "$COCKPIT_ROOT_PATH/td15.log"', 'touch "$COCKPIT_WORKSPACE_PATH/made-by-teardown.txt"'] });
      const path = await addExternal('td-dirty');

      const dialog = await confirmDeletion(path);
      await waitForDialogLine(dialog, /^It has uncommitted changes\. They will be lost\.$/);
      expect(linesIn('td15.log')).toHaveLength(1);
      expect(existsSync(join(path, 'made-by-teardown.txt'))).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(await isListed(path)).toBe(true);
      expect(await dialog.first().isVisible()).toBe(true);

      await deleteButton(dialog).click();
      await dialog.first().waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linesIn('td15.log')).toHaveLength(1);
    });

    test('COCKPIT-68 AC25 — a failing teardown on a worktree with the warning on screen: one "Delete anyway" removes the worktree with its changes (force sent) and does not run the teardown again', async () => {
      const { page } = session;
      writeConfig(repo, { teardown: ['echo ran >> "$COCKPIT_ROOT_PATH/td25.log"; exit 4'] });
      const path = await addExternal('td-force');
      writeFileSync(join(path, 'unsaved.txt'), 'uncommitted work\n');
      await countIpcCalls(session, ['workspaces:remove']);
      const removesBefore = (await removeOptions(session)).length;

      const dialog = await openDeleteDialog(page, path, 'td-force');
      expect(await dialog.innerText()).toContain('It has uncommitted changes. They will be lost.');
      await deleteButton(dialog).click();
      await dialog.getByText('Teardown failed with exit code 4').waitFor();
      expect(existsSync(path)).toBe(true);
      expect(linesIn('td25.log')).toHaveLength(1);

      await deleteButton(dialog, 'Delete anyway').click();
      await dialog.first().waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(repo).map((worktree) => worktree.path)).not.toContain(path);
      expect(linesIn('td25.log')).toHaveLength(1);
      const sent = (await removeOptions(session)).slice(removesBefore);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.force, 'the warning was on screen').toBe(true);
    });

    test('AC15 — Escape on a running teardown ends its process and keeps the workspace', async () => {
      const { page } = session;
      writeConfig(repo, { teardown: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-td'] });
      const waiter = holdWaiter(repo, 'never-td', { watchGone: true });
      const path = await addExternal('td-cancel');

      const dialog = await confirmDeletion(path);
      await waiter.pid();

      await page.keyboard.press('Escape');
      await dialog.first().waitFor({ state: 'hidden' });

      await waiter.gone;
      expect(existsSync(path)).toBe(true);
      expect(linkedWorktrees(repo).map((worktree) => worktree.path)).toContain(path);
      expect(localBranches(repo)).toContain('td-cancel');
      expect(await isListed(path)).toBe(true);
    });

    test('AC14 — Ctrl+C in the teardown terminal is a failure: the CLI says "was killed by SIGINT", the dialog says the teardown failed or ended with Delete anyway, and the worktree and the row stay', async () => {
      const { page } = session;
      writeConfig(repo, { teardown: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-sig-td'] });
      const waiter = holdWaiter(repo, 'never-sig-td', { watchGone: true });
      const path = await addExternal('td-signal');
      await collectPtyData(page);

      const dialog = await confirmDeletion(path);
      await waiter.pid();
      await focusPane(await dialogTerminal(page));
      await page.keyboard.press('Control+c');

      await dialog.getByText(/Teardown (failed with exit code \d+|ended before it finished\.)/).waitFor();
      expect(await collectedPtyData(page)).toMatch(/✗ Teardown failed: .*waitfor\.sh.* was killed by SIGINT/);
      await waiter.gone;
      expect(await deleteButton(dialog, 'Delete anyway').count()).toBe(1);
      expect(existsSync(path)).toBe(true);
      expect(linkedWorktrees(repo).map((worktree) => worktree.path)).toContain(path);
      expect(localBranches(repo)).toContain('td-signal');
      expect(await isListed(path)).toBe(true);
    });

    test('AC16 — a config readWorkspaceConfig refuses removes nothing on Delete and shows its message with Delete anyway, which removes the workspace', async () => {
      writeConfig(repo, { run: ['bun dev'] });
      const path = await addExternal('td-bad');
      const { page } = session;
      const refused = await teardownApi(page, repo.root, path);
      expect(refused.status).toBe('refused');

      const dialog = await confirmDeletion(path);
      await dialog.getByText(refused.message!).first().waitFor();
      expect(await deleteButton(dialog, 'Delete anyway').count()).toBe(1);
      expect(existsSync(path)).toBe(true);
      expect(localBranches(repo)).toContain('td-bad');
      expect(await isListed(path)).toBe(true);

      await deleteButton(dialog, 'Delete anyway').click();
      await dialog.first().waitFor({ state: 'hidden' });
      await waitUnlisted(path);

      expect(existsSync(path)).toBe(false);
      expect(localBranches(repo)).not.toContain('td-bad');
    });

    test('AC18 — workspaces.teardown refuses a project that is not in Cockpit and a path that is not one of its linked worktrees, and spawns nothing', async () => {
      const { page } = session;
      writeConfig(repo, { setup: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-18'], teardown: ['sh "$COCKPIT_ROOT_PATH/waitfor.sh" never-18'] });
      // If a run did start the script, it would block and show.
      const waiter = holdWaiter(repo, 'never-18');
      const elsewhere = join(repo.parent, 'not-a-worktree');
      mkdirSync(elsewhere);

      expect(await teardownApi(page, '/no/such/project', '/no/such/project/ws')).toEqual({
        status: 'refused',
        message: '/no/such/project is not a project in Cockpit.',
      });
      expect(await teardownApi(page, repo.root, elsewhere)).toEqual({
        status: 'refused',
        message: `${elsewhere} is not a workspace of ${repo.name}.`,
      });
      // The main working tree is the project, not a workspace.
      expect(await teardownApi(page, repo.root, repo.root)).toEqual({
        status: 'refused',
        message: `${repo.root} is not a workspace of ${repo.name}.`,
      });

      // The daemon answers in order: once it ran a probe shell it has handled any spawn the calls would have sent.
      await ptyHostPid(page);
      expect(waiters(repo, 'never-18')).toEqual([]);
      // No run reported its pid: the reader of that FIFO is closed here, not at the end of the worker.
      waiter.close();
    });
  });
});
