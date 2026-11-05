import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { launchBuilt, launchSpawned, type Session, untilRead, versionLabel } from './launch';
import { makeTestDir } from './run-root';
import { addProject, afterIpcAnswers, entryTitles, isBelowProjectsHeader, makePlainFolder, makeRepo, projectsGit, projectsInState, readGitAlert, refusalsShown, removeThroughMenu, sidebarEntries, sidebarLines, snapshotRepo, stateSnapshot, type TempRepo, waitForEntries, waitForLine } from './support/projects';
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

    test('AC2 — adding the same repository again, by its root or a subfolder, keeps one entry, shows a message and leaves state.json alone', async () => {
      const { page } = session;
      const message = `${alpha.name} is already in Cockpit.`;
      const before = stateSnapshot(session.dataDir);

      for (const pick of [alpha.root, join(alpha.root, 'src')]) {
        await addProject(session, pick);
        await waitForLine(page, message);

        expect(await entryTitles(page)).toEqual([alpha.root]);
        expect(await refusalsShown(page)).toEqual([message]);
        expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
        expect(stateSnapshot(session.dataDir)).toEqual(before);
      }
    });

    test('AC3 — a folder outside any git repository is refused with a message, no entry and state.json untouched', async () => {
      const { page } = session;
      const message = `${plain.root} is not in a git repository.`;
      const before = stateSnapshot(session.dataDir);

      await addProject(session, plain.root);
      await waitForLine(page, message);

      expect(await entryTitles(page)).toEqual([alpha.root]);
      expect(await refusalsShown(page)).toEqual([message]);
      expect(await isBelowProjectsHeader(page, { text: message })).toBe(true);
      expect(stateSnapshot(session.dataDir)).toEqual(before);
    });

    test('AC4 — a message goes away when a valid repository is added, and the project appears', async () => {
      const { page } = session;
      expect(await refusalsShown(page), 'a message is shown before the add').not.toEqual([]);

      await addProject(session, bravo.root);
      await waitForEntries(page, [alpha.root, bravo.root]);

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

    test('AC6 — the "…" menu offers "Remove from Cockpit" (Files stay on disk); picking it removes the entry at once and leaves the repository on disk', async () => {
      const { page } = session;
      const alphaOnDisk = snapshotRepo(alpha);
      const bravoOnDisk = snapshotRepo(bravo);

      await removeThroughMenu(page, bravo.root);
      await waitForEntries(page, [alpha.root]);
      // No confirmation to answer.
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(await page.getByRole('alertdialog').count()).toBe(0);
      expect(projectsInState(session.dataDir)).toEqual([{ path: alpha.root }]);
      expect(snapshotRepo(bravo)).toEqual(bravoOnDisk);

      await removeThroughMenu(page, alpha.root);
      await waitForEntries(page, []);
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(await page.getByRole('alertdialog').count()).toBe(0);
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

  test('AC12 — adding a repository is refused with "git is not installed", no entry, and state.json untouched', async () => {
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    const before = stateSnapshot(session.dataDir);

    await addProject(session, repo.root);
    // The line is the refusal the add answered: no entry was added by then.
    await waitForLine(page, 'git is not installed');

    expect(await entryTitles(page)).toEqual([]);
    expect(await isBelowProjectsHeader(page, { text: 'git is not installed' })).toBe(true);
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    expect(projectsInState(session.dataDir) ?? []).toEqual([]);
    expect(existsSync(join(session.dataDir, 'state.json.tmp'))).toBe(false);
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
