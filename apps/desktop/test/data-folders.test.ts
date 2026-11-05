import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { daemonSocketIn, versionLabel } from './launch';
import { makeTestDir } from './run-root';
import { devFolderOfThisWorktree, devHomeIn, expectNoErrors, launchBuiltWith, makeSessionsFixture, readStub, readStubEnv, type SessionsFixture, sessionsInState, startSession } from './support/sessions';

describe('built app default folders when COCKPIT_HOME and COCKPIT_USER_DATA_DIR are unset', () => {
  let fx: SessionsFixture;

  beforeAll(() => {
    fx = makeSessionsFixture(['claude']);
  });

  afterAll(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  test.each([
    ['unset', undefined],
    ['empty', ''],
  ])('AC1, AC4, AC5 — with COCKPIT_HOME and COCKPIT_USER_DATA_DIR both %s and HOME=<tmp>, the unpackaged app puts the session folder in <tmp>/.cockpit-dev/<folder>/sessions/<id>, the socket next to it, state.json in <folder>/user-data, and nothing else under <tmp>/.cockpit-dev nor under <tmp>/.cockpit', async (_label, value) => {
    // A short folder: the socket path is limited to 103 bytes on macOS (`<fx.root>/…` would exceed it).
    const devFolder = await devFolderOfThisWorktree();
    const userHome = realpathSync(makeTestDir('u'));
    const session = await launchBuiltWith({ ...fx.env(), HOME: userHome }, value ?? null, value ?? null);
    try {
      await session.page.getByText(versionLabel).waitFor();
      const id = await startSession(session.page, 'Claude Code', 'Claude Code 1');
      const home = devHomeIn(userHome, devFolder);
      const directory = join(home, 'sessions', id);

      expect((await readStub(session.page)).cwd).toBe(directory);
      expect(statSync(directory).isDirectory()).toBe(true);
      // The daemon's socket is <HOME>/.cockpit-dev/<folder>/daemon-1-<build>.sock, and the session gets it.
      expect(statSync(daemonSocketIn(home)).isSocket()).toBe(true);
      expect((await readStubEnv(session.page)).socket).toBe(daemonSocketIn(home));
      // userData is <folder>/user-data: state.json is there, with the session, and not in the data folder.
      const userData = join(home, 'user-data');
      expect(JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))).toMatchObject({ version: 1 });
      const stored = sessionsInState(userData);
      expect(stored.map((s) => s.directory)).toEqual([directory]);
      expect(existsSync(join(session.dataDir, 'state.json'))).toBe(false);
      // <HOME>/.cockpit-dev holds only the worktree's folder, and the installed app's home is left alone.
      expect(readdirSync(join(userHome, '.cockpit-dev'))).toEqual([devFolder]);
      expect(existsSync(join(userHome, '.cockpit'))).toBe(false);
      // Nothing went to the developer's own folders.
      expect(existsSync(join(homedir(), '.cockpit', 'sessions', id))).toBe(false);
      expect(existsSync(join(homedir(), '.cockpit-dev', devFolder, 'sessions', id))).toBe(false);
      expect(existsSync(join(homedir(), '.cockpit-dev', 'sessions', id))).toBe(false);
      await expectNoErrors(session);
    } finally {
      await session.close();
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  test('AC6 — with COCKPIT_HOME set and COCKPIT_USER_DATA_DIR unset, the given home holds the daemon and userData defaults to <HOME>/.cockpit-dev/<folder>/user-data', async () => {
    const devFolder = await devFolderOfThisWorktree();
    const userHome = realpathSync(makeTestDir('u'));
    const cockpitHome = makeTestDir('h');
    const session = await launchBuiltWith({ ...fx.env(), HOME: userHome }, null, cockpitHome);
    try {
      await session.page.getByText(versionLabel).waitFor();

      expect(statSync(daemonSocketIn(cockpitHome)).isSocket()).toBe(true);
      expect(JSON.parse(readFileSync(join(devHomeIn(userHome, devFolder), 'user-data', 'state.json'), 'utf8'))).toMatchObject({ version: 1 });
      // The default home is not used: <folder> holds user-data only.
      expect(readdirSync(devHomeIn(userHome, devFolder))).toEqual(['user-data']);
      expect(existsSync(join(userHome, '.cockpit'))).toBe(false);
      await expectNoErrors(session);
    } finally {
      await session.close();
      rmSync(userHome, { recursive: true, force: true });
      rmSync(cockpitHome, { recursive: true, force: true });
    }
  });

  test('AC6 — with COCKPIT_USER_DATA_DIR set and COCKPIT_HOME unset, state.json is in the given folder and the home defaults to <HOME>/.cockpit-dev/<folder>', async () => {
    const devFolder = await devFolderOfThisWorktree();
    const userHome = realpathSync(makeTestDir('u'));
    const dataDir = makeTestDir('d-');
    const session = await launchBuiltWith({ ...fx.env(), HOME: userHome }, dataDir, null);
    try {
      await session.page.getByText(versionLabel).waitFor();
      const home = devHomeIn(userHome, devFolder);

      expect(statSync(daemonSocketIn(home)).isSocket()).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ version: 1 });
      // userData is the given folder: <folder> holds no user-data.
      expect(existsSync(join(home, 'user-data'))).toBe(false);
      expect(existsSync(join(userHome, '.cockpit'))).toBe(false);
      await expectNoErrors(session);
    } finally {
      await session.close();
      rmSync(userHome, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
