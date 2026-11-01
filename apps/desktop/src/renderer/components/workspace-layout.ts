// The pure part of the workspace page: the tree of panes, the tab labels and the status of a
// workspace's row. A pane holds tabs (terminal keys) and the selected one; a split divides its
// area in two equal halves. Nothing here imports through `@/`, so a vitest test imports it.

export interface Pane {
  id: string;
  tabs: string[];
  selected: string | null;
}

/** `first` is the left (`right`) or the top (`down`) half. */
export interface Split {
  direction: 'right' | 'down';
  first: Layout;
  second: Layout;
}

export type Layout = Pane | Split;

/** The area of a pane, in percent of the workspace's area. */
export interface PaneBox {
  pane: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

const isPane = (layout: Layout): layout is Pane => 'tabs' in layout;

/** One pane holding `tabs`, the first selected. */
export const singlePane = (id: string, tabs: string[]): Pane => ({ id, tabs: [...tabs], selected: tabs[0] ?? null });

/** The panes in reading order: left to right, top to bottom within a split. */
export function panesOf(layout: Layout): Pane[] {
  return isPane(layout) ? [layout] : [...panesOf(layout.first), ...panesOf(layout.second)];
}

function mapPane(layout: Layout, id: string, change: (pane: Pane) => Layout): Layout {
  if (isPane(layout)) return layout.id === id ? change(layout) : layout;
  return { ...layout, first: mapPane(layout.first, id, change), second: mapPane(layout.second, id, change) };
}

/** A new tab at the end of the pane, selected. */
export const addTab = (layout: Layout, pane: string, tab: string): Layout =>
  mapPane(layout, pane, (found) => ({ ...found, tabs: [...found.tabs, tab], selected: tab }));

export const selectTab = (layout: Layout, pane: string, tab: string): Layout =>
  mapPane(layout, pane, (found) => ({ ...found, selected: tab }));

/** The pane keeps its tabs; a new pane (after it) holds one selected tab. */
export const split = (layout: Layout, pane: string, direction: 'right' | 'down', newPane: string, tab: string): Layout =>
  mapPane(layout, pane, (found) => ({ direction, first: found, second: { id: newPane, tabs: [tab], selected: tab } }));

/** The tab that takes the keyboard when a tab closes. */
export interface Focus {
  pane: string;
  tab: string;
}

/** The layout without a pane, or null when it was the only one. */
function removePane(layout: Layout, id: string): Layout | null {
  if (isPane(layout)) return layout.id === id ? null : layout;
  const first = removePane(layout.first, id);
  const second = removePane(layout.second, id);
  return first && second ? { ...layout, first, second } : (first ?? second);
}

/** The sibling subtree that fills the area of the pane `id`. */
function siblingOf(layout: Layout, id: string): Layout | undefined {
  if (isPane(layout)) return undefined;
  if (isPane(layout.first) && layout.first.id === id) return layout.second;
  if (isPane(layout.second) && layout.second.id === id) return layout.first;
  return siblingOf(layout.first, id) ?? siblingOf(layout.second, id);
}

/**
 * Closes a tab. The selection moves to the tab on its left (the new first one when it was the
 * first); the last tab of a pane removes the pane, its sibling fills the area and its first pane's
 * selected tab takes the keyboard. `focus` is null when nothing takes it: a tab that was not
 * selected, or the last tab of the only pane (which stays, empty).
 */
export function closeTab(layout: Layout, paneId: string, tab: string): { layout: Layout; focus: Focus | null } {
  const pane = panesOf(layout).find(({ id }) => id === paneId);
  if (!pane?.tabs.includes(tab)) return { layout, focus: null };
  const tabs = pane.tabs.filter((each) => each !== tab);
  if (tabs.length === 0) {
    const sibling = siblingOf(layout, paneId);
    const remaining = removePane(layout, paneId);
    if (!sibling || !remaining) return { layout: { ...pane, tabs, selected: null }, focus: null };
    const first = panesOf(sibling)[0]!;
    return { layout: remaining, focus: first.selected === null ? null : { pane: first.id, tab: first.selected } };
  }
  if (pane.selected !== tab) return { layout: mapPane(layout, paneId, (found) => ({ ...found, tabs })), focus: null };
  const selected = tabs[Math.max(pane.tabs.indexOf(tab) - 1, 0)]!;
  return { layout: mapPane(layout, paneId, (found) => ({ ...found, tabs, selected })), focus: { pane: paneId, tab: selected } };
}

/** The area of each pane, in percent. */
export function boxes(layout: Layout, box: Omit<PaneBox, 'pane'> = { left: 0, top: 0, width: 100, height: 100 }): PaneBox[] {
  if (isPane(layout)) return [{ pane: layout.id, ...box }];
  const { left, top, width, height } = box;
  if (layout.direction === 'right') {
    const half = width / 2;
    return [...boxes(layout.first, { left, top, width: half, height }), ...boxes(layout.second, { left: left + half, top, width: half, height })];
  }
  const half = height / 2;
  return [...boxes(layout.first, { left, top, width, height: half }), ...boxes(layout.second, { left, top: top + half, width, height: half })];
}

/**
 * A tab's label: the title its program set, without the leading characters that are neither letters
 * nor digits (a spinner, `~`) and the whitespace after them; `fallback` when there is none.
 */
export function tabLabel(title: string | undefined, fallback: string): string {
  const label = title?.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return label || fallback;
}

// From the most to the least urgent.
const URGENCY = ['Needs input', 'Working', 'Ready'];

const rank = (label: string) => {
  const index = URGENCY.indexOf(label);
  if (index >= 0) return index;
  return label.startsWith('Exited') ? URGENCY.length : URGENCY.length + 1;
};

/** The most urgent of a workspace's sessions' status names (see `getSessionDots`), or null with none. */
export function workspaceStatus(labels: string[]): string | null {
  return labels.reduce<string | null>((best, label) => (best === null || rank(label) < rank(best) ? label : best), null);
}
