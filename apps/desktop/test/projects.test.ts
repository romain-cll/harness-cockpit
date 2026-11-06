import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { launchBuilt, launchSpawned, type Session, untilRead, versionLabel } from './launch';
import { makeTestDir } from './run-root';
import { addProject, afterIpcAnswers, countIpcCalls, entryTitles, ipcCalls, isBelowProjectsHeader, makePlainFolder, makeRepo, openDialogs, projectsGit, projectsInState, readGitAlert, refusalsShown, removeThroughMenu, sidebarEntries, sidebarLines, snapshotRepo, startProjectRemoval, stateSnapshot, type TempRepo, untilFewerOverlays, waitForEntries } from './support/projects';
import { expectNoErrors } from './support/sessions';
import { dropTerminalWorkspace, watchFrontmost } from './support/terminal';

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

  // The picker is stubbed in the main process (`session.evaluateInMain`). The
  // tests share the session and run in order: the repository added by AC1 is
  // the one AC2 adds again, and AC6 removes what AC1 and AC4 added.
  describe('projects', () => {
    let alpha: TempRepo;
    let bravo: TempRepo;
    let plain: TempRepo;
    const folders: TempRepo[] = [];

    beforeAll(() => {
      alpha = makeRepo('alpha-project');
      bravo = makeRepo('bravo-project');
      plain = makePlainFolder('not-a-repository');
      folders.push(alpha, bravo, plain);
    });

    afterAll(() => {
      for (const folder of folders) rmSync(folder.parent, { recursive: true, force: true });
    });

    // A failing test must not leave a menu or a dialog that blocks the tests after it.
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

    test('AC1 — adding a subfolder of a repository lists the repository by name, titled with its root, and stores its root', async () => {
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      expect(await sidebarLines(page)).toContain('Projects');
      expect(await entryTitles(page)).toEqual([]);

      await addProject(session, join(alpha.root, 'src'));
      await waitForEntries(page, [alpha.root]);

      const entries = await sidebarEntries(page);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.title).toBe(alpha.root);
      expect(entries[0]!.text).toContain(alpha.name);
      expect(await isBelowProjectsHeader(page, { title: alpha.root })).toBe(true);

      // `saveState` ran before the answer the sidebar shows.
      expect(projectsInState(session.dataDir)).toEqual([{ path: alpha.root }]);
      expect(existsSync(join(session.dataDir, 'state.json.tmp'))).toBe(false);
    });

    test('AC2, COCKPIT-72 AC7 — adding the same repository again, by its root or a subfolder, keeps one entry and opens a dialog with one OK button saying "<name> is already in Cockpit."; the Projects section shows no message and state.json is left alone', async () => {
      const { page } = session;
      const message = `${alpha.name} is already in Cockpit.`;
      const before = stateSnapshot(session.dataDir);

      for (const pick of [alpha.root, join(alpha.root, 'src')]) {
        await addProject(session, pick);
        const dialog = openDialogs(page).filter({ hasText: message });
        await dialog.waitFor();

        expect(await dialog.getByRole('button', { name: 'OK', exact: true }).count()).toBe(1);
        expect(await dialog.getByRole('button', { name: 'Cancel' }).count()).toBe(0);
        expect(await entryTitles(page)).toEqual([alpha.root]);
        expect(await page.locator('aside [role="status"]').count()).toBe(0);
        expect(await refusalsShown(page)).toEqual([]);
        expect(stateSnapshot(session.dataDir)).toEqual(before);

        await dialog.getByRole('button', { name: 'OK', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
      }
    });

    test('AC3, COCKPIT-72 AC5 — a folder outside any git repository opens "This folder is not a git repository" naming the folder, with Cancel and "Initialize git repository"; no entry, no message, state.json untouched, and Cancel closes it and changes nothing', async () => {
      const { page } = session;
      const before = stateSnapshot(session.dataDir);
      const onDisk = readdirSync(plain.root);

      await addProject(session, plain.root);
      const dialog = openDialogs(page).filter({ hasText: 'This folder is not a git repository' });
      await dialog.waitFor();

      expect(await dialog.innerText()).toContain(plain.root);
      expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(1);
      expect(await dialog.getByRole('button', { name: 'Initialize git repository', exact: true }).count()).toBe(1);
      expect(await entryTitles(page)).toEqual([alpha.root]);
      expect(await page.locator('aside [role="status"]').count()).toBe(0);
      expect(stateSnapshot(session.dataDir)).toEqual(before);

      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await afterIpcAnswers(page);
      expect(await entryTitles(page)).toEqual([alpha.root]);
      expect(stateSnapshot(session.dataDir)).toEqual(before);
      expect(existsSync(join(plain.root, '.git'))).toBe(false);
      expect(readdirSync(plain.root)).toEqual(onDisk);
    });

    test('AC4 — a valid repository added after the refusals is listed with no dialog and no message left', async () => {
      const { page } = session;
      expect(await openDialogs(page).count(), 'the refusals left no dialog open').toBe(0);

      await addProject(session, bravo.root);
      await waitForEntries(page, [alpha.root, bravo.root]);

      expect(await openDialogs(page).count()).toBe(0);
      expect(await refusalsShown(page)).toEqual([]);
      expect(projectsInState(session.dataDir)).toEqual([{ path: alpha.root }, { path: bravo.root }]);
    });

    test('AC5 — cancelling the picker changes neither the list, nor state.json, and shows no message', async () => {
      const { page } = session;
      expect(await refusalsShown(page)).toEqual([]);
      const before = stateSnapshot(session.dataDir);

      await addProject(session, null);
      // The picker answered (`addProject`); the answer of the add that follows shows nothing, so the page
      // waits for the main process's later replies.
      await afterIpcAnswers(page);

      expect(await entryTitles(page)).toEqual([alpha.root, bravo.root]);
      expect(await refusalsShown(page)).toEqual([]);
      expect(stateSnapshot(session.dataDir)).toEqual(before);
    });

    test('COCKPIT-68 AC4 — "Remove project…" opens "Remove <name>?" saying what is removed and what stays, with Cancel and Remove; the project is still listed and in state.json', async () => {
      const { page } = session;
      const before = stateSnapshot(session.dataDir);

      const dialog = await startProjectRemoval(page, bravo.root);

      const text = await dialog.innerText();
      expect(text).toContain(`Remove ${bravo.name}?`);
      expect(text).toContain('This removes the project from Cockpit. The repository stays on disk, and the sessions running in its workspaces end.');
      expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(1);
      expect(await dialog.getByRole('button', { name: 'Remove', exact: true }).count()).toBe(1);
      expect(await entryTitles(page)).toEqual([alpha.root, bravo.root]);
      expect(stateSnapshot(session.dataDir)).toEqual(before);
      expect(projectsInState(session.dataDir)).toEqual([{ path: alpha.root }, { path: bravo.root }]);

      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    });

    test('COCKPIT-68 AC5 — Cancel and Escape close the dialog: the project stays listed and in state.json, and no removal reaches the main process', async () => {
      const { page } = session;
      const before = stateSnapshot(session.dataDir);
      await countIpcCalls(session, ['projects:remove']);
      const removesBefore = await ipcCalls(session, 'projects:remove');
      const onDisk = snapshotRepo(bravo);

      const first = await startProjectRemoval(page, bravo.root);
      await first.getByRole('button', { name: 'Cancel', exact: true }).click();
      await first.waitFor({ state: 'hidden' });
      const second = await startProjectRemoval(page, bravo.root);
      await page.keyboard.press('Escape');
      await second.waitFor({ state: 'hidden' });
      await afterIpcAnswers(page);

      expect(await ipcCalls(session, 'projects:remove')).toBe(removesBefore);
      expect(await entryTitles(page)).toEqual([alpha.root, bravo.root]);
      expect(stateSnapshot(session.dataDir)).toEqual(before);
      expect(snapshotRepo(bravo)).toEqual(onDisk);
    });

    test('COCKPIT-68 AC6 — Remove takes the project out of the sidebar and state.json at once and leaves the repository on disk', async () => {
      const { page } = session;
      const alphaOnDisk = snapshotRepo(alpha);
      const bravoOnDisk = snapshotRepo(bravo);

      await removeThroughMenu(page, bravo.root);
      await waitForEntries(page, [alpha.root]);
      expect(await page.getByRole('alertdialog').count()).toBe(0);
      expect(projectsInState(session.dataDir)).toEqual([{ path: alpha.root }]);
      expect(snapshotRepo(bravo)).toEqual(bravoOnDisk);

      await removeThroughMenu(page, alpha.root);
      await waitForEntries(page, []);
      expect(projectsInState(session.dataDir)).toEqual([]);
      expect(snapshotRepo(alpha)).toEqual(alphaOnDisk);
      expect(alphaOnDisk.hasGit).toBe(true);
      expect(basename(alpha.root)).toBe(alpha.name);
    });
  });
});

// A login shell that prints an environment whose PATH holds no git. A real
// `/bin/sh -l` would source `/etc/profile`, whose `path_helper` puts `/usr/bin`
// back, so the fake shell sets the PATH of the shell that prints the environment
// itself (`$2` is the command `resolveShellEnv` asks for: `env -0`, by absolute
// path, between two printf markers).
function makeShellWithoutGit(dir: string): string {
  const empty = join(dir, 'empty-bin');
  mkdirSync(empty);
  const shell = join(dir, 'shell-without-git');
  writeFileSync(shell, `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\nPATH='${empty}' /bin/sh -c "$2"\n`);
  chmodSync(shell, 0o755);
  // macOS scans a new executable the first time it runs.
  execFileSync(shell, ['--warmup']);
  // The premise of the test: no git on the PATH this shell prints.
  const printed = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  expect(printed).toBe(empty);
  return shell;
}

describe('built app with no git on the login shell PATH', () => {
  let folder: string;
  let repo: TempRepo;
  let session: Session;

  beforeAll(async () => {
    folder = makeTestDir('f-');
    repo = makeRepo('no-git-project');
    const executablePath: string = createRequire(import.meta.url)('electron');
    session = await launchSpawned(executablePath, ['.'], true, undefined, {
      ...process.env,
      SHELL: makeShellWithoutGit(folder),
    });
  });

  afterAll(async () => {
    await session?.close();
    rmSync(folder, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  test('AC12, COCKPIT-72 AC7 — adding a repository is refused with a dialog with one OK button saying "git is not installed", no entry, no message in the Projects section, and state.json untouched', async () => {
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    const before = stateSnapshot(session.dataDir);

    await addProject(session, repo.root);
    const dialog = openDialogs(page).filter({ hasText: 'git is not installed' });
    await dialog.waitFor();

    expect(await dialog.getByRole('button', { name: 'OK', exact: true }).count()).toBe(1);
    expect(await entryTitles(page)).toEqual([]);
    expect(await page.locator('aside [role="status"]').filter({ hasText: 'git is not installed' }).count()).toBe(0);
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    expect(projectsInState(session.dataDir) ?? []).toEqual([]);
    expect(existsSync(join(session.dataDir, 'state.json.tmp'))).toBe(false);

    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  });

  test('COCKPIT-65 AC10 — an amber alert with a triangle-alert icon sits under the New workspace link and above the Projects header, and projects.git() answers "missing"', async () => {
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    expect(await projectsGit(page)).toBe('missing');
    const alert = await untilRead(page, readGitAlert, (found) => found !== null);
    expect(alert, 'the alert shows').not.toBeNull();
    expect(alert!.icon, 'a triangle-alert icon').toBe(true);
    expect(alert!.top, 'under the New workspace link').toBeGreaterThanOrEqual(alert!.terminalBottom - 1);
    expect(alert!.bottom, 'above the Projects header').toBeLessThanOrEqual(alert!.projectsTop + 1);
    const [r, g, b] = alert!.iconRgb;
    expect(r! >= 150 && r! > g! && g! >= 70 && g! > b! && b! <= 80, `the icon is amber, got rgb(${r}, ${g}, ${b})`).toBe(true);
  });
});
