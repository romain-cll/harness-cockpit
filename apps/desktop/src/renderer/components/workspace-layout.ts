// The pure part of the workspace page: the tree of panes, the tab labels and the status of a
// workspace's row. A pane holds tabs (terminal keys) and the selected one; a split divides its
// area in two, `ratio` being the share of the first half. Nothing here imports through `@/`, so a vitest test imports it.

export interface Pane {
  id: string;
  tabs: string[];
  selected: string | null;
}

/** `first` is the left (`right`) or the top (`down`) half. */
export interface Split {
  direction: 'right' | 'down';
  /** The share of `first` along the split's axis: 0.5 from `split()`, moved by dragging its separator. */
  ratio: number;
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

/** A new tab at the end of the pane, selected; unchanged when a pane already holds the tab. */
export const addTab = (layout: Layout, pane: string, tab: string): Layout =>
  panesOf(layout).some(({ tabs }) => tabs.includes(tab))
    ? layout
    : mapPane(layout, pane, (found) => ({ ...found, tabs: [...found.tabs, tab], selected: tab }));

export const selectTab = (layout: Layout, pane: string, tab: string): Layout =>
  mapPane(layout, pane, (found) => ({ ...found, selected: tab }));

/** The pane keeps its tabs; a new pane (after it) holds one selected tab. */
export const split = (layout: Layout, pane: string, direction: 'right' | 'down', newPane: string, tab: string): Layout =>
  mapPane(layout, pane, (found) => ({ direction, ratio: 0.5, first: found, second: { id: newPane, tabs: [tab], selected: tab } }));

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
  const [first, second] = halves(layout, box);
  return [...boxes(layout.first, first), ...boxes(layout.second, second)];
}

type Box = Omit<PaneBox, 'pane'>;

/** The areas of a split's two halves inside the split's own box. */
function halves({ direction, ratio }: Split, { left, top, width, height }: Box): [Box, Box] {
  if (direction === 'right') {
    const firstWidth = width * ratio;
    return [
      { left, top, width: firstWidth, height },
      { left: left + firstWidth, top, width: width - firstWidth, height },
    ];
  }
  const firstHeight = height * ratio;
  return [
    { left, top, width, height: firstHeight },
    { left, top: top + firstHeight, width, height: height - firstHeight },
  ];
}

/** Where a split sits in the tree: 0 for `first`, 1 for `second`, from the root. Opaque to callers. */
export type SplitPath = readonly (0 | 1)[];

/** A split's separator: the split's box and the separator's position (a `left` for a right split, a `top` for a down one), in percent. */
export interface Separator {
  path: SplitPath;
  direction: Split['direction'];
  box: Box;
  position: number;
}

/** One separator per split: the root first, then the splits of `first`, then those of `second`. */
export function separators(layout: Layout, box: Box = { left: 0, top: 0, width: 100, height: 100 }, path: SplitPath = []): Separator[] {
  if (isPane(layout)) return [];
  const [first, second] = halves(layout, box);
  const position = layout.direction === 'right' ? box.left + box.width * layout.ratio : box.top + box.height * layout.ratio;
  return [
    { path, direction: layout.direction, box, position },
    ...separators(layout.first, first, [...path, 0]),
    ...separators(layout.second, second, [...path, 1]),
  ];
}

function splitAt(layout: Layout, path: SplitPath): Split {
  const found = path.reduce<Layout>((each, index) => (isPane(each) ? each : index === 0 ? each.first : each.second), layout);
  if (isPane(found)) throw new Error('No split at this path');
  return found;
}

/** The layout with the ratio of the split at `path` changed. */
export function setRatio(layout: Layout, path: SplitPath, ratio: number): Layout {
  if (isPane(layout)) return layout;
  const [index, ...rest] = path;
  if (index === undefined) return { ...layout, ratio };
  return index === 0 ? { ...layout, first: setRatio(layout.first, rest, ratio) } : { ...layout, second: setRatio(layout.second, rest, ratio) };
}

/**
 * `ratio` moved into the range where every pane on both sides of the split at `path` is at least
 * `floor` px along its axis; the split's current ratio when no ratio gives that to both sides.
 * `area` is the workspace's size in px.
 */
export function clampRatio(layout: Layout, path: SplitPath, ratio: number, area: { width: number; height: number }, floor: number): number {
  const target = splitAt(layout, path);
  const { box } = separators(layout).find((each) => each.path.join() === path.join())!;
  const right = target.direction === 'right';
  const size = (right ? area.width * box.width : area.height * box.height) / 100;
  // The smallest share of its side a pane takes along the axis.
  const smallest = (side: Layout) => Math.min(...boxes(side).map((each) => (right ? each.width : each.height) / 100));
  const lowest = floor / (size * smallest(target.first));
  const highest = 1 - floor / (size * smallest(target.second));
  return lowest > highest ? target.ratio : Math.min(Math.max(ratio, lowest), highest);
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

/** The banner of a page after the daemon died with `count` terminals. */
export const stoppedMessage = (count: number) => `Background service stopped · ${count} terminal${count === 1 ? '' : 's'} ended`;

/** The sentence of the dialog that offers to end the terminals of a daemon of another protocol. */
export const restartMessage = (count: number) => `Restarting it ends ${count === 1 ? 'this terminal' : `these ${count} terminals`}:`;
