import { basename } from 'node:path';
import { expect } from 'vitest';
import { type Locator, type Page } from 'playwright-core';
import { UI_TIMEOUT, ck80Log, poll } from './launch';

// COCKPIT-66: the New workspace page (the composer at `/`) as the tests drive it, shared by the test
// files that create workspaces and sessions. The project, agent and base selects have no accessible
// names in the spec, so they are found by what they show: the project select by its `bg-project-N`
// badge or the text "No project", the agent select by its text, the base select by its `git-branch` icon.

export const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
export const urlIn = (page: Page, path: string) => new URL(path, page.url()).href;

export const promptBox = (page: Page) => page.getByRole('textbox', { name: 'Prompt', exact: true });
export const createButton = (page: Page) => page.getByRole('button', { name: 'Create workspace', exact: true });
const controls = (page: Page) => page.locator('main').locator('button, [role="combobox"]');
export const projectSelect = (page: Page) =>
  controls(page)
    .filter({ has: page.locator('[class*="bg-project-"]') })
    .or(controls(page).filter({ hasText: /^\s*No project\s*$/ }))
    .first();
export const agentSelect = (page: Page) => controls(page).filter({ hasText: /^\s*(Detecting…|Claude Code|Codex|OpenCode|Terminal)\s*$/ }).first();
export const baseSelect = (page: Page) => controls(page).filter({ has: page.locator('svg.lucide-git-branch') }).first();
export const textOf = async (locator: Locator) => norm(await locator.innerText());

// The message the composer shows (`role="status"`), empty when there is none.
export const messageOf = async (page: Page) => {
  const messages = page.locator('main').getByRole('status').filter({ hasText: /\S/ });
  return (await messages.count()) === 0 ? '' : norm(await messages.first().innerText());
};

export const openPopup = async (page: Page, trigger: Locator) => {
  ck80Log.push(`[ck80] ${Date.now()} test openPopup click; menus in DOM ${await page.locator('[role="menu"]').count()}`);
  await trigger.click({ timeout: UI_TIMEOUT });
  ck80Log.push(`[ck80] ${Date.now()} test openPopup clicked`);
  const menu = page.getByRole('menu');
  await menu.waitFor({ timeout: UI_TIMEOUT });
  return menu;
};
export const itemsOf = (menu: Locator) => menu.locator('[role^="menuitem"]');
export const itemTexts = async (menu: Locator) => (await itemsOf(menu).allInnerTexts()).map(norm);
export const isDisabledItem = (item: Locator) =>
  item.evaluate((element) => element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('data-disabled'));
export const closePopups = async (page: Page) => {
  for (let attempt = 0; attempt < 3 && (await page.locator('[role="menu"], [role="listbox"]').count()) > 0; attempt++) {
    await page.keyboard.press('Escape');
    await poll(() => page.locator('[role="menu"], [role="listbox"]').count(), (count) => count === 0, 1_000);
  }
};

// Goes to the composer for a project (a path, or `none` for no project) as the app's own links do.
export async function openComposer(page: Page, project?: string) {
  await page.goto(urlIn(page, project === undefined ? '/' : `/?project=${encodeURIComponent(project)}`));
  await promptBox(page).waitFor({ timeout: UI_TIMEOUT });
}

// Goes to the composer through the sidebar, as a user does and without reloading the page (the Sessions
// "+", or "New workspace…" in the project's menu); falls back to the URL when the sidebar offers no way.
export async function openComposerFromSidebar(page: Page, project: string) {
  try {
    if (project === 'none') {
      await page.getByRole('button', { name: 'Start session', exact: true }).click({ timeout: 3_000 });
    } else {
      await page.getByTitle(project, { exact: true }).first().hover({ timeout: 3_000 });
      await page.getByRole('button', { name: `Actions for ${basename(project)}`, exact: true }).click({ timeout: 3_000 });
      await page.getByRole('menuitem', { name: 'New workspace…' }).click({ timeout: 3_000 });
      ck80Log.push(`[ck80] ${Date.now()} test clicked New workspace…`);
    }
    await promptBox(page).waitFor({ timeout: UI_TIMEOUT });
    ck80Log.push(`[ck80] ${Date.now()} test prompt box visible`);
  } catch {
    await closePopups(page);
    await openComposer(page, project);
  }
}

export async function pickAgent(page: Page, name: string) {
  const menu = await openPopup(page, agentSelect(page));
  await itemsOf(menu).filter({ hasText: new RegExp(`^\\s*${name}`) }).first().click({ timeout: UI_TIMEOUT });
  await poll(() => textOf(agentSelect(page)), (text) => text === name, UI_TIMEOUT);
}

export async function detectAgain(page: Page) {
  const menu = await openPopup(page, agentSelect(page));
  await itemsOf(menu).filter({ hasText: /^\s*Detect again\s*$/ }).click({ timeout: UI_TIMEOUT });
}

export const waitForAgent = (page: Page, text: string) => poll(() => textOf(agentSelect(page)), (value) => value === text, UI_TIMEOUT);
export const waitForBase = (page: Page, text: string) => poll(() => textOf(baseSelect(page)), (value) => value === text, UI_TIMEOUT);

export const searchBranches = (page: Page) => page.locator('input[placeholder="Search branches"], input[aria-label="Search branches"]');

// The base popup: its lines (group labels and branches), whether the search field has the focus, the checked options.
export const basePopup = (page: Page) =>
  page.evaluate(() => {
    const input = document.querySelector('input[placeholder="Search branches"], input[aria-label="Search branches"]') as HTMLInputElement | null;
    if (!input) return null;
    let node: HTMLElement | null = input;
    while (node && !node.querySelector('[role="listbox"]')) node = node.parentElement;
    return {
      focused: document.activeElement === input,
      lines: (node?.innerText ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
      selected: [...(node?.querySelectorAll('[role="option"][aria-selected="true"]') ?? [])].map((option) => (option.textContent ?? '').trim()),
    };
  });

export async function chooseBase(page: Page, base: string) {
  await baseSelect(page).click({ timeout: UI_TIMEOUT });
  await searchBranches(page).waitFor({ timeout: UI_TIMEOUT });
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.locator('[role="option"]').filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }).click({ timeout: UI_TIMEOUT });
  await waitForBase(page, base);
}

export const sessionIdIn = (page: Page) => /^\/sessions\/([^/]+)$/.exec(new URL(page.url()).pathname)?.[1];

// The id of the session whose page opened, other than `previous`.
export const waitForNewSession = async (page: Page, previous?: string) => {
  const id = await poll(() => (sessionIdIn(page) === previous ? undefined : sessionIdIn(page)), Boolean, 15_000);
  expect(id, `the page ${page.url()} is a new session's`).toBeTruthy();
  return id!;
};

// The path of the workspace whose page (`/workspace?path=`) is open, if one is.
export const workspacePathIn = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname === '/workspace' ? (url.searchParams.get('path') ?? undefined) : undefined;
};

// Waits for the workspace page of `path` (any workspace without it).
export const waitForWorkspacePage = async (page: Page, path?: string) => {
  const found = await poll(() => workspacePathIn(page), (found) => found !== undefined && (path === undefined || found === path), 15_000);
  expect(found, `the page ${page.url()} is the workspace page${path ? ` of ${path}` : ''}`).toBeTruthy();
  return found!;
};

interface StoredSession {
  id: string;
  name: string;
  directory: string;
  project?: string;
}

// The sessions the app stores, read through the page.
export const storedSessions = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { api: { sessions: { list(): Promise<StoredSession[]> } } }).api.sessions.list());

// The labels of the workspace page's tabs and the selected one (a tab's label is the session's name until its
// program sets a title, then that title), `null` when no tab is selected.
export const tabsOf = (page: Page) =>
  page.evaluate(() => {
    const label = (tab: Element) => (tab.getAttribute('title') ?? tab.querySelector('[title]')?.getAttribute('title') ?? tab.textContent ?? '').trim();
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    return { labels: tabs.map(label), selected: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map(label) };
  });

// Waits for the new stored session of the workspace at `path` (not one of `known`) and for a selected tab.
export async function waitForWorkspaceSession(page: Page, path: string, known: Set<string>) {
  const stored = await poll(
    async () => (await storedSessions(page)).find((each) => each.directory === path && !known.has(each.id)),
    Boolean,
    15_000,
  );
  expect(stored, `a session stored for ${path}`).toBeTruthy();
  await poll(async () => (await tabsOf(page)).selected.length, (count) => count > 0, UI_TIMEOUT);
  return stored!;
}

// Waits for the detection to end and picks `agent` unless it is the one shown.
export async function useAgent(page: Page, agent: string) {
  await poll(() => textOf(agentSelect(page)), (text) => text !== 'Detecting…', 30_000);
  if ((await textOf(agentSelect(page))) !== agent) await pickAgent(page, agent);
}

export interface Sent {
  /** The new session's id: the session of "No project", or the agent's tab of a workspace. Not with "Terminal" and a project. */
  id?: string;
  /** The workspace's path, with a project. */
  path?: string;
}

// Fills the composer for `project` (`none` for no project) and sends it with Enter or the button: picks
// `agent` ("Terminal" by default, so a real CLI of the developer's machine never starts), waits for the
// base to be known and, with `base`, picks it. With "No project" the session's page opens (`id`); with a
// project the workspace page opens (`path`), and with an agent its new session is the selected tab (`id`).
export async function sendFromComposer(
  page: Page,
  project: { root: string } | 'none',
  { prompt, agent = 'Terminal', base, enter = false }: { prompt: string; agent?: string; base?: string; enter?: boolean },
): Promise<Sent> {
  const previous = sessionIdIn(page);
  const known = new Set((await storedSessions(page)).map((each) => each.id));
  await openComposerFromSidebar(page, project === 'none' ? 'none' : project.root);
  await useAgent(page, agent);
  if (project !== 'none') {
    await poll(() => textOf(baseSelect(page)).catch(() => ''), (text) => text !== '' && text !== 'Select a base', UI_TIMEOUT);
    if (base) await chooseBase(page, base);
  }
  await promptBox(page).fill(prompt);
  if (enter) await promptBox(page).press('Enter');
  else await createButton(page).click({ timeout: UI_TIMEOUT });
  if (project === 'none') return { id: await waitForNewSession(page, previous) };
  const path = await waitForWorkspacePage(page);
  if (agent === 'Terminal') return { path };
  return { path, id: (await waitForWorkspaceSession(page, path, known)).id };
}
