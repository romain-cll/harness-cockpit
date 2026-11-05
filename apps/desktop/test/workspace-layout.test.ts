import { describe, expect, test } from 'vitest';
import {
  addTab,
  boxes,
  clampRatio,
  closeTab,
  separators,
  setRatio,
  singlePane,
  split,
  stoppedMessage,
  tabLabel,
  workspaceStatus,
  type Layout,
} from '../src/renderer/components/workspace-layout';

// COCKPIT-70: the pure part of the workspace page. A layout is a tree: a pane (`{ id, tabs, selected }`,
// the tabs being terminal keys) or a split (`{ direction, first, second }`, `first` being the left or
// top half). The module imports nothing through `@/`.

const pane = (id: string, tabs: string[], selected: string | null = tabs[0] ?? null): Layout => ({ id, tabs, selected });

describe('addTab', () => {
  test('AC10, AC11 — a new tab goes at the end of the pane and is selected', () => {
    expect(addTab(singlePane('p1', ['a', 'b']), 'p1', 'c')).toEqual(pane('p1', ['a', 'b', 'c'], 'c'));
  });

  test('AC1 — a pane with no tab takes one', () => {
    expect(addTab(singlePane('p1', []), 'p1', 'a')).toEqual(pane('p1', ['a'], 'a'));
  });
});

describe('singlePane', () => {
  test('AC19 — the restored terminals are the tabs of one pane, in the order given, the first selected', () => {
    expect(singlePane('p1', ['s1', 's2', 's3'])).toEqual(pane('p1', ['s1', 's2', 's3'], 's1'));
    expect(singlePane('p1', [])).toEqual(pane('p1', [], null));
  });
});

describe('split', () => {
  test('AC14 — "Split right" keeps the tabs on the left and puts one new selected tab in a new pane on the right', () => {
    const layout = split(singlePane('p1', ['a', 'b']), 'p1', 'right', 'p2', 'c');
    expect(layout).toEqual({ direction: 'right', ratio: 0.5, first: pane('p1', ['a', 'b']), second: pane('p2', ['c'], 'c') });
    expect(boxes(layout)).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 50, height: 100 },
      { pane: 'p2', left: 50, top: 0, width: 50, height: 100 },
    ]);
  });

  test('AC14 — "Split down" puts the new pane at the bottom, in two halves of equal height', () => {
    const layout = split(singlePane('p1', ['a']), 'p1', 'down', 'p2', 'b');
    expect(layout).toMatchObject({ direction: 'down' });
    expect(boxes(layout)).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 100, height: 50 },
      { pane: 'p2', left: 0, top: 50, width: 100, height: 50 },
    ]);
  });

  test('AC14 — splits nest: a split of a pane of a split halves only that pane', () => {
    const right = split(singlePane('p1', ['a']), 'p1', 'right', 'p2', 'b');
    const layout = split(right, 'p2', 'down', 'p3', 'c');
    expect(boxes(layout)).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 50, height: 100 },
      { pane: 'p2', left: 50, top: 0, width: 50, height: 50 },
      { pane: 'p3', left: 50, top: 50, width: 50, height: 50 },
    ]);
    const deeper = split(layout, 'p3', 'right', 'p4', 'd');
    expect(boxes(deeper).slice(2)).toEqual([
      { pane: 'p3', left: 50, top: 50, width: 25, height: 50 },
      { pane: 'p4', left: 75, top: 50, width: 25, height: 50 },
    ]);
  });
});

describe('closeTab', () => {
  test('AC16 — closing the selected tab selects the one on its left, which takes the keyboard', () => {
    const layout = pane('p1', ['a', 'b', 'c'], 'b');
    expect(closeTab(layout, 'p1', 'b')).toEqual({ layout: pane('p1', ['a', 'c'], 'a'), focus: { pane: 'p1', tab: 'a' } });
  });

  test('AC16 — closing the first tab selects the new first one', () => {
    const layout = pane('p1', ['a', 'b', 'c'], 'a');
    expect(closeTab(layout, 'p1', 'a')).toEqual({ layout: pane('p1', ['b', 'c'], 'b'), focus: { pane: 'p1', tab: 'b' } });
  });

  test('AC16 — closing the selected last tab selects the new last one', () => {
    const layout = pane('p1', ['a', 'b', 'c'], 'c');
    expect(closeTab(layout, 'p1', 'c')).toEqual({ layout: pane('p1', ['a', 'b'], 'b'), focus: { pane: 'p1', tab: 'b' } });
  });

  test("AC16 — the last tab of a pane removes the pane: its sibling fills the area and its first terminal takes the keyboard", () => {
    // p1 | (p2 / p3)
    const layout: Layout = {
      direction: 'right',
      ratio: 0.5,
      first: pane('p1', ['a']),
      second: { direction: 'down', ratio: 0.5, first: pane('p2', ['b', 'c'], 'c'), second: pane('p3', ['d']) },
    };

    // The left pane goes: the sibling subtree fills the window, the keyboard goes to its first pane's selected tab.
    const left = closeTab(layout, 'p1', 'a');
    expect(left.layout).toEqual({ direction: 'down', ratio: 0.5, first: pane('p2', ['b', 'c'], 'c'), second: pane('p3', ['d']) });
    expect(left.focus).toEqual({ pane: 'p2', tab: 'c' });
    expect(boxes(left.layout)).toEqual([
      { pane: 'p2', left: 0, top: 0, width: 100, height: 50 },
      { pane: 'p3', left: 0, top: 50, width: 100, height: 50 },
    ]);

    // The bottom pane goes: its sibling pane takes the freed area and the keyboard.
    const bottom = closeTab(layout, 'p3', 'd');
    expect(bottom.layout).toEqual({ direction: 'right', ratio: 0.5, first: pane('p1', ['a']), second: pane('p2', ['b', 'c'], 'c') });
    expect(bottom.focus).toEqual({ pane: 'p2', tab: 'c' });
    expect(boxes(bottom.layout)).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 50, height: 100 },
      { pane: 'p2', left: 50, top: 0, width: 50, height: 100 },
    ]);
  });

  test('AC16 — when the removed pane was the second half, a sibling that is a split gives the keyboard to its first pane', () => {
    // (p1 / p2) | p3: closing p3's last tab leaves p1 / p2, and the keyboard goes to p1.
    const layout: Layout = {
      direction: 'right',
      ratio: 0.5,
      first: { direction: 'down', ratio: 0.5, first: pane('p1', ['a']), second: pane('p2', ['b']) },
      second: pane('p3', ['c']),
    };
    const closed = closeTab(layout, 'p3', 'c');
    expect(closed.layout).toEqual({ direction: 'down', ratio: 0.5, first: pane('p1', ['a']), second: pane('p2', ['b']) });
    expect(closed.focus).toEqual({ pane: 'p1', tab: 'a' });
  });

  test('AC16 — the last tab of the only pane leaves an empty pane, and nothing takes the keyboard', () => {
    expect(closeTab(pane('p1', ['a']), 'p1', 'a')).toEqual({ layout: pane('p1', [], null), focus: null });
  });
});

describe('tabLabel', () => {
  test('AC7 — drops the leading characters that are neither letters nor digits, and the whitespace after them', () => {
    expect(tabLabel('✳ Fix the tests', 'Claude Code 1')).toBe('Fix the tests');
    expect(tabLabel('⠂ Working', 'Claude Code 1')).toBe('Working');
    expect(tabLabel('~/code/app', 'Terminal')).toBe('code/app');
  });

  test('AC7 — keeps a title that starts with a letter or a digit, accents included, as it is', () => {
    expect(tabLabel('Fix the tests ✳', 'Terminal')).toBe('Fix the tests ✳');
    expect(tabLabel('42 files changed', 'Terminal')).toBe('42 files changed');
    expect(tabLabel('Édition du fichier', 'Terminal')).toBe('Édition du fichier');
  });

  test('AC7 — falls back with no title, an empty one, or one that is empty once stripped', () => {
    expect(tabLabel(undefined, 'Terminal')).toBe('Terminal');
    expect(tabLabel('', 'Claude Code 1')).toBe('Claude Code 1');
    expect(tabLabel('  ', 'Claude Code 1')).toBe('Claude Code 1');
    expect(tabLabel('✳ ', 'Claude Code 1')).toBe('Claude Code 1');
    expect(tabLabel('***', 'Terminal')).toBe('Terminal');
  });
});

describe('workspaceStatus', () => {
  test('AC3 — the most urgent status wins: Needs input, Working, Ready, Exited N, Ended', () => {
    expect(workspaceStatus(['Ended', 'Exited 3', 'Ready', 'Working', 'Needs input'])).toBe('Needs input');
    expect(workspaceStatus(['Ended', 'Exited 3', 'Ready', 'Working'])).toBe('Working');
    expect(workspaceStatus(['Ended', 'Exited 3', 'Ready'])).toBe('Ready');
    expect(workspaceStatus(['Ended', 'Exited 3'])).toBe('Exited 3');
    expect(workspaceStatus(['Ended'])).toBe('Ended');
  });

  test('AC3 — the order of the sessions does not matter', () => {
    expect(workspaceStatus(['Needs input', 'Working'])).toBe('Needs input');
    expect(workspaceStatus(['Working', 'Needs input'])).toBe('Needs input');
    expect(workspaceStatus(['Ended', 'Exited 7'])).toBe('Exited 7');
  });

  test('AC3 — no session, or none with a status, gives none', () => {
    expect(workspaceStatus([])).toBeNull();
  });
});

// COCKPIT-45: resizing splits by dragging. The contract of the new pure helpers:
//  - every split has a `ratio`, the share of `first` along its axis (0.5 from `split()`), used by `boxes()`;
//  - `separators(layout)` lists one entry per split, the root first, then the splits of `first`, then those of `second`:
//    `{ path, direction, box, position }`. `path` identifies the split (an opaque value handed back to `setRatio` and
//    `clampRatio`), `box` is the split's area `{ left, top, width, height }` and `position` where its separator sits,
//    all in percent of the workspace's area (`position` is a `left` for a right split, a `top` for a down one);
//  - `setRatio(layout, path, ratio)` returns the layout with that split's ratio changed, nothing else;
//  - `clampRatio(layout, path, ratio, area, floor)` returns `ratio` moved into the range where every pane on both
//    sides of the split is at least `floor` px along the split's axis (wide for a right split, tall for a down
//    one), `area` being the workspace's `{ width, height }` in px; when no ratio gives that to both sides, the
//    split's current ratio.

const rounded = (list: { pane: string; left: number; top: number; width: number; height: number }[]) =>
  list.map((each) => ({ ...each, left: +each.left.toFixed(6), top: +each.top.toFixed(6), width: +each.width.toFixed(6), height: +each.height.toFixed(6) }));

const AREA = { width: 1000, height: 600 };

/** The layout with the ratio of its `index`th split (in `separators` order) set. */
const resize = (layout: Layout, index: number, ratio: number) => setRatio(layout, separators(layout)[index]!.path, ratio);

/** `p1 | (p2 / p3)`. */
const nested = () => split(split(singlePane('p1', ['a']), 'p1', 'right', 'p2', 'b'), 'p2', 'down', 'p3', 'c');

describe('boxes with a ratio', () => {
  test('AC1 — a right split at 0.7 gives 70% of the width to the left pane and 30% to the right one', () => {
    const layout = resize(split(singlePane('p1', ['a']), 'p1', 'right', 'p2', 'b'), 0, 0.7);
    expect(rounded(boxes(layout))).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 70, height: 100 },
      { pane: 'p2', left: 70, top: 0, width: 30, height: 100 },
    ]);
  });

  test('AC2 — a down split at 0.3 gives 30% of the height to the top pane and 70% to the bottom one', () => {
    const layout = resize(split(singlePane('p1', ['a']), 'p1', 'down', 'p2', 'b'), 0, 0.3);
    expect(rounded(boxes(layout))).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 100, height: 30 },
      { pane: 'p2', left: 0, top: 30, width: 100, height: 70 },
    ]);
  });
});

describe('separators', () => {
  test('AC4 — one separator per split, the root first, with its direction, its split\'s box and its position in percent', () => {
    const list = separators(nested());
    expect(list).toHaveLength(2);
    expect(list.map(({ direction }) => direction)).toEqual(['right', 'down']);
    expect(list[0]).toMatchObject({ box: { left: 0, top: 0, width: 100, height: 100 }, position: 50 });
    expect(list[1]).toMatchObject({ box: { left: 50, top: 0, width: 50, height: 100 }, position: 50 });
    expect(separators(singlePane('p1', ['a']))).toEqual([]);
  });

  test('AC4 — the separator of a nested split moves with its area and keeps its proportion when the outer separator is dragged', () => {
    const layout = resize(nested(), 1, 0.25);
    expect(separators(layout)[1]).toMatchObject({ box: { left: 50, top: 0, width: 50, height: 100 }, position: 25 });
    const dragged = resize(layout, 0, 0.7);
    expect(separators(dragged)[0]).toMatchObject({ position: 70 });
    expect(separators(dragged)[1]).toMatchObject({ box: { left: 70, top: 0, width: 30, height: 100 }, position: 25 });
  });
});

describe('setRatio', () => {
  test('AC4 — dragging the root separator resizes the panes on both sides; the nested split keeps its ratio', () => {
    const layout = resize(nested(), 0, 0.7);
    expect(rounded(boxes(layout))).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 70, height: 100 },
      { pane: 'p2', left: 70, top: 0, width: 30, height: 50 },
      { pane: 'p3', left: 70, top: 50, width: 30, height: 50 },
    ]);
  });

  test('AC4 — dragging the nested separator changes only the panes of that split', () => {
    const layout = resize(nested(), 1, 0.8);
    expect(rounded(boxes(layout))).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 50, height: 100 },
      { pane: 'p2', left: 50, top: 0, width: 50, height: 80 },
      { pane: 'p3', left: 50, top: 80, width: 50, height: 20 },
    ]);
  });

  test('AC6 — setting 0.5 brings a resized split back to equal halves', () => {
    const resized = resize(nested(), 0, 0.7);
    expect(rounded(boxes(resize(resized, 0, 0.5)))).toEqual(rounded(boxes(nested())));
  });
});

describe('clampRatio', () => {
  const right = () => split(singlePane('p1', ['a']), 'p1', 'right', 'p2', 'b');
  const down = () => split(singlePane('p1', ['a']), 'p1', 'down', 'p2', 'b');
  const clamp = (layout: Layout, index: number, ratio: number, area = AREA, floor = 160) =>
    clampRatio(layout, separators(layout)[index]!.path, ratio, area, floor);

  test('AC5 — a ratio that leaves both panes at least the floor is unchanged', () => {
    expect(clamp(right(), 0, 0.7)).toBeCloseTo(0.7, 6);
    expect(clamp(right(), 0, 0.16)).toBeCloseTo(0.16, 6);
    expect(clamp(right(), 0, 0.84)).toBeCloseTo(0.84, 6);
  });

  test('AC5 — a right split stops where a pane would be narrower than 160 px', () => {
    expect(clamp(right(), 0, 0.99)).toBeCloseTo(0.84, 6);
    expect(clamp(right(), 0, 0.01)).toBeCloseTo(0.16, 6);
    expect(clamp(right(), 0, -3)).toBeCloseTo(0.16, 6);
    expect(clamp(right(), 0, 7)).toBeCloseTo(0.84, 6);
  });

  test('AC5 — a down split stops where a pane would be shorter than 100 px', () => {
    expect(clamp(down(), 0, 0.99, AREA, 100)).toBeCloseTo(1 - 100 / 600, 6);
    expect(clamp(down(), 0, 0.01, AREA, 100)).toBeCloseTo(100 / 600, 6);
    expect(clamp(down(), 0, 0.4, AREA, 100)).toBeCloseTo(0.4, 6);
  });

  test('AC5 — the floor applies to every pane of a nested side: the smaller nested pane reaches it first', () => {
    // p1 | (p2 | p3) with p2 a quarter of the right side: dragging right, p2 (0.25 × the right side) is the first to reach 160 px.
    const layout = resize(split(right(), 'p2', 'right', 'p3', 'c'), 1, 0.25);
    expect(clamp(layout, 0, 0.99)).toBeCloseTo(0.36, 6);
    // Dragging left, p1 is alone on its side.
    expect(clamp(layout, 0, 0.01)).toBeCloseTo(0.16, 6);
  });

  test('AC5 — a nested side in the other direction does not change the floor of the dragged split', () => {
    // p1 | (p2 / p3): the panes on the right are as wide as the right side.
    expect(clamp(nested(), 0, 0.99)).toBeCloseTo(0.84, 6);
    // The nested down split has the whole height: the floor is 100 px of 600.
    expect(clamp(nested(), 1, 0.99, AREA, 100)).toBeCloseTo(1 - 100 / 600, 6);
  });

  test('AC5 — a nested split is clamped against its own box, not against the workspace area', () => {
    // p1 | (p2 | p3): the nested split is 500 px wide, each of its panes keeps 160 px of them.
    const layout = split(right(), 'p2', 'right', 'p3', 'c');
    expect(clamp(layout, 1, 0.99)).toBeCloseTo(1 - 160 / 500, 6);
    expect(clamp(layout, 1, 0.01)).toBeCloseTo(160 / 500, 6);
  });

  test('AC5 — when the area cannot give the floor to both sides the ratio does not change', () => {
    const resized = resize(right(), 0, 0.6);
    expect(clamp(resized, 0, 0.9, { width: 300, height: 600 })).toBe(0.6);
    expect(clamp(resized, 0, 0.1, { width: 319, height: 600 })).toBe(0.6);
    const tall = resize(down(), 0, 0.3);
    expect(clamp(tall, 0, 0.9, { width: 1000, height: 199 }, 100)).toBe(0.3);
  });

  test('AC6 — equal halves are clamped as well: 0.5 moves into the range a nested side leaves', () => {
    // p1 | (p2 | p3) over 600 px: the right side holds two panes of at least 160 px, so p1 can have at most 280 px.
    const layout = resize(split(right(), 'p2', 'right', 'p3', 'c'), 0, 0.9);
    expect(clamp(layout, 0, 0.5, { width: 600, height: 600 })).toBeCloseTo(1 - 320 / 600, 6);
    expect(clamp(layout, 0, 0.5)).toBeCloseTo(0.5, 6);
  });
});

describe('split and closeTab keep the ratios', () => {
  const resized = () => resize(split(singlePane('p1', ['a']), 'p1', 'right', 'p2', 'b'), 0, 0.7);

  test('AC8 — splitting the right pane of a 0.7 split halves that pane and keeps the left one', () => {
    const layout = split(resized(), 'p2', 'down', 'p3', 'c');
    expect(rounded(boxes(layout))).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 70, height: 100 },
      { pane: 'p2', left: 70, top: 0, width: 30, height: 50 },
      { pane: 'p3', left: 70, top: 50, width: 30, height: 50 },
    ]);
    expect(separators(layout)[0]).toMatchObject({ position: 70 });
  });

  test('AC8 — splitting the left pane of a 0.7 split divides the 70% in two halves and keeps the right pane', () => {
    const layout = split(resized(), 'p1', 'right', 'p3', 'c');
    expect(rounded(boxes(layout))).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 35, height: 100 },
      { pane: 'p3', left: 35, top: 0, width: 35, height: 100 },
      { pane: 'p2', left: 70, top: 0, width: 30, height: 100 },
    ]);
  });

  test('AC8 — closing the last tab of a pane gives its whole area to its sibling and leaves the other separators where they were', () => {
    // p1 | (p2 / (p3 | p4)) with the separators at 60%, 40% and 30%.
    let layout = split(split(split(singlePane('p1', ['a']), 'p1', 'right', 'p2', 'b'), 'p2', 'down', 'p3', 'c'), 'p3', 'right', 'p4', 'd');
    layout = resize(resize(resize(layout, 0, 0.6), 1, 0.4), 2, 0.3);

    // The middle pane goes: the inner split takes the whole right side, its separator stays at 30% of it.
    const noMiddle = closeTab(layout, 'p2', 'b').layout;
    expect(rounded(boxes(noMiddle))).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 60, height: 100 },
      { pane: 'p3', left: 60, top: 0, width: 12, height: 100 },
      { pane: 'p4', left: 72, top: 0, width: 28, height: 100 },
    ]);
    expect(separators(noMiddle)[0]).toMatchObject({ position: 60 });

    // A pane of the inner split goes: the middle pane keeps its 40% and the root its 60%.
    const noInner = closeTab(layout, 'p4', 'd').layout;
    expect(rounded(boxes(noInner))).toEqual([
      { pane: 'p1', left: 0, top: 0, width: 60, height: 100 },
      { pane: 'p2', left: 60, top: 0, width: 40, height: 40 },
      { pane: 'p3', left: 60, top: 40, width: 40, height: 60 },
    ]);
  });

  test('AC8 — closing the left pane of a resized split gives the whole area to the other one', () => {
    expect(rounded(boxes(closeTab(resized(), 'p1', 'a').layout))).toEqual([{ pane: 'p2', left: 0, top: 0, width: 100, height: 100 }]);
  });
});

describe('stoppedMessage', () => {
  test('AC2, AC3 — the banner reads "Background service stopped · N terminals ended", and "1 terminal ended" for a single one', () => {
    expect(stoppedMessage(3)).toBe('Background service stopped · 3 terminals ended');
    expect(stoppedMessage(2)).toBe('Background service stopped · 2 terminals ended');
    expect(stoppedMessage(1)).toBe('Background service stopped · 1 terminal ended');
  });
});
