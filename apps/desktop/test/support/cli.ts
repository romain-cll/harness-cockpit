import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isAlive, killDaemonsIn, launchPackaged, quitApp, type Session, versionLabel } from '../launch';
import { makeTestDir } from '../run-root';
import { daemonPid, must } from './daemon';
import { linkedWorktrees, makeRepo, type TempRepo, waitForEntries, worktreePath } from './projects';
import { makeSessionsFixture, PACKAGED_CLI, type SessionsFixture } from './sessions';

// COCKPIT-37: the `cockpit` command with the app closed, and the launch file the app leaves for it.

export interface CockpitRun {
  code: number | null;
  out: string;
  err: string;
}

/**
 * Runs the compiled CLI as a plain shell would: `env` and the `PATH`, nothing else (the test run's own
 * `COCKPIT_SOCKET`, if any, must not reach it). The daemon it starts is detached, so the run ends with the CLI.
 */
export function runCockpit(cli: string, args: string[], env: Record<string, string>, stdin = ''): Promise<CockpitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(stdin);
  });
}

/** What the CLI needs from a plain shell: the Cockpit home, and the fake login shell the daemon resolves its environment from. */
export const cliEnv = (fx: SessionsFixture, home: string): Record<string, string> => ({ HOME: fx.root, SHELL: fx.shell, COCKPIT_HOME: home });

/** The launch file the app writes at each launch: how the CLI finds or starts the daemon. */
export const launchFileIn = (home: string) =>
  JSON.parse(readFileSync(join(home, 'daemon-launch.json'), 'utf8')) as { executable: string; bundle: string; build: string; stateDir: string; cli: string };

/** `ws create` as a plain shell runs it; the created workspace's path and branch. */
export async function createFromShell(cli: string, env: Record<string, string>, project: string, task: string) {
  const run = await runCockpit(cli, ['ws', 'create', '--project', project, '--task', task], env);
  expect(run.err).toBe('');
  expect(run.code).toBe(0);
  expect(run.out.endsWith('\n')).toBe(true);
  expect(run.out.split('\n').filter(Boolean)).toHaveLength(1);
  return JSON.parse(run.out) as { status: string; workspace: { path: string; branch: string } };
}

// The smoke path of the packaged app: its launch file points at the bundle inside `app.asar` and at the CLI in the
// bundle, and with the app quit and no daemon running, that CLI makes a workspace the next launch lists.
export const describeCliPackagedSmoke = () =>
  describe('cockpit command: packaged app smoke path', () => {
    let fx: SessionsFixture;
    let repo: TempRepo;
    let dataDir: string;
    let session: Session | undefined;

    beforeAll(() => {
      fx = makeSessionsFixture(['claude']);
      repo = makeRepo('cli-packaged');
      dataDir = makeTestDir('d-');
      writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, projects: [{ path: repo.root }] }));
    });

    afterAll(async () => {
      await session?.close().catch(() => {});
      await killDaemonsIn(join(dataDir, 'h'));
      rmSync(fx.root, { recursive: true, force: true });
      rmSync(repo.parent, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    test('AC1, AC2 smoke path — the launch file names the daemon bundle in app.asar and Contents/Resources/bin/cockpit; with the app quit, the packaged CLI starts the daemon and creates a workspace, and the next launch lists it', async () => {
      session = await launchPackaged({ dataDir, env: fx.env() });
      await session.page.getByText(versionLabel).waitFor();
      const home = session.cockpitHome;
      expect(launchFileIn(home)).toMatchObject({ cli: PACKAGED_CLI() });
      expect(launchFileIn(home).bundle).toContain('app.asar');
      await quitApp(session);
      await killDaemonsIn(home);
      // The files of the daemon that was killed stay; its pid is not alive.
      const killed = must(daemonPid(home), 'the daemon of the first launch');
      expect(isAlive(killed)).toBe(false);

      const created = await createFromShell(PACKAGED_CLI(), cliEnv(fx, home), repo.root, 'fix-login');

      expect(created.status).toBe('created');
      expect(created.workspace.branch).toBe('fix-login');
      const worktree = realpathSync(created.workspace.path);
      expect(linkedWorktrees(repo).map(({ path }) => path)).toEqual([worktree]);
      const started = must(daemonPid(home), 'the daemon the CLI started');
      expect(started).not.toBe(killed);
      expect(isAlive(started)).toBe(true);

      session = await launchPackaged({ dataDir, env: fx.env() });
      await session.page.getByText(versionLabel).waitFor();
      await waitForEntries(session.page, [repo.root, worktree]);
      expect(existsSync(worktree)).toBe(true);
      expect(worktree).toBe(worktreePath(session, repo, 'fix-login'));
    });
  });
