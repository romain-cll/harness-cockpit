import { describe, expect, test } from 'vitest';
import {
  addTab,
  boxes,
  closeTab,
  singlePane,
  split,
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
    expect(layout).toEqual({ direction: 'right', first: pane('p1', ['a', 'b']), second: pane('p2', ['c'], 'c') });
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
      first: pane('p1', ['a']),
      second: { direction: 'down', first: pane('p2', ['b', 'c'], 'c'), second: pane('p3', ['d']) },
    };

    // The left pane goes: the sibling subtree fills the window, the keyboard goes to its first pane's selected tab.
    const left = closeTab(layout, 'p1', 'a');
    expect(left.layout).toEqual({ direction: 'down', first: pane('p2', ['b', 'c'], 'c'), second: pane('p3', ['d']) });
    expect(left.focus).toEqual({ pane: 'p2', tab: 'c' });
    expect(boxes(left.layout)).toEqual([
      { pane: 'p2', left: 0, top: 0, width: 100, height: 50 },
      { pane: 'p3', left: 0, top: 50, width: 100, height: 50 },
    ]);

    // The bottom pane goes: its sibling pane takes the freed area and the keyboard.
    const bottom = closeTab(layout, 'p3', 'd');
    expect(bottom.layout).toEqual({ direction: 'right', first: pane('p1', ['a']), second: pane('p2', ['b', 'c'], 'c') });
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
      first: { direction: 'down', first: pane('p1', ['a']), second: pane('p2', ['b']) },
      second: pane('p3', ['c']),
    };
    const closed = closeTab(layout, 'p3', 'c');
    expect(closed.layout).toEqual({ direction: 'down', first: pane('p1', ['a']), second: pane('p2', ['b']) });
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
