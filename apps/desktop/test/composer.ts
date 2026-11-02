import { basename } from 'node:path';
import { expect } from 'vitest';
import { type Locator, type Page } from 'playwright-core';
import { UI_TIMEOUT, poll } from './launch';

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
  await trigger.click({ timeout: UI_TIMEOUT });
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
    }
    await promptBox(page).waitFor({ timeout: UI_TIMEOUT });
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

// Waits for the detection to end and picks `agent` unless it is the one shown.
export async function useAgent(page: Page, agent: string) {
  await poll(() => textOf(agentSelect(page)), (text) => text !== 'Detecting…', 30_000);
  if ((await textOf(agentSelect(page))) !== agent) await pickAgent(page, agent);
}

// Fills the composer for `project` (`none` for no project) and sends it with Enter or the button: picks
// `agent` ("Terminal" by default, so a real CLI of the developer's machine never starts), waits for the
// base to be known and, with `base`, picks it. Resolves with the id of the session whose page opens.
export async function sendFromComposer(
  page: Page,
  project: { root: string } | 'none',
  { prompt, agent = 'Terminal', base, enter = false }: { prompt: string; agent?: string; base?: string; enter?: boolean },
): Promise<string> {
  const previous = sessionIdIn(page);
  await openComposerFromSidebar(page, project === 'none' ? 'none' : project.root);
  await useAgent(page, agent);
  if (project !== 'none') {
    await poll(() => textOf(baseSelect(page)).catch(() => ''), (text) => text !== '' && text !== 'Select a base', UI_TIMEOUT);
    if (base) await chooseBase(page, base);
  }
  await promptBox(page).fill(prompt);
  if (enter) await promptBox(page).press('Enter');
  else await createButton(page).click({ timeout: UI_TIMEOUT });
  return waitForNewSession(page, previous);
}
