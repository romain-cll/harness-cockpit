import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { type Session, untilRead, versionLabel } from './launch';
import { addProject, addRepository, dispatchFocus, gitAlertOf, gitIn, makeLightRepo, makePlainFolder, makeRepo, projectsGit, sidebarLines, type TempRepo, tokenColor, waitForLine } from './support/projects';
import { promptBox } from './composer';
import { daemonPidIn } from './support/panes';
import {
  closeOverlays,
  dotTarget,
  launchBuiltWith,
  locationsSeen,
  makeSessionsFixture,
  openSessionEntry,
  openWorkspaceStartMenu,
  readStub,
  recordLocations,
  reportStatus,
  routerSettled,
  type SessionsFixture,
  startInWorkspace,
  startSession,
  storedSessionIds,
  stubNotifications,
  untilStartListed,
  watchStarts,
  workspaceTabs,
} from './support/sessions';
import { focusTerminal, goHome, typeLine, waitForRow } from './support/terminal';

// --- Redesign foundation (COCKPIT-65) ----------------------------------------

// The titles (project roots, workspace paths, session folders) of the sidebar rows that are shown.
// Self-contained: it also runs in `untilRead`.
const readVisibleTitles = (): string[] => [
  ...new Set(
    [...document.querySelectorAll('aside [title]')]
      .filter((element) => {
        const { width, height } = element.getBoundingClientRect();
        return width > 0 && height > 0 && element.checkVisibility();
      })
      .map((element) => element.getAttribute('title')!),
  ),
];
const visibleTitles = (page: Page) => page.evaluate(readVisibleTitles);
const waitForVisibleTitles = (page: Page, wanted: string[]) =>
  untilRead(page, readVisibleTitles, (shown, wanted: string[]) => wanted.every((title) => shown.includes(title)), wanted);

// The computed fills of `body`, `<main>` and `<aside>` under a color scheme.
async function fillsUnder(page: Page, colorScheme: 'dark' | 'light') {
  await page.emulateMedia({ colorScheme });
  return page.evaluate(() => {
    const fill = (selector: string) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).backgroundColor : 'missing';
    };
    return { body: fill('body'), main: fill('main'), aside: fill('aside') };
  });
}

// What AC2 measures: `<main>` against the window, its box model, the sidebar's right border and the
// page header row.
const shellOf = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main')!;
    const aside = document.querySelector('aside');
    const style = getComputedStyle(main);
    const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
    const rect = main.getBoundingClientRect();
    const header = main.querySelector('header')?.getBoundingClientRect();
    return {
      windowHeight: window.innerHeight,
      mainTop: rect.top,
      mainHeight: rect.height,
      margin: sides.map((side) => style[`margin${side}`]),
      border: sides.map((side) => style[`border${side}Width`]),
      radius: style.borderRadius,
      padding: sides.map((side) => style[`padding${side}`]),
      asideRightBorder: aside ? getComputedStyle(aside).borderRightWidth : null,
      headerTop: header?.top ?? null,
      headerHeight: header?.height ?? null,
    };
  });

// The project badge of the row titled `path`: the 16 px element holding the first character of `name`.
const badgeOf = (page: Page, path: string, name: string) =>
  page.evaluate(
    ({ path, name }) => {
      const item = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === path)?.closest('li');
      const letter = name[0]!.toLowerCase();
      const badge = ([...(item?.querySelectorAll('*') ?? [])] as HTMLElement[]).find((element) => {
        const { width, height } = element.getBoundingClientRect();
        return (element.textContent ?? '').trim().toLowerCase() === letter && Math.round(width) === 16 && Math.round(height) === 16;
      });
      if (!badge) return null;
      const style = getComputedStyle(badge);
      return { text: badge.innerText.trim(), background: style.backgroundColor, color: style.color, radius: style.borderRadius };
    },
    { path, name },
  );

// The chevron button of a project row and what its icon looks like (class and transform), so a test sees
// the chevron turn.
const chevronOf = (page: Page, label: string) =>
  page.getByRole('button', { name: label, exact: true }).evaluate((button) => {
    const icon = button.querySelector('svg');
    return {
      expanded: button.getAttribute('aria-expanded'),
      look: icon ? `${icon.getAttribute('class')} ${getComputedStyle(icon).transform} ${getComputedStyle(button).transform}` : 'no icon',
    };
  });

const STATUS_ICON = /lucide-(contrast|circle-dot|circle-check|circle-x|circle-dashed)(\s|$)/;

// The status icon of a session's row (COCKPIT-65 AC9): which Lucide icon, its size, its color, its
// accessible name and whether it sits left of the session's name.
const readStatusIcon = ({ id, name, source, directory }: { id: string; name: string; source: string; directory: string | null; kind?: string; label?: string | null }) => {
  let link = document.querySelector(`aside a[href$="/sessions/${id}"]`);
  // A session of a workspace has no row of its own: its workspace's row shows the icon.
  if (!link && directory) link = [...document.querySelectorAll('aside a[title]')].find((each) => each.getAttribute('title') === directory) ?? null;
  if (!link) return null;
  const svg = [...link.querySelectorAll('svg')].find((element) => new RegExp(source).test(element.getAttribute('class') ?? ''));
  if (!svg) return null;
  const holder = svg.closest('[role="img"]');
  const texts = ([...link.querySelectorAll('*')] as HTMLElement[]).filter((element) => (element.textContent ?? '').trim() === name);
  const nameElement = texts.find((element) => !texts.some((other) => other !== element && element.contains(other)));
  const box = svg.getBoundingClientRect();
  return {
    kind: new RegExp(source).exec(svg.getAttribute('class')!)![1]!,
    width: Math.round(box.width),
    height: Math.round(box.height),
    color: getComputedStyle(svg).color,
    role: holder?.getAttribute('role') ?? null,
    label: holder?.getAttribute('aria-label') ?? null,
    title: holder?.getAttribute('title') ?? null,
    hidden: svg.getAttribute('aria-hidden'),
    roleImgInRow: !!link.closest('li')?.querySelector('[role="img"]'),
    leftOfName: !!nameElement && box.right <= nameElement.getBoundingClientRect().left + 1,
  };
};

// Waits until the row of session `id` shows the icon `kind`, then checks all of AC9 for it: 14 px, left of
// the name, the token's color and, when `label` is given, role img with that aria-label and title.
async function expectStatusIcon(
  page: Page,
  id: string,
  name: string,
  expected: { kind: string; token: string; label: string | null },
) {
  const target = { ...(await dotTarget(page, id)), name, source: STATUS_ICON.source, kind: expected.kind, label: expected.label };
  const icon = await untilRead(page, readStatusIcon, (found, arg: typeof target) => found?.kind === arg.kind && (found?.label ?? null) === arg.label, target);
  expect(icon, `the status icon of ${name} (${id})`).not.toBeNull();
  expect(icon!.kind).toBe(expected.kind);
  expect([icon!.width, icon!.height], 'the icon is 14 px').toEqual([14, 14]);
  expect(icon!.leftOfName, 'the icon sits left of the name').toBe(true);
  expect(icon!.color, `the color of ${expected.token}`).toBe(await tokenColor(page, expected.token));
  if (expected.label === null) {
    expect(icon!.hidden).toBe('true');
    expect(icon!.roleImgInRow, 'no accessible name').toBe(false);
  } else {
    expect([icon!.role, icon!.label, icon!.title]).toEqual(['img', expected.label, expected.label]);
  }
}

describe('redesign foundation: built app', () => {
  let fx: SessionsFixture;
  let session: Session;
  let alpha: TempRepo;
  let bravo: TempRepo;
  let plain: TempRepo;
  let alphaWorkspace = '';
  let bravoWorkspace = '';
  const ids = { top: '', workspace: '' };

  beforeAll(async () => {
    // Stub agents, and a `git` wrapper that logs every run (the number of `--version` runs, AC10).
    fx = makeSessionsFixture(['claude'], { log: true, gitLog: true });
    alpha = makeRepo('alpha-redesign');
    bravo = makeLightRepo('bravo-redesign');
    plain = makePlainFolder('not-a-repository-redesign');
    alphaWorkspace = join(alpha.parent, 'feat-a');
    bravoWorkspace = join(bravo.parent, 'feat-b');
    gitIn(alpha.root, 'worktree', 'add', '--quiet', '-b', 'feat-a', alphaWorkspace);
    gitIn(bravo.root, 'worktree', 'add', '--quiet', '-b', 'feat-b', bravoWorkspace);
    session = await launchBuiltWith(fx.env());
    await session.page.getByText(versionLabel).waitFor();
    // A status report with no window focused would show a real notification.
    await stubNotifications(session);
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    for (const repo of [alpha, bravo, plain]) if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  afterEach(() => closeOverlays(session.page));

  const gitRuns = () => readFileSync(fx.gitLog, 'utf8').split('\n').filter((line) => line.endsWith(' --version')).length;

  test('COCKPIT-65 AC10 — with git on the login shell PATH no alert shows and projects.git() answers "ok"; git --version ran once, and a reload, a focus and another call run none', async () => {
    const { page } = session;
    expect(await projectsGit(page)).toBe('ok');
    expect(await gitAlertOf(page)).toBeNull();
    expect(await sidebarLines(page)).not.toContain('Git is not installed');
    expect(gitRuns(), 'the first call checked git').toBe(1);

    await page.reload();
    await page.getByText(versionLabel).waitFor();
    await dispatchFocus(page);
    // The call's answer comes after the loader's calls of the reload and of the focus: a `git --version` they
    // started has been logged by then.
    expect(await projectsGit(page)).toBe('ok');
    expect(gitRuns(), 'a reload, a focus and a second call run no new git --version').toBe(1);
  });

  test('COCKPIT-65 setup — two projects with a workspace each, and a session outside any project and one in a workspace', async () => {
    const { page } = session;
    await addRepository(session, alpha);
    await addRepository(session, bravo);
    await waitForVisibleTitles(page, [alphaWorkspace, bravoWorkspace]);
    ids.top = await startSession(page, 'Claude Code', 'Claude Code 1');
    await readStub(page);
    ids.workspace = await startInWorkspace(page, alphaWorkspace, 'feat-a', 'Claude Code', 'Claude Code 1');
    await readStub(page);
    expect(ids.top).not.toBe(ids.workspace);
    await goHome(page);
  });

  test('COCKPIT-65 AC1 — in dark mode body and <main> are #0E0E10 and the <aside> #161618, in light mode #FFFFFF and #F7F7F8, on Home and on a session page', async () => {
    const { page } = session;
    try {
      for (const where of ['home', 'session'] as const) {
        if (where === 'home') await goHome(page);
        else await openSessionEntry(page, 'Claude Code 1');
        expect(await fillsUnder(page, 'dark'), `dark, ${where}`).toEqual({ body: 'rgb(14, 14, 16)', main: 'rgb(14, 14, 16)', aside: 'rgb(22, 22, 24)' });
        expect(await fillsUnder(page, 'light'), `light, ${where}`).toEqual({ body: 'rgb(255, 255, 255)', main: 'rgb(255, 255, 255)', aside: 'rgb(247, 247, 248)' });
      }
    } finally {
      await page.emulateMedia({ colorScheme: null });
    }
  });

  test('COCKPIT-65 AC2 — <main> fills the window height with no margin, border or rounded corner, nothing separates it from the sidebar, it has 8 px of padding and the header row is 28 px tall at 8 px from the top', async () => {
    const { page } = session;
    for (const where of ['home', 'session'] as const) {
      if (where === 'home') await goHome(page);
      else await openSessionEntry(page, 'Claude Code 1');
      const shell = await shellOf(page);
      expect([shell.mainTop, shell.mainHeight], `${where}: <main> spans the window`).toEqual([0, shell.windowHeight]);
      expect(shell.margin, `${where}: margin`).toEqual(['0px', '0px', '0px', '0px']);
      expect(shell.border, `${where}: border`).toEqual(['0px', '0px', '0px', '0px']);
      expect(shell.radius, `${where}: radius`).toBe('0px');
      expect(shell.padding, `${where}: padding`).toEqual(['8px', '8px', '8px', '8px']);
      expect(shell.asideRightBorder, `${where}: the sidebar's right border`).toBe('0px');
      expect([shell.headerTop, shell.headerHeight], `${where}: the header row`).toEqual([8, 28]);
      expect(shell.headerTop! + shell.headerHeight! / 2, `${where}: its centre`).toBe(22);
    }
  });

  test('COCKPIT-65 AC3 — the traffic lights are at { x: 14, y: 16 }', async () => {
    expect(
      await session.evaluateInMain<{ x: number; y: number }>("require('electron').BrowserWindow.getAllWindows()[0].getWindowButtonPosition()"),
    ).toEqual({ x: 14, y: 16 });
  });

  test('COCKPIT-65 AC4 — the sidebar is 220 px wide: a 28 px top strip 8 px from the top with "Hide sidebar" at its right, then New workspace, Projects, Sessions and the muted version line at the bottom', async () => {
    const { page } = session;
    await goHome(page);
    const box = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!;
    const aside = await box(page.locator('aside'));
    expect(aside.width).toBe(220);
    const hide = page.getByRole('button', { name: 'Hide sidebar', exact: true });
    const hideBox = await box(hide);
    expect(hideBox.x + hideBox.width / 2, 'at the right of the strip').toBeGreaterThan(aside.x + aside.width / 2);
    expect(hideBox.x + hideBox.width).toBeLessThanOrEqual(aside.x + aside.width);
    // The strip: the button or one of its ancestors is 28 px tall, 8 px from the top.
    expect(
      await hide.evaluate((button) => {
        for (let element: Element | null = button; element && element.tagName !== 'ASIDE'; element = element.parentElement) {
          const { top, height } = element.getBoundingClientRect();
          if (top === 8 && height === 28) return true;
        }
        return false;
      }),
      'a 28 px strip at 8 px from the top',
    ).toBe(true);
    expect(hideBox.y + hideBox.height / 2).toBe(22);

    const tops = {
      hide: hideBox.y,
      newWorkspace: (await box(page.locator('aside').getByRole('link', { name: 'New workspace', exact: true }))).y,
      projects: (await box(page.getByRole('button', { name: 'Projects', exact: true }))).y,
      sessions: (await box(page.getByRole('button', { name: 'Sessions', exact: true }))).y,
      version: (await box(page.locator('aside').getByText(versionLabel))).y,
    };
    const order = Object.entries(tops).sort(([, a], [, b]) => a - b).map(([name]) => name);
    expect(order).toEqual(['hide', 'newWorkspace', 'projects', 'sessions', 'version']);

    const version = page.locator('aside').getByText(versionLabel);
    const versionBox = await box(version);
    expect(aside.y + aside.height - (versionBox.y + versionBox.height), 'at the bottom of the sidebar').toBeLessThanOrEqual(24);
    const colours = await version.evaluate((element) => ({
      line: getComputedStyle(element).color,
      sidebar: getComputedStyle(element.closest('aside')!).color,
    }));
    expect(colours.line, 'muted').not.toBe(colours.sidebar);
  });

  test('COCKPIT-65 AC5 — nothing in the sidebar is heavier than 400 and every Lucide icon in it has a stroke width of 1.25, with a project, a workspace, sessions and the selected row shown', async () => {
    const { page } = session;
    await page.getByTitle(alphaWorkspace, { exact: true }).first().click();
    await page.locator('aside a[aria-current="page"]').filter({ hasText: 'feat-a' }).waitFor();
    expect(await badgeOf(page, alpha.root, alpha.name), 'the project badge shows').not.toBeNull();
    const facts = await page.evaluate(() => {
      const elements = [...document.querySelectorAll('aside *')] as Element[];
      const icons = [...document.querySelectorAll('aside svg.lucide')];
      return {
        heavy: elements
          .filter((element) => Number(getComputedStyle(element).fontWeight) > 400)
          .map((element) => `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 30)}" ${getComputedStyle(element).fontWeight}`),
        icons: icons.length,
        strokes: icons.filter((icon) => parseFloat(getComputedStyle(icon).strokeWidth) !== 1.25).map((icon) => `${icon.getAttribute('class')} ${getComputedStyle(icon).strokeWidth}`),
        bots: document.querySelectorAll('aside svg.lucide-bot').length,
      };
    });
    expect(facts.heavy, 'elements with a font weight above 400').toEqual([]);
    expect(facts.icons).toBeGreaterThan(6);
    expect(facts.strokes, 'icons whose stroke width is not 1.25').toEqual([]);
    expect(facts.bots, "today's bot icon is gone").toBe(0);
  });

  test('COCKPIT-65 AC6 — "Hide sidebar" removes the <aside> and puts "Show sidebar" in the main header row right of the traffic lights, with the page content right of it; "Show sidebar" brings back the same content; a reload shows the sidebar', async () => {
    const { page } = session;
    await goHome(page);
    const content = await sidebarLines(page);
    expect(content).toContain('Projects');
    expect(await page.getByRole('button', { name: 'Show sidebar', exact: true }).count()).toBe(0);

    await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    await page.locator('aside').waitFor({ state: 'detached' });
    const show = page.getByRole('button', { name: 'Show sidebar', exact: true });
    await show.waitFor();
    const showBox = (await show.boundingBox())!;
    expect(showBox.y + showBox.height / 2, 'centred on the 22 px line').toBeCloseTo(22, 0);
    expect(showBox.x, 'right of the traffic lights').toBeGreaterThanOrEqual(72);
    expect(await page.locator('main').getByRole('button', { name: 'Show sidebar', exact: true }).count(), 'in the main area').toBe(1);
    const heading = (await page.getByRole('heading', { name: 'New workspace', exact: true }).boundingBox())!;
    expect(heading.x, 'the page content starts right of the button').toBeGreaterThanOrEqual(showBox.x + showBox.width - 1);
    const shell = await shellOf(page);
    expect([shell.headerTop, shell.headerHeight]).toEqual([8, 28]);

    await show.click();
    await page.locator('aside').waitFor();
    expect(await sidebarLines(page), 'the same Projects and Sessions content').toEqual(content);
    expect(await page.getByRole('button', { name: 'Show sidebar', exact: true }).count()).toBe(0);

    await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    await page.locator('aside').waitFor({ state: 'detached' });
    await page.reload();
    await page.locator('aside').waitFor();
    await page.getByText(versionLabel).waitFor();
    expect(await page.locator('aside').count()).toBe(1);
  });

  test('COCKPIT-65 AC8 — a project row shows a 16 px badge (radius 4) with the first letter of its name in upper case, white on one of six palette colours, the same after a reload; its chevron button hides that project\'s workspaces and their sessions only, and a reload shows every project expanded', async () => {
    const { page } = session;
    const palette = ['rgb(94, 106, 210)', 'rgb(217, 119, 6)', 'rgb(13, 148, 136)', 'rgb(225, 29, 72)', 'rgb(2, 132, 199)', 'rgb(124, 58, 237)'];
    const badges = {
      alpha: await badgeOf(page, alpha.root, alpha.name),
      bravo: await badgeOf(page, bravo.root, bravo.name),
    };
    expect(badges.alpha).toMatchObject({ text: 'A', color: 'rgb(255, 255, 255)', radius: '4px' });
    expect(badges.bravo).toMatchObject({ text: 'B', color: 'rgb(255, 255, 255)', radius: '4px' });
    expect(palette).toContain(badges.alpha!.background);
    expect(palette).toContain(badges.bravo!.background);

    const expanded = `Collapse ${alpha.name}`;
    const collapsed = `Expand ${alpha.name}`;
    const open = await chevronOf(page, expanded);
    expect(open.expanded).toBe('true');
    expect((await chevronOf(page, `Collapse ${bravo.name}`)).expanded).toBe('true');
    expect(await visibleTitles(page)).toEqual(expect.arrayContaining([alphaWorkspace, bravoWorkspace]));

    await page.getByRole('button', { name: expanded, exact: true }).click();
    const closed = await chevronOf(page, collapsed);
    expect(closed.expanded).toBe('false');
    expect(closed.look, 'the chevron turns to point right').not.toBe(open.look);
    const titles = await visibleTitles(page);
    expect(titles).toContain(alpha.root);
    expect(titles, 'the workspace rows of the project are hidden').not.toContain(alphaWorkspace);
    expect(titles, 'another project is unaffected').toContain(bravoWorkspace);
    expect((await chevronOf(page, `Collapse ${bravo.name}`)).expanded).toBe('true');

    await page.getByRole('button', { name: collapsed, exact: true }).click();
    expect((await chevronOf(page, expanded)).expanded).toBe('true');
    expect(await visibleTitles(page)).toContain(alphaWorkspace);

    // The colour is picked from the path: it does not change.
    await page.getByRole('button', { name: expanded, exact: true }).click();
    await page.reload();
    await page.getByText(versionLabel).waitFor();
    await waitForVisibleTitles(page, [alphaWorkspace]);
    expect((await chevronOf(page, expanded)).expanded, 'a reload shows the project expanded').toBe('true');
    expect((await chevronOf(page, `Collapse ${bravo.name}`)).expanded).toBe('true');
    expect(await badgeOf(page, alpha.root, alpha.name)).toEqual(badges.alpha);
    expect(await badgeOf(page, bravo.root, bravo.name)).toEqual(badges.bravo);
  });

  test('COCKPIT-65 AC7 — the "Projects" and "Sessions" header buttons hide and show their list, their "+" button and the Projects message line stay, and a reload shows both lists', async () => {
    const { page } = session;
    const projects = page.getByRole('button', { name: 'Projects', exact: true });
    const sessions = page.getByRole('button', { name: 'Sessions', exact: true });
    const topSession = page.locator(`aside a[href$="/sessions/${ids.top}"]`);
    expect(await projects.getAttribute('aria-expanded')).toBe('true');
    expect(await sessions.getAttribute('aria-expanded')).toBe('true');
    expect(await projects.locator('svg').count(), 'a caret').toBeGreaterThan(0);

    // A message line under the Projects header.
    const refusal = `${plain.root} is not in a git repository.`;
    await addProject(session, plain.root);
    await waitForLine(page, refusal);

    await projects.click();
    expect(await projects.getAttribute('aria-expanded')).toBe('false');
    const hiddenProjects = await visibleTitles(page);
    expect(hiddenProjects).not.toContain(alpha.root);
    expect(hiddenProjects).not.toContain(bravo.root);
    expect(await page.getByRole('button', { name: 'Add project', exact: true }).isVisible()).toBe(true);
    expect(await sidebarLines(page), 'the message stays').toContain(refusal);
    expect(await topSession.isVisible(), 'the other section is unaffected').toBe(true);
    await projects.click();
    expect(await projects.getAttribute('aria-expanded')).toBe('true');
    expect(await visibleTitles(page)).toEqual(expect.arrayContaining([alpha.root, bravo.root]));

    await sessions.click();
    expect(await sessions.getAttribute('aria-expanded')).toBe('false');
    expect(await topSession.isVisible()).toBe(false);
    expect(await page.getByRole('button', { name: 'Start session', exact: true }).isVisible()).toBe(true);
    await sessions.click();
    expect(await sessions.getAttribute('aria-expanded')).toBe('true');
    expect(await topSession.isVisible()).toBe(true);

    // A second click on each, then a reload: both lists show.
    await projects.click();
    await sessions.click();
    await page.reload();
    await page.getByText(versionLabel).waitFor();
    await waitForVisibleTitles(page, [alpha.root]);
    expect(await page.getByRole('button', { name: 'Projects', exact: true }).getAttribute('aria-expanded')).toBe('true');
    expect(await page.getByRole('button', { name: 'Sessions', exact: true }).getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator(`aside a[href$="/sessions/${ids.top}"]`).isVisible()).toBe(true);
  });

  test('COCKPIT-65 AC9 — a session row shows a 14 px status icon left of its name: contrast Working, circle-dot Needs input, circle-check Ready, circle-x Exited 3, circle-dashed Ended, and a muted aria-hidden circle-dashed before its first report', async () => {
    const { page } = session;
    const top = 'Claude Code 1';
    const unreported = { kind: 'circle-dashed', token: '--muted-foreground', label: null };
    await expectStatusIcon(page, ids.top, top, unreported);
    // A session of a workspace has no row: its workspace's row shows the icon.
    await expectStatusIcon(page, ids.workspace, 'feat-a', unreported);

    await reportStatus(session, ids.top, 'working');
    await expectStatusIcon(page, ids.top, top, { kind: 'contrast', token: '--status-working', label: 'Working' });
    await reportStatus(session, ids.top, 'waiting');
    await expectStatusIcon(page, ids.top, top, { kind: 'circle-dot', token: '--status-waiting', label: 'Needs input' });
    await reportStatus(session, ids.top, 'finished');
    await expectStatusIcon(page, ids.top, top, { kind: 'circle-check', token: '--status-ready', label: 'Ready' });
    // The row of a workspace is drawn the same way.
    await reportStatus(session, ids.workspace, 'working');
    await expectStatusIcon(page, ids.workspace, 'feat-a', { kind: 'contrast', token: '--status-working', label: 'Working' });

    await openSessionEntry(page, top);
    await focusTerminal(page);
    await typeLine(page, 'exit');
    await waitForRow(page, '[Process exited with code 3]');
    await expectStatusIcon(page, ids.top, top, { kind: 'circle-x', token: '--status-exited', label: 'Exited 3' });

    await page.getByTitle(alphaWorkspace, { exact: true }).first().click();
    await focusTerminal(page);
    await typeLine(page, 'quit');
    await waitForRow(page, '[Process exited with code 0]');
    await expectStatusIcon(page, ids.workspace, 'feat-a', { kind: 'circle-dashed', token: '--muted-foreground', label: 'Ended' });
  });

  // --- A session's start never overrides a later navigation (COCKPIT-86) ----------------------------------

  // Where the page is, as the router has it.
  const hereNow = (page: Page) => page.evaluate(() => location.pathname + location.search);
  const startItem = (page: Page) => page.getByRole('menuitem', { name: 'Claude Code', exact: true });
  const sessionsPlus = (page: Page) => page.getByRole('button', { name: 'Start session', exact: true });

  test('COCKPIT-86 AC1 — a session started from a workspace row\'s menu, its tab added and the flow\'s router.invalidate() still loading, does not pull the page back to the workspace when the user clicks the Sessions "+" and the load ends', async () => {
    const { page } = session;
    await goHome(page);
    const answer = await projectsGit(page);
    // The first `projects:git` call from now on is held: the root loader the flow's `router.invalidate()` runs. Later
    // calls (the user's own navigation) answer at once.
    await session.evaluateInMain(`(() => {
      const { ipcMain } = require('electron');
      globalThis.__gitHeld = new Promise((resolve) => { globalThis.__gitHolding = resolve; });
      const gate = new Promise((resolve) => { globalThis.__gitRelease = resolve; });
      let held = false;
      ipcMain.removeHandler('projects:git');
      ipcMain.handle('projects:git', async () => {
        if (!held) {
          held = true;
          globalThis.__gitHolding();
          await gate;
        }
        return ${JSON.stringify(answer)};
      });
    })()`);
    let released = false;
    const release = async () => {
      released = true;
      await session.evaluateInMain('globalThis.__gitRelease()');
    };
    try {
      await openWorkspaceStartMenu(page, bravoWorkspace, 'feat-b');
      await startItem(page).click();
      await session.evaluateInMain('globalThis.__gitHeld');
      await recordLocations(page);
      await sessionsPlus(page).click();
      await promptBox(page).waitFor();
      await release();
    } finally {
      if (!released) await release();
    }
    await routerSettled(page);
    expect(await hereNow(page), 'the composer is still open').toBe('/?project=none');
    expect((await locationsSeen(page)).filter((href) => href.startsWith('/workspace')), 'the page never went back to the workspace').toEqual([]);
  });

  test('COCKPIT-86 AC2 — a session started from a workspace row\'s menu whose start has not answered (daemon stopped) does not pull the page back when the user clicks the Sessions "+" and the daemon resumes: the composer stays, the session is stored and the workspace shows its tab', async () => {
    const { page } = session;
    await goHome(page);
    const known = await storedSessionIds(page);
    const starts = await watchStarts(session);
    const daemon = daemonPidIn(session.cockpitHome);
    await openWorkspaceStartMenu(page, bravoWorkspace, 'feat-b');
    process.kill(daemon, 'SIGSTOP');
    try {
      await startItem(page).click();
      await recordLocations(page);
      await sessionsPlus(page).click();
      await promptBox(page).waitFor();
    } finally {
      process.kill(daemon, 'SIGCONT');
    }
    const stored = await untilStartListed(session, known, starts);
    await routerSettled(page);
    expect(await hereNow(page), 'the composer is still open').toBe('/?project=none');
    expect((await locationsSeen(page)).filter((href) => href.startsWith('/workspace')), 'the page never went to the workspace').toEqual([]);
    expect(stored.directory).toBe(bravoWorkspace);

    await page.getByTitle(bravoWorkspace, { exact: true }).first().click();
    await page.getByRole('tab', { name: stored.name, exact: true }).waitFor();
  });

  test('COCKPIT-86 AC5 — a start refused from a workspace row\'s menu navigates nowhere, adds no tab and shows "Could not start Claude Code: …" in the sidebar\'s message slot', async () => {
    const { page } = session;
    await page.getByTitle(bravoWorkspace, { exact: true }).first().click();
    await page.getByRole('tab').first().waitFor();
    const tabsBefore = await workspaceTabs(page);
    await goHome(page);
    const known = await storedSessionIds(page);
    await recordLocations(page);
    const binary = join(fx.bin, 'claude');
    await openWorkspaceStartMenu(page, bravoWorkspace, 'feat-b');
    renameSync(binary, `${binary}.off`);
    try {
      await startItem(page).click();
      await page.locator('aside [role="status"]').filter({ hasText: /^\s*Could not start Claude Code:/ }).first().waitFor();
    } finally {
      renameSync(`${binary}.off`, binary);
    }
    await routerSettled(page);
    expect(await hereNow(page), 'the page did not move').toBe('/');
    expect(await locationsSeen(page), 'the history went nowhere').toEqual([]);
    expect(await storedSessionIds(page), 'no session stored').toEqual(known);

    await page.getByTitle(bravoWorkspace, { exact: true }).first().click();
    await page.getByRole('tab').first().waitFor();
    expect(await workspaceTabs(page), 'no tab added').toEqual(tabsBefore);
  });
});
