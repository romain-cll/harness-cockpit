import { basename } from 'node:path';
import { expect } from 'vitest';
import { type Locator, type Page } from 'playwright-core';

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
const exactly = (text: string) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);

// The message the composer shows (`role="status"`), empty when there is none.
const messages = (page: Page) => page.locator('main').getByRole('status').filter({ hasText: /\S/ });
export const messageOf = async (page: Page) => ((await messages(page).count()) === 0 ? '' : norm(await messages(page).first().innerText()));
// Waits for the composer to show a message, and gives it.
export const waitForMessage = async (page: Page) => {
  await messages(page).first().waitFor();
  return messageOf(page);
};

// The menu `trigger` opens: Base UI labels a menu by its trigger, so a menu another trigger opened, still in the
// DOM during its exit animation, is never this one.
export const openPopup = async (page: Page, trigger: Locator) => {
  const id = await trigger.getAttribute('id');
  await trigger.click();
  const menu = page.locator(`[role="menu"][aria-labelledby="${id}"]`);
  await menu.waitFor();
  return menu;
};
export const itemsOf = (menu: Locator) => menu.locator('[role^="menuitem"]');
export const itemTexts = async (menu: Locator) => (await itemsOf(menu).allInnerTexts()).map(norm);
export const isDisabledItem = (item: Locator) =>
  item.evaluate((element) => element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('data-disabled'));
// Escape closes the innermost popup: one press per popup, each awaited until it has left the DOM.
export const closePopups = async (page: Page) => {
  const popups = page.locator('[role="menu"], [role="listbox"]');
  while ((await popups.count()) > 0) {
    await page.keyboard.press('Escape');
    await popups.last().waitFor({ state: 'detached' });
  }
};

// Goes to the composer for a project (a path, or `none` for no project) as the app's own links do.
export async function openComposer(page: Page, project?: string) {
  await page.goto(urlIn(page, project === undefined ? '/' : `/?project=${encodeURIComponent(project)}`));
  await promptBox(page).waitFor();
}

// Goes to the composer through the sidebar, as a user does and without reloading the page (the Sessions
// "+", or "New workspace" (formerly "New workspace…") in the project's menu). A project the app does not list has no row to use, so the
// URL is the way; one it lists has its row rendered sooner or later, and the click waits for it.
export async function openComposerFromSidebar(page: Page, project: string) {
  if (project === 'none') {
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
  } else if (await isListed(page, project)) {
    await page.getByTitle(project, { exact: true }).first().hover();
    await page.getByRole('button', { name: `Actions for ${basename(project)}`, exact: true }).click();
    await page.getByRole('menuitem', { name: /^New workspace…?$/ }).click();
  } else {
    await openComposer(page, project);
    return;
  }
  await promptBox(page).waitFor();
}

const isListed = (page: Page, project: string) =>
  page.evaluate(
    async (path) => (await (window as unknown as { api: { projects: { list(): Promise<{ path: string }[]> } } }).api.projects.list()).some((each) => each.path === path),
    project,
  );

export async function pickAgent(page: Page, name: string) {
  const menu = await openPopup(page, agentSelect(page));
  await itemsOf(menu).filter({ hasText: new RegExp(`^\\s*${name}`) }).first().click();
  await waitForAgent(page, name);
}

export async function detectAgain(page: Page) {
  const menu = await openPopup(page, agentSelect(page));
  await itemsOf(menu).filter({ hasText: /^\s*Detect again\s*$/ }).click();
}

export const waitForAgent = (page: Page, text: string) => agentSelect(page).filter({ hasText: exactly(text) }).waitFor();
export const waitForBase = (page: Page, text: string) => baseSelect(page).filter({ hasText: exactly(text) }).waitFor();

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
  await baseSelect(page).click();
  await searchBranches(page).waitFor();
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.locator('[role="option"]').filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }).click();
  await waitForBase(page, base);
}

export const sessionIdIn = (page: Page) => /^\/sessions\/([^/]+)$/.exec(new URL(page.url()).pathname)?.[1];

// The id of the session whose page opened, other than `previous`.
export const waitForNewSession = async (page: Page, previous?: string) => {
  await page.waitForURL((url) => {
    const id = /^\/sessions\/([^/]+)$/.exec(url.pathname)?.[1];
    return id !== undefined && id !== previous;
  });
  const id = sessionIdIn(page);
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
  await page.waitForURL((url) => url.pathname === '/workspace' && url.searchParams.has('path') && (path === undefined || url.searchParams.get('path') === path));
  const found = workspacePathIn(page);
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

// Waits for the selected tab of the workspace page (COCKPIT-89: the page opens while the worktree is still being
// made, and the session's terminal joins it as a tab once the session is stored).
export const waitForSelectedTab = (page: Page) => page.locator('[role="tab"][aria-selected="true"]').first().waitFor();

// Gives the new stored session of the workspace at `path` (not one of `known`) once its tab is selected: the
// tab shows after the session was stored, so one read of the stored sessions is enough then.
export async function waitForWorkspaceSession(page: Page, path: string, known: Set<string>) {
  await waitForSelectedTab(page);
  const stored = (await storedSessions(page)).find((each) => each.directory === path && !known.has(each.id));
  expect(stored, `a session stored for ${path}`).toBeTruthy();
  return stored!;
}

// Waits for the detection to end and picks `agent` unless it is the one shown.
export async function useAgent(page: Page, agent: string) {
  await agentSelect(page).filter({ hasNotText: 'Detecting…' }).waitFor();
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
// project the workspace page opens (`path`) while its worktree is still being made, and once its tab is selected
// (the shell of "Terminal", or the agent's new session, `id`) the send is done.
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
    await baseSelect(page).filter({ hasText: /\S/ }).filter({ hasNotText: exactly('Select a base') }).waitFor();
    if (base) await chooseBase(page, base);
  }
  await promptBox(page).fill(prompt);
  if (enter) await promptBox(page).press('Enter');
  else await createButton(page).click();
  if (project === 'none') return { id: await waitForNewSession(page, previous) };
  const path = await waitForWorkspacePage(page);
  if (agent === 'Terminal') {
    await waitForSelectedTab(page);
    return { path };
  }
  return { path, id: (await waitForWorkspaceSession(page, path, known)).id };
}
