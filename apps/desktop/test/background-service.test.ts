import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { killDaemonsIn, MAIN_PROCESS_ERROR, quitApp, type Session, untilRead, versionLabel } from './launch';
import {
  addWorktree,
  endedIconOf,
  expectScreen,
  expectTabCount,
  type Fixture,
  goToWorkspacePage,
  killDaemon,
  launchBuiltOn,
  leaveStaleDaemon,
  makeDataDir,
  makeFixture,
  makeRepoWithSetup,
  makeWorkspace,
  must,
  newAgentTab,
  newShellTab,
  restartButton,
  restartDialog,
  selectTab,
  startFakeDaemon,
  stoppedBanner,
  stubPicker,
  tabNames,
  tabNamed,
  typeLine,
  uniqueBuild,
  untilEvents,
  watchEvents,
  daemonPid,
  daemonFile,
} from './support/daemon';
import { waitForRowStatus } from './support/panes';
import { deleteButton, openDeleteDialog, removeThroughMenu, waitForNoEntry } from './support/projects';

// COCKPIT-69: each way the background service can fail, stop, vanish after a reboot or become unreachable has its
// own screen. The built app runs every case (the dev server and the packaged app run one smoke path each, in
// `support/daemon.ts`). A fake login shell puts a stub `claude` on the PATH and hands the shell tabs a real /bin/sh.

const FAILURE_TITLE = "Cockpit's background service could not start";
const REBOOT_REASON = "Cockpit's background service stopped when your Mac restarted.";

const failureView = (page: Page) => page.getByText(FAILURE_TITLE, { exact: true });
const endedView = (page: Page) => page.getByText('This terminal ended', { exact: true });
const noTab = (page: Page) => page.getByText('No tab open', { exact: true });
const state = (dataDir: string, content: unknown) => writeFileSync(join(dataDir, 'state.json'), JSON.stringify(content));
const storedSessions = (dataDir: string) => (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { sessions?: Array<{ id: string; open?: boolean }> }).sessions ?? [];

// The look of the banner: its fill and border against the `--status-working` token (10% and 25%), and whether it sits
// under the tab bar. Self-contained: it runs in the page.
const readBanner = () => {
  const mentions = (element: Element) => /Background service stopped/.test(element.textContent ?? '');
  const leaf = [...document.querySelectorAll('*')].find((element) => mentions(element) && ![...element.children].some(mentions))!;
  let box: Element | null = leaf;
  while (box && ![...box.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Restart')) box = box.parentElement;
  const probe = document.createElement('div');
  document.body.append(probe);
  probe.style.backgroundColor = 'color-mix(in oklab, var(--status-working) 10%, transparent)';
  probe.style.border = '1px solid color-mix(in oklab, var(--status-working) 25%, transparent)';
  const expected = { fill: getComputedStyle(probe).backgroundColor, border: getComputedStyle(probe).borderTopColor };
  probe.remove();
  const style = getComputedStyle(box!);
  const tabs = document.querySelector('[role="tablist"]')!.getBoundingClientRect();
  return { fill: style.backgroundColor, border: style.borderTopColor, expected, below: box!.getBoundingClientRect().top >= tabs.bottom - 1 };
};

describe('background service: stopped while the app runs', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let build: string;
  let session: Session;
  let workspace: { path: string; root: string };
  const NAME = 'svc-ws';
  const seeded = { id: randomUUID(), name: 'Earlier session', harness: 'claude-code', directory: '', createdAt: new Date().toISOString() };

  beforeAll(() => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    build = uniqueBuild();
    // A session outside any project, stored by an earlier launch: its page can be opened with the banner.
    seeded.directory = join(fx.root, 'earlier');
    state(dataDir, { version: 1, sessions: [seeded] });
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  });

  test('AC3 — no terminal ran: the daemon dies, a shell is then opened and runs a command, and no banner has shown', async () => {
    session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: build }), dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    workspace = await makeWorkspace(session, NAME);
    await goToWorkspacePage(page, workspace.path);
    await watchEvents(page);

    const before = await killDaemon(home, build);
    // The app has seen the daemon go once the page is told.
    await untilEvents(page, 'changed', 1);
    await newShellTab(page);
    await typeLine(page, 'echo first-$((6*7))');
    await expectScreen(page, /^first-42$/m);

    expect(await stoppedBanner(page).count()).toBe(0);
    expect(must(daemonPid(home, build), 'the new daemon pid')).not.toBe(before);
  });

  test('AC2 — 2 shells and 1 session, plus a shell closed before: killing the daemon shows the amber banner "Background service stopped · 3 terminals ended" under the tab bar with "Restart", each terminal ends with [Process ended], each tab shows the "Ended" icon and the workspace row shows "Ended"', async () => {
    const { page } = session;
    // The first shell is there; a second, then the session.
    await newShellTab(page);
    await expectTabCount(page, 2);
    await typeLine(page, 'echo second-$((6*7))');
    await expectScreen(page, /^second-42$/m);
    await newAgentTab(page);
    await expectTabCount(page, 3);
    await expectScreen(page, /^ready$/m);
    // A shell the user closed: it is not counted. Its exit has reached the app before the daemon is killed.
    await newShellTab(page);
    await typeLine(page, 'echo closed-$((6*7))');
    await expectScreen(page, /^closed-42$/m);
    await expectTabCount(page, 4);
    await watchEvents(page);
    await page.getByRole('button', { name: 'Close Terminal', exact: true }).nth(2).click();
    await untilEvents(page, 'exits', 1);
    await expectTabCount(page, 3);

    await killDaemon(home, build);

    await stoppedBanner(page, 3).waitFor();
    await restartButton(page).waitFor();
    const look = await page.evaluate(readBanner);
    expect(look.below, 'the banner sits under the top tab bar').toBe(true);
    expect(look.fill, 'a 10% fill of --status-working').toBe(look.expected.fill);
    expect(look.border, 'a 25% border of --status-working').toBe(look.expected.border);
    for (const index of [0, 1, 2]) {
      await endedIconOf(page.getByRole('tab').nth(index)).waitFor();
      await selectTab(page, index);
      await expectScreen(page, /\[Process ended\]/);
    }
    await waitForRowStatus(page, NAME, 'Ended');
  });

  test('AC4 — with the banner, a session page outside any project shows it too; the Home page shows none', async () => {
    const { page } = session;

    await page.locator('aside').getByRole('link', { name: seeded.name }).click();
    await page.getByRole('heading', { name: seeded.name }).waitFor();
    await stoppedBanner(page, 3).waitFor();

    await page.getByRole('link', { name: 'New workspace', exact: true }).click();
    await page.getByRole('heading', { name: 'New workspace', exact: true }).waitFor();
    expect(await stoppedBanner(page).count()).toBe(0);
  });

  test('AC6 — "Restart" starts another daemon and the banner goes; the ended tabs keep their output and a new shell tab runs a command', async () => {
    const { page } = session;
    const killed = must(daemonPid(home, build), 'the killed daemon pid');
    await goToWorkspacePage(page, workspace.path);
    await stoppedBanner(page, 3).waitFor();

    await restartButton(page).click();

    await stoppedBanner(page).waitFor({ state: 'detached' });
    expect(must(daemonPid(home, build), 'the new daemon pid')).not.toBe(killed);
    await selectTab(page, 0);
    await expectScreen(page, /^first-42$/m);
    await expectScreen(page, /\[Process ended\]/);
    await selectTab(page, 2);
    await expectScreen(page, /^marker-before-quit$/m);
    await expectScreen(page, /\[Process ended\]/);
    await newShellTab(page);
    await typeLine(page, 'echo after-restart-$((6*7))');
    await expectScreen(page, /^after-restart-42$/m);
  });

  test('AC3, AC5 — a single terminal ran: the banner reads "1 terminal ended", and a reload shows the same count', async () => {
    const { page } = session;

    await killDaemon(home, build);
    await stoppedBanner(page, 1).waitFor();

    await page.reload();
    await page.getByRole('tablist').first().waitFor();
    await stoppedBanner(page, 1).waitFor();
  });

  test('AC7 — opening a terminal from the "+" menu without clicking "Restart" starts the daemon again and the banner goes', async () => {
    const { page } = session;
    const killed = must(daemonPid(home, build), 'the killed daemon pid');
    await stoppedBanner(page, 1).waitFor();

    await newShellTab(page);
    await typeLine(page, 'echo from-menu-$((6*7))');

    await expectScreen(page, /^from-menu-42$/m);
    await stoppedBanner(page).waitFor({ state: 'detached' });
    expect(must(daemonPid(home, build), 'the new daemon pid')).not.toBe(killed);
  });

  test('AC8 — with the banner and a socket path that is a folder, "Restart" shows the failure view with the reason; once the cause is removed, "Try again" gets the panes back with no banner', async () => {
    const { page } = session;
    await killDaemon(home, build);
    await stoppedBanner(page, 1).waitFor();
    const socket = must(daemonFile(home, 'sock', build), 'the daemon sock');
    rmSync(socket);
    mkdirSync(socket);

    await restartButton(page).click();

    await failureView(page).waitFor();
    await page.locator('code, pre, [class*="mono"]').filter({ hasText: socket }).first().waitFor();
    expect(await page.getByRole('tablist').count(), 'the view replaces the panes').toBe(0);

    rmSync(socket, { recursive: true });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();

    await page.getByRole('tablist').first().waitFor();
    expect(await failureView(page).count()).toBe(0);
    expect(await stoppedBanner(page).count()).toBe(0);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});

describe('background service: a session of before the Mac restarted', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let repo: { parent: string; root: string };
  let session: Session;
  const NAME = 'boot-ws';

  beforeAll(() => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    repo = makeRepoWithSetup();
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(repo.parent, { recursive: true, force: true });
  });

  test('AC9 — a session marked open, created before the boot, that no daemon holds: the workspace page selects a tab with its name and the "Ended" icon; its pane says "This terminal ended" and why, offers "New terminal here" (outlined), no "Resume last session"; the row shows "Ended"; a session with no mark (stored before this change) has no tab', async () => {
    const worktree = join(fx.root, 'wt-boot');
    addWorktree(repo.root, NAME, worktree);
    const long = '2000-01-01T00:00:00.000Z';
    const base = { harness: 'claude-code', directory: worktree, createdAt: long, project: repo.root };
    state(dataDir, {
      version: 1,
      projects: [{ path: repo.root }],
      sessions: [
        { ...base, id: randomUUID(), name: 'Claude Code 1', open: true },
        { ...base, id: randomUUID(), name: 'Claude Code 2' },
      ],
    });
    session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: uniqueBuild() }), dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();

    await page.getByTitle(worktree, { exact: true }).first().click();
    await page.getByRole('tablist').first().waitFor();

    await expectTabCount(page, 1);
    const tab = tabNamed(page, 'Claude Code 1');
    expect(await tab.getAttribute('aria-selected')).toBe('true');
    await endedIconOf(tab).waitFor();
    await endedView(page).waitFor();
    await page.getByText(REBOOT_REASON, { exact: true }).waitFor();
    const button = page.getByRole('button', { name: 'New terminal here', exact: true });
    await button.waitFor();
    expect(await page.getByText('Resume last session').count()).toBe(0);
    const brand = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--brand)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    const look = await button.evaluate((element) => ({ border: getComputedStyle(element).borderTopWidth, fill: getComputedStyle(element).backgroundColor }));
    expect(look.border, 'outlined').not.toBe('0px');
    expect(look.fill, 'not filled with --brand').not.toBe(brand);
    await waitForRowStatus(page, NAME, 'Ended');
  });
});

describe('background service: ended tabs across relaunches', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let build: string;
  let repo: { parent: string; root: string };
  let session: Session | undefined;
  let worktree: string;
  const NAME = 'end-ws';

  beforeAll(() => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    build = uniqueBuild();
    repo = makeRepoWithSetup();
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(repo.parent, { recursive: true, force: true });
  });

  const launch = async () => {
    // Normally quit by the test before it (`quitApp`, the daemon stays); a test that failed halfway leaves it running.
    if (session?.isRunning()) await session.close().catch(() => {});
    session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: build }), dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
    await goToWorkspacePage(session.page, worktree);
    return session.page;
  };

  test('AC13 — a session whose tab the user closed, and one whose terminal exited by itself, show no ended tab after a reload', async () => {
    session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: build }), dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    const made = await makeWorkspace(session, NAME, repo.root);
    worktree = made.path;
    await goToWorkspacePage(page, worktree);
    await newAgentTab(page);
    await expectTabCount(page, 1);
    await expectScreen(page, /^ready$/m);
    await newAgentTab(page);
    await expectTabCount(page, 2);
    await expectScreen(page, /^ready$/m);
    expect(await tabNames(page)).toEqual(['Claude Code 1', 'Claude Code 2']);

    // The first is closed by the user (the running agent asks first); the second exits by itself (code 3).
    await page.getByRole('button', { name: 'Close Claude Code 1', exact: true }).click();
    await page.getByRole('button', { name: 'Close tab', exact: true }).click();
    await expectTabCount(page, 1);
    await typeLine(page, 'exit');
    await expectScreen(page, /\[Process exited with code \d+\]/);

    await page.reload();
    await page.getByRole('tablist').first().waitFor();

    // The page is done restoring once it says no tab is open.
    await noTab(page).waitFor();
    expect(await endedView(page).count()).toBe(0);

    // The session the next tests rely on.
    await newAgentTab(page);
    await expectTabCount(page, 1);
    await expectScreen(page, /^ready$/m);
    expect(await tabNames(page)).toEqual(['Claude Code 3']);
    await quitApp(session);
  });

  test('AC14 — a session the running daemon still holds shows as a live tab after the app launches again, never as ended', async () => {
    const page = await launch();

    await expectTabCount(page, 1);
    await expectScreen(page, /^marker-before-quit$/m);
    expect(await endedIconOf(tabNamed(page, 'Claude Code 3')).count()).toBe(0);
    expect(await endedView(page).count()).toBe(0);

    // A second one, for the next tests; then the daemon is killed while the app is closed.
    await newAgentTab(page);
    await expectTabCount(page, 2);
    await expectScreen(page, /^ready$/m);
    await quitApp(session!);
    await killDaemon(home, build);
  });

  test('AC9, AC10, AC11, AC12 — a session started after the boot and lost with the daemon shows an ended tab with no reason line; "New terminal here" replaces its tab with a selected shell in the worktree that takes the keyboard; a tab closed has no confirmation', async () => {
    const page = await launch();

    await expectTabCount(page, 2);
    expect(await tabNames(page)).toEqual(['Claude Code 3', 'Claude Code 4']);
    expect(await tabNamed(page, 'Claude Code 3').getAttribute('aria-selected')).toBe('true');
    await endedIconOf(tabNamed(page, 'Claude Code 3')).waitFor();
    await endedIconOf(tabNamed(page, 'Claude Code 4')).waitFor();
    await endedView(page).waitFor();
    expect(await page.getByText(REBOOT_REASON).count(), 'no reason line: no reboot is proven').toBe(0);
    expect(await page.getByText('Resume last session').count()).toBe(0);
    await waitForRowStatus(page, NAME, 'Ended');

    // AC11: the ended tab is replaced by a selected shell tab in the worktree, which has the keyboard.
    await page.getByRole('button', { name: 'New terminal here', exact: true }).click();
    await expectTabCount(page, 2);
    expect((await tabNames(page)).sort()).toEqual(['Claude Code 4', 'Terminal']);
    expect(await tabNamed(page, 'Terminal').getAttribute('aria-selected')).toBe('true');
    await untilRead(page, () => !!document.activeElement?.closest('.xterm'), (held) => held);
    await page.keyboard.type('echo here-$(basename "$PWD")');
    await page.keyboard.press('Enter');
    await expectScreen(page, new RegExp(`^here-${NAME}$`, 'm'));

    // AC12: closing the other ended tab asks nothing.
    await tabNamed(page, 'Claude Code 4').click();
    await endedView(page).waitFor();
    await page.getByRole('button', { name: 'Close Claude Code 4', exact: true }).click();
    await expectTabCount(page, 1);
    expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBe(0);

    // Neither comes back after a relaunch, the shell closed too so that nothing is restored.
    await page.getByRole('button', { name: 'Close Terminal', exact: true }).click();
    await noTab(page).waitFor();
    await quitApp(session!);
  });

  test('AC11, AC12 — after a relaunch neither the replaced nor the closed ended tab comes back', async () => {
    const page = await launch();

    await noTab(page).waitFor();
    expect(await page.getByRole('tab').count()).toBe(0);
    expect(await endedView(page).count()).toBe(0);
  });
});

describe('background service: a daemon of another protocol', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let build: string;
  let repo: { parent: string; root: string };
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;
  let session: Session | undefined;
  let worktree: string;
  const NAME = 'dlg-ws';
  const ids = { claude: randomUUID(), codex: randomUUID() };

  beforeAll(async () => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    build = uniqueBuild();
    repo = makeRepoWithSetup();
    worktree = join(fx.root, 'wt-dlg');
    addWorktree(repo.root, NAME, worktree);
    const base = { directory: worktree, createdAt: new Date().toISOString(), project: repo.root, open: true };
    state(dataDir, {
      version: 1,
      projects: [{ path: repo.root }],
      sessions: [
        { ...base, id: ids.claude, name: 'Claude Code 1', harness: 'claude-code' },
        { ...base, id: ids.codex, name: 'Codex 1', harness: 'codex' },
      ],
    });
    const common = { cwd: worktree, cols: 80, rows: 24, workspace: worktree };
    fake = await startFakeDaemon(home, [
      { ...common, id: 1, kind: 'session', command: '/usr/local/bin/claude', sessionId: ids.claude, status: 'working' },
      { ...common, id: 2, kind: 'shell', command: '/bin/sh' },
      { ...common, id: 3, kind: 'session', command: '/usr/local/bin/codex', sessionId: ids.codex, status: 'waiting' },
    ]);
    // Files of a third protocol that nothing listens on.
    await leaveStaleDaemon(home, 3);
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await fake?.close();
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(repo.parent, { recursive: true, force: true });
  });

  const launch = async () => {
    if (session?.isRunning()) await session.close().catch(() => {});
    session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: build }), dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
    return session.page;
  };

  test('AC16, AC17 — the dialog lists the 3 terminals on the Home page and logs no error; "Later" closes it with no shutdown, a session the daemon holds is no ended tab, new terminals run in the app\'s own daemon, a reload does not reopen it', async () => {
    const page = await launch();
    const dialog = restartDialog(page);

    await dialog.waitFor();
    await dialog.getByText('Restarting it ends these 3 terminals:').waitFor();
    const text = await dialog.innerText();
    expect(text).toMatch(/Claude Code 1\s*·\s*Claude Code\b[\s\S]*·\s*sh\b[\s\S]*Codex 1\s*·\s*Codex\b/);
    expect(await dialog.locator('[role="img"][aria-label="Working"]').count()).toBe(1);
    expect(await dialog.locator('[role="img"][aria-label="Needs input"]').count()).toBe(1);
    expect(await dialog.locator('svg.lucide-square-terminal').count()).toBe(1);
    await dialog.getByRole('button', { name: 'Restart and end terminals', exact: true }).waitFor();
    expect(session!.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(session!.output()).not.toMatch(/skipped a background service|ECONNREFUSED|ENOTSOCK/);

    await dialog.getByRole('button', { name: 'Later', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    expect(fake.calls).toContain('GET /terminals');
    expect(fake.calls).not.toContain('POST /shutdown');

    // The sessions the fake holds are marked open: while it holds them they are no ended tabs.
    await page.getByTitle(worktree, { exact: true }).first().click();
    await page.getByRole('tablist').first().waitFor();
    await noTab(page).waitFor();
    expect(await endedView(page).count()).toBe(0);

    // New terminals run in the app's own daemon.
    await newShellTab(page);
    await typeLine(page, 'echo ppid-$PPID');
    const screen = await expectScreen(page, /^ppid-\d+$/m);
    expect(Number(/^ppid-(\d+)$/m.exec(screen)![1])).toBe(must(daemonPid(home, build), 'the own daemon pid'));

    await page.reload();
    await page.getByRole('tablist').first().waitFor();
    await expectTabCount(page, 1);
    expect(await restartDialog(page).count()).toBe(0);
    expect(fake.calls).not.toContain('POST /shutdown');
    await quitApp(session!);
  });

  test('AC17, AC19, AC18 — the next launch opens the dialog again; a daemon that refuses, or does not answer, keeps it open and shows why; once it accepts, the dialog closes, the daemon got POST /shutdown and the sessions it held show as ended tabs', async () => {
    const page = await launch();
    const dialog = restartDialog(page);
    await dialog.waitFor();
    const restart = dialog.getByRole('button', { name: 'Restart and end terminals', exact: true });

    fake.mode = 'refuse';
    await restart.click();
    await fake.called('POST /shutdown', 1);
    await dialog.getByText(/409|refus/i).first().waitFor();
    expect(await dialog.isVisible()).toBe(true);

    fake.mode = 'silent';
    await restart.click();
    await fake.called('POST /shutdown', 2);
    await dialog.getByText(/did not answer within 5 s/).first().waitFor();
    expect(await dialog.isVisible()).toBe(true);

    fake.mode = 'accept';
    await restart.click();
    await dialog.waitFor({ state: 'detached' });
    expect(fake.calls.filter((call) => call === 'POST /shutdown')).toHaveLength(3);

    await page.getByTitle(worktree, { exact: true }).first().click();
    await page.getByRole('tablist').first().waitFor();
    await endedIconOf(tabNamed(page, 'Claude Code 1')).waitFor();
    await endedIconOf(tabNamed(page, 'Codex 1')).waitFor();
    expect(session!.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});

describe('background service: a daemon of another protocol with no terminal', () => {
  let dataDir: string;
  let home: string;
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;
  let session: Session | undefined;

  beforeAll(async () => {
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    fake = await startFakeDaemon(home, []);
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await fake?.close();
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC20 — holding no shell or session, it is listed and no dialog shows', async () => {
    session = await launchBuiltOn({ ...process.env, SHELL: '/bin/sh', COCKPIT_TEST_DAEMON_BUILD: uniqueBuild() }, dataDir, home);
    const { page } = session;
    await page.getByText(versionLabel).waitFor();
    await fake.called('GET /terminals');

    // The page asks again after a reload: whatever the app decided about the daemon is settled by then.
    await page.reload();
    await page.getByText(versionLabel).waitFor();

    expect(await restartDialog(page).count()).toBe(0);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});

describe('background service: the open mark when a workspace or a project goes', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let build: string;
  let repo: { parent: string; root: string };
  let session: Session | undefined;

  beforeAll(() => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    build = uniqueBuild();
    // No teardown command: a workspace deletes at once.
    repo = makeRepoWithSetup({});
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(repo.parent, { recursive: true, force: true });
  });

  const launch = async () => {
    if (session?.isRunning()) await session.close().catch(() => {});
    session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: build }), dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
    return session;
  };

  // A workspace with a running session in its tab, marked open in state.json.
  const workspaceWithSession = async (current: Session, name: string) => {
    const made = await makeWorkspace(current, name, repo.root);
    await goToWorkspacePage(current.page, made.path);
    await newAgentTab(current.page);
    await expectTabCount(current.page, 1);
    await expectScreen(current.page, /^ready$/m);
    expect(storedSessions(dataDir).at(-1)?.open, 'the session is marked open while it runs').toBe(true);
    await watchEvents(current.page);
    return made;
  };

  test('AC22 — deleting the workspace keeps the session stored with its mark cleared; a new workspace on the same branch after a relaunch shows no ended tab', async () => {
    const first = await launch();
    const { page } = first;
    const made = await workspaceWithSession(first, 'del-ws');

    const dialog = await openDeleteDialog(page, made.path, 'del-ws');
    await deleteButton(dialog).click();
    await dialog.waitFor({ state: 'hidden' });
    await waitForNoEntry(page, made.path);
    // The agent's terminal ended: the daemon holds nothing of it any more.
    await untilEvents(page, 'exits', 1);

    const stored = storedSessions(dataDir);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.open, 'the mark is cleared').not.toBe(true);

    await quitApp(first);
    const second = await launch();
    const again = await makeWorkspace(second, 'del-ws', repo.root);
    expect(again.path).toBe(made.path);
    await goToWorkspacePage(second.page, again.path);
    await noTab(second.page).waitFor();
    expect(await endedView(second.page).count()).toBe(0);
  });

  test('AC23 — removing the project keeps the session stored with its mark cleared; adding the project again after a relaunch shows its workspaces with no tab', async () => {
    const first = session!;
    const { page } = first;
    const made = await workspaceWithSession(first, 'rm-ws');

    await removeThroughMenu(page, repo.root);
    await waitForNoEntry(page, repo.root);
    await untilEvents(page, 'exits', 1);

    const stored = storedSessions(dataDir);
    expect(stored).toHaveLength(2);
    expect(stored.at(-1)!.open, 'the mark is cleared').not.toBe(true);

    await quitApp(first);
    const second = await launch();
    await stubPicker(second, repo.root);
    await second.page.evaluate(() => (window as unknown as { api: { projects: { add(): Promise<unknown> } } }).api.projects.add());
    await second.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await goToWorkspacePage(second.page, made.path);
    await noTab(second.page).waitFor();
    expect(await endedView(second.page).count()).toBe(0);
  });
});

describe('background service: the daemon of a superseded build dies', () => {
  let fx: Fixture;
  let dataDir: string;
  let home: string;
  let repo: { parent: string; root: string };
  let session: Session | undefined;

  beforeAll(() => {
    fx = makeFixture();
    dataDir = makeDataDir();
    home = join(dataDir, 'h');
    // No teardown command: a workspace deletes at once.
    repo = makeRepoWithSetup({});
  });

  afterAll(async () => {
    await session?.close().catch(() => {});
    await killDaemonsIn(home);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(repo.parent, { recursive: true, force: true });
  });

  const launch = async (build: string) => {
    if (session?.isRunning()) await session.close().catch(() => {});
    session = await launchBuiltOn(fx.env({ COCKPIT_TEST_DAEMON_BUILD: build }), dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
    return session;
  };

  test('AC24 — builds A and B each hold a shell and the app runs build C: after A dies, "Restart" clears the banner; after B dies, a terminal from the "+" menu does; C keeps its pid', async () => {
    const [a, b, c] = [uniqueBuild(), uniqueBuild(), uniqueBuild()] as const;
    const first = await launch(a);
    const made = await makeWorkspace(first, 'sup-ws', repo.root);
    await goToWorkspacePage(first.page, made.path);
    await newShellTab(first.page);
    await typeLine(first.page, 'echo from-a-$((6*7))');
    await expectScreen(first.page, /^from-a-42$/m);
    await quitApp(first);

    const second = await launch(b);
    await goToWorkspacePage(second.page, made.path);
    await expectTabCount(second.page, 1);
    await newShellTab(second.page);
    await expectTabCount(second.page, 2);
    await typeLine(second.page, 'echo from-b-$((6*7))');
    await expectScreen(second.page, /^from-b-42$/m);
    await quitApp(second);

    const third = await launch(c);
    const { page } = third;
    await goToWorkspacePage(page, made.path);
    await expectTabCount(page, 2);
    const own = must(daemonPid(home, c), 'the own daemon pid');

    await killDaemon(home, a);
    await stoppedBanner(page, 1).waitFor();
    await restartButton(page).click();
    await stoppedBanner(page).waitFor({ state: 'detached' });
    expect(daemonPid(home, c), 'the own daemon keeps its pid').toBe(own);

    await killDaemon(home, b);
    await stoppedBanner(page, 1).waitFor();
    await newShellTab(page);
    await typeLine(page, 'echo from-c-$((6*7))');
    await expectScreen(page, /^from-c-42$/m);
    await stoppedBanner(page).waitFor({ state: 'detached' });
    expect(daemonPid(home, c), 'the own daemon keeps its pid').toBe(own);
  });
});
