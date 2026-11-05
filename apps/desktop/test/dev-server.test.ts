import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { daemonSocketIn, isAlive, launchDev, type Session, versionLabel } from './launch';
import { makeTestDir } from './run-root';
import { describeDaemonDevServerSmoke } from './support/daemon';
import { describeMode } from './support/mode-checks';
import { describePanesDevServerSmoke } from './support/panes';
import { addRepository, makeRepo, untilAnswered, worktreePath, writeConfig } from './support/projects';
import { addGhFixture, addOrigin, expectChangesShowNewFile, expectShipSmoke, type GhFixture, GIT_APP_ENV } from './support/right-bar';
import { addOpenFixture, createPlainWorkspace, createWorkspaceWithAgent, devFolderOfThisWorktree, devHomeIn, expectControlEndpoint, expectNoErrors, expectSetupSpawnedWithDetectedPath, expectSetupThenAgent, FIRST_MENU, launchDevWith, makeSessionsFixture, type OpenFixture, openWorkspaceMenu, pickInSubmenu, readStub, rememberedApps, REPOSITORY_CLI, type SessionsFixture, sessionsInState, startForeignSetup, startSession, waitForOpenRuns, waitForSessionEntries, waitForWorkspaceTabs } from './support/sessions';

describeMode('dev server', launchDev);

// One smoke path through the sessions IPC in the dev server: the page, the
// main process, the pty host and the disk. It needs a launch of its own with
// the fake login shell that holds the stubs. The packaged app's smoke path is
// folded into the first launch of the AC9 restart test in `packaged.test.ts`. The
// launchd-environment mode has none: its point is the user's real login shell,
// where a session would run a real CLI.
describe('sessions smoke path: dev server', () => {
  let fx: SessionsFixture;
  let open: OpenFixture;
  let gh: GhFixture;
  let session: Session;
  // A `cockpit setup` of someone else, running for the whole describe (COCKPIT-81 AC2).
  let foreign: Awaited<ReturnType<typeof startForeignSetup>>;

  beforeAll(async () => {
    foreign = await startForeignSetup(REPOSITORY_CLI);
    fx = makeSessionsFixture(['claude']);
    open = addOpenFixture(fx);
    // A stub `gh` for the ship section (COCKPIT-38).
    gh = addGhFixture(fx);
    session = await launchDevWith({ ...open.env(), ...GIT_APP_ENV });
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    await foreign?.stop();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  test('smoke path — picking Claude Code runs the stub in a new folder under COCKPIT_HOME, lists the session and stores it', async () => {
    const { page } = session;
    const id = await startSession(page, 'Claude Code', 'Claude Code 1');
    const home = join(session.cockpitHome, 'sessions', id);

    const stub = await readStub(page);
    expect(stub.cwd).toBe(realpathSync(home));
    expect(stub.term).toBe('xterm-256color');
    expect(await waitForSessionEntries(page, [['Claude Code 1', false]])).toEqual([['Claude Code 1', false]]);
    const stored = sessionsInState(session.dataDir);
    expect(stored.map((s) => [s.name, s.directory])).toEqual([['Claude Code 1', home]]);
  });

  test('control smoke path, AC8 — the stub gets its session id and the socket, its hooks name apps/cli/dist/cockpit, and a hook line turns the row to "Working"', async () => {
    await expectControlEndpoint(session, fx, REPOSITORY_CLI);
  });

  test('workspace sessions smoke path, changes AC16 — a new workspace with Claude Code and a prompt runs the stub in the worktree with the prompt, shows the session as a tab of the workspace page and stores it, and the Changes sidebar shows a file written in the worktree with its diff', async () => {
    const { page } = session;
    const repo = makeRepo('smoke-agent-ws');
    const origin = addOrigin(repo);
    try {
      writeConfig(repo, { setup: ['echo smoke-setup'] });
      await addRepository(session, repo);
      const id = await createWorkspaceWithAgent(page, repo, { agent: 'Claude Code', prompt: 'fix the tests' }, 'Claude Code 1');
      const path = worktreePath(session, repo, 'fix-the-tests');

      // COCKPIT-57: `apps/cli/dist/cockpit setup` ran the setup in the terminal, then the stub.
      await expectSetupThenAgent(page, 'fix-the-tests', 'echo smoke-setup', 'smoke-setup');
      const stub = await readStub(page);
      expect(stub.cwd).toBe(path);
      expect(stub.argCount).toBe(1);
      expect(stub.args).toBe('fix the tests');
      expectSetupSpawnedWithDetectedPath(fx, REPOSITORY_CLI, stub.pid);
      expect(isAlive(foreign.pid), 'the foreign `cockpit setup` is still running').toBe(true);
      expect(await waitForWorkspaceTabs(page, ['Claude Code 1'])).toEqual(['Claude Code 1']);
      const stored = sessionsInState(session.dataDir);
      expect(stored.find((entry) => entry.id === id)).toMatchObject({ name: 'Claude Code 1', directory: path, project: repo.root });
      // Changes sidebar (COCKPIT-34 AC16): a file written in the worktree shows with its diff.
      await expectChangesShowNewFile(page, path);
      // Ship section (COCKPIT-38): the stub's pull request shows, then a commit and a push reach origin.
      await expectShipSmoke(page, gh, path, origin, 'fix-the-tests');
    } finally {
      rmSync(repo.parent, { recursive: true, force: true });
    }
  });

  test('open workspace smoke path — "Open in editor" then Cursor runs open -a <Cursor.app> <worktree> and stores editor "cursor"', async () => {
    const { page } = session;
    const repo = makeRepo('smoke-open-ws');
    try {
      await addRepository(session, repo);
      const path = await createPlainWorkspace(session, repo, 'smoke-open');

      await openWorkspaceMenu(page, path, FIRST_MENU);
      await untilAnswered(session, 'workspaces:open', () => pickInSubmenu(page, 'Open in editor', 'Cursor'));

      expect(await waitForOpenRuns(open, 1)).toEqual([['-a', join(open.apps, 'Cursor.app'), path]]);
      expect(rememberedApps(session.dataDir).editor).toBe('cursor');
    } finally {
      rmSync(repo.parent, { recursive: true, force: true });
    }
  });

  test('logs no error and keeps running', async () => {
    await expectNoErrors(session);
  });
});

describe('dev server default folders', () => {
  test('AC1, AC4, AC5 smoke path — under electron-vite dev with COCKPIT_HOME and COCKPIT_USER_DATA_DIR unset and HOME=<tmp>, state.json is in <tmp>/.cockpit-dev/<folder>/user-data and the daemon\'s socket in <tmp>/.cockpit-dev/<folder>', async () => {
    // A short folder, so the socket path fits 103 bytes. The temporary HOME applies to the whole
    // `bun run dev` tree (bun and install-electron included); the Electron binary is already in node_modules.
    const devFolder = await devFolderOfThisWorktree();
    const userHome = realpathSync(makeTestDir('u'));
    // A fake login shell whose PATH holds no real agent CLI: harness detection must not run the machine's
    // `opencode`, which would write under the temporary HOME while it is removed. `bun run dev` finds bun
    // through the launching process's PATH, which `fx.env()` keeps.
    const fx = makeSessionsFixture([]);
    const session = await launchDevWith({ ...fx.env(), HOME: userHome }, null, null);
    try {
      await session.page.getByText(versionLabel).waitFor();
      const home = devHomeIn(userHome, devFolder);

      expect(JSON.parse(readFileSync(join(home, 'user-data', 'state.json'), 'utf8'))).toMatchObject({ version: 1 });
      expect(statSync(daemonSocketIn(home)).isSocket()).toBe(true);
      expect(readdirSync(join(userHome, '.cockpit-dev'))).toEqual([devFolder]);
      expect(existsSync(join(userHome, '.cockpit'))).toBe(false);
      expect(existsSync(join(session.dataDir, 'state.json'))).toBe(false);
      await expectNoErrors(session);
    } finally {
      await session.close();
      rmSync(userHome, { recursive: true, force: true });
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describePanesDevServerSmoke();
describeDaemonDevServerSmoke();
