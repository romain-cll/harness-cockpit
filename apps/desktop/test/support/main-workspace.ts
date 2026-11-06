import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Locator, type Page } from 'playwright-core';

// COCKPIT-71: what the tests of the main workspace (a project's workspace with no worktree) share. Its path is the
// project's path, so its sidebar row is titled like the project's: the project row is a `div`, the workspace row a link.

// The sidebar's links titled `root`, as text: the main workspace row of the project at `root` (none, or one). Self-contained: it runs in the page.
export const readMainRows = (root: string): string[] => {
  const section = [...document.querySelectorAll('aside section')].find((candidate) => candidate.querySelector('h2')?.textContent === 'Projects');
  return [...(section?.querySelectorAll('a[title]') ?? [])].filter((link) => link.getAttribute('title') === root).map((link) => (link.textContent ?? '').trim());
};

export const mainRowsOf = (page: Page, root: string) => page.evaluate(readMainRows, root);
export const mainRowLink = (page: Page, root: string) => page.locator(`aside a[title="${root}"]`).first();

// Waits until the project at `root` lists its main workspace, or until it does not.
export const waitForMainRow = (page: Page, root: string) => mainRowLink(page, root).waitFor();
export const waitForNoMainRow = (page: Page, root: string) => mainRowLink(page, root).waitFor({ state: 'detached' });
// Waits until the main workspace row of `root` shows `text`.
export const waitForMainRowText = (page: Page, root: string, text: string) => mainRowLink(page, root).filter({ hasText: text }).waitFor();

// Opens the "…" menu of the main workspace row of `root` (named `name`) and picks "Delete workspace…". The generic
// helpers find the project's row first, whose title is the same.
export async function startMainDeletion(page: Page, root: string, name: string) {
  await mainRowLink(page, root).hover();
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete workspace…', exact: true }).click();
}

// The named status icon (a pull request's, a session's) of the main workspace row of `root`.
export const mainRowIcon = (page: Page, root: string, name: string): Locator => mainRowLink(page, root).getByRole('img', { name, exact: true });

// The projects as `state.json` stores them.
export const storedProjects = (dataDir: string) =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { projects?: Array<{ path: string; mainWorkspace?: boolean }> }).projects ?? [];
// The sessions as `state.json` stores them, `open` included.
export const storedSessionsOf = (dataDir: string) =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { sessions?: Array<{ id: string; harness: string; directory: string; project?: string; open?: boolean }> }).sessions ?? [];

// The colour a design token resolves to, as a background or a text colour.
export const tokenColour = (page: Page, token: string, property: 'color' | 'backgroundColor' = 'color') =>
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

// What the Worktree switch looks like: its control (the box that holds the track and the label), the 28 × 16 track,
// the knob and the label. Self-contained: it runs in the page.
export const readSwitchLook = () => {
  const track = document.querySelector('main [role="switch"]') as HTMLElement | null;
  if (!track) return null;
  const label = [...document.querySelectorAll('main *')].find((element) => element.children.length === 0 && (element.textContent ?? '').trim() === 'Worktree');
  if (!label) return null;
  let control: HTMLElement | null = track.parentElement;
  while (control && !control.contains(label)) control = control.parentElement;
  const box = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const thumb = [...track.querySelectorAll('*')].find((element) => {
    const rect = element.getBoundingClientRect();
    return Math.round(rect.width) === 12 && Math.round(rect.height) === 12;
  });
  const style = (element: Element) => getComputedStyle(element);
  return {
    on: track.getAttribute('aria-checked') === 'true',
    control: control && { ...box(control), paddingLeft: style(control).paddingLeft, paddingRight: style(control).paddingRight },
    track: { ...box(track), background: style(track).backgroundColor },
    thumb: thumb ? { ...box(thumb), background: style(thumb).backgroundColor } : null,
    label: { ...box(label), fontSize: style(label).fontSize, fontWeight: style(label).fontWeight, color: style(label).color },
  };
};
