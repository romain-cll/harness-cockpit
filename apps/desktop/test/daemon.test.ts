import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectDaemon } from '@cockpit/daemon';
import { type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { heldProcess, isAlive, killDaemonsIn, MAIN_PROCESS_ERROR, quitApp, type Session, startClock, untilRead, versionLabel, watchTerminalEnd } from './launch';
import { addWorktree, aliveOf, type ApiWindow, beginSetup, commandOf, daemonEnded, daemonFile, daemonPid, daemonProcessesOf, daemonSettled, destroyWindows, dotOf, environmentOf, escapeRegExp, expectDot, expectScreen, expectTabCount, factsOf, type Fixture, goToWorkspacePage, hasEnded, killApp, launchBuiltOn, makeDataDir, makeFixture, makeRepoWithSetup, makeWorkspace, must, newShellTab, notificationShown, pagesOf, postEvent, selectTab, SETUP_PID, shellPid, startSession, startSetup, stubPicker, tabNames, tokenFor, typeLine, uniqueBuild, untilWindows, watchTerminal } from './support/daemon';

describe('daemon: built app', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let build: string;
  let env: NodeJS.ProcessEnv;
  let session: Session | undefined;
  let repo: { parent: string; root: string } | undefined;
  const known = { daemon: 0, session: '', sessionPid: 0, shells: [] as number[], workspace: '' };
  // COCKPIT-80 AC10: a process that is none of the test's, whose command line is the setup's
  // (`echo setup-pid-$$-ready; read _ < '<fifo>'`) and whose pid is lower than any setup's, runs for the
  // whole describe: a setup picked out by a machine-wide `ps` pattern would be this one, every run.
  let foreign: ChildProcess;

  beforeAll(async () => {
    foreign = spawn('/bin/sh', ['-c', `echo setup-pid-$$-ready; ${heldProcess().snippet}`], { stdio: 'ignore' });
    foreign.unref();
    await once(foreign, 'spawn');
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    build = uniqueBuild();
    env = fx.env({ COCKPIT_TEST_DAEMON_BUILD: build });
  });

  afterAll(async () => {
    foreign.kill('SIGKILL');
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  test('AC1 — with no daemon running the app spawns one before its window: detached into its own session, on the app\'s Electron as Node, with .sock and .token (0600), .pid and .log, and no Cockpit Pty Host process', async () => {
    session = await launchBuiltOn(env, dataDir, home);
    await session.page.getByText(versionLabel).waitFor();

    expect(readdirSync(home).filter((name) => name.startsWith('daemon-1-')).sort()).toEqual([`daemon-1-${build}.log`, `daemon-1-${build}.pid`, `daemon-1-${build}.sock`, `daemon-1-${build}.token`]);
    const socket = must(daemonFile(home, 'sock', build), 'the daemon sock');
    const token = must(daemonFile(home, 'token', build), 'the daemon token');
    const pid = must(daemonPid(home, build), 'the daemon pid');
    expect(statSync(socket).isSocket()).toBe(true);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(token).mode & 0o777).toBe(0o600);
    expect(readFileSync(token, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(must(daemonFile(home, 'log', build), 'the daemon log'))).toBe(true);
    expect(isAlive(pid)).toBe(true);
    expect(daemonProcessesOf(build)).toEqual([pid]);
    expect(commandOf(pid)).toContain('--cockpit-daemon');
    expect(environmentOf(pid)).toContain('ELECTRON_RUN_AS_NODE=1');
    // Its own session: it leads its process group, which is not the app's.
    expect(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim()).toBe(String(pid));
    expect(await session.evaluateInMain<string[]>(`require('electron').app.getAppMetrics().map((metric) => metric.name ?? '')`)).not.toContain('Cockpit Pty Host');
    known.daemon = pid;
  });

  test('AC13 — a shell of a workspace page gets COCKPIT_SOCKET (the daemon\'s .sock) and no session id; a session gets its own id and the socket; no pty environment holds ELECTRON_RUN_AS_NODE; the hook reaches the daemon (dot) and an unknown id gets 404', async () => {
    const { page } = session!;
    known.workspace = (await makeWorkspace(session!, 'daemon-ws')).path;
    await goToWorkspacePage(page, known.workspace);
    await newShellTab(page);
    // The socket is long: its name and whether it sits in COCKPIT_HOME are printed, not the whole path.
    await typeLine(
      page,
      `printf 'sock=<%s> home=<%s> sid=<%s> ras=<%s>\\n' "$(basename "$COCKPIT_SOCKET")" "$([ "$(dirname "$COCKPIT_SOCKET")" = '${home}' ] && echo ok)" "\${COCKPIT_SESSION_ID-unset}" "\${ELECTRON_RUN_AS_NODE-unset}"`,
    );
    const socket = must(daemonFile(home, 'sock', build), 'the daemon sock');
    await expectScreen(page, new RegExp(`^sock=<daemon-1-${build}\\.sock> home=<ok> sid=<unset> ras=<unset>$`, 'm'));
    known.shells.push(await shellPid(page));

    // A second tab, a second shell.
    await newShellTab(page);
    await expectScreen(page, /^sh-[\d.]+\$$/m);
    await typeLine(page, 'echo marker-two-$((6*7))');
    await expectScreen(page, /^marker-two-42$/m);
    known.shells.push(await shellPid(page));

    // The session, its status through the hook, and the endpoint's 404.
    known.session = await startSession(page);
    const [facts] = factsOf(fx);
    known.sessionPid = facts!.pid;
    expect(facts).toMatchObject({ session: known.session, socket, runasnode: 'unset' });
    await typeLine(page, 'hook UserPromptSubmit');
    await expectScreen(page, /^hooked:UserPromptSubmit$/m);
    await expectDot(page, known.session, 'Working');
    expect(await postEvent(socket, tokenFor(socket), { sessionId: randomUUID(), event: 'working' })).toBe(404);
  });

  test('AC2 — when the app quits (app.quit()) the daemon, the session and the two shells are still alive', async () => {
    await quitApp(session!);
    // The daemon has seen the app's connection close by the time it answers a new connection. `aliveOf` is a
    // snapshot: a process the daemon had signalled on that close but that is not gone yet would still read alive. The
    // next test carries the claim: it types into the same shells and the session after the relaunch.
    await daemonSettled(home, build);

    expect(aliveOf([known.daemon, known.sessionPid, ...known.shells])).toEqual([true, true, true, true]);
  });

  test('AC1, AC3, AC5 — the app launched again reuses the daemon (same pid, no second one); the session shows no "Ended" dot and its last status, its page shows the marker and takes a line; the workspace page shows one tab per shell in creation order, each with its marker and running a new command', async () => {
    session = await launchBuiltOn(env, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    expect(daemonPid(home, build)).toBe(known.daemon);
    expect(daemonProcessesOf(build)).toEqual([known.daemon]);

    await expectDot(page, known.session, 'Working');
    await page.locator(`aside a[href$="/sessions/${known.session}"]`).click();
    await expectScreen(page, /^marker-before-quit$/m);
    await typeLine(page, 'after-quit');
    await expectScreen(page, /^got:after-quit$/m);

    await goToWorkspacePage(page, known.workspace);
    await expectTabCount(page, 2);
    expect(await tabNames(page)).toEqual(['Terminal', 'Terminal']);
    await selectTab(page, 0);
    await expectScreen(page, /^sock=<daemon-1-.+\.sock> home=<ok> sid=<unset> ras=<unset>$/m);
    expect(await shellPid(page)).toBe(known.shells[0]);
    await selectTab(page, 1);
    await expectScreen(page, /^marker-two-42$/m);
    expect(await shellPid(page)).toBe(known.shells[1]);
    // One terminal per tab: no split came back.
    expect(await page.locator('.xterm:visible').count()).toBe(1);

    // The view starts at the pty's size: the rows it shows are the rows `stty size` reports.
    await typeLine(page, 'stty size');
    const screen = await expectScreen(page, /^\d+ \d+$/m);
    const rows = Number(/^(\d+) \d+$/m.exec(screen)![1]);
    expect(await page.locator('.xterm:visible .xterm-rows > div').count()).toBe(rows);
  });

  test('AC1 — an app on another data folder running at the same time shares the daemon: same pid, still one daemon process', async () => {
    const otherDir = makeDataDir();
    const other = await launchBuiltOn(env, otherDir, home);
    try {
      await other.page.getByText(versionLabel).waitFor();
      expect(daemonPid(home, build)).toBe(known.daemon);
      expect(daemonProcessesOf(build)).toEqual([known.daemon]);
      await quitApp(other);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('AC4, AC6 — a reload keeps every process and shows one tab per shell without the split; a closed tab ends its shell and is not shown again', async () => {
    const { page } = session!;
    await goToWorkspacePage(page, known.workspace);
    await selectTab(page, 0);
    await page.getByRole('tab').nth(0).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Split right', exact: true }).click();
    await page.locator('.xterm:visible').nth(1).waitFor();
    await page.locator('.xterm:visible').nth(2).waitFor({ state: 'detached' });
    // The pane that owns the split shell is the second visible terminal.
    const splitPid = await shellPid(page, 1);
    expect(splitPid).not.toBe(known.shells[0]);
    // The daemon will say when it ends: this connection attaches its terminal now.
    const watcher = await connectDaemon(must(daemonFile(home, 'sock', build), 'the daemon sock'));
    const split = await watchTerminalEnd(watcher, splitPid);

    await page.reload();
    await page.getByRole('tablist').first().waitFor();

    for (const pid of [...known.shells, splitPid, known.sessionPid]) expect(isAlive(pid), `process ${pid}`).toBe(true);
    await expectTabCount(page, 3);
    expect(await tabNames(page)).toEqual(['Terminal', 'Terminal', 'Terminal']);
    expect(await page.locator('.xterm:visible').count()).toBe(1);

    // Closing the last tab ends its shell; after a reload only two are left.
    await selectTab(page, 2);
    await page.getByRole('button', { name: 'Close Terminal', exact: true }).nth(2).click();
    try {
      await split.ended;
    } finally {
      watcher.close();
    }
    expect(isAlive(splitPid)).toBe(false);
    await page.reload();
    await page.getByRole('tablist').first().waitFor();
    await expectTabCount(page, 2);
    expect(await tabNames(page)).toEqual(['Terminal', 'Terminal']);
    expect(isAlive(known.shells[0]!) && isAlive(known.sessionPid)).toBe(true);
  });

  test('AC4 — closing the window and opening one again (activate) shows the running shells and session as before', async () => {
    expect(await destroyWindows(session!)).toEqual([]);
    for (const pid of [...known.shells, known.sessionPid]) expect(isAlive(pid)).toBe(true);

    const opened = untilWindows(session!, (urls) => urls.length === 1);
    await session!.evaluateInMain(`require('electron').app.emit('activate')`);
    expect(await opened).toHaveLength(1);
    const [reopened] = (await pagesOf(session!)).slice(-1);
    await reopened!.getByText(versionLabel).waitFor();
    await goToWorkspacePage(reopened!, known.workspace);
    await expectTabCount(reopened!, 2);
    expect(await shellPid(reopened!)).toBe(known.shells[0]);
    await expectDot(reopened!, known.session, 'Working');
  });

  test('COCKPIT-81 part 2 AC2 — a setup whose pid line is already on the screen when the test attaches still gives its pid (the attach serializes the screen: no newline after the last row)', async () => {
    repo = makeRepoWithSetup();
    const livePage = (await pagesOf(session!)).at(-1)!;
    const live = { ...session!, page: livePage } as Session;
    const socket = must(daemonFile(home, 'sock', build), 'the daemon sock');
    const early = await connectDaemon(socket);
    const late = await connectDaemon(socket);

    try {
      const id = await beginSetup(live, early, repo, 'setup-late');
      // The setup has printed its line once a first attach has seen it, so the next attach only gets the screen.
      const watched = await watchTerminal(early, id);
      const seen = await watched.find(/setup-pid-\d+/);
      const { screen } = await late.attach(id);

      expect(screen, 'the line is on the serialized screen').toContain(seen[0]);
      expect(screen, 'no newline follows the last row').not.toMatch(/setup-pid-\d+[^\r\n]*\r?\n/);
      const found = SETUP_PID.exec(screen);
      expect(found, 'the pattern the tests find a setup pid with matches the late screen').not.toBeNull();
      expect(Number(found![1])).toBeGreaterThan(0);

      // The setup ends with its page.
      await livePage.reload();
      await livePage.getByText(versionLabel).waitFor();
      await watched.exited;
    } finally {
      early.close();
      late.close();
    }
  });

  test('AC7, AC10 — a setup (commands terminal) ends when its page reloads, and is not shown again; when the app is killed with SIGKILL the daemon, the shells and the session still run once the daemon has dealt with its disconnection, and the setup is gone', async () => {
    repo = makeRepoWithSetup();
    const livePage = (await pagesOf(session!)).at(-1)!;
    const live = { ...session!, page: livePage } as Session;
    const daemon = await connectDaemon(must(daemonFile(home, 'sock', build), 'the daemon sock'));

    try {
      const first = await startSetup(live, daemon, repo, 'setup-reload');
      await livePage.reload();
      await livePage.getByText(versionLabel).waitFor();
      await first.exited;
      expect(hasEnded(first.pid), 'the setup ends with its page').toBe(true);
      await goToWorkspacePage(livePage, known.workspace);
      await expectTabCount(livePage, 2);
      expect(await tabNames(livePage)).toEqual(['Terminal', 'Terminal']);

      const second = await startSetup(live, daemon, repo, 'setup-kill');
      await killApp(session!);

      // The daemon ends the commands terminal when the app's connection closes: its `exit` message is the proof
      // that it handled the disconnection, and nothing else of the app's end is left to happen.
      await second.exited;
      expect(isAlive(known.daemon)).toBe(true);
      expect(hasEnded(second.pid), 'the daemon ends the commands terminal of the killed app').toBe(true);
      expect(aliveOf([known.daemon, known.sessionPid, ...known.shells])).toEqual([true, true, true, true]);
      expect(isAlive(foreign.pid!), 'the foreign process is no setup: still running').toBe(true);
    } finally {
      daemon.close();
    }
  });

  test('AC8 — an app of another build shows the session and the shell of the older daemon and takes their input; new terminals run in a daemon of its own; the older daemon exits and removes .sock, .token and .pid, not .log, once its last terminal ends', async () => {
    const newer = uniqueBuild();
    session = await launchBuiltOn({ ...env, COCKPIT_TEST_DAEMON_BUILD: newer }, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    await expectDot(page, known.session, 'Working');
    await page.locator(`aside a[href$="/sessions/${known.session}"]`).click();
    await expectScreen(page, /^marker-before-quit$/m);
    await typeLine(page, 'from-newer');
    await expectScreen(page, /^got:from-newer$/m);
    await goToWorkspacePage(page, known.workspace);
    await expectTabCount(page, 2);
    await selectTab(page, 1);
    await expectScreen(page, /^marker-two-42$/m);
    await typeLine(page, 'echo from-newer-$((6*7))');
    await expectScreen(page, /^from-newer-42$/m);

    // A new terminal runs in the new build's daemon.
    await newShellTab(page);
    const fresh = await shellPid(page);
    const newerPid = must(daemonPid(home, newer), 'the daemon pid');
    expect(newerPid).not.toBe(known.daemon);
    expect(execFileSync('ps', ['-p', String(fresh), '-o', 'ppid='], { encoding: 'utf8' }).trim()).toBe(String(newerPid));
    expect(isAlive(known.daemon)).toBe(true);
    expect(daemonFile(home, 'sock', build)).toBeDefined();

    // End the older daemon's session (the stub exits on `exit`) and its two shells.
    await page.locator(`aside a[href$="/sessions/${known.session}"]`).click();
    await typeLine(page, 'exit');
    await expectDot(page, known.session, 'Exited 3');
    await goToWorkspacePage(page, known.workspace);
    for (const index of [0, 1]) {
      await selectTab(page, index);
      await typeLine(page, 'exit');
    }

    await daemonEnded(known.daemon);
    expect([daemonFile(home, 'sock', build), daemonFile(home, 'token', build), daemonFile(home, 'pid', build)]).toEqual([undefined, undefined, undefined]);
    expect(daemonFile(home, 'log', build)).toBeDefined();
    expect(daemonFile(home, 'sock', newer)).toBeDefined();
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});

// --- Built app: the setup state and the agent's exit survive a relaunch (COCKPIT-57) ---------------

describe('daemon: built app, setup states and agent exits after a relaunch', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let session: Session | undefined;
  let repo: { parent: string; root: string } | undefined;

  beforeAll(() => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    env = fx.env({ COCKPIT_TEST_DAEMON_BUILD: uniqueBuild() });
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  // The label the workspace's own row shows (`Setting up`, `Setup failed`), null when it shows none. Self-contained: it runs in `untilRead`.
  const readLabel = ({ path }: { path: string; label?: string | null }) => {
    const item = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === path)?.closest('li');
    const leaf = [...(item?.querySelectorAll('*') ?? [])].find(
      (element) => element.children.length === 0 && !element.closest('a[href*="/sessions/"]') && /^(Setting up|Setup failed)$/.test((element.textContent ?? '').trim()),
    );
    return leaf ? (leaf.textContent ?? '').trim() : null;
  };
  const expectLabel = async (page: Page, path: string, label: string | null) =>
    expect(await untilRead(page, readLabel, (found, arg: { path: string; label: string | null }) => found === arg.label, { path, label }), `the label of ${path}`).toBe(label);

  test('AC6 — a workspace whose setup failed, then reported running again, and a session whose agent exited with code 3, show the same label and the same dot after the app quit and was launched again', async () => {
    repo = makeRepoWithSetup({ setup: ['exit 6'] });
    session = await launchBuiltOn(env, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    // A workspace and a session in it started as the composer does: `cockpit setup`, which fails.
    await stubPicker(session, repo.root);
    await page.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!());
    const created = await page.evaluate(([root, name]) => (window as unknown as ApiWindow).api.workspaces!.create!(root, name, 'main'), [repo.root, 'relaunch-ws'] as const);
    expect(created.status).toBe('created');
    const path = (created as { workspace: { path: string } }).workspace.path;
    const started = await page.evaluate(
      ([root, path]) =>
        (window as unknown as ApiWindow).api.sessions!.start!('claude-code', { cols: 80, rows: 24 }, { workspace: { project: root, path }, prompt: 'p', setup: true }),
      [repo.root, path] as const,
    );
    expect(started.status).toBe('started');
    await expectLabel(page, path, 'Setup failed');

    // The daemon is told the setup runs again (what `cockpit setup` typed in the shell reports).
    const socket = must(daemonFile(home, 'sock'), 'the daemon sock');
    expect(await postEvent(socket, tokenFor(socket), { sessionId: started.session.id, event: 'setup-running' })).toBe(204);
    await expectLabel(page, path, 'Setting up');

    // A plain session whose agent exits with code 3 while its shell goes on.
    const exiting = await startSession(page);
    expect(await postEvent(socket, tokenFor(socket), { sessionId: exiting, event: 'exited', exitCode: 3 })).toBe(204);
    await expectDot(page, exiting, 'Exited 3');

    await quitApp(session);
    session = await launchBuiltOn(env, dataDir, home);
    await session.page.getByText(versionLabel).waitFor();

    await expectLabel(session.page, path, 'Setting up');
    await expectDot(session.page, exiting, 'Exited 3');
    expect(await dotOf(session.page, started.session.id)).toBeNull();
  }, 90_000);
});

describe('daemon: an update with an idle daemon', () => {
  let dataDir: string;
  let home: string;
  let session: Session | undefined;

  beforeAll(() => {
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC8 — a daemon holding no terminal exits as soon as an app of another build connects', async () => {
    const [older, newer] = [uniqueBuild(), uniqueBuild()];
    const first = await launchBuiltOn({ ...process.env, SHELL: '/bin/sh', COCKPIT_TEST_DAEMON_BUILD: older }, dataDir, home);
    await first.page.getByText(versionLabel).waitFor();
    const olderPid = must(daemonPid(home, older), 'the daemon pid');
    expect(isAlive(olderPid)).toBe(true);
    await quitApp(first);

    session = await launchBuiltOn({ ...process.env, SHELL: '/bin/sh', COCKPIT_TEST_DAEMON_BUILD: newer }, dataDir, home);
    await session.page.getByText(versionLabel).waitFor();

    await daemonEnded(olderPid);
    expect(daemonFile(home, 'sock', older)).toBeUndefined();
    expect(daemonFile(home, 'sock', newer)).toBeDefined();
  });
});

// --- Built app: the daemon cannot start ---------------------------------------

describe('daemon: built app, the daemon cannot start', () => {
  let dataDir: string;
  const build = uniqueBuild();
  let session: Session | undefined;
  let repo: { parent: string; root: string } | undefined;

  beforeAll(() => {
    dataDir = makeDataDir();
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  const reasonOf = (output: string) => {
    const lines = output.split('\n').filter((line) => line.startsWith("Cockpit's background service could not start: "));
    expect(lines.length, 'one stderr line').toBe(1);
    return lines[0]!.slice("Cockpit's background service could not start: ".length);
  };
  const failureView = (page: Page) => page.getByText("Cockpit's background service could not start", { exact: true });
  const SUBTITLE = 'Terminals and agents run in this service. Your projects and workspaces are untouched.';

  test('AC10 — COCKPIT_HOME a regular file: the window opens; stderr names the path; a workspace page and a session page show the failure view; the Sessions section says so; spawn and sessions.start are refused with the reason; projects can still be added and removed', async () => {
    const fx = makeFixture();
    const home = join(dataDir, 'h');
    writeFileSync(home, 'a file, not a folder');
    repo = makeRepoWithSetup();
    // A session of an earlier launch, so its page can be opened while the daemon is down.
    const seeded = { id: randomUUID(), name: 'Claude Code 1', harness: 'claude-code', directory: join(fx.root, 'earlier'), createdAt: new Date().toISOString() };
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, sessions: [seeded] }));
    try {
      session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: build }), dataDir, home);
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      const reason = reasonOf(session.output());
      expect(reason).toContain(home);

      // The failure view: title, subtitle, the reason in monospace and "Try again", on a workspace page and on a session page.
      const expectFailureView = async () => {
        await failureView(page).waitFor();
        await page.getByText(SUBTITLE, { exact: true }).waitFor();
        await page.locator('code, pre, [class*="mono"]').filter({ hasText: reason }).first().waitFor();
        await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
        expect(await page.getByRole('button', { name: 'Show log', exact: true }).count(), 'no log file exists').toBe(0);
      };
      // Projects can be added though the daemon is down (worktrees need the home folder: this one is made with git).
      await stubPicker(session, repo.root);
      expect((await page.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!())).status).toBe('added');
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).projects.map((p: { path: string }) => p.path)).toEqual([repo.root]);
      const worktree = join(fx.root, 'wt-view');
      addWorktree(repo.root, 'view', worktree);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.getByTitle(worktree, { exact: true }).first().click();
      await expectFailureView();
      expect(await page.locator('[role="tablist"]').count(), 'the view replaces the panes').toBe(0);
      expect(await page.locator('.xterm').count(), 'no terminal is drawn').toBe(0);
      await page.locator('aside').getByRole('link', { name: seeded.name }).click();
      await page.waitForURL(new RegExp(`/sessions/${seeded.id}$`));
      await page.getByRole('heading', { name: seeded.name }).waitFor();
      await expectFailureView();
      expect(await page.getByText('This session has ended.').count(), 'the failure view replaces the ended page').toBe(0);

      await page.locator('aside').getByText(`Cockpit's background service could not start: ${reason}`, { exact: true }).waitFor();

      const spawned = await page.evaluate(() => (window as unknown as ApiWindow).api.pty!.spawn!({ cols: 80, rows: 24 }).then(() => 'spawned', (error: Error) => error.message));
      expect(spawned).toContain(reason);
      const started = await page.evaluate(() => (window as unknown as ApiWindow).api.sessions!.start!('claude-code', { cols: 80, rows: 24 }, {}));
      expect(started.status).toBe('refused');
      expect(started.message).toContain(reason);
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).sessions, 'only the seeded session').toEqual([seeded]);

      // Projects can still be removed.
      await page.evaluate((root) => (window as unknown as ApiWindow).api.projects!.remove!(root), repo.root);
      expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).projects ?? []).toEqual([]);
      expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('AC10, AC11, COCKPIT-69 AC1 — daemon-1-<build>.sock a folder: the view stays with the new reason while the cause remains, "Show log" opens the log with shell.openPath, and "Try again" after removing the cause starts the daemon and a terminal runs a command', async () => {
    await session!.close();
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir);
    const fx = makeFixture();
    const home = join(dataDir, 'h');
    const socket = join(home, `daemon-1-${build}.sock`);
    mkdirSync(socket, { recursive: true });
    try {
      session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: build }), dataDir, home);
      const { page } = session;
      await page.getByText(versionLabel).waitFor();
      const reason = reasonOf(session.output());
      expect(reason).toContain(socket);
      // The home folder exists, so a workspace can be made: its page shows the failure view.
      repo ??= makeRepoWithSetup();
      const root = repo.root;
      const view = await makeWorkspace(session, 'view-ws', root);
      await page.getByTitle(view.path, { exact: true }).first().click();
      await failureView(page).waitFor();

      // COCKPIT-69 AC1: the look of the view, in computed colours. Self-contained: it runs in the page.
      const look = await page.evaluate((reasonText) => {
        const colorOf = (token: string) => {
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`;
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        const icon = document.querySelector('svg.lucide-server-crash');
        const reasonElement = [...document.querySelectorAll('code, pre, [class*="mono"]')].find((element) => (element.textContent ?? '').includes(reasonText));
        // The nearest block around the reason (itself included) that has a fill.
        let block: Element | null = reasonElement ?? null;
        while (block && getComputedStyle(block).backgroundColor === 'rgba(0, 0, 0, 0)') block = block.parentElement;
        const button = (name: string) => [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === name);
        const tryAgain = button('Try again') && getComputedStyle(button('Try again')!);
        const showLog = button('Show log') && getComputedStyle(button('Show log')!);
        return {
          icon: icon && { color: getComputedStyle(icon).color, width: icon.getBoundingClientRect().width, height: icon.getBoundingClientRect().height },
          reason: reasonElement && { color: getComputedStyle(reasonElement).color, font: getComputedStyle(reasonElement).fontFamily, fill: block && getComputedStyle(block).backgroundColor },
          tryAgain: tryAgain && { fill: tryAgain.backgroundColor },
          showLog: showLog && { border: showLog.borderTopWidth, fill: showLog.backgroundColor },
          tokens: { destructive: colorOf('--destructive'), subtle: colorOf('--subtle'), hover: colorOf('--hover'), brand: colorOf('--brand') },
        };
      }, reason);
      expect(look.icon, 'Lucide server-crash, 20 px, in --destructive').toEqual({ color: look.tokens.destructive, width: 20, height: 20 });
      expect(look.reason?.font, 'monospace').toMatch(/mono/i);
      expect(look.reason?.color, 'the reason in --subtle').toBe(look.tokens.subtle);
      expect(look.reason?.fill, 'on a --hover block').toBe(look.tokens.hover);
      expect(look.tryAgain?.fill, '"Try again" filled with --brand').toBe(look.tokens.brand);
      expect(look.showLog?.border, '"Show log" outlined').not.toBe('0px');
      expect(look.showLog?.fill, '"Show log" not filled with --brand').not.toBe(look.tokens.brand);

      // "Show log": the log file exists, shell.openPath receives it.
      await session.evaluateInMain(`(() => { globalThis.__opened = []; require('electron').shell.openPath = async (path) => { globalThis.__opened.push(path); globalThis.__onOpened?.(); return ''; }; })()`);
      await page.getByRole('button', { name: 'Show log', exact: true }).click();
      expect(await session.evaluateInMain<string[]>(`new Promise((resolve) => { globalThis.__onOpened = () => resolve(globalThis.__opened); if (globalThis.__opened.length > 0) resolve(globalThis.__opened); })`)).toEqual([join(home, `daemon-1-${build}.log`)]);

      // Projects and workspaces are untouched: the home folder exists, so a worktree can be made and deleted.
      const created = await page.evaluate((root) => (window as unknown as ApiWindow).api.workspaces!.create!(root, 'still-works', 'main'), root);
      expect(created.status).toBe('created');
      // The worktree is made when `create` answers: the list shows it at once.
      const worktree = await page.evaluate(
        async (root) =>
          ((await (window as unknown as ApiWindow).api.projects!.list!()) as Array<{ path: string; workspaces: Array<{ path: string; name: string }> }>)
            .find((project) => project.path === root)
            ?.workspaces.find((workspace) => workspace.name === 'still-works')?.path,
        root,
      );
      expect(worktree, 'the workspace is listed').toBeDefined();
      expect(existsSync(worktree!)).toBe(true);
      const removed = await page.evaluate(([root, path]) => (window as unknown as ApiWindow).api.workspaces!.remove!(root, path, {}), [root, worktree!] as const);
      expect(removed.status).toBe('removed');
      expect(existsSync(worktree!)).toBe(false);

      // The cause remains: the view stays.
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await failureView(page).waitFor();
      expect(daemonProcessesOf(build)).toEqual([]);

      // The cause is removed.
      rmSync(socket, { recursive: true, force: true });
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await failureView(page).waitFor({ state: 'detached' });
      expect(await page.locator('aside').getByText("Cockpit's background service could not start", { exact: false }).count()).toBe(0);
      await newShellTab(page);
      await typeLine(page, 'echo cockpit-$((6*7))');
      await expectScreen(page, /^cockpit-42$/m);
      expect(isAlive(must(daemonPid(home, build), 'the daemon pid'))).toBe(true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// --- Built app: a daemon that does not answer ---------------------------------

describe('daemon: built app, a daemon that does not answer', () => {
  let dataDir: string;
  let home: string;
  let session: Session | undefined;

  beforeAll(() => {
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    // A stopped daemon is resumed, then killed.
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
  });

  const failureView = (page: Page) => page.getByText("Cockpit's background service could not start", { exact: true });
  const baseEnv = (build: string) => ({ ...process.env, SHELL: '/bin/sh', COCKPIT_TEST_DAEMON_BUILD: build });

  test('AC18 — the daemon of the app\'s build is stopped (SIGSTOP): the window opens and, within 10 s, the failure state shows "did not answer within 5 s: <socket>" (view, sidebar line, stderr line, refusals); after SIGCONT "Try again" connects and a terminal runs a command', async () => {
    const build = uniqueBuild();
    const first = await launchBuiltOn(baseEnv(build), dataDir, home);
    await first.page.getByText(versionLabel).waitFor();
    const pid = must(daemonPid(home, build), 'the daemon pid');
    const workspace = await makeWorkspace(first, 'stopped-ws');
    await quitApp(first);
    process.kill(pid, 'SIGSTOP');

    session = await launchBuiltOn(baseEnv(build), dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    const socket = join(home, `daemon-1-${build}.sock`);
    const reason = `Cockpit's background service did not answer within 5 s: ${socket}`;

    // The criterion's bound: the failure state shows within 10 s of the window opening.
    const within = startClock();
    await page.getByTitle(workspace.path, { exact: true }).first().click();
    await failureView(page).waitFor();
    within('the failure state shows', 10_000);
    await page.locator('code, pre, [class*="mono"]').filter({ hasText: reason }).first().waitFor();
    await page.locator('aside').getByText(`Cockpit's background service could not start: ${reason}`, { exact: true }).waitFor();
    expect(session.output()).toContain(`Cockpit's background service could not start: ${reason}`);
    const spawned = await page.evaluate(() => (window as unknown as ApiWindow).api.pty!.spawn!({ cols: 80, rows: 24 }).then(() => 'spawned', (error: Error) => error.message));
    expect(spawned).toContain(reason);
    const started = await page.evaluate(() => (window as unknown as ApiWindow).api.sessions!.start!('claude-code', { cols: 80, rows: 24 }, {}));
    expect(started.status).toBe('refused');

    process.kill(pid, 'SIGCONT');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await failureView(page).waitFor({ state: 'detached' });
    await newShellTab(page);
    await typeLine(page, 'echo cockpit-$((6*7))');
    await expectScreen(page, /^cockpit-42$/m);
    expect(isAlive(pid), 'the same daemon').toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  }, 90_000);

  test('AC18 — a daemon of another build that does not answer is skipped, noted on stderr, and the app\'s own daemon works', async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir);
    const [older, newer] = [uniqueBuild(), uniqueBuild()];
    const first = await launchBuiltOn(baseEnv(older), dataDir, home);
    await first.page.getByText(versionLabel).waitFor();
    const pid = must(daemonPid(home, older), 'the older daemon pid');
    const workspace = await makeWorkspace(first, 'older-ws');
    await quitApp(first);
    process.kill(pid, 'SIGSTOP');

    session = await launchBuiltOn(baseEnv(newer), dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    await goToWorkspacePage(page, workspace.path);
    await page.getByRole('button', { name: 'New tab', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
    await typeLine(page, 'echo cockpit-$((6*7))');
    await expectScreen(page, /^cockpit-42$/m);

    expect(await page.getByText("Cockpit's background service could not start").count(), 'no failure state').toBe(0);
    const olderSocket = join(home, `daemon-1-${older}.sock`);
    // The app notes on stderr that it skipped the older daemon: it says so once its connection attempt gave up.
    await session.outputMatch(new RegExp(`did not answer[^\\n]*${escapeRegExp(olderSocket)}`));
    expect(daemonPid(home, newer), 'the app\'s own daemon').toBeDefined();
    expect(isAlive(pid)).toBe(true);
  }, 90_000);
});

// --- Built app: IPC from another origin ----------------------------------------

describe('daemon: built app, requests from another origin', () => {
  let dataDir: string;
  let session: Session | undefined;

  beforeAll(() => {
    dataDir = makeDataDir();
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(join(dataDir, 'h'));
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC22, COCKPIT-69 AC21 — pty.list, pty.attach (of an existing terminal), daemon.status, daemon.retry, daemon.showLog and the new sessions.ended, sessions.dismiss, daemon.outdated, daemon.restart and daemon.later reject from another origin: no daemon is started or contacted, shell.openPath is not called and the terminal\'s owner is unchanged', async () => {
    const build = uniqueBuild();
    const home = join(dataDir, 'h');
    // The daemon cannot start (its socket path is a folder), so its log exists and a retry would start it once the cause is gone.
    const socket = join(home, `daemon-1-${build}.sock`);
    mkdirSync(socket, { recursive: true });
    session = await launchBuiltOn({ ...process.env, SHELL: '/bin/sh', COCKPIT_TEST_DAEMON_BUILD: build }, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    // The app notes the failure on stderr after its attempt to start the daemon, which opened the log.
    await session.outputMatch(/Cockpit's background service could not start: /);
    expect(existsSync(join(home, `daemon-1-${build}.log`))).toBe(true);
    await session.evaluateInMain(`(() => { globalThis.__opened = []; require('electron').shell.openPath = async (path) => { globalThis.__opened.push(path); globalThis.__onOpened?.(); return ''; }; })()`);
    // The app's own page may ask: the handlers are there.
    expect(await page.evaluate(() => (window as unknown as ApiWindow).api.daemon!.status!().then(() => 'answered'))).toBe('answered');
    // The cause is gone: a retry that got through would start the daemon.
    rmSync(socket, { recursive: true, force: true });
    const outputBefore = session.output();

    const results = await session.evaluateInMain<Record<string, string>>(`(async () => {
      const handlers = require('electron').ipcMain._invokeHandlers;
      const calls = { 'pty:list': [], 'daemon:status': [], 'daemon:retry': [], 'daemon:show-log': [], 'sessions:ended': [], 'sessions:dismiss': ['a-session'], 'daemon:outdated': [], 'daemon:restart': [], 'daemon:later': [] };
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

    expect(results).toEqual({
      'pty:list': 'rejected',
      'daemon:status': 'rejected',
      'daemon:retry': 'rejected',
      'daemon:show-log': 'rejected',
      'sessions:ended': 'rejected',
      'sessions:dismiss': 'rejected',
      'daemon:outdated': 'rejected',
      'daemon:restart': 'rejected',
      'daemon:later': 'rejected',
    });
    expect(await session.evaluateInMain<string[]>('globalThis.__opened'), 'shell.openPath is not called').toEqual([]);
    expect(daemonProcessesOf(build), 'no daemon is started').toEqual([]);
    expect(daemonFile(home, 'sock', build)).toBeUndefined();
    expect(daemonFile(home, 'pid', build)).toBeUndefined();
    expect(session.output().slice(outputBefore.length)).not.toMatch(MAIN_PROCESS_ERROR);

    // The app's own "Try again" does start it (on the page of a workspace, made now that the cause is gone).
    const workspace = await makeWorkspace(session, 'origin-ws');
    await page.getByTitle(workspace.path, { exact: true }).first().click();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    // The panes show once the daemon answers, and its files are written before it can.
    await page.getByRole('tablist').first().waitFor();
    expect(daemonPid(home, build)).toBeDefined();
    expect(daemonProcessesOf(build)).toHaveLength(1);

    // A terminal that exists: the app's page spawns a shell and listens to its output.
    type PtyWindow = { __ptyData: Record<number, string>; __ptyChecks: Array<() => void> };
    const id = await page.evaluate(async () => {
      const api = (window as unknown as { api: { pty: { spawn(o: { cols: number; rows: number }): Promise<number>; onData(l: (id: number, data: string) => void): () => void } } }).api;
      const w = window as unknown as PtyWindow;
      w.__ptyData = {};
      w.__ptyChecks = [];
      api.pty.onData((terminalId, data) => {
        w.__ptyData[terminalId] = (w.__ptyData[terminalId] ?? '') + data;
        for (const check of w.__ptyChecks.slice()) check();
      });
      return api.pty.spawn({ cols: 80, rows: 24 });
    });
    // Resolves with what the terminal has printed once it holds `text`, checked at once and on each chunk.
    const heard = (text: string) =>
      page.evaluate(
        ([id, text]) =>
          new Promise<string>((resolve) => {
            const w = window as unknown as PtyWindow;
            const check = () => {
              const data = w.__ptyData[id as number] ?? '';
              if (!data.includes(text as string)) return;
              w.__ptyChecks.splice(w.__ptyChecks.indexOf(check), 1);
              resolve(data);
            };
            w.__ptyChecks.push(check);
            check();
          }),
        [id, text] as const,
      );
    const type = (text: string) => page.evaluate(([id, text]) => (window as unknown as ApiWindow).api.pty!.write!(id, text), [id, text] as const);
    await type('echo before-$((6*7))\n');
    await heard('before-42');

    // Another origin attaches that id: it is refused, and the owner (the app's page) is unchanged.
    const attached = await session.evaluateInMain<string>(`(async () => {
      const handler = require('electron').ipcMain._invokeHandlers.get('pty:attach');
      try {
        await handler({ senderFrame: { url: 'https://example.com/' }, sender: null }, ${id});
        return 'resolved';
      } catch (error) {
        return 'rejected: ' + error.message;
      }
    })()`);
    expect(attached, 'pty:attach from another origin').toBe('rejected: pty:attach refused: unexpected origin');
    await type('echo after-$((6*7))\n');
    expect(await heard('after-42'), 'the terminal still reaches the app\'s page').toContain('after-42');
  });
});

// --- Built app: a notification with no window ----------------------------------

describe('daemon: built app, notification with no window', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let session: Session | undefined;

  beforeAll(async () => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: uniqueBuild() }), dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  });

  test('AC13 — with no window open a "waiting" report shows a notification, and clicking it opens a window on the session\'s page', async () => {
    const { page } = session!;
    const id = await startSession(page);
    await session!.evaluateInMain(`(() => {
      const { Notification, BrowserWindow } = require('electron');
      globalThis.__notified = [];
      globalThis.__onShown = [];
      Notification.prototype.show = function () {
        globalThis.__notified.push(this);
        for (const listener of globalThis.__onShown.splice(0)) listener();
      };
      BrowserWindow.getFocusedWindow = () => null;
    })()`);
    expect(await destroyWindows(session!)).toEqual([]);

    const socket = must(daemonFile(home, 'sock'), 'the daemon sock');
    expect(await postEvent(socket, tokenFor(socket), { sessionId: id, event: 'waiting' })).toBe(204);
    await notificationShown(session!);
    expect(await session!.evaluateInMain<string>('globalThis.__notified.at(-1).body')).toBe('Needs input');

    const opened = untilWindows(session!, (urls, wanted: string) => urls.length === 1 && urls[0]!.endsWith(wanted), `/sessions/${id}`);
    await session!.evaluateInMain(`globalThis.__notified.at(-1).emit('click')`);
    expect(await opened).toHaveLength(1);
  });

  test('AC24 — with no window open, clicking the notification of a workspace session opens a window on that workspace\'s page with the session\'s tab selected', async () => {
    // The window the previous test's click opened is the only page left; the first one was destroyed.
    const open = (await pagesOf(session!)).find((page) => page.url().startsWith('app://'));
    expect(open, 'a window is open').toBeDefined();
    const root = makeRepoWithSetup({}).root;
    await stubPicker(session!, root);
    await open!.evaluate(() => (window as unknown as ApiWindow).api.projects!.add!());
    const created = await open!.evaluate(([root, name]) => (window as unknown as ApiWindow).api.workspaces!.create!(root, name, 'main'), [root, 'nowin-ws'] as const);
    expect(created.status).toBe('created');
    const path = (created as { workspace: { path: string } }).workspace.path;
    // An earlier terminal in the workspace (a shell), so that the tab a fresh window selects by itself
    // (the first) is not the notified session's.
    await open!.evaluate((path) => (window as unknown as ApiWindow).api.pty!.spawn!({ cols: 80, rows: 24, workspace: path }), path);
    const started = await open!.evaluate(
      ([root, path]) => (window as unknown as ApiWindow).api.sessions!.start!('claude-code', { cols: 80, rows: 24 }, { workspace: { project: root, path } }),
      [root, path] as const,
    );
    expect(started.status).toBe('started');
    const id = started.session.id as string;

    await session!.evaluateInMain(`globalThis.__notified.length = 0`);
    expect(await destroyWindows(session!)).toEqual([]);

    const socket = must(daemonFile(home, 'sock'), 'the daemon sock');
    expect(await postEvent(socket, tokenFor(socket), { sessionId: id, event: 'waiting' })).toBe(204);
    await notificationShown(session!);
    expect(await session!.evaluateInMain<string>('globalThis.__notified.at(-1).title')).toBe('Claude Code 1');

    const landed = (url: string) => {
      if (!url.startsWith('app://')) return false;
      const parsed = new URL(url);
      return parsed.pathname === '/workspace' && parsed.searchParams.get('path') === path;
    };
    // Self-contained: it runs in the main process.
    const onWorkspace = (urls: string[], wanted: string) => {
      if (urls.length !== 1 || !urls[0]!.startsWith('app://')) return false;
      const parsed = new URL(urls[0]!);
      return parsed.pathname === '/workspace' && parsed.searchParams.get('path') === wanted;
    };
    const opened = untilWindows(session!, onWorkspace, path);
    await session!.evaluateInMain(`globalThis.__notified.at(-1).emit('click')`);
    const urls = await opened;
    expect(urls).toHaveLength(1);
    expect(landed(urls[0]!), `the window is on the workspace page: ${urls[0]}`).toBe(true);

    const page = (await pagesOf(session!)).find((candidate) => landed(candidate.url()))!;
    expect(page, 'the new window\'s page').toBeDefined();
    const tabs = page.locator('[role="tab"]');
    await tabs.nth(1).waitFor();
    await tabs.nth(2).waitFor({ state: 'detached' });
    // The shell comes first, the notified session second; the session's tab is the selected one.
    expect((await tabs.last().textContent())?.trim()).toBe('Claude Code 1');
    await page.locator('[role="tab"][aria-selected="true"]', { hasText: 'Claude Code 1' }).waitFor();
    expect(await tabs.first().getAttribute('aria-selected'), 'the shell\'s tab is not selected').toBe('false');
  });
});

// --- Packaged app and dev server: one smoke path each ---------------------------
