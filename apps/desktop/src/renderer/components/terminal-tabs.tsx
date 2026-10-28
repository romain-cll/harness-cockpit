import { Columns2Icon, PlusIcon, Rows2Icon, XIcon } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { closeLiveTerminal, createLiveTerminal, type LiveTerminal } from '@/components/live-terminals';
import { PageHeader } from '@/components/page-header';
import { Terminal } from '@/components/terminal';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// A tab's terminals form a binary tree: each split divides its area in two equal halves.
type Layout = { terminal: number } | { direction: 'right' | 'down'; first: Layout; second: Layout };

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function leaves(layout: Layout): number[] {
  return 'terminal' in layout ? [layout.terminal] : [...leaves(layout.first), ...leaves(layout.second)];
}

function split(layout: Layout, target: number, direction: 'right' | 'down', added: number): Layout {
  if ('terminal' in layout) {
    return layout.terminal === target ? { direction, first: layout, second: { terminal: added } } : layout;
  }
  return {
    ...layout,
    first: split(layout.first, target, direction, added),
    second: split(layout.second, target, direction, added),
  };
}

/** The layout without that terminal, or null when it was the only one. */
function remove(layout: Layout, target: number): Layout | null {
  if ('terminal' in layout) return layout.terminal === target ? null : layout;
  const first = remove(layout.first, target);
  const second = remove(layout.second, target);
  return first && second ? { ...layout, first, second } : (first ?? second);
}

/** The terminal that takes the keyboard when that one closes: the first of its sibling's subtree. */
function siblingOf(layout: Layout, target: number): number | undefined {
  if ('terminal' in layout) return undefined;
  if ('terminal' in layout.first && layout.first.terminal === target) return leaves(layout.second)[0];
  if ('terminal' in layout.second && layout.second.terminal === target) return leaves(layout.first)[0];
  return siblingOf(layout.first, target) ?? siblingOf(layout.second, target);
}

/** The area of each terminal, in percent of the tab's area. */
function boxes(layout: Layout, box: Box = { left: 0, top: 0, width: 100, height: 100 }): Array<[number, Box]> {
  if ('terminal' in layout) return [[layout.terminal, box]];
  const { left, top, width, height } = box;
  if (layout.direction === 'right') {
    const half = width / 2;
    return [...boxes(layout.first, { left, top, width: half, height }), ...boxes(layout.second, { left: left + half, top, width: half, height })];
  }
  const half = height / 2;
  return [...boxes(layout.first, { left, top, width, height: half }), ...boxes(layout.second, { left, top: top + half, width, height: half })];
}

interface Tab {
  /** Shown as "Terminal N"; never reused on a visit, so it also identifies the tab. */
  number: number;
  layout: Layout;
  /** The terminal that gets the keyboard when the tab is shown. */
  focused: number;
}

interface State {
  tabs: Tab[];
  selected: number | null;
  nextNumber: number;
  nextTerminal: number;
}

type Action =
  | { type: 'open' }
  | { type: 'select'; tab: number }
  | { type: 'close-tab'; tab: number }
  | { type: 'split'; tab: number; terminal: number; direction: 'right' | 'down' }
  | { type: 'close-terminal'; tab: number; terminal: number }
  | { type: 'focus'; tab: number; terminal: number };

const initial: State = { tabs: [{ number: 1, layout: { terminal: 1 }, focused: 1 }], selected: 1, nextNumber: 2, nextTerminal: 2 };

function closeTab(state: State, number: number): State {
  const index = state.tabs.findIndex((tab) => tab.number === number);
  const tabs = state.tabs.filter((tab) => tab.number !== number);
  // The selection moves to the tab on the left, or to the new first one.
  const selected = state.selected === number ? (tabs[Math.max(index - 1, 0)]?.number ?? null) : state.selected;
  return { ...state, tabs, selected };
}

function reduce(state: State, action: Action): State {
  const update = (number: number, change: (tab: Tab) => Tab): State => ({
    ...state,
    tabs: state.tabs.map((tab) => (tab.number === number ? change(tab) : tab)),
  });

  switch (action.type) {
    case 'open':
      return {
        tabs: [...state.tabs, { number: state.nextNumber, layout: { terminal: state.nextTerminal }, focused: state.nextTerminal }],
        selected: state.nextNumber,
        nextNumber: state.nextNumber + 1,
        nextTerminal: state.nextTerminal + 1,
      };
    case 'select':
      return { ...state, selected: action.tab };
    case 'close-tab':
      return closeTab(state, action.tab);
    case 'split':
      return {
        ...update(action.tab, (tab) => ({
          ...tab,
          layout: split(tab.layout, action.terminal, action.direction, state.nextTerminal),
          focused: state.nextTerminal,
        })),
        nextTerminal: state.nextTerminal + 1,
      };
    case 'close-terminal': {
      const tab = state.tabs.find((candidate) => candidate.number === action.tab);
      const layout = tab && remove(tab.layout, action.terminal);
      if (!layout) return closeTab(state, action.tab);
      return update(action.tab, (current) => ({
        ...current,
        layout,
        focused: current.focused === action.terminal ? siblingOf(tab.layout, action.terminal)! : current.focused,
      }));
    }
    case 'focus':
      return update(action.tab, (tab) => ({ ...tab, focused: action.terminal }));
  }
}

// The page's state outlives the page: it lives at module level, so leaving the
// Terminal page and coming back finds the tabs as they were, and only a reload starts
// over. Numbers and terminal ids therefore count for the page's lifetime.
let state = initial;
const listeners = new Set<() => void>();
// The terminal of each pane, created when the pane first renders.
const panes = new Map<number, LiveTerminal>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const getState = () => state;

const terminalIds = ({ tabs }: State) => tabs.flatMap((tab) => leaves(tab.layout));

// The terminals an action removes are closed: their shells end.
function dispatch(action: Action) {
  const next = reduce(state, action);
  const kept = new Set(terminalIds(next));
  for (const id of terminalIds(state)) {
    const pane = panes.get(id);
    if (pane && !kept.has(id)) {
      closeLiveTerminal(pane);
      panes.delete(id);
    }
  }
  state = next;
  for (const listener of listeners) listener();
}

function paneTerminal(id: number): LiveTerminal {
  let pane = panes.get(id);
  if (!pane) {
    const { entry, started } = createLiveTerminal(({ cols, rows }) => window.api.pty.spawn({ cols, rows }));
    started.catch((error: unknown) => {
      // The pane may have been closed (its terminal disposed) before the spawn rejected.
      if (panes.get(id) !== entry) return;
      entry.term.write(`\r\n[Could not start the shell: ${error instanceof Error ? error.message : error}]`);
    });
    pane = entry;
    panes.set(id, pane);
  }
  return pane;
}

/**
 * Shows the shells the page attached to again (`restoreTerminals`), one tab each, in the order given:
 * no layout is saved, so a split comes back as two tabs. Tabs of a page that has none yet are
 * replaced; otherwise the new ones follow the tabs it has.
 */
export function restoreTabs(shells: LiveTerminal[]) {
  if (shells.length === 0) return;
  let next: State = panes.size === 0 ? { tabs: [], selected: null, nextNumber: 1, nextTerminal: 1 } : state;
  for (const shell of shells) {
    const { nextNumber, nextTerminal } = next;
    panes.set(nextTerminal, shell);
    next = {
      tabs: [...next.tabs, { number: nextNumber, layout: { terminal: nextTerminal }, focused: nextTerminal }],
      selected: next.selected ?? nextNumber,
      nextNumber: nextNumber + 1,
      nextTerminal: nextTerminal + 1,
    };
  }
  state = next;
  for (const listener of listeners) listener();
}

function PaneButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick}>
      {children}
    </Button>
  );
}

// The terminal page: tabs in the page header, each tab a tree of split terminals.
// Every terminal of every tab sits in one flat list keyed by its id and is placed
// by its box, so splitting, closing a neighbour or switching tab never remounts a
// view. The terminals of other tabs are hidden.
export function TerminalTabs() {
  const { tabs, selected } = useSyncExternalStore(subscribe, getState);

  return (
    <>
      <PageHeader title="Terminal">
        <Tabs value={selected} onValueChange={(tab: number) => dispatch({ type: 'select', tab })}>
          <TabsList>
            {tabs.map(({ number }) => (
              <div key={number} className="relative h-full">
                <TabsTrigger value={number} className="pr-6">
                  Terminal {number}
                </TabsTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Close Terminal ${number}`}
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                  onClick={() => dispatch({ type: 'close-tab', tab: number })}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
          </TabsList>
        </Tabs>
        <Button variant="ghost" size="icon" aria-label="New terminal" onClick={() => dispatch({ type: 'open' })}>
          <PlusIcon />
        </Button>
      </PageHeader>
      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
            <p>No terminal open</p>
            <Button variant="outline" onClick={() => dispatch({ type: 'open' })}>
              New terminal
            </Button>
          </div>
        )}
        {tabs.flatMap((tab) =>
          boxes(tab.layout).map(([terminal, { left, top, width, height }]) => {
            const shown = tab.number === selected;
            return (
              <div
                key={terminal}
                className={`group/pane absolute ${shown ? '' : 'invisible'}`}
                style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                onFocus={() => dispatch({ type: 'focus', tab: tab.number, terminal })}
              >
                <Terminal live={paneTerminal(terminal)} focused={shown && tab.focused === terminal} />
                {/* Not rendered in a hidden tab: the buttons' own transition would keep them clickable for a moment. */}
                {shown && (
                  <div className="absolute top-1 right-3 flex gap-0.5 opacity-0 group-focus-within/pane:opacity-100 group-hover/pane:opacity-100">
                    <PaneButton label="Split right" onClick={() => dispatch({ type: 'split', tab: tab.number, terminal, direction: 'right' })}>
                      <Columns2Icon />
                    </PaneButton>
                    <PaneButton label="Split down" onClick={() => dispatch({ type: 'split', tab: tab.number, terminal, direction: 'down' })}>
                      <Rows2Icon />
                    </PaneButton>
                    <PaneButton label="Close terminal" onClick={() => dispatch({ type: 'close-terminal', tab: tab.number, terminal })}>
                      <XIcon />
                    </PaneButton>
                  </div>
                )}
              </div>
            );
          }),
        )}
      </div>
    </>
  );
}
