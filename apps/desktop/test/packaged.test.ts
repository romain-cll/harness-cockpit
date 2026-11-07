import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { daemonSocketIn, isAlive, launchEnv, launchPackaged, launchSpawned, MAIN_PROCESS_ERROR, packagedAppDir, type Session, stopGroup, versionLabel } from './launch';
import { makeTestDir } from './run-root';
import { describeCliPackagedSmoke } from './support/cli';
import { describeDaemonPackagedSmoke } from './support/daemon';
import { describeMode } from './support/mode-checks';
import { describePanesPackagedSmoke } from './support/panes';
import { addProject, addRepository, entryTitles, makeRepo, openMenu, projectsInState, removeThroughMenu, sidebarEntries, sidebarLines, snapshotRepo, stateSnapshot, type TempRepo, untilAnswered, waitForEntries, worktreePath, writeConfig } from './support/projects';
import { addGhFixture, addOrigin, expectChangesShowNewFile, expectShipSmoke, type GhFixture, GIT_APP_ENV } from './support/right-bar';
import { addOpenFixture, controlTokenIn, createWorkspaceWithAgent, describeResumeSmoke, expectControlEndpoint, expectNoErrors, expectSetupSpawnedWithDetectedPath, expectSetupThenAgent, FIRST_MENU, launchPackagedWith, makeSessionsFixture, type OpenFixture, openSessionEntry, openWorkspaceMenu, PACKAGED_CLI, pickInSubmenu, pickTopItem, readStub, rememberedApps, sessionEntries, type SessionsFixture, sessionsInState, startForeignSetup, startSession, waitForOpenRuns, waitForSessionEntries, waitForWorkspaceTabs } from './support/sessions';
import { clearFocusCalls, FRONT_CALLS, frontCalls, runSecondLaunch, stubFocus, windowCount } from './support/single-instance';
import { applicationType, consoleErrorsOf, watchFrontmost } from './support/terminal';

describeMode('packaged app', launchPackaged);

interface QuickRun {
  exit: { code: number | null; signal: NodeJS.Signals | null };
  /** Everything the app wrote to stderr. */
  stderr: string;
}

// Starts the packaged app on a data folder it must refuse, and waits for it to
// exit. The app quits before any window, so there is no page to attach to, and
// no debugging port either: "opens no window" is proven by the traces a window
// leaves in the data folder (`windowTracesIn`), not by watching the browser,
// which the app can outrun (it creates a window and exits within one task).
async function runUntilExit(dataDir: string): Promise<QuickRun> {
  const { env } = launchEnv(true, dataDir);
  // Its own process group, so a hung run leaves no Electron helper behind.
  const child = spawn(join(packagedAppDir(), 'Contents/MacOS/Cockpit'), [], {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => (stderr += chunk));

  try {
    // `close` fires once the app and every helper holding its output have ended (a normal exit can leave helpers
    // that still write in the data folder), with the last stderr chunks in: a run that hangs is the test's guard.
    const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    return { exit: { code, signal }, stderr };
  } finally {
    await stopGroup(child);
  }
}

// What Chromium writes into the data folder only once a window exists (its
// profile: preferences, storage, caches). The app that quits before opening one
// leaves none of it. AC4 and AC8 check they are absent after the exit; the
// guard in the restart test checks a normal start does create them, so an
// Electron that stops writing them fails the guard instead of passing the
// check silently.
const WINDOW_TRACES = ['Preferences', 'Local Storage', 'Session Storage', 'Cache'];
const windowTracesIn = (dir: string) => readdirSync(dir).filter((name) => WINDOW_TRACES.includes(name));

// Resolves with the traces once Chromium has written one: the folder tells (a watch on it).
const windowTracesAppear = (dir: string) =>
  new Promise<string[]>((resolve) => {
    const check = () => {
      const found = windowTracesIn(dir);
      if (found.length === 0) return;
      watcher.close();
      resolve(found);
    };
    const watcher = watch(dir, check);
    check();
  });

const stateFileIn = (dir: string) => join(dir, 'state.json');
const backupsIn = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'));

// The state file across restarts of the packaged app, always on a data folder
// the test creates and removes.
describe('packaged app state file', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTestDir('d-');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function expectHomePageWithoutError(session: Session) {
    await session.page.getByText(versionLabel).waitFor();
    await session.page.getByText('No projects yet', { exact: true }).waitFor();
    expect(await consoleErrorsOf(session.page)).toEqual([]);
    expect(await session.page.pageErrors()).toEqual([]);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  }

  test('AC2 — a second start leaves state.json unchanged and sets nothing aside', async () => {
    const first = await launchPackaged({ dataDir });
    await expectHomePageWithoutError(first);
    // Guard for AC4 and AC8: a normal start leaves window traces (Chromium may
    // write them shortly after the page shows), so their absence there means
    // something.
    const traces = await windowTracesAppear(dataDir);
    expect(traces, 'a normal start leaves window traces in the data folder').not.toEqual([]);
    await first.close();

    const file = stateFileIn(dataDir);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    const before = { content: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs };

    const second = await launchPackaged({ dataDir });
    try {
      await expectHomePageWithoutError(second);
    } finally {
      await second.close();
    }

    expect(readFileSync(file, 'utf8')).toBe(before.content);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(backupsIn(dataDir)).toEqual([]);
    expect(existsSync(join(dataDir, 'state.json.tmp'))).toBe(false);
  });

  test('AC7 — a project survives a restart on the same data folder, and removing it leaves the repository on disk', async () => {
    const repo = makeRepo('persistent-project');
    try {
      const first = await launchPackaged({ dataDir });
      try {
        await first.page.getByText(versionLabel).waitFor();
        await addProject(first, repo.root);
        await waitForEntries(first.page, [repo.root]);
        expect(projectsInState(dataDir)).toEqual([{ path: repo.root }]);
      } finally {
        await first.close();
      }

      const repoOnDisk = snapshotRepo(repo);
      const second = await launchPackaged({ dataDir });
      try {
        await second.page.getByText(versionLabel).waitFor();
        await waitForEntries(second.page, [repo.root]);
        expect((await sidebarEntries(second.page))[0]!.text).toContain(repo.name);
        expect(projectsInState(dataDir)).toEqual([{ path: repo.root }]);

        await removeThroughMenu(second.page, repo.root);
        await waitForEntries(second.page, []);
        expect(projectsInState(dataDir)).toEqual([]);
        expect(backupsIn(dataDir)).toEqual([]);
        expect(snapshotRepo(repo)).toEqual(repoOnDisk);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(repo.parent, { recursive: true, force: true });
    }
  });

  test('AC8 — a state.json from an earlier build, without projects, shows no project and is left unchanged', async () => {
    const file = stateFileIn(dataDir);
    writeFileSync(file, '{ "version": 1 }\n');
    const before = stateSnapshot(dataDir);

    const session = await launchPackaged({ dataDir });
    try {
      await expectHomePageWithoutError(session);
      // The Projects section is there, empty.
      await session.page.getByRole('button', { name: 'Add project', exact: true }).waitFor();
      expect(await sidebarLines(session.page)).toContain('Projects');
      expect(await entryTitles(session.page)).toEqual([]);
    } finally {
      await session.close();
    }

    expect(stateSnapshot(dataDir)).toEqual(before);
    expect(backupsIn(dataDir)).toEqual([]);
    expect(existsSync(join(dataDir, 'state.json.tmp'))).toBe(false);
  });

  test('AC3 — a corrupted state.json is set aside and replaced, and the app starts', async () => {
    const corrupt = '{not json';
    writeFileSync(stateFileIn(dataDir), corrupt);

    const session = await launchPackaged({ dataDir });
    try {
      await expectHomePageWithoutError(session);
      const backups = backupsIn(dataDir);
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(dataDir, backups[0]!), 'utf8')).toBe(corrupt);
      expect(JSON.parse(readFileSync(stateFileIn(dataDir), 'utf8'))).toEqual({ version: 1 });
      expect(session.output()).toContain(backups[0]!);
    } finally {
      await session.close();
    }
  });

  test('AC4 — a state.json from a newer version opens no window, exits with code 1 and is left untouched', async () => {
    const newer = '{"version":2}';
    const file = stateFileIn(dataDir);
    writeFileSync(file, newer);
    const mtimeMs = statSync(file).mtimeMs;

    const run = await runUntilExit(dataDir);

    expect(run.exit).toEqual({ code: 1, signal: null });
    expect(run.stderr).toContain('written by a newer version of Cockpit');
    expect(readFileSync(file, 'utf8')).toBe(newer);
    expect(statSync(file).mtimeMs).toBe(mtimeMs);
    expect(readdirSync(dataDir).filter((name) => name.startsWith('state.json.'))).toEqual([]);
    expect(windowTracesIn(dataDir)).toEqual([]);
  });

  test('AC8 — a state.json that cannot be read opens no window, exits with code 1 and is left alone', async () => {
    const file = stateFileIn(dataDir);
    // Reading a folder fails with EISDIR, whatever the user's permissions.
    mkdirSync(file);

    const run = await runUntilExit(dataDir);

    expect(run.exit).toEqual({ code: 1, signal: null });
    expect(run.stderr).toContain('Cockpit cannot read its data');
    expect(run.stderr).toContain(file);
    expect(run.stderr).toContain('EISDIR');
    expect(statSync(file).isDirectory()).toBe(true);
    expect(readdirSync(file)).toEqual([]);
    expect(readdirSync(dataDir).filter((name) => name.startsWith('state.json'))).toEqual(['state.json']);
    expect(windowTracesIn(dataDir)).toEqual([]);
  });
});

// Quitting as Cmd+Q does (`app.quit()`): no shell may be left running behind the
// user's back.

describe('single instance: packaged app', () => {
  let session: Session;
  let dataDir: string;
  let userHome: string;
  let front: Awaited<ReturnType<typeof watchFrontmost>>;
  let env: NodeJS.ProcessEnv;
  let fx: SessionsFixture;

  beforeAll(async () => {
    front = await watchFrontmost();
    dataDir = makeTestDir('d-');
    // A short folder: the socket path is limited to 103 bytes on macOS.
    userHome = makeTestDir('u');
    // A fake login shell whose PATH holds no real agent CLI: detection must not run the machine's, which
    // would write under the temporary HOME while it is removed.
    fx = makeSessionsFixture([]);
    env = { ...fx.env(), HOME: userHome };
    // COCKPIT_HOME unset: the packaged app's default home.
    session = await launchSpawned(join(packagedAppDir(), 'Contents/MacOS/Cockpit'), [], true, dataDir, env, null);
    await session.page.getByText(versionLabel).waitFor();
    await stubFocus(session);
  });

  afterAll(async () => {
    await front?.stop();
    await session?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (userHome) rmSync(userHome, { recursive: true, force: true });
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  test('AC6 — with COCKPIT_HOME unset and HOME=<tmp>, the daemon\'s socket is <tmp>/.cockpit/daemon-1-<build>.sock and <tmp>/.cockpit-dev does not exist', () => {
    expect(statSync(daemonSocketIn(join(userHome, '.cockpit'))).isSocket()).toBe(true);
    expect(existsSync(join(userHome, '.cockpit-dev'))).toBe(false);
    expect(session.output()).not.toContain("Cockpit's background service could not start");
  });

  test('AC1, AC2 smoke path — a second launch of the packaged app exits with code 0 and leaves the files alone, and the running app shows and focuses its window', async () => {
    const second = () =>
      runSecondLaunch(
        join(packagedAppDir(), 'Contents/MacOS/Cockpit'),
        ['--remote-debugging-port=0', '--inspect=0'],
        launchEnv(true, dataDir, env, null).env,
      );
    // The running app's home is <HOME>/.cockpit, not a folder inside the data folder.
    const home = join(userHome, '.cockpit');
    const files = () => ({ state: stateSnapshot(dataDir), socketInode: statSync(daemonSocketIn(home)).ino, token: controlTokenIn(home) });
    const before = files();
    await clearFocusCalls(session);

    const launched = await second();

    expect(launched.exit, `the second launch exited (output: ${launched.output})`).toEqual({ code: 0, signal: null });
    expect(launched.elapsedMs).toBeLessThan(10_000);
    expect(launched.output).not.toMatch(MAIN_PROCESS_ERROR);
    expect(files()).toEqual(before);
    expect([...new Set(await frontCalls(session))].sort()).toEqual(FRONT_CALLS);
    expect(await windowCount(session)).toBe(1);
    expect(session.isRunning()).toBe(true);
    expect(await front.activated(session.pid)).toBe(false);
  });
});

// Sessions across a restart of the packaged app, on a data folder the test
// creates and removes; the launch's Cockpit home is inside it.
describe('packaged app sessions after a restart', () => {
  let fx: SessionsFixture;
  let dataDir: string;

  let repo: TempRepo;
  let origin: string;
  let open: OpenFixture;
  let gh: GhFixture;
  // A `cockpit setup` of someone else, running for the whole test (COCKPIT-81 AC2).
  let foreign: Awaited<ReturnType<typeof startForeignSetup>>;

  beforeEach(async () => {
    foreign = await startForeignSetup(PACKAGED_CLI());
    fx = makeSessionsFixture(['claude', 'codex']);
    open = addOpenFixture(fx);
    // A stub `gh` for the ship section (COCKPIT-38).
    gh = addGhFixture(fx);
    dataDir = makeTestDir('d-');
    repo = makeRepo('packaged-agent-ws');
    origin = addOrigin(repo);
  });

  afterEach(async () => {
    await foreign?.stop();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo.parent, { recursive: true, force: true });
  });

  test('AC9, changes AC16 — sessions of a previous launch are listed as "Ended", newest first, open as ended and leave state.json and their folders alone (the first launch also runs the Changes sidebar, ship section and open-workspace smoke paths)', async () => {
    const first = await launchPackagedWith({ ...open.env(), ...GIT_APP_ENV }, dataDir);
    try {
      await first.page.getByText(versionLabel).waitFor();
      // The packaged app's sessions smoke path: the stub runs in a new folder
      // under COCKPIT_HOME, the entry shows as running, the session is stored.
      const id = await startSession(first.page, 'Claude Code', 'Claude Code 1');
      const home = join(first.cockpitHome, 'sessions', id);
      const stub = await readStub(first.page);
      expect(stub.cwd).toBe(realpathSync(home));
      expect(stub.term).toBe('xterm-256color');
      expect(await waitForSessionEntries(first.page, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
      const storedFirst = sessionsInState(dataDir);
      expect(storedFirst.map((s) => [s.name, s.directory])).toEqual([['Claude Code 1', home]]);
      // Control endpoint smoke path (COCKPIT-56 AC8: the CLI is in the bundle).
      await expectControlEndpoint(first, fx, PACKAGED_CLI());

      await startSession(first.page, 'Codex', 'Codex 1');
      expect(sessionsInState(dataDir)).toHaveLength(2);

      // Workspace sessions smoke path: a new workspace with Claude Code and a prompt.
      writeConfig(repo, { setup: ['echo smoke-setup'] });
      await addRepository(first, repo);
      const wsId = await createWorkspaceWithAgent(first.page, repo, { agent: 'Claude Code', prompt: 'fix the tests' }, 'Claude Code 1');
      const wsPath = worktreePath(first, repo, 'fix-the-tests');
      // COCKPIT-57: the bundle's `Contents/Resources/bin/cockpit setup` ran the setup, then the stub.
      await expectSetupThenAgent(first.page, 'fix-the-tests', 'echo smoke-setup', 'smoke-setup');
      const wsStub = await readStub(first.page);
      expect(wsStub.cwd).toBe(wsPath);
      expect(wsStub.argCount).toBe(1);
      expect(wsStub.args).toBe('fix the tests');
      expectSetupSpawnedWithDetectedPath(fx, PACKAGED_CLI(), wsStub.pid);
      expect(isAlive(foreign.pid), 'the foreign `cockpit setup` is still running').toBe(true);
      expect(await waitForWorkspaceTabs(first.page, ['Claude Code 1'])).toEqual(['Claude Code 1']);
      const storedWs = sessionsInState(dataDir);
      expect(storedWs.find((entry) => entry.id === wsId)).toMatchObject({ name: 'Claude Code 1', directory: wsPath, project: repo.root });

      // Open workspace smoke path: "Open in editor" then Cursor.
      await openWorkspaceMenu(first.page, wsPath, FIRST_MENU);
      await untilAnswered(first, 'workspaces:open', () => pickInSubmenu(first.page, 'Open in editor', 'Cursor'));
      expect(await waitForOpenRuns(open, 1)).toEqual([['-a', join(open.apps, 'Cursor.app'), wsPath]]);
      expect(rememberedApps(dataDir).editor).toBe('cursor');

      // Project menu smoke path (COCKPIT-88): "Reveal in Finder".
      await openMenu(first.page, repo.root);
      await untilAnswered(first, 'projects:reveal', () => pickTopItem(first.page, 'Reveal in Finder'));
      expect((await waitForOpenRuns(open, 2)).at(-1)).toEqual(['-R', repo.root]);

      // Changes sidebar smoke path (COCKPIT-34 AC16): a file written in the worktree shows with its diff.
      await expectChangesShowNewFile(first.page, wsPath);
      // Ship section smoke path (COCKPIT-38): the stub's pull request shows, then a commit and a push reach origin.
      await expectShipSmoke(first.page, gh, wsPath, origin, 'fix-the-tests');
      await expectNoErrors(first);
    } finally {
      await first.close();
    }

    const stored = sessionsInState(dataDir).filter((entry) => entry.project === undefined);
    expect(stored.map((s) => s.name)).toEqual(['Claude Code 1', 'Codex 1']);
    const before = stateSnapshot(dataDir);

    const second = await launchPackagedWith(fx.env(), dataDir);
    try {
      await second.page.getByText(versionLabel).waitFor();
      expect(await waitForSessionEntries(second.page, [['Codex 1', true], ['Claude Code 1', true]])).toEqual([
        ['Codex 1', true],
        ['Claude Code 1', true],
      ]);
      // Statuses are not kept: a session of an earlier launch shows the "Ended" dot, never "Exited N".
      expect((await sessionEntries(second.page)).map((entry) => entry.status)).toEqual(['Ended', 'Ended']);

      await openSessionEntry(second.page, 'Claude Code 1');
      await second.page.getByText('This session has ended.').waitFor();
      await second.page.getByText(stored[0]!.directory).first().waitFor();
      expect(statSync(stored[0]!.directory).isDirectory()).toBe(true);
      expect(statSync(stored[1]!.directory).isDirectory()).toBe(true);
      await expectNoErrors(second);
    } finally {
      await second.close();
    }

    expect(stateSnapshot(dataDir)).toEqual(before);
    expect(backupsIn(dataDir)).toEqual([]);
  });
});

// The real launch, as a user starts the app. It opens a visible window, so it
// runs in CI only, never on a developer's machine.
describe.runIf(process.env.CI)('packaged app without the background switch', () => {
  let session: Session;

  beforeAll(async () => {
    session = await launchPackaged({ background: false });
  });

  afterAll(async () => {
    await session?.close();
    if (session) expect(existsSync(session.dataDir)).toBe(false);
  });

  test('opens a visible window as a regular app', async () => {
    // A window that was never shown reports `hidden`.
    const visibility = await session.page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const check = () => {
            if (document.visibilityState !== 'visible') return;
            document.removeEventListener('visibilitychange', check);
            resolve(document.visibilityState);
          };
          document.addEventListener('visibilitychange', check);
          check();
        }),
    );
    expect(visibility).toBe('visible');
    expect(await applicationType(session.pid)).toContain('"Foreground"');
  });

  test('AC7 — the output holds what the app wrote from its first line', () => {
    expect(session.output()).toContain('DevTools listening on');
  });
});

describePanesPackagedSmoke();
describeDaemonPackagedSmoke();
describeCliPackagedSmoke();

describeResumeSmoke('packaged app', (fx) => launchPackagedWith(fx.env()), PACKAGED_CLI);
