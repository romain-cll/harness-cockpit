import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type Locator, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MAIN_PROCESS_ERROR, launchSpawned, startClock, versionLabel, type Session } from './launch';
import { makeTestDir } from './run-root';
import {
  agentSelect,
  basePopup,
  baseSelect,
  closePopups,
  createButton,
  detectAgain,
  isDisabledItem,
  itemTexts,
  itemsOf,
  waitForMessage,
  norm,
  openComposer,
  openPopup as openMenu,
  pickAgent,
  projectSelect,
  promptBox,
  searchBranches,
  textOf,
  waitForAgent,
  waitForBase,
  storedSessions,
  waitForNewSession,
  waitForSelectedTab,
  waitForWorkspacePage,
  worktreeSwitch,
} from './composer';
import { projectColour } from '../src/renderer/components/project-colour';
import { openPopup } from './composer';
import { readSwitchLook } from './support/main-workspace';
import { afterIpcAnswers, countIpcCalls, ipcCalls, stateSnapshot } from './support/projects';
import { expectNoErrors, launchBuiltWith, makeSessionsFixture, sessionEntries, sessionIdOf, type SessionsFixture } from './support/sessions';
import {
  entryOf,
  git,
  gitOrNull,
  holdGit,
  installStub,
  loadingText,
  localBranches,
  makeClone,
  makeFixture,
  makeLight,
  openFifo,
  releaseFifo,
  removeStub,
  sessionsInState,
  shellRuns,
  signalled,
  startsOf,
  tabs,
  waitForRow,
  worktreeIn,
  worktreesDirIn,
  type Fixture,
  type Repo,
} from './support/composer-fixture';

// COCKPIT-66: the New workspace page (the composer at `/`). One built-app launch with a fake login
// shell whose `PATH` holds stub agent CLIs (a stub is a `#!/bin/sh` file that logs its launch, so no
// real CLI ever runs), a seeded `state.json` (the projects) and a `git` that is the real one. The
// tests run in order on that launch: the first ones see the detection still running (the stubs'
// `--version` waits for a gate file), the later ones change what is on the `PATH` and detect again.

// --- Fixture: shared with workspace-setup.test.ts (support/composer-fixture.ts) ---

const gates = new Map<string, FileHandle>();
async function setGate(fx: Fixture, names: string[], closed: boolean) {
  for (const name of names) {
    const path = join(fx.bin, `${name}.gate`);
    const held = gates.get(path);
    gates.delete(path);
    if (held) await releaseFifo(held, path);
    if (closed) gates.set(path, await openFifo(path));
  }
}

const versionRuns = (fx: Fixture) => {
  const counts: Record<string, number> = {};
  for (const line of readFileSync(fx.runLog, 'utf8').split('\n').filter(Boolean)) {
    const name = line.replace(' --version', '');
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
};

// --- Page helpers ------------------------------------------------------------

const tokenColour = (page: Page, token: string, property: 'color' | 'backgroundColor' = 'color') =>
  page.evaluate(
    ([token, property]) => {
      const probe = document.createElement('span');
      probe.style[property as 'color'] = `var(${token})`;
      document.body.append(probe);
      const value = getComputedStyle(probe)[property as 'color'];
      probe.remove();
      return value;
    },
    [token, property] as const,
  );

const waitForSessionPage = waitForNewSession;

// The rows of the terminal on the page.
const terminalRows = (page: Page) =>
  page
    .locator('.xterm-rows:visible')
    .first()
    .evaluate((element) => [...element.children].map((row) => (row.textContent ?? '').replace(/ /g, ' ').trimEnd()));
const mainBox = async (locator: Locator) => (await locator.boundingBox())!;

// --- The launch --------------------------------------------------------------

describe('new workspace page: built app', () => {
  let fx: Fixture;
  let session: Session;
  let dataDir: string;
  let clone: Repo;
  let nodef: Repo;
  let gone: Repo;
  let refuse: Repo;
  let home: string;

  const worktreeOf = (repo: Repo, branch: string) => worktreeIn(home, repo, branch);
  const worktreesDirOf = (repo: Repo) => worktreesDirIn(home, repo);
  const listing = (repo: Repo) => (existsSync(worktreesDirOf(repo)) ? readdirSync(worktreesDirOf(repo)).sort() : []);
  const linkInSessions = (page: Page, id: string) =>
    page
      .locator('aside section')
      .filter({ has: page.locator('h2, button[aria-expanded]').filter({ hasText: /^\s*Sessions\s*$/ }) })
      .locator(`a[href$="/sessions/${id}"]`);

  beforeAll(async () => {
    fx = makeFixture();
    installStub(fx, 'claude');
    installStub(fx, 'codex');
    // The detection waits on these until a test opens the gate.
    await setGate(fx, ['claude', 'codex'], true);
    clone = makeClone('cmp-clone');
    mkdirSync(join(clone.root, '.cockpit'));
    writeFileSync(join(clone.root, '.cockpit', 'config.json'), JSON.stringify({ setup: ['echo setup-ran >> "$COCKPIT_ROOT_PATH/setup.log"'] }));
    nodef = makeLight('cmp-nodef');
    git(nodef.root, 'checkout', '--detach');
    gone = makeLight('cmp-gone');
    refuse = makeLight('cmp-refuse');
    dataDir = makeTestDir('d-');
    writeFileSync(
      join(dataDir, 'state.json'),
      JSON.stringify({ version: 1, projects: [clone, nodef, gone, refuse].map((repo) => ({ path: repo.root })) }),
    );
    rmSync(gone.parent, { recursive: true, force: true });
    session = await launchSpawned(createRequire(import.meta.url)('electron') as string, ['.'], true, dataDir, fx.env());
    home = join(realpathSync(dataDir), 'h');
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    await session?.close();
    for (const folder of [dataDir, fx?.root, clone?.parent, nodef?.parent, refuse?.parent]) {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  // --- Detection, first: the stubs' `--version` is still waiting on its gate --------------------------

  test('AC11, AC15 — while the harnesses are detected the agent select shows a spinner and "Detecting…", its menu holds one disabled "Detecting agent CLIs…" item and the button is disabled; once the gate opens each stub ran `--version` once, and a reload, another page and a second visit reuse the result', async () => {
    const { page } = session;
    await promptBox(page).fill('Some task');
    const trigger = agentSelect(page);
    expect(await textOf(trigger)).toBe('Detecting…');
    expect(await trigger.locator('svg.animate-spin, svg.lucide-loader-circle, svg.lucide-loader-2, svg.lucide-loader').count()).toBeGreaterThan(0);
    expect(await createButton(page).isDisabled()).toBe(true);

    const menu = await openMenu(page, trigger);
    expect(await itemTexts(menu)).toEqual(['Detecting agent CLIs…']);
    expect(await isDisabledItem(itemsOf(menu).first())).toBe(true);
    await closePopups(page);

    await setGate(fx, ['claude', 'codex'], false);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    expect(await createButton(page).isEnabled()).toBe(true);
    expect(versionRuns(fx)).toEqual({ claude: 1, codex: 1 });

    // A reload, a visit to another page and a second visit to this one run no `--version` again.
    await page.reload();
    await promptBox(page).waitFor();
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await page.getByRole('link', { name: 'New workspace', exact: true }).click();
    await promptBox(page).waitFor();
    await waitForAgent(page, 'Claude Code');
    await closePopups(page);
    await openMenu(page, agentSelect(page));
    await closePopups(page);
    expect(versionRuns(fx)).toEqual({ claude: 1, codex: 1 });
  }, 60_000);

  // --- Navigation -----------------------------------------------------------------------------------

  test('AC1, AC2 — the home page is the "New workspace" heading (h1, 12 px, muted) above a centred composer, and the sidebar nav holds "New workspace" (square-pen, link to /, current) and nothing else: no "Home", no "Terminal"', async () => {
    const { page } = session;
    await openComposer(page);
    expect(new URL(page.url()).pathname).toBe('/');

    const heading = page.getByRole('heading', { level: 1, name: 'New workspace', exact: true });
    expect(await heading.count()).toBe(1);
    expect(await page.getByRole('heading', { name: 'Home' }).count()).toBe(0);
    expect(await heading.evaluate((element) => getComputedStyle(element).fontSize)).toBe('12px');
    expect(await heading.evaluate((element) => getComputedStyle(element).color)).toBe(await tokenColour(page, '--muted-foreground'));
    const main = await mainBox(page.locator('main'));
    const headingBox = await mainBox(heading);
    const promptBoxRect = await mainBox(promptBox(page));
    expect(Math.abs(headingBox.x + headingBox.width / 2 - (main.x + main.width / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(promptBoxRect.x + promptBoxRect.width / 2 - (main.x + main.width / 2))).toBeLessThanOrEqual(2);
    expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(promptBoxRect.y);

    const links = page.locator('aside nav a');
    expect((await links.allInnerTexts()).map(norm)).toEqual(['New workspace']);
    expect(await links.evaluateAll((all) => all.map((link) => new URL((link as HTMLAnchorElement).href).pathname))).toEqual(['/']);
    expect(await links.nth(0).getAttribute('aria-current')).toBe('page');
    expect(await links.nth(0).locator('svg.lucide-square-pen').count()).toBe(1);
    expect(await page.locator('aside').getByRole('link', { name: 'Home' }).count()).toBe(0);
    expect(await page.locator('aside').getByRole('link', { name: 'Terminal' }).count()).toBe(0);
    // That `/terminal` is no route any more is COCKPIT-70's AC4 (the route tree).
  });

  test('AC5 — without a project param, or with a path that is not in the state, the project select shows the first project of the sidebar', async () => {
    const { page } = session;
    await openComposer(page);
    expect(await textOf(projectSelect(page))).toContain(clone.name);
    await openComposer(page, '/not/a/project');
    expect(await textOf(projectSelect(page))).toContain(clone.name);
    await openComposer(page, nodef.root);
    expect(await textOf(projectSelect(page))).toContain(nodef.name);
  });

  test('AC3 — "New workspace" (the label is checked by the menus tests) in a project\'s menu goes to /?project=<path>, the project select shows that project and no dialog opens', async () => {
    const { page } = session;
    await openComposer(page);
    await page.getByTitle(refuse.root, { exact: true }).first().hover();
    await page.getByRole('button', { name: `Actions for ${refuse.name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: /^New workspace…?$/ }).click();

    await page.waitForURL((url) => url.searchParams.get('project') === refuse.root);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await textOf(projectSelect(page))).toContain(refuse.name);
    expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBe(0);
  });

  test('AC4 — the Sessions "+" goes to /?project=none, the project select shows "No project" and no menu opens', async () => {
    const { page } = session;
    await openComposer(page);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();

    await page.waitForURL((url) => url.searchParams.get('project') === 'none');
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await textOf(projectSelect(page))).toBe('No project');
    expect(await page.locator('[role="menu"]').count()).toBe(0);
  });

  // --- The composer ---------------------------------------------------------------------------------

  test('AC6 — the composer is 600 px wide with a rounded-xl bg-hover body, a 1 px border, padding 12/10/10/12, a 13 px "Prompt" with its placeholder, a toolbar of 24 px rounded-md controls 6 px apart and a 26 px round bg-brand button with a white arrow-up at its right, in both color schemes', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForBase(page, 'origin/main');
    const field = promptBox(page);
    expect(await field.getAttribute('placeholder')).toBe('Describe the task');

    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const expected = {
        hover: await tokenColour(page, '--hover', 'backgroundColor'),
        border: await tokenColour(page, '--border'),
        brand: await tokenColour(page, '--brand', 'backgroundColor'),
      };
      expect(expected.brand, 'the brand colour').toBe('rgb(94, 106, 210)');

      const composer = await field.evaluate((element) => {
        let node: HTMLElement | null = element.parentElement;
        while (node && parseFloat(getComputedStyle(node).borderTopWidth) === 0) node = node.parentElement;
        if (!node) return null;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          width: rect.width,
          right: rect.right,
          bottom: rect.bottom,
          radius: style.borderTopLeftRadius,
          background: style.backgroundColor,
          borderWidth: style.borderTopWidth,
          borderColor: style.borderTopColor,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
          fontSize: getComputedStyle(element).fontSize,
        };
      });
      expect(composer, 'the composer has a border').not.toBeNull();
      expect(composer!.width, scheme).toBeCloseTo(600, 0);
      expect(composer!.radius, scheme).toBe('12px');
      expect(composer!.background, scheme).toBe(expected.hover);
      expect(composer!.borderWidth, scheme).toBe('1px');
      expect(composer!.borderColor, scheme).toBe(expected.border);
      expect(composer!.padding, scheme).toEqual(['12px', '10px', '10px', '12px']);
      expect(composer!.fontSize, scheme).toBe('13px');

      const [project, agent, base, create, prompt] = await Promise.all(
        [projectSelect(page), agentSelect(page), baseSelect(page), createButton(page), field].map((locator) => mainBox(locator)),
      );
      for (const [name, box] of [['project', project], ['agent', agent], ['base', base]] as const) {
        expect(box!.height, `${name} control, ${scheme}`).toBeCloseTo(24, 0);
      }
      for (const select of [projectSelect(page), agentSelect(page), baseSelect(page)]) {
        expect(await select.evaluate((element) => getComputedStyle(element).borderTopLeftRadius), scheme).toBe('8px');
      }
      expect(agent!.x - (project!.x + project!.width), `project to agent, ${scheme}`).toBeCloseTo(6, 0);
      // COCKPIT-71 AC1: the Worktree switch sits between the agent select and the base select.
      expect(await worktreeSwitch(page).count(), `the Worktree switch, ${scheme}`).toBe(1);
      const control = (await page.evaluate(readSwitchLook))!.control!;
      expect(control.left - (agent!.x + agent!.width), `agent to switch, ${scheme}`).toBeCloseTo(6, 0);
      expect(base!.x - control.right, `switch to base, ${scheme}`).toBeCloseTo(6, 0);
      expect(create!.width, scheme).toBeCloseTo(26, 0);
      expect(create!.height, scheme).toBeCloseTo(26, 0);
      expect(create!.x, 'at the right of the toolbar').toBeGreaterThan(base!.x + base!.width);
      expect(composer!.right - 1 - 10 - (create!.x + create!.width), 'right padding after the button').toBeCloseTo(0, 0);
      expect(
        await createButton(page).evaluate((element) => {
          const style = getComputedStyle(element);
          const radius = style.borderTopLeftRadius;
          const round = radius.endsWith('%') ? parseFloat(radius) >= 50 : parseFloat(radius) >= 13;
          const icon = element.querySelector('svg.lucide-arrow-up');
          return { round, background: style.backgroundColor, icon: icon ? getComputedStyle(icon).color : null };
        }),
        scheme,
      ).toEqual({ round: true, background: expected.brand, icon: 'rgb(255, 255, 255)' });

      // The toolbar sits 12 px under the field.
      const toolbarTop = await projectSelect(page).evaluate((element, other) => {
        const otherElement = other as Element;
        let node: Element | null = element.parentElement;
        while (node && !node.contains(otherElement)) node = node.parentElement;
        return node ? node.getBoundingClientRect().top : null;
      }, await agentSelect(page).elementHandle());
      expect(toolbarTop! - (prompt!.y + prompt!.height), `field to toolbar, ${scheme}`).toBeCloseTo(12, 0);
    }
    await page.emulateMedia({ colorScheme: null });
  });

  test('AC7 — the project select lists every project with its badge and name and a check on the selected one, then a separator and "No project" with the muted hint "Runs in its own folder"', async () => {
    const { page } = session;
    await openComposer(page, refuse.root);
    const menu = await openMenu(page, projectSelect(page));
    const items = itemsOf(menu);
    expect(await items.count()).toBe(5);
    const projects = [clone, nodef, gone, refuse];
    for (const [index, project] of projects.entries()) {
      const item = items.nth(index);
      expect(await textOf(item)).toContain(project.name);
      const badge = item.locator(`.${projectColour(project.root)}`);
      expect(await badge.count(), `${project.name} has its ${projectColour(project.root)} badge`).toBe(1);
      expect(norm(await badge.innerText())).toBe(project.name[0]!.toUpperCase());
      const checks = await item.locator('svg.lucide-check').count();
      expect(checks, `${project.name} check`).toBe(project === refuse ? 1 : 0);
    }
    const none = items.nth(4);
    expect(await textOf(none)).toBe('No project Runs in its own folder');
    expect(await none.locator('svg.lucide-check').count()).toBe(0);
    const hintColour = await none.getByText('Runs in its own folder', { exact: true }).evaluate((element) => getComputedStyle(element).color);
    expect(hintColour).toBe(await tokenColour(page, '--muted-foreground'));
    const separator = await mainBox(menu.locator('[role="separator"]').first());
    expect(separator.y).toBeGreaterThanOrEqual((await mainBox(items.nth(3))).y);
    expect(separator.y).toBeLessThanOrEqual((await mainBox(none)).y);
    await closePopups(page);
  });

  test('AC7 — picking a project in the select shows it, switches the base select to that project\'s default base and sets ?project=; picking "No project" removes the base select and sets ?project=none', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForBase(page, 'origin/main');

    let menu = await openMenu(page, projectSelect(page));
    await itemsOf(menu).filter({ hasText: refuse.name }).click();
    await page.waitForURL((url) => url.searchParams.get('project') === refuse.root);
    expect(await textOf(projectSelect(page))).toContain(refuse.name);
    expect(await textOf(projectSelect(page))).not.toContain(clone.name);
    await waitForBase(page, 'main');

    menu = await openMenu(page, projectSelect(page));
    await itemsOf(menu).filter({ hasText: /^\s*No project/ }).click();
    await page.waitForURL((url) => url.searchParams.get('project') === 'none');
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await textOf(projectSelect(page))).toBe('No project');
    await baseSelect(page).waitFor({ state: 'detached' });
  });

  test('AC8, AC9 — the base select shows the default base; opened, it has a focused "Search branches" field, the local branches under "Local" and the origin branches under "Remote" with the selected one checked; typing filters both groups case-insensitively (an empty group is hidden, no match says "No branch found") and picking a branch selects it and closes the popup; with "No project" there is no base select', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForBase(page, 'origin/main');
    expect(await baseSelect(page).locator('svg.lucide-git-branch').count()).toBe(1);

    await baseSelect(page).click();
    await searchBranches(page).waitFor();
    const opened = (await basePopup(page))!;
    expect(opened.focused).toBe(true);
    expect(opened.lines.slice(0, 1)).toEqual(['Local']);
    expect(opened.lines.indexOf('Remote')).toBeGreaterThan(0);
    const remoteAt = opened.lines.indexOf('Remote');
    expect(opened.lines.slice(1, remoteAt).sort()).toEqual(['local-topic', 'main', 'topic/nested']);
    expect(opened.lines.slice(remoteAt + 1).sort()).toEqual(['origin/develop', 'origin/feature/x', 'origin/main', 'origin/release/1.0']);
    expect(opened.selected).toEqual(['origin/main']);

    await searchBranches(page).fill('FEATURE');
    expect((await basePopup(page))!.lines).toEqual(['Remote', 'origin/feature/x']);
    await searchBranches(page).fill('MAIN');
    expect((await basePopup(page))!.lines.sort()).toEqual(['Local', 'Remote', 'main', 'origin/main']);
    await searchBranches(page).fill('nested');
    expect((await basePopup(page))!.lines).toEqual(['Local', 'topic/nested']);
    await searchBranches(page).fill('zzz-no-branch');
    expect((await basePopup(page))!.lines).toEqual(['No branch found']);

    await searchBranches(page).fill('nested');
    await page.locator('[role="option"]').filter({ hasText: 'topic/nested' }).click();
    await searchBranches(page).first().waitFor({ state: 'detached' });
    expect(await textOf(baseSelect(page))).toBe('topic/nested');

    await openComposer(page, 'none');
    expect(await textOf(projectSelect(page))).toBe('No project');
    expect(await baseSelect(page).count()).toBe(0);
  });

  test('AC10 — without a default base the base select says "Select a base" and the button stays disabled until one is picked; a project whose branches cannot be listed shows a message in the composer and the button stays disabled', async () => {
    const { page } = session;
    await openComposer(page, nodef.root);
    await promptBox(page).fill('Some task');
    await waitForBase(page, 'Select a base');
    expect(await createButton(page).isDisabled()).toBe(true);
    await baseSelect(page).click();
    await searchBranches(page).waitFor();
    await page.locator('[role="option"]').filter({ hasText: /^\s*main\s*$/ }).click();
    await waitForBase(page, 'main');
    expect(await createButton(page).isEnabled()).toBe(true);

    await openComposer(page, gone.root);
    await promptBox(page).fill('Some task');
    const message = await waitForMessage(page);
    expect(message).not.toBe('');
    expect(await createButton(page).isDisabled()).toBe(true);
  });

  // --- The agent select -----------------------------------------------------------------------------

  test('AC12 — the agent select shows the first detected harness; its menu lists each detected harness with its version muted at the right and a check on the selected one, then "Terminal", a separator and "Detect again" (refresh-cw)', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');

    const menu = await openMenu(page, agentSelect(page));
    expect(await itemTexts(menu)).toEqual(['Claude Code 9.9.9', 'Codex 9.9.9', 'Terminal', 'Detect again']);
    const items = itemsOf(menu);
    for (const index of [0, 1]) {
      const version = items.nth(index).getByText('9.9.9', { exact: true });
      expect(await version.count()).toBe(1);
      expect(await version.evaluate((element) => getComputedStyle(element).color)).toBe(await tokenColour(page, '--muted-foreground'));
      const [versionBox, itemBox] = [await mainBox(version), await mainBox(items.nth(index))];
      expect(versionBox.x + versionBox.width, 'the version is at the right').toBeGreaterThan(itemBox.x + itemBox.width - 24);
    }
    expect(await items.nth(0).locator('svg.lucide-check').count()).toBe(1);
    expect(await items.nth(1).locator('svg.lucide-check').count()).toBe(0);
    expect(await items.nth(3).locator('svg.lucide-refresh-cw').count()).toBe(1);
    const separator = await mainBox(menu.locator('[role="separator"]').first());
    expect(separator.y).toBeGreaterThanOrEqual((await mainBox(items.nth(2))).y);
    expect(separator.y).toBeLessThanOrEqual((await mainBox(items.nth(3))).y);
    await closePopups(page);
  });

  test('AC14 — "Detect again" shows "Detecting…" meanwhile, runs `--version` once more for each detected CLI and replaces the list: a CLI installed since launch appears (no version when it prints none), a removed one disappears, and a selected harness that disappeared falls back to the first detected', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await pickAgent(page, 'Codex');

    installStub(fx, 'opencode', { noVersion: true });
    removeStub(fx, 'codex');
    await setGate(fx, ['claude', 'opencode'], true);
    await detectAgain(page);
    await waitForAgent(page, 'Detecting…');
    expect(await createButton(page).isDisabled()).toBe(true);
    await setGate(fx, ['claude', 'opencode'], false);
    await waitForAgent(page, 'Claude Code');

    expect(versionRuns(fx)).toEqual({ claude: 2, codex: 1, opencode: 1 });
    const menu = await openMenu(page, agentSelect(page));
    expect(await itemTexts(menu)).toEqual(['Claude Code 9.9.9', 'OpenCode', 'Terminal', 'Detect again']);
    await closePopups(page);
  }, 60_000);

  // AC13 (no agent CLI at all) runs on the launch without any, below.

  test('AC15 — the button is disabled for a blank prompt (spaces only) and enabled for a filled one, and Shift+Enter inserts a new line without sending', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    expect(await createButton(page).isDisabled()).toBe(true);
    await promptBox(page).fill('    ');
    expect(await createButton(page).isDisabled()).toBe(true);
    await promptBox(page).press('Enter');
    expect(new URL(page.url()).pathname, 'Enter on a blank prompt sends nothing').toBe('/');

    await promptBox(page).fill('first line');
    expect(await createButton(page).isEnabled()).toBe(true);
    await promptBox(page).press('Shift+Enter');
    await promptBox(page).pressSequentially('second line');
    expect(await promptBox(page).inputValue()).toBe('first line\nsecond line');
    expect(new URL(page.url()).pathname, 'Shift+Enter sends nothing').toBe('/');
    expect(localBranches(clone)).not.toContain('first-line-second-line');
  });

  // --- Send -----------------------------------------------------------------------------------------

  test('AC16, AC18 — Enter sends: the worktree is created from the base under COCKPIT_HOME on the prompt\'s slug, `cockpit setup` runs and the agent starts in it with the trimmed prompt as one argument, the session is stored with its project, the workspace page opens with the session as its one, selected tab and the composer is cleared', async () => {
    const { page } = session;
    const prompt = '  Fix the "login" $HOME redirect loop!  ';
    const branch = 'fix-the-login-home-redirect-loop';
    const path = worktreeOf(clone, branch);
    const startsBefore = startsOf(fx, 'claude').length;
    const setupLog = join(clone.root, 'setup.log');
    const setupRunsBefore = existsSync(setupLog) ? readFileSync(setupLog, 'utf8').split('\n').filter(Boolean).length : 0;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill(prompt);
    await promptBox(page).press('Enter');

    await waitForWorkspacePage(page, path);
    // The page opens while the worktree is made; the session's tab joins it once the session is stored.
    await waitForSelectedTab(page);
    const stored = sessionsInState(dataDir).find((each) => each.directory === path);
    expect(stored, 'the session is stored when its tab shows').toBeDefined();
    const id = stored!.id;
    // The page is the workspace's, with the session as its one tab, selected.
    const shown = await tabs(page);
    expect(shown.labels).toHaveLength(1);
    expect(shown.selected[0]).toMatch(/Claude Code/);
    expect(existsSync(path)).toBe(true);
    expect(git(clone.root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${path}\n`);
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${branch}.cockpitBase`)).toBe('origin/main');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(clone.root, 'rev-parse', 'origin/main'));

    await waitForRow(page, `cockpit setup · ${branch} · .cockpit/config.json`);
    await waitForRow(page, '$ echo setup-ran >> "$COCKPIT_ROOT_PATH/setup.log"');
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'ready');
    expect(readFileSync(setupLog, 'utf8').split('\n').filter(Boolean).length).toBe(setupRunsBefore + 1);
    const starts = startsOf(fx, 'claude').slice(startsBefore);
    expect(starts).toEqual([{ cwd: path, args: [prompt.trim()] }]);

    expect(sessionsInState(dataDir).find((stored) => stored.id === id)).toMatchObject({
      harness: 'claude-code',
      name: 'Claude Code 1',
      directory: path,
      project: clone.root,
    });
    expect(await entryOf(page, path).count()).toBe(1);
    expect(await entryOf(page, path).innerText()).toContain(branch);

    await page.getByRole('link', { name: 'New workspace', exact: true }).click();
    await promptBox(page).waitFor();
    expect(await promptBox(page).inputValue()).toBe('');
  }, 60_000);

  test('AC17, COCKPIT-89 AC2 — "Terminal" with a project, its worktree held: the workspace page opens at once on the loading page; once the hold is released it shows one shell tab with the output of `cockpit setup --shell` (the setup, then the login shell, no agent) and no session is stored', async () => {
    const { page } = session;
    const branch = 'run-the-tests';
    const path = worktreeOf(clone, branch);
    const before = { claude: startsOf(fx, 'claude').length, shells: shellRuns(fx), sessions: sessionsInState(dataDir).length };
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await pickAgent(page, 'Terminal');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill('Run the tests');
    const held = await holdGit(fx, 'git');
    try {
      await createButton(page).click();
      await held.reached();
      await waitForWorkspacePage(page, path);
      await loadingText(page).waitFor();
      expect(existsSync(path), 'the worktree does not exist yet').toBe(false);
    } finally {
      await held.release();
    }

    await waitForSelectedTab(page);
    expect(existsSync(path)).toBe(true);
    expect(await tabs(page)).toEqual({ labels: ['Terminal'], selected: ['Terminal'] });
    await waitForRow(page, `cockpit setup · ${branch} · .cockpit/config.json`);
    await waitForRow(page, '✓ Setup done');
    await waitForRow(page, 'login-shell>');
    expect(shellRuns(fx)).toBe(before.shells + 1);
    expect(startsOf(fx, 'claude')).toHaveLength(before.claude);
    expect(await storedSessions(page)).toHaveLength(before.sessions);
  }, 60_000);

  test('AC17, AC19 — "No project" with "Terminal" runs the login shell in a new folder under COCKPIT_HOME/sessions, and with an agent starts it there with the prompt as its argument, no worktree and no setup; both are listed in the Sessions section', async () => {
    const { page } = session;
    const before = { shells: shellRuns(fx), claude: startsOf(fx, 'claude').length, worktrees: listing(clone) };

    await openComposer(page, 'none');
    await waitForAgent(page, 'Claude Code');
    await pickAgent(page, 'Terminal');
    await promptBox(page).fill('Scratch pad');
    await createButton(page).click();
    const terminalId = await waitForSessionPage(page);
    await page.getByRole('heading', { name: 'Terminal 1', exact: true }).waitFor();
    await waitForRow(page, 'login-shell>');
    expect((await terminalRows(page)).some((row) => row.startsWith('cockpit setup'))).toBe(false);
    expect(shellRuns(fx)).toBe(before.shells + 1);
    const terminal = sessionsInState(dataDir).find((stored) => stored.id === terminalId)!;
    expect(terminal).toMatchObject({ harness: 'terminal', name: 'Terminal 1', directory: join(home, 'sessions', terminalId) });
    expect(terminal.project).toBeUndefined();
    expect(existsSync(terminal.directory)).toBe(true);
    expect(await linkInSessions(page, terminalId).count()).toBe(1);

    await openComposer(page, 'none');
    await waitForAgent(page, 'Claude Code');
    await promptBox(page).fill('Explore the codebase');
    await promptBox(page).press('Enter');
    const agentId = await waitForSessionPage(page, terminalId);
    await waitForRow(page, 'ready');
    const agent = sessionsInState(dataDir).find((stored) => stored.id === agentId)!;
    expect(agent).toMatchObject({ harness: 'claude-code', name: 'Claude Code 1', directory: join(home, 'sessions', agentId) });
    expect(agent.project).toBeUndefined();
    expect(startsOf(fx, 'claude').slice(before.claude)).toEqual([{ cwd: agent.directory, args: ['Explore the codebase'] }]);
    expect(await linkInSessions(page, agentId).count()).toBe(1);
    expect(listing(clone)).toEqual(before.worktrees);
    expect(shellRuns(fx), 'only the Terminal session ran the login shell').toBe(before.shells + 1);
  }, 60_000);

  test('AC18 — the same task again gets a "-2" branch', async () => {
    const { page } = session;
    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill('Run the tests!');
    await createButton(page).click();
    await waitForWorkspacePage(page, worktreeOf(clone, 'run-the-tests-2'));
    await waitForSelectedTab(page);
    expect(localBranches(clone)).toContain('run-the-tests-2');
    expect(localBranches(clone)).toContain('run-the-tests');
  }, 60_000);

  // --- The workspace name from the agent's title ----------------------------------------------------

  // The titles the stub prints in the worktree folder `folder` (the prompt's slug: a rename never moves it).
  const titlesFor = (folder: string) => join(fx.bin, `claude.titles.${folder}`);

  // The main process has read every title the daemon sent so far: its `projects:list` runs on the per-repository
  // chain a rename would be queued on. Used after the stubs' last title, before asserting that nothing was renamed.
  const settleMain = (page: Page) =>
    page.evaluate(() => (globalThis as unknown as { api: { projects: { list(): Promise<unknown> } } }).api.projects.list());

  test('AC21, AC22, AC23 — the first prompt-derived title renames the branch to its slug, sets cockpitName, keeps cockpitBase, leaves the folder and shows the name on the sidebar row within 5 s; the idle title and a second title change nothing; a session started from the workspace row renames nothing', async () => {
    const { page } = session;
    const first = 'please-fix-the-login-redirect-loop';
    const titles = titlesFor(first);
    writeFileSync(titles, '✳ Fix the login redirect loop\n✳ Something else entirely\n');
    let done = await openFifo(`${titles}.done`);
    const renamed = 'fix-the-login-redirect-loop';
    const path = worktreeOf(clone, first);

    await openComposer(page, clone.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'origin/main');
    await promptBox(page).fill('Please fix the login redirect loop');
    await promptBox(page).press('Enter');
    await waitForWorkspacePage(page, path);

    // The stub has printed its titles once it writes to the FIFO; the idle title `✳ Claude Code` came first and renames nothing.
    // `nameWorkspace` writes `cockpitName` last, then the windows list again: the row showing the name is the event that
    // the branch is renamed and named. AC21's bound: the name shows within 5 s of the stub's last title.
    await signalled(done);
    const within = startClock();
    await entryOf(page, path).filter({ hasText: 'Fix the login redirect loop' }).waitFor();
    within('the sidebar row shows the name', 5_000);
    expect(localBranches(clone)).toContain(renamed);
    expect(localBranches(clone)).not.toContain(first);
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${renamed}.cockpitName`)).toBe('Fix the login redirect loop');
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${renamed}.cockpitBase`)).toBe('origin/main');
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${first}.cockpitBase`)).toBeNull();
    expect(existsSync(path), 'the folder does not move').toBe(true);
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(renamed);
    // The sidebar row shows the name without a window focus; its title attribute stays the path.
    expect(await entryOf(page, path).innerText()).toContain('Fix the login redirect loop');
    expect(await entryOf(page, path).getAttribute('title')).toBe(path);

    // A second prompt-derived title changes nothing: the main process has read every title the stub printed.
    await settleMain(page);
    expect(localBranches(clone)).toContain(renamed);
    expect(localBranches(clone)).not.toContain('something-else-entirely');
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${renamed}.cockpitName`)).toBe('Fix the login redirect loop');
    expect(await entryOf(page, path).innerText()).toContain('Fix the login redirect loop');

    // A session started from the workspace row (no `nameFromTitle`) renames nothing, whatever its title.
    writeFileSync(titles, '✳ Started from the row\n');
    await done.close();
    done = await openFifo(`${titles}.done`);
    const started = await page.evaluate(
      ([project, workspace]) =>
        (globalThis as unknown as { api: { sessions: { start(harness: string, size: object, options: object): Promise<{ status: string }> } } }).api.sessions.start(
          'claude-code',
          { cols: 80, rows: 24 },
          { workspace: { project, path: workspace } },
        ),
      [clone.root, path] as const,
    );
    expect(started.status).toBe('started');
    await signalled(done);
    await settleMain(page);
    expect(localBranches(clone)).toContain(renamed);
    await done.close();
    rmSync(`${titles}.done`, { force: true });
    expect(localBranches(clone)).not.toContain('started-from-the-row');
    expect(gitOrNull(clone.root, 'config', '--get', `branch.${renamed}.cockpitName`)).toBe('Fix the login redirect loop');

    // No error was logged by the main process or the page across the whole block.
    expect(session.isRunning()).toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(await page.pageErrors({ filter: 'all' })).toEqual([]);
    expect((await page.consoleMessages({ filter: 'all' })).filter((message) => message.type() === 'error').map((message) => message.text())).toEqual([]);
  }, 90_000);

  // Types a line on the keyboard of the visible terminal, as a user does.
  const typeLine = async (page: Page, text: string) => {
    await page.locator('.xterm:visible').first().click();
    await page.locator('.xterm:visible .xterm-helper-textarea').first().focus();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };

  test('AC23 — a title printed by a setup command, before the agent started, never names the workspace: the stub\'s title does', async () => {
    const { page } = session;
    const placeholder = 'title-during-the-setup';
    writeFileSync(titlesFor(placeholder), '✳ Fix the login redirect loop\n');
    const renamed = 'fix-the-login-redirect-loop';
    const config = join(refuse.root, '.cockpit');
    mkdirSync(config, { recursive: true });
    // A title that matches the harness's prompt pattern, printed by the setup command itself, before the agent starts.
    writeFileSync(join(config, 'config.json'), JSON.stringify({ setup: [`printf '\\033]0;\\342\\234\\263 Setup title\\007'; echo title-printed`] }));
    try {
      await openComposer(page, refuse.root);
      await waitForAgent(page, 'Claude Code');
      await waitForBase(page, 'main');
      await promptBox(page).fill('Title during the setup');
      await promptBox(page).press('Enter');
      await waitForWorkspacePage(page, worktreeOf(refuse, placeholder));
      await waitForRow(page, 'title-printed');
      // The row shows the name once `nameWorkspace` has renamed the branch and stored the name.
      await entryOf(page, worktreeOf(refuse, placeholder)).filter({ hasText: 'Fix the login redirect loop' }).waitFor();
    } finally {
      rmSync(config, { recursive: true, force: true });
    }

    expect(localBranches(refuse)).not.toContain('setup-title');
    expect(localBranches(refuse)).not.toContain(placeholder);
    expect(gitOrNull(refuse.root, 'config', '--get', `branch.${renamed}.cockpitName`)).toBe('Fix the login redirect loop');
    expect(git(worktreeOf(refuse, placeholder), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(renamed);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  }, 60_000);

  test('AC23 — a title the login shell sets after the agent exited, which printed no prompt-derived title, renames nothing: the branch keeps the prompt\'s slug and no cockpitName is set', async () => {
    const { page } = session;
    const branch = 'title-after-the-agent';
    await openComposer(page, refuse.root);
    await waitForAgent(page, 'Claude Code');
    await waitForBase(page, 'main');
    await promptBox(page).fill('Title after the agent');
    await promptBox(page).press('Enter');
    await waitForWorkspacePage(page, worktreeOf(refuse, branch));
    await waitForRow(page, 'ready');

    // The agent exits before it printed a prompt-derived title; the login shell then prints one.
    await typeLine(page, 'exit');
    await waitForRow(page, '[Claude Code exited with code 3]');
    await waitForRow(page, 'login-shell>');
    await typeLine(page, "printf '\\033]0;\\342\\234\\263 Shell title\\007'; git branch --show-current; echo shell-title-done");
    await waitForRow(page, 'shell-title-done');
    await settleMain(page);

    // The shell's own `git` ran after the title, in the worktree: it still sees the prompt's slug.
    await waitForRow(page, branch);
    expect(localBranches(refuse)).toContain(branch);
    expect(localBranches(refuse)).not.toContain('shell-title');
    expect(gitOrNull(refuse.root, 'config', '--get', `branch.${branch}.cockpitName`)).toBeNull();
    expect(git(worktreeOf(refuse, branch), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);

    expect(session.isRunning()).toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(await page.pageErrors({ filter: 'all' })).toEqual([]);
  }, 90_000);

  test('AC5 — with no project in Cockpit the project select shows "No project"', async () => {
    const { page } = session;
    for (const repo of [clone, nodef, gone, refuse]) {
      await page.evaluate((path) => (globalThis as unknown as { api: { projects: { remove(path: string): Promise<unknown> } } }).api.projects.remove(path), repo.root);
    }
    // `/` is the empty state without a project (COCKPIT-72 AC1): the composer is at `/?project=none`.
    await openComposer(page, 'none');
    expect(await textOf(projectSelect(page))).toBe('No project');
    expect(await baseSelect(page).count()).toBe(0);
  });
});

describe('built app without any agent CLI on the login shell PATH', () => {
  let fx: SessionsFixture;
  let session: Session;
  let dataDir: string;

  beforeAll(async () => {
    fx = makeSessionsFixture([]);
    dataDir = makeTestDir('d-');
    session = await launchBuiltWith(fx.env(), dataDir);
    await session.page.getByText(versionLabel).waitFor();
    // `/` is the empty state without a project (COCKPIT-72 AC1): the composer is at `/?project=none`.
    await openComposer(session.page, 'none');
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC2, COCKPIT-66 AC13 — with no agent CLI the New workspace page\'s agent select shows "Terminal", its menu a disabled "No agent CLI found" item with the install hint above "Terminal", and no session starts', async () => {
    const { page } = session;
    const before = stateSnapshot(session.dataDir);

    await waitForAgent(page, 'Terminal');
    const menu = await openPopup(page, agentSelect(page));

    expect(await itemTexts(menu)).toEqual([
      'No agent CLI found Install Claude Code, Codex or OpenCode, then detect again. Until then, the workspace opens with a terminal.',
      'Terminal',
      'Detect again',
    ]);
    const missing = menu.locator('[role^="menuitem"]').first();
    expect(await missing.evaluate((item) => item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('data-disabled'))).toBe(true);

    // A disabled item: the click starts nothing, so no `sessions:start` reached the main process by the time its
    // later answers came.
    await countIpcCalls(session, ['sessions:start']);
    await missing.click({ force: true }).catch(() => {});
    await afterIpcAnswers(page);
    expect(await ipcCalls(session, 'sessions:start')).toBe(0);
    await page.keyboard.press('Escape');
    expect(await sessionEntries(page)).toEqual([]);
    expect(sessionIdOf(page)).toBeUndefined();
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    await expectNoErrors(session);
  });

  test('COCKPIT-68 AC26 — the agent menu\'s multi-line hint item is taller than 28 px, holds its text, and no two items overlap', async () => {
    const { page } = session;
    await waitForAgent(page, 'Terminal');
    const menu = await openPopup(page, agentSelect(page));

    const boxes = await itemsOf(menu).evaluateAll((items) =>
      items.map((item) => {
        // Layout boxes: the popup's opening animation scales its rects.
        const element = item as HTMLElement;
        const top = element.offsetTop;
        return { top, bottom: top + element.offsetHeight, height: element.offsetHeight, text: (item.textContent ?? '').trim(), overflow: item.scrollHeight - item.clientHeight };
      }),
    );
    await page.keyboard.press('Escape');

    expect(boxes).toHaveLength(3);
    const hint = boxes.find((box) => box.text.startsWith('No agent CLI found'))!;
    expect(hint.height, 'the hint item').toBeGreaterThan(28);
    for (const box of boxes) expect(box.overflow, `${box.text} fits its box`).toBeLessThanOrEqual(1);
    const ordered = [...boxes].sort((a, b) => a.top - b.top);
    for (let at = 1; at < ordered.length; at++) {
      expect(ordered[at]!.top, `${ordered[at]!.text} starts below ${ordered[at - 1]!.text}`).toBeGreaterThanOrEqual(ordered[at - 1]!.bottom - 0.5);
    }
  });
});
