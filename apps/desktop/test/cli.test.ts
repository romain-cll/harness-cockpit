import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectDaemon } from '@cockpit/daemon';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { killDaemonsIn, MAIN_PROCESS_ERROR, quitApp, type Session, versionLabel } from './launch';
import { cliEnv, createFromShell, launchFileIn, runCockpit } from './support/cli';
import { daemonFile, daemonPid, goToWorkspacePage, launchBuiltOn, makeDataDir, must, uniqueBuild } from './support/daemon';
import { entryTitles, linkedWorktrees, makeRepo, type TempRepo, waitForEntries, waitForEntry, worktreePath } from './support/projects';
import { harnessIdOf, makeSessionsFixture, REPOSITORY_CLI, type SessionsFixture, sessionsInState, untilState } from './support/sessions';
import { outputOf, ptyWrite, spawnShell, waitForOutput } from './support/terminal';
import type { PtySpawnOptions } from './support/terminal';

// COCKPIT-37: the `cockpit` command drives the app's state through the daemon, with the app open or closed. The built
// app runs the full block; the packaged app one smoke path (`support/cli.ts`). The CLI is the compiled `apps/cli/dist/cockpit`.

describe('cockpit command: built app', () => {
  let fx: SessionsFixture;
  let repo: TempRepo;
  let dataDir: string;
  let home: string;
  let build: string;
  let session: Session | undefined;

  beforeAll(() => {
    fx = makeSessionsFixture(['claude']);
    repo = makeRepo('cli-project');
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    build = uniqueBuild();
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, projects: [{ path: repo.root }] }));
    // The fake login shell is interactive (as in sessions.test.ts): a command typed in an app terminal runs.
    writeFileSync(join(fx.root, 'interactive'), '');
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(join(fx.root, 'interactive'), { force: true });
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(repo.parent, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const launch = () => launchBuiltOn({ ...fx.env(), COCKPIT_TEST_DAEMON_BUILD: build }, dataDir, home);

  test('AC1 — with the app quit and no daemon running, `cockpit ws create` from a plain shell prints the created workspace on one JSON line (exit 0), the worktree exists, and the next launch lists it under the project', async () => {
    session = await launch();
    await session.page.getByText(versionLabel).waitFor();
    await waitForEntry(session.page, repo.root);
    await quitApp(session);
    await killDaemonsIn(home);
    expect(launchFileIn(home)).toMatchObject({ build, cli: REPOSITORY_CLI });

    const created = await createFromShell(REPOSITORY_CLI, cliEnv(fx, home), repo.root, 'fix-login');

    const worktree = worktreePath(session, repo, 'fix-login');
    expect(created).toMatchObject({ status: 'created', workspace: { branch: 'fix-login' } });
    expect(realpathSync(created.workspace.path)).toBe(worktree);
    expect(existsSync(worktree)).toBe(true);
    expect(linkedWorktrees(repo)).toEqual([{ path: worktree, branch: 'fix-login' }]);

    session = await launch();
    await session.page.getByText(versionLabel).waitFor();
    expect(await waitForEntries(session.page, [repo.root, worktree])).toEqual([repo.root, worktree]);
  });

  test('AC3 — the app open on the home page: `cockpit ws create` typed in a terminal of the app shows the new row in the project\'s sidebar, with no reload, focus or click', async () => {
    const { page } = session!;
    expect(new URL(page.url()).pathname).toBe('/');
    // A shell with the spawn defaults: `COCKPIT_SOCKET`, the CLI first on `PATH`.
    const shell = await spawnShell(page, { cols: 80, rows: 24 } as PtySpawnOptions);
    await ptyWrite(page, shell, `cockpit ws create --project '${repo.root}' --task from-agent\n`);

    await waitForOutput(page, shell, /"status":"\w+"|usage:|Open Cockpit once/);
    expect(await outputOf(page, shell)).toContain('"status":"created"');
    const worktree = worktreePath(session!, repo, 'from-agent');
    await waitForEntry(page, worktree);

    expect((await entryTitles(page)).sort()).toEqual([repo.root, ...linkedWorktrees(repo).map(({ path }) => path)].sort());
    expect(session!.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });

  test('AC4 — `cockpit session start` from a plain shell starts the agent in the workspace, and the open app shows it as a tab of the workspace page with no reload', async () => {
    const { page } = session!;
    const worktree = worktreePath(session!, repo, 'from-agent');
    await goToWorkspacePage(page, worktree);

    const run = await runCockpit(REPOSITORY_CLI, ['session', 'start', '--project', repo.root, '--workspace', worktree, '--harness', 'claude-code', '--prompt', 'hello'], cliEnv(fx, home));

    expect(run).toMatchObject({ code: 0, err: '' });
    const started = JSON.parse(run.out) as { status: string; session: { id: string; name: string } };
    expect(started).toMatchObject({ status: 'started', session: { name: 'Claude Code 1' } });
    await page.getByRole('tab', { name: 'Claude Code 1', exact: true }).waitFor();
    expect(sessionsInState(dataDir)).toEqual([expect.objectContaining({ id: started.session.id, project: repo.root, directory: worktree, open: true })]);
  });
});

describe('cockpit command: a session on the daemon of an older build', () => {
  let fx: SessionsFixture;
  let repo: TempRepo;
  let dataDir: string;
  let home: string;
  let session: Session | undefined;

  beforeAll(() => {
    fx = makeSessionsFixture(['claude']);
    repo = makeRepo('cli-update');
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, projects: [{ path: repo.root }] }));
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(repo.parent, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC10, AC14 — after the app relaunched as a new build, a conversation id the session of the old build\'s daemon reports (`cockpit session-id`) is stored on the session in state.json, and when its agent then exits on its own the app relays it and state.json shows open false, the id kept', async () => {
    const oldBuild = uniqueBuild();
    const newBuild = uniqueBuild();
    session = await launchBuiltOn({ ...fx.env(), COCKPIT_TEST_DAEMON_BUILD: oldBuild }, dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
    const env = cliEnv(fx, home);
    const workspace = await createFromShell(REPOSITORY_CLI, env, repo.root, 'update-ws');
    const started = await runCockpit(REPOSITORY_CLI, ['session', 'start', '--project', repo.root, '--workspace', workspace.workspace.path, '--harness', 'claude-code', '--prompt', 'hello'], env);
    expect(started).toMatchObject({ code: 0, err: '' });
    const { id } = (JSON.parse(started.out) as { session: { id: string } }).session;
    const oldSocket = must(daemonFile(home, 'sock', oldBuild), 'the old build\'s daemon socket');
    await quitApp(session);

    session = await launchBuiltOn({ ...fx.env(), COCKPIT_TEST_DAEMON_BUILD: newBuild }, dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
    expect(daemonPid(home, newBuild), 'the new build starts its own daemon').toBeDefined();
    expect(harnessIdOf({ sessions: sessionsInState(dataDir) }, id)).toBeUndefined();

    await untilState(dataDir, (state) => harnessIdOf(state, id) === 'conversation-after-update', () =>
      runCockpit(REPOSITORY_CLI, ['session-id', 'claude-code'], { HOME: fx.root, COCKPIT_SOCKET: oldSocket, COCKPIT_SESSION_ID: id }, JSON.stringify({ session_id: 'conversation-after-update', hook_event_name: 'UserPromptSubmit' })),
    );

    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).sessions).toEqual([expect.objectContaining({ id, harnessSessionId: 'conversation-after-update', open: true })]);

    // The agent ends by itself on the old daemon, which writes nothing (superseded): the app hears its exit and
    // forwards `session-dismiss` to the daemon of its own build, which closes the mark.
    const oldDaemon = await connectDaemon(oldSocket);
    const terminal = (await oldDaemon.list()).find((entry) => entry.sessionId === id);
    expect(terminal, 'the session still runs on the old build\'s daemon').toBeDefined();
    await untilState(dataDir, (state) => state.sessions?.find((stored) => stored.id === id)?.open === false, async () => oldDaemon.write(terminal!.id, 'quit\n'));
    oldDaemon.close();

    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).sessions).toEqual([expect.objectContaining({ id, harnessSessionId: 'conversation-after-update', open: false })]);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});
