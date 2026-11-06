import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { sendFromComposer } from '../composer';
import { freePort, isAlive, launchEnv, MAIN_PROCESS_ERROR, packagedAppDir, type Session, versionLabel } from '../launch';
import { makeTestDir } from '../run-root';
import { addProject, addRepository, chooseLocation, cloneButton, cloneDialog, deleteDialog, entryTitles, gitState, linkedWorktrees, localBranches, makeRepo, nameBox, pickAddItem, projectsInState, removeThroughMenu, sidebarEntries, sidebarLines, snapshotRepo, startDeletion, stateSnapshot, type TempRepo, urlBox, waitForEntries, worktreePath, writeConfig } from './projects';
import { startMainDeletion, waitForNoMainRow } from './main-workspace';
import { clearFocusCalls, FRONT_CALLS, frontCalls, runSecondLaunch, stubFocus } from './single-instance';
import { allConsoleErrorsOf, allPageErrorsOf, applicationType, captureRow, dropTerminalWorkspace, getShellPath, LAUNCHD_ENV, LAUNCHD_PATH, launchLaunchd, normalizeFnm, openTerminal, pidOf, ptyKill, type PtyWindow, ptyWrite, spawnShell, typeLine, unexpectedConsoleErrors, waitForOutput, waitForRow, watchFrontmost } from './terminal';

// Launches the app the four ways it runs: the dev server, the built app, the
// packaged app and the packaged app with the minimal environment launchd gives
// an app opened from the Finder or the Dock, and checks each one starts,
// renders, logs no error, stays in the background and writes its data in its
// own folder. In CI only, `packaged.test.ts` also launches the packaged app without the
// background switch.


export const describeMode = (mode: string, launch: () => Promise<Session>) => describe(mode, () => {
  let session: Session;
  let front: Awaited<ReturnType<typeof watchFrontmost>>;
  // The terminal tests run the shell the tests chose (`SHELL=/bin/sh`). The
  // launchd-environment mode runs the developer's real shell and its
  // configuration, so it only gets the PATH check (terminal AC12).
  const inIsolatedShell = launch !== launchLaunchd;
  // COCKPIT-48: a feature's full block runs once, in the built app. The other
  // modes run one smoke path per feature that goes through its IPC end to end
  // (`smoke paths` below), plus the checks that differ between modes.
  const full = mode === 'built app';

  beforeAll(async () => {
    front = await watchFrontmost();
    session = await launch();
  });

  afterAll(async () => {
    await front?.stop();
    await session?.close();
    // The folder is removed once the app has closed.
    if (session) expect(existsSync(session.dataDir)).toBe(false);
  });

  // The repository `openTerminal` made goes after each test, so the tests that follow list only their own projects.
  afterEach(async () => {
    if (session) await dropTerminalWorkspace(session);
  });

  test('shows the home page and the version from the main process', async () => {
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    // No project yet: the home page is the empty state (COCKPIT-72 AC1).
    await page.getByText('No projects yet', { exact: true }).waitFor();
    expect(await page.title()).toBe('Cockpit');
    expect(await page.getByRole('link', { name: 'New workspace', exact: true }).getAttribute('aria-current')).toBe('page');
  });

  test('keeps Node out of the renderer', async () => {
    // Checks Node's `process` rather than any `process`: TanStack Router defines
    // a `process.env` stub in development.
    const nodeGlobals = await session.page.evaluate(() => {
      const scope = globalThis as { require?: unknown; process?: { versions?: unknown } };
      return { require: typeof scope.require, versions: typeof scope.process?.versions };
    });
    expect(nodeGlobals).toEqual({ require: 'undefined', versions: 'undefined' });
  });

  test('follows the system color scheme', async () => {
    const { page } = session;
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    // COCKPIT-65 AC1, AC12: the `app` fill of the new tokens.
    expect(await background()).toBe('rgb(14, 14, 16)');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await background()).toBe('rgb(255, 255, 255)');
  });

  // COCKPIT-65 AC4, AC10, AC12: the smoke assertion of the modes that do not run the full block. The
  // launchd-environment mode is the one where the login shell's real PATH must find git.
  test.runIf(!full)('COCKPIT-65 AC4, AC10 smoke — the sidebar is 220 px wide and shows no git alert', async () => {
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    expect((await page.locator('aside').boundingBox())?.width).toBe(220);
    expect(await sidebarLines(page)).not.toContain('Git is not installed');
  });

  test('reloads to the same page', async () => {
    const { page } = session;
    await page.reload();
    await page.getByText(versionLabel).waitFor();
  });

  test('stays in the background', async () => {
    // No Dock icon (`UIElement`) and never the frontmost app, whichever app the
    // user brings to the front meanwhile.
    expect(await applicationType(session.pid)).toContain('"UIElement"');
    expect(await front.activated(session.pid)).toBe(false);
  });

  test('runs while hidden', async () => {
    const hidden = await session.page.evaluate(async () => ({
      visibility: document.visibilityState,
      // The frame comes, or the test's own guard fires: a page that does not run while hidden never answers.
      frame: await new Promise<boolean>((resolve) => requestAnimationFrame(() => resolve(true))),
    }));
    expect(hidden).toEqual({ visibility: 'visible', frame: true });
  });

  test('keeps its data in its own folder', async () => {
    // The state is loaded before the window opens, and the session is attached to that window.
    expect(readdirSync(session.dataDir)).not.toEqual([]);
  });

  test('AC7 — the output holds what the app wrote from its first line', async () => {
    // Chromium prints this line during startup, before the test attaches to the window.
    expect(session.output()).toContain('DevTools listening on');
  });

  test('AC1 (state) — the data folder holds state.json with version 1', async () => {
    const file = join(session.dataDir, 'state.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    expect(existsSync(join(session.dataDir, 'state.json.tmp'))).toBe(false);
  });

  test('AC1 — spawns a shell through window.api.pty and receives its output', async () => {
    const { page } = session;
    const id = await spawnShell(page);
    expect(typeof id).toBe('number');

    await ptyWrite(page, id, 'echo cockpit-$((6*7))\n');
    await waitForOutput(page, id, 'cockpit-42');

    await ptyKill(page, id);
  });

  // node-pty is N-API: electron-builder must ship its prebuilds as they are
  // (`npmRebuild: false`), not compile it in place.
  test.runIf(mode === 'packaged app')('ships the node-pty prebuilds, not a rebuilt copy', () => {
    const nodePty = join(packagedAppDir(), 'Contents/Resources/app.asar.unpacked/node_modules/node-pty');
    expect(existsSync(join(nodePty, 'prebuilds'))).toBe(true);
    expect(existsSync(join(nodePty, 'build'))).toBe(false);
  });

  test('login shell: AC3 — gets the PATH of the login shell from the main process', async () => {
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    const path = await getShellPath(page);
    expect(typeof path).toBe('string');
    expect(path).not.toBe('');
  });

  // The app is given the environment launchd gives an app opened from the
  // Finder, so the same environment can be given to the login shell.
  test.runIf(launch === launchLaunchd)(
    'login shell: AC1 — gets exactly the PATH printed by the login shell, not the launchd PATH',
    async () => {
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      const expected = execFileSync(LAUNCHD_ENV.SHELL!, ['-ilc', 'printf %s "$PATH"'], {
        cwd: homedir(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        // The same environment as the app's shell: launchd's plus the two test variables.
        env: {
          ...LAUNCHD_ENV,
          COCKPIT_TEST_BACKGROUND: '1',
          COCKPIT_USER_DATA_DIR: session.dataDir,
        },
      });
      const path = await getShellPath(page);
      expect(normalizeFnm(path)).toBe(normalizeFnm(expected));
      expect(path).not.toBe(LAUNCHD_PATH);
    },
  );

  // One smoke path per feature in the modes that do not run its full block: it
  // goes through the IPC end to end, with the same helpers as the full blocks.
  // In the launchd-environment mode these are the paths that spawn git.
  describe.runIf(!full)('smoke paths', () => {
    const folders: TempRepo[] = [];

    afterAll(() => {
      for (const folder of folders) rmSync(folder.parent, { recursive: true, force: true });
    });

    test.runIf(mode === 'dev server')(
      'single instance smoke path (AC1, AC2) — a second `bun run dev` on the same data folder exits with code 0 and the running app shows and focuses its window',
      async () => {
        await stubFocus(session);
        await clearFocusCalls(session);
        const before = stateSnapshot(session.dataDir);
        const env = launchEnv(true, session.dataDir, { ...process.env, SHELL: '/bin/sh' }, session.cockpitHome).env;

        const second = await runSecondLaunch(
          'bun',
          ['run', 'dev', '--remoteDebuggingPort', String(await freePort()), '--inspect', String(await freePort())],
          env,
        );

        expect(second.exit, `the second dev launch exited (output: ${second.output})`).toEqual({ code: 0, signal: null });
        expect([...new Set(await frontCalls(session))].sort()).toEqual(FRONT_CALLS);
        expect(stateSnapshot(session.dataDir)).toEqual(before);
        expect(session.isRunning()).toBe(true);
        expect(await front.activated(session.pid)).toBe(false);
      },
      120_000,
    );

    test('smoke path (a) — projects: a repository added through the picker is listed and stored, then removed through the "…" menu and left on disk', async () => {
      const { page } = session;
      const repo = makeRepo('smoke-project');
      folders.push(repo);
      await page.getByText(versionLabel).waitFor();
      expect(await entryTitles(page)).toEqual([]);

      await addProject(session, repo.root);
      await waitForEntries(page, [repo.root]);
      expect((await sidebarEntries(page))[0]!.text).toContain(repo.name);
      expect(projectsInState(session.dataDir)).toEqual([{ path: repo.root }]);

      const onDisk = snapshotRepo(repo);
      await removeThroughMenu(page, repo.root);
      await waitForEntries(page, []);
      expect(projectsInState(session.dataDir)).toEqual([]);
      expect(snapshotRepo(repo)).toEqual(onDisk);
      expect(onDisk.hasGit).toBe(true);
    });

    test('smoke path (c), COCKPIT-72 AC11 — clone: "Clone from Git…" clones a local repository through "Choose…" into <location>/<name>, parent folders created, lists and stores the project, then "Remove project…" leaves the clone on disk', async () => {
      const { page } = session;
      const source = makeRepo('smoke-clone-source');
      const location = realpathSync(makeTestDir('p-'));
      folders.push(source, { parent: location, root: location, name: 'location' });
      const target = join(location, 'a', 'smoke-clone');
      await page.getByText(versionLabel).waitFor();

      await pickAddItem(page, 'Clone from Git…');
      const dialog = cloneDialog(page);
      await dialog.waitFor();
      await urlBox(dialog).fill(source.root);
      await nameBox(dialog).fill('smoke-clone');
      await chooseLocation(session, dialog, join(location, 'a'), `Clones into ${join(location, 'a')}/smoke-clone`);
      await cloneButton(dialog).click();
      await dialog.waitFor({ state: 'hidden' });

      await waitForEntries(page, [target]);
      expect(projectsInState(session.dataDir)).toEqual([{ path: target }]);
      expect(existsSync(join(target, 'README.md'))).toBe(true);
      await removeThroughMenu(page, target);
      await waitForEntries(page, []);
      expect(projectsInState(session.dataDir)).toEqual([]);
      expect(existsSync(join(target, 'README.md'))).toBe(true);
    });

    test('smoke path (b), workspace scripts AC19, setup through the CLI AC11 — workspaces: the composer with "Terminal" creates a worktree under COCKPIT_HOME from the base main and lists it, its page opens with a shell tab that runs the setup (no agent); "Delete workspace…" runs `cockpit teardown`, which writes the login-shell PATH and the worktree path, then removes the folder, the worktree, the branch and the row', async () => {
      const { page } = session;
      const repo = makeRepo('smoke-workspace');
      folders.push(repo);
      const branch = 'smoke-ws';
      writeConfig(repo, {
        setup: ['touch "$COCKPIT_ROOT_PATH/setup-ran"'],
        teardown: ['printf \'%s\\n\' "$PATH" "$(pwd -P)" > "$COCKPIT_ROOT_PATH/teardown-out.txt"'],
      });
      await addRepository(session, repo);
      const path = worktreePath(session, repo, branch);

      // "Terminal" instead of an agent: no real CLI starts (the launchd launch finds the user's own).
      await sendFromComposer(page, repo, { prompt: 'Smoke ws', base: 'main' });
      await waitForEntries(page, [repo.root, path]);

      expect(existsSync(join(path, 'README.md'))).toBe(true);
      expect(linkedWorktrees(repo)).toContainEqual({ path, branch });
      expect(localBranches(repo)).toContain(branch);

      // No agent chosen (COCKPIT-70): the workspace page opens with a shell tab that runs `cockpit setup --shell`.
      await page.waitForURL((url) => url.pathname === '/workspace' && url.searchParams.get('path') === path);
      await waitForRow(page, '✓ Setup done');
      expect(existsSync(join(repo.root, 'setup-ran')), 'the setup ran in the shell tab').toBe(true);

      expect(existsSync(join(repo.root, 'teardown-out.txt'))).toBe(false);
      await startDeletion(page, path);
      const confirm = deleteDialog(page, `Delete ${branch}?`);
      await confirm.waitFor();
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await confirm.waitFor({ state: 'hidden' });
      await waitForEntries(page, [repo.root]);

      // The teardown ran through the CLI in the worktree, with the login shell's PATH (the CLI's folder may come first).
      const [teardownPath, teardownCwd] = readFileSync(join(repo.root, 'teardown-out.txt'), 'utf8').split('\n');
      expect(normalizeFnm(teardownPath!).endsWith(normalizeFnm(await getShellPath(page)))).toBe(true);
      expect(teardownCwd).toBe(path);
      expect(existsSync(path)).toBe(false);
      expect(linkedWorktrees(repo)).toEqual([]);
      expect(localBranches(repo)).not.toContain(branch);

      await removeThroughMenu(page, repo.root);
      await waitForEntries(page, []);
      expect(projectsInState(session.dataDir)).toEqual([]);
    });

    test('smoke path (d), COCKPIT-71 — main workspace: the composer with the Worktree switch off and "Terminal" opens a shell tab in the project\'s folder, making no branch and no worktree and marking the project; "Delete workspace…" removes the row and the mark and leaves the folder', async () => {
      const { page } = session;
      const repo = makeRepo('smoke-main');
      folders.push(repo);
      await addRepository(session, repo);
      const before = gitState(repo);

      await sendFromComposer(page, repo, { prompt: 'Smoke main', worktree: false });
      await typeLine(page, 'pwd -P');
      await waitForRow(page, repo.root);
      expect(gitState(repo)).toEqual(before);
      expect(linkedWorktrees(repo)).toEqual([]);
      expect(projectsInState(session.dataDir)).toEqual([{ path: repo.root, mainWorkspace: true }]);

      await startMainDeletion(page, repo.root, 'main');
      const confirm = deleteDialog(page, 'Delete main?');
      await confirm.waitFor();
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await confirm.waitFor({ state: 'hidden' });
      await waitForNoMainRow(page, repo.root);
      expect(projectsInState(session.dataDir)).toEqual([{ path: repo.root }]);
      expect(existsSync(join(repo.root, 'README.md'))).toBe(true);
      expect(gitState(repo)).toEqual(before);

      await removeThroughMenu(page, repo.root);
      await waitForEntries(page, []);
    });
  });

  test('logs no error and keeps running', async () => {
    const { page } = session;
    expect(await allConsoleErrorsOf(page)).toEqual([]);
    expect(await allPageErrorsOf(page)).toEqual([]);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(session.isRunning()).toBe(true);
    // Still never the frontmost app, after every check above.
    expect(await front.activated(session.pid)).toBe(false);
  });

  // A navigation away from the app, scripted from the page (a real Finder drop
  // cannot be produced over CDP), must change nothing: same URL, same page, same
  // shell. Not run in the launchd-environment mode (it runs the developer's real shell).
  describe.runIf(inIsolatedShell)('navigations away from the app', () => {
    // The file:// URL of a file that exists.
    const existingFileUrl = pathToFileURL(import.meta.filename).href;

    // The console messages and page errors of earlier tests are not this
    // suite's business, and its own (Chromium's refusal of the file:// URL) must
    // not reach the tests that follow.
    beforeAll(async () => {
      await session.page.clearConsoleMessages();
      await session.page.clearPageErrors();
    });
    afterAll(async () => {
      await session.page.clearConsoleMessages();
      await session.page.clearPageErrors();
    });

    // The main process's `will-navigate` events, recorded through the inspector. The app's
    // own guard listens first, so `prevented` tells whether it refused the URL.
    const watchNavigations = () =>
      session.evaluateInMain(`(() => {
        if (globalThis.__navigations) return;
        globalThis.__navigations = [];
        globalThis.__navigationListeners = [];
        for (const contents of require('electron').webContents.getAllWebContents()) {
          contents.on('will-navigate', (event, url) => {
            globalThis.__navigations.push({ url, prevented: event.defaultPrevented });
            for (const listener of globalThis.__navigationListeners) listener();
          });
        }
      })()`);

    // Arms the wait for the attempt's verdict, before the attempt: the main process saw `will-navigate`
    // for the URL and the guard refused it, or, for a `file://` URL that Chromium refuses before any navigation, the
    // console reports the refusal. Resolves with true.
    function armAttempt(target: string): Promise<boolean> {
      const { page } = session;
      if (new URL(target).protocol === 'file:') {
        const refusal = `Not allowed to load local resource: ${target}`;
        const seen = page.waitForEvent('console', { predicate: (message) => message.type() === 'error' && message.text() === refusal }).then(() => true);
        seen.catch(() => {});
        return seen;
      }
      const href = JSON.stringify(new URL(target).href);
      return session.evaluateInMain<boolean>(`new Promise((resolve) => {
        const refused = () => globalThis.__navigations.some(({ url, prevented }) => prevented && new URL(url).href === ${href});
        const check = () => refused() && (resolve(true), true);
        if (!check()) globalThis.__navigationListeners.push(check);
      })`);
    }

    // After a navigation attempt Playwright keeps a pending navigation that never
    // commits, and locator waits (`waitFor`, `click`) hang on it: from the attempt
    // on, the page is read and driven through `page.evaluate` and the keyboard only.
    async function attemptNavigation(target: string) {
      const { page } = session;
      await openTerminal(session);
      await watchNavigations();
      const appUrl = await page.evaluate(() => location.href);
      await typeLine(page, 'echo pid-$$');
      const [pid] = (await captureRow(page, /^pid-(\d+)$/)).map(Number);
      expect(isAlive(pid!)).toBe(true);

      try {
        const attempt = armAttempt(target);
        attempt.catch(() => {});
        await page.evaluate((url) => {
          location.href = url;
        }, target);
        const seen = await attempt;
        expect(seen, `the attempt to navigate to ${target} was seen and refused`).toBe(true);

        expect(await page.evaluate(() => location.href)).toBe(appUrl);
        // Still on the workspace page: its tab bar is there.
        expect(await page.evaluate(() => document.querySelector('[role="tablist"]') !== null)).toBe(true);
        expect(isAlive(pid!)).toBe(true);

        await page.evaluate(() => (document.querySelector('.xterm-helper-textarea') as HTMLElement | null)?.focus());
        await typeLine(page, 'echo cockpit-$((6*7))');
        await waitForRow(page, 'cockpit-42');
      } finally {
        // Load the app page again, whether or not the page left it, so the pending
        // navigation is gone and the next test can click.
        await page.goto(appUrl);
        await page.getByRole('tablist').first().waitFor();
      }
    }

    test('navigation AC2 — app://other/ leaves the page, its shell and its terminal as they were', async () => {
      await attemptNavigation('app://other/');
    });

    test('navigation AC3 — https://example.com/ leaves the page, its shell and its terminal as they were', async () => {
      await attemptNavigation('https://example.com/');
    });

    test('navigation AC4 — the file:// URL of an existing file leaves the page, its shell and its terminal as they were', async () => {
      await attemptNavigation(existingFileUrl);
    });

    test('navigation AC5 — those attempts log no console error but Chromium refusing the file:// URL they tried, no page error and no main-process error', async () => {
      const { page } = session;
      const errors = await allConsoleErrorsOf(page);
      // Only the refusal of the exact URL of navigation AC4 is allowed (tabs AC12).
      expect(unexpectedConsoleErrors(errors, existingFileUrl)).toEqual([]);
      expect(await allPageErrorsOf(page)).toEqual([]);
      expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
      expect(session.isRunning()).toBe(true);
    });

    // How many shells the page's list holds.
    const listedShells = async (page: Page) =>
      page.evaluate(async () => (await (window as unknown as PtyWindow).api.pty.list()).filter((terminal) => (terminal.kind ?? 'shell') === 'shell').length);

    // The URL is on the app's origin, so the navigation is allowed, and it ends on
    // an error page. The shell keeps running all the same (COCKPIT-55: only commands
    // terminals end with their page), and the app page shows it again.
    async function expectShellSurvivesNavigationTo(path: string) {
      const { page } = session;
      await openTerminal(session);
      const appUrl = await page.evaluate(() => location.href);
      const pid = await pidOf(page);
      expect(isAlive(pid)).toBe(true);
      const shellsBefore = await listedShells(page);

      try {
        // The main process tells when the main frame committed a document or failed to load: the app's own
        // listeners, added when the window was created, have run by then (they end the commands terminals and
        // mark them as closing, which the page's list leaves out at once). The page's own event tells when the
        // commit is done, so the `goto` below is not interrupted by it (an error page commits after `did-fail-load`).
        await session.evaluateInMain(`(() => {
          const contents = require('electron').webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith('app://'));
          globalThis.__navigated = new Promise((resolve) => {
            const done = () => {
              contents.removeListener('did-navigate', onNavigate);
              contents.removeListener('did-fail-load', onFail);
              setImmediate(resolve);
            };
            const onNavigate = () => done();
            const onFail = (_event, errorCode, _description, _url, isMainFrame) => {
              if (isMainFrame && errorCode !== -3) done();
            };
            contents.on('did-navigate', onNavigate);
            contents.on('did-fail-load', onFail);
          });
        })()`);
        const committed = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame() && frame.url() !== appUrl);
        await page
          .evaluate((path) => {
            location.href = new URL(path, location.href).href;
          }, path)
          .catch(() => {});
        await session.evaluateInMain('globalThis.__navigated');
        await committed;
        expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
        expect(session.isRunning()).toBe(true);
      } finally {
        await page.goto(appUrl);
        await page.getByRole('tablist').first().waitFor();
      }
      // The shell is still listed (a terminal the app ended is not) and running.
      expect(await listedShells(page), 'the shell keeps running').toBe(shellsBefore);
      expect(isAlive(pid)).toBe(true);
      expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    }

    test.runIf(full)('tabs AC11 — a same-origin navigation to a missing file (a 404) leaves the shell running, with no main-process error', async () => {
      await expectShellSurvivesNavigationTo('/missing.js');
    });

    // The app's protocol handler throws on a malformed percent-encoding
    // (`decodeURIComponent`), so the load fails instead of answering a 404 with a
    // document: the navigation commits an error page, and `did-navigate` is not
    // what the main process hears (a 404 does commit a document, which is why the
    // test above passes without `did-fail-load`).
    test.runIf(full)('tabs AC11 — a same-origin navigation the app cannot serve (error page, no document) leaves the shell running, with no main-process error', async () => {
      await expectShellSurvivesNavigationTo('/%');
    });
  });
});
