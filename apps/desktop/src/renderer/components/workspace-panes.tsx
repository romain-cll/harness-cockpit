import { useRouter } from '@tanstack/react-router';
import { Columns2Icon, CopyIcon, PanelLeftOpenIcon, PlusIcon, Rows2Icon, SquareTerminalIcon, XIcon } from 'lucide-react';
import { useRef, useState, useSyncExternalStore } from 'react';
import type { Project, Session, StartSessionResult, Workspace } from '../../shared/api';
import { toggleSidebar, useSidebarCollapsed } from '@/components/collapsed';
import { HarnessIcon } from '@/components/harness-icon';
import {
  agentRuns,
  closeLiveTerminal,
  createLiveTerminal,
  endSessions,
  getSessionDots,
  getSessionTerminal,
  restoreTerminals,
  startSession,
  subscribe as subscribeTerminals,
  type LiveTerminal,
} from '@/components/live-terminals';
import { detectHarnesses, useDetectedHarnesses } from '@/components/start-session-menu';
import { Terminal } from '@/components/terminal';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { addTab, boxes, closeTab, panesOf, selectTab, singlePane, split, tabLabel, workspaceStatus, type Layout, type Pane, type PaneBox } from '@/components/workspace-layout';
import { cn } from 'cn';

// --- The store -------------------------------------------------------------------
//
// The panes of each workspace outlive its page: they live at module level, so leaving the workspace
// page (Home, another workspace) and coming back finds the panes, tabs, selections, outputs and
// processes as they were; only a reload starts over (the processes run on in the daemon and come back
// as the tabs of one pane, see `restoreFromDaemon`). A tab is a live terminal (`live-terminals.ts`),
// which a view only moves its element in and out of.

interface Tab {
  key: string;
  live: LiveTerminal;
  /** The label until the program sets a title: the session's name, or `Terminal`. */
  name: string;
  /** The title the program set (OSC 0 or 2), as it sent it. */
  title?: string;
  /** Set for an agent's tab. */
  session?: { id: string; harness: string };
}

interface View {
  layout: Layout;
  /** The pane the user last clicked or typed in: new tabs go there, and the keyboard with it. */
  focusedPane: string;
  /** Counts the times a terminal must take the keyboard again though nothing else changed. */
  request: number;
  tabs: ReadonlyMap<string, Tab>;
}

const views = new Map<string, View>();
const listeners = new Set<() => void>();
let counter = 0;
const nextId = (prefix: string) => `${prefix}${++counter}`;

function subscribeViews(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function commit(path: string, view: View) {
  views.set(path, view);
  for (const listener of listeners) listener();
}

/** The view of a workspace, one empty pane until it gets tabs. */
function viewOf(path: string): View {
  let view = views.get(path);
  if (!view) {
    const pane = nextId('p');
    view = { layout: singlePane(pane, []), focusedPane: pane, request: 0, tabs: new Map() };
    views.set(path, view);
  }
  return view;
}

// The requested pane, else the focused one, else the first.
function paneIn(view: View, requested?: string): string {
  const ids = panesOf(view.layout).map(({ id }) => id);
  return [requested, view.focusedPane].find((id) => id !== undefined && ids.includes(id)) ?? ids[0]!;
}

function setTitle(path: string, key: string, title: string) {
  const view = views.get(path);
  const tab = view?.tabs.get(key);
  if (view && tab) commit(path, { ...view, tabs: new Map(view.tabs).set(key, { ...tab, title }) });
}

// The tab's label follows the title its program sets.
const watchTitle = (path: string, { key, live }: Tab) => void live.term.onTitleChange((title) => setTitle(path, key, title));

function addToView(path: string, tab: Tab, pane?: string) {
  const view = viewOf(path);
  const target = paneIn(view, pane);
  watchTitle(path, tab);
  commit(path, {
    layout: addTab(view.layout, target, tab.key),
    focusedPane: target,
    request: view.request + 1,
    tabs: new Map(view.tabs).set(tab.key, tab),
  });
}

// A shell in the worktree; with `setup` it runs the repository's setup first. A tab with a terminal
// whose spawn is pending already takes keys.
function newShell(path: string, setup = false): Tab {
  const key = nextId('t');
  const { entry, started } = createLiveTerminal(({ cols, rows }) => window.api.pty.spawn({ cols, rows, workspace: path, ...(setup && { setup }) }));
  started.catch((error: unknown) => {
    // The tab may have been closed before the spawn rejected.
    if (views.get(path)?.tabs.get(key)?.live !== entry) return;
    entry.term.write(`\r\n[Could not start the shell: ${error instanceof Error ? error.message : error}]`);
  });
  return { key, live: entry, name: 'Terminal' };
}

/** A new shell tab at the end of the pane (the focused one by default), selected, with the keyboard. */
export function openShellTab(path: string, { pane, setup }: { pane?: string; setup?: boolean } = {}) {
  addToView(path, newShell(path, setup), pane);
}

/** The tab of a session the store holds, at the end of the pane (the focused one by default). */
export function addSessionTab(session: Session, pane?: string) {
  const live = getSessionTerminal(session.id);
  if (live) addToView(session.directory, { key: `s:${session.id}`, live, name: session.name, session: { id: session.id, harness: session.harness } }, pane);
}

function splitPane(path: string, pane: string, direction: 'right' | 'down') {
  const view = viewOf(path);
  const tab = newShell(path);
  const added = nextId('p');
  watchTitle(path, tab);
  commit(path, {
    layout: split(view.layout, pane, direction, added, tab.key),
    focusedPane: added,
    request: view.request + 1,
    tabs: new Map(view.tabs).set(tab.key, tab),
  });
}

function select(path: string, pane: string, key: string) {
  const view = viewOf(path);
  commit(path, { ...view, layout: selectTab(view.layout, pane, key), focusedPane: pane, request: view.request + 1 });
}

/** Gives the keyboard back to the focused terminal, once a menu that took it has closed. */
function refocus(path: string) {
  const view = viewOf(path);
  commit(path, { ...view, request: view.request + 1 });
}

function focusPane(path: string, pane: string) {
  const view = views.get(path);
  if (view && view.focusedPane !== pane) commit(path, { ...view, focusedPane: pane });
}

/** Shows the tab of a session (a clicked notification) and gives it the keyboard. */
export function selectSessionTab(path: string, sessionId: string) {
  const key = `s:${sessionId}`;
  const pane = panesOf(viewOf(path).layout).find(({ tabs }) => tabs.includes(key));
  if (pane) select(path, pane.id, key);
}

// Closes a tab at once: its process ends (a session stays stored).
function closeNow(path: string, pane: string, key: string) {
  const view = viewOf(path);
  const tab = view.tabs.get(key);
  if (!tab) return;
  if (tab.session) endSessions([tab.session.id]);
  else closeLiveTerminal(tab.live);
  const { layout, focus } = closeTab(view.layout, pane, key);
  const tabs = new Map(view.tabs);
  tabs.delete(key);
  commit(path, { layout, tabs, focusedPane: focus?.pane ?? view.focusedPane, request: focus ? view.request + 1 : view.request });
}

/** Ends every process of a workspace that is gone (deleted, or its project removed) and drops its tabs. */
export function closeWorkspace(path: string) {
  const view = views.get(path);
  if (!view) return;
  views.delete(path);
  for (const { live, session } of view.tabs.values()) {
    if (session) endSessions([session.id]);
    else closeLiveTerminal(live);
  }
  for (const listener of listeners) listener();
}

// The restore in progress: it waits for the daemon, which may be slow or stopped, so the page does not wait for it.
let restoring: Promise<void> | undefined;
let restoredOnce = false;

/** Settles once the terminals the page found at its load are shown again as tabs. */
export const whenRestored = () => restoring ?? Promise.resolve();

/** Whether the terminals the page found at its load are still being attached to. */
export const useRestoring = () => useSyncExternalStore(subscribeViews, () => restoring !== undefined);

/**
 * Attaches to the shells and sessions the daemons run and shows them again: the terminals of each
 * workspace, in creation order, as the tabs of one pane, the first selected. No layout is saved.
 */
export function restoreFromDaemon(again = false): Promise<void> {
  // Once per page load (the root loader runs again at every change).
  if (restoredOnce && !again) return whenRestored();
  restoredOnce = true;
  const run = restore(again).finally(() => {
    if (restoring === run) restoring = undefined;
    for (const listener of listeners) listener();
  });
  restoring = run;
  for (const listener of listeners) listener();
  return run;
}

async function restore(again: boolean): Promise<void> {
  const restored = await restoreTerminals(again);
  if (restored.length === 0) return;
  const sessions = restored.some(({ sessionId }) => sessionId !== undefined) ? await window.api.sessions.list() : [];
  for (const { entry, workspace, sessionId } of restored) {
    const session = sessions.find(({ id }) => id === sessionId);
    const view = viewOf(workspace);
    const first = panesOf(view.layout)[0]!;
    const key = sessionId === undefined ? nextId('t') : `s:${sessionId}`;
    const tab: Tab = {
      key,
      live: entry,
      name: sessionId === undefined ? 'Terminal' : (session?.name ?? 'Session'),
      ...(sessionId !== undefined && { session: { id: sessionId, harness: session?.harness ?? '' } }),
    };
    watchTitle(workspace, tab);
    const layout = addTab(view.layout, first.id, key);
    commit(workspace, { ...view, layout: selectTab(layout, first.id, first.selected ?? key), tabs: new Map(view.tabs).set(key, tab) });
  }
}

// --- The message slot and the row status --------------------------------------------

// Why the last add, start or deletion was refused; shown under the Projects header.
let message: string | undefined;
const messageListeners = new Set<() => void>();

export function setProjectsMessage(next?: string) {
  message = next;
  for (const listener of messageListeners) listener();
}

export const useProjectsMessage = () =>
  useSyncExternalStore(
    (listener) => {
      messageListeners.add(listener);
      return () => void messageListeners.delete(listener);
    },
    () => message,
  );

/** The accessible name of the most urgent status among the sessions the workspace's tabs hold, if any. */
export function useWorkspaceStatus(path: string): string | undefined {
  const view = useSyncExternalStore(subscribeViews, () => views.get(path));
  const dots = useSyncExternalStore(subscribeTerminals, getSessionDots);
  const labels = [...(view?.tabs.values() ?? [])].flatMap(({ session }) => (session && dots.get(session.id) ? [dots.get(session.id)!] : []));
  return workspaceStatus(labels) ?? undefined;
}

/** Starts a session in the workspace as a new tab of a pane; a refusal goes to the message slot. */
async function startInPane(project: string, path: string, harness: string, pane: string): Promise<StartSessionResult> {
  const result = await startSession(harness, { workspace: { project, path } });
  if (result.status === 'started') addSessionTab(result.session, pane);
  setProjectsMessage(result.status === 'refused' ? result.message : undefined);
  return result;
}

// --- The view --------------------------------------------------------------------

function NewTabMenu({ onHarness, onTerminal, onRefocus }: { onHarness: (harness: string) => void; onTerminal: () => void; onRefocus: () => void }) {
  const harnesses = useDetectedHarnesses();
  // Whether the menu started something: the new tab then keeps the keyboard, not the button.
  const started = useRef(false);
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          started.current = false;
          void detectHarnesses();
        } else if (started.current) {
          onRefocus();
        }
      }}
    >
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="New tab" className="app-no-drag shrink-0" />}>
        <PlusIcon />
      </DropdownMenuTrigger>
      {/* Gone as soon as it closes, with no exit animation: a menu that closed is never mistaken for the one that opens next. */}
      {open && (
        <DropdownMenuContent align="start" className="w-auto min-w-44" finalFocus={() => !started.current}>
          {harnesses === undefined && <DropdownMenuItem disabled>Detecting agent CLIs…</DropdownMenuItem>}
          {harnesses?.map((harness) => (
            <DropdownMenuItem
              key={harness.id}
              onClick={() => {
                started.current = true;
                onHarness(harness.id);
              }}
            >
              <HarnessIcon harness={harness.id} />
              {harness.name}
            </DropdownMenuItem>
          ))}
          {harnesses?.length === 0 && <DropdownMenuItem disabled>No agent CLI found</DropdownMenuItem>}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger delay={0}>Open harness</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {harnesses?.map((harness) => (
                <DropdownMenuItem
                  key={harness.id}
                  onClick={() => {
                    started.current = true;
                    onHarness(harness.id);
                  }}
                >
                  <HarnessIcon harness={harness.id} />
                  <span>{harness.name}</span> {harness.version && <span className="ml-auto pl-4 text-muted-foreground">{harness.version}</span>}
                </DropdownMenuItem>
              ))}
              {!!harnesses?.length && <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={() => void detectHarnesses(true)}>Detect again</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onClick={() => {
              started.current = true;
              onTerminal();
            }}
          >
            <SquareTerminalIcon />
            Terminal
          </DropdownMenuItem>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

const labelOf = ({ title, name }: Tab) => tabLabel(title, name);

function TabItem({
  tab,
  selected,
  onSelect,
  onSplit,
  onCopyPath,
  onClose,
  onRefocus,
}: {
  tab: Tab;
  selected: boolean;
  onSelect: () => void;
  onSplit: (direction: 'right' | 'down') => void;
  onCopyPath: () => void;
  onClose: () => void;
  onRefocus: () => void;
}) {
  const label = labelOf(tab);
  // Whether the menu moved the keyboard (a new pane, another tab): it then keeps it, not the tab.
  const moved = useRef(false);
  return (
    <ContextMenu
      onOpenChange={(open) => open && (moved.current = false)}
      onOpenChangeComplete={(open) => !open && moved.current && onRefocus()}
    >
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              'group/tab app-no-drag flex h-7 max-w-[200px] min-w-0 items-center gap-1 rounded-md border border-sidebar-accent pr-1 pl-2 text-xs',
              selected ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          />
        }
      >
        <button
          type="button"
          role="tab"
          aria-selected={selected}
          title={label}
          onClick={onSelect}
          className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 text-left outline-none focus-visible:underline"
        >
          {tab.session ? <HarnessIcon harness={tab.session.harness} className="size-3.5 shrink-0" /> : <SquareTerminalIcon className="size-3.5 shrink-0" />}
          <span className="min-w-0 truncate">{label}</span>
        </button>
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={onClose}
          className={cn(
            'flex size-4 shrink-0 cursor-default items-center justify-center rounded-sm hover:bg-hover focus-visible:opacity-100',
            selected ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100',
          )}
        >
          <XIcon className="size-3" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-auto" finalFocus={() => !moved.current}>
        <ContextMenuItem
          onClick={() => {
            moved.current = true;
            onSplit('right');
          }}
        >
          <Columns2Icon />
          Split right
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            moved.current = true;
            onSplit('down');
          }}
        >
          <Rows2Icon />
          Split down
        </ContextMenuItem>
        <ContextMenuItem onClick={onCopyPath}>
          <CopyIcon />
          Copy path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            moved.current = true;
            onClose();
          }}
        >
          <XIcon />
          Close tab
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// A pane: its tab bar, and the terminals of its tabs stacked under it, only the selected one visible.
// The panes of a workspace sit in one flat list keyed by id and are placed by their box, so splitting
// or closing a neighbour never remounts a pane, and the terminals of unselected tabs keep their size.
function PaneView({
  project,
  workspace,
  view,
  pane,
  box,
  sidebarHidden,
  waiting,
  onClose,
}: {
  project: Project;
  workspace: Workspace;
  view: View;
  pane: Pane;
  box: PaneBox;
  sidebarHidden: boolean;
  /** The terminals of the previous page are being shown again: no empty state yet. */
  waiting: boolean;
  onClose: (pane: string, tab: Tab) => void;
}) {
  const router = useRouter();
  const path = workspace.path;
  const top = box.top === 0;
  return (
    <div
      className={cn('absolute flex flex-col gap-1 border-border p-2', box.left > 0 && 'border-l', box.top > 0 && 'border-t')}
      style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
      onFocus={() => focusPane(path, pane.id)}
    >
      <div className={cn('flex h-7 shrink-0 items-center select-none', top && 'app-drag')}>
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1">
          {/* Room for the window controls and the button that shows the sidebar. */}
          {top && box.left === 0 && sidebarHidden && <div className="w-[88px] shrink-0" />}
          {pane.tabs.map((key) => {
            const tab = view.tabs.get(key)!;
            return (
              <TabItem
                key={key}
                tab={tab}
                selected={key === pane.selected}
                onSelect={() => select(path, pane.id, key)}
                onSplit={(direction) => splitPane(path, pane.id, direction)}
                onCopyPath={() => void navigator.clipboard.writeText(path)}
                onClose={() => onClose(pane.id, tab)}
                onRefocus={() => refocus(path)}
              />
            );
          })}
          <NewTabMenu
            onHarness={(harness) => void startInPane(project.path, path, harness, pane.id).then(() => router.invalidate())}
            onTerminal={() => openShellTab(path, { pane: pane.id })}
            onRefocus={() => refocus(path)}
          />
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {pane.tabs.length === 0 && !waiting && <p className="flex h-full items-center justify-center text-xs text-muted-foreground">No tab open</p>}
        {pane.tabs.map((key) => (
          <div key={key} className={cn('absolute inset-0', key !== pane.selected && 'invisible')}>
            <Terminal live={view.tabs.get(key)!.live} focused={pane.id === view.focusedPane && key === pane.selected} request={view.request} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The panes of a workspace: tab bars in the top row of the window, the terminals under them. */
export function WorkspacePanes({ project, workspace }: { project: Project; workspace: Workspace }) {
  const view = useSyncExternalStore(subscribeViews, () => viewOf(workspace.path));
  const waiting = useRestoring();
  const sidebarHidden = useSidebarCollapsed();
  // A running agent asks first; anything else closes at once.
  const [closing, setClosing] = useState<{ pane: string; tab: Tab }>();

  function requestClose(pane: string, tab: Tab) {
    if (tab.session && agentRuns(tab.session.id)) setClosing({ pane, tab });
    else closeNow(workspace.path, pane, tab.key);
  }

  const panes = panesOf(view.layout);
  return (
    // The tab bars are the page's top row: the area cancels the padding of `<main>`.
    <div role="region" aria-label={workspace.name} className="relative -m-2 min-h-0 flex-1">
      {sidebarHidden && (
        <Button variant="ghost" size="icon" aria-label="Show sidebar" className="app-no-drag absolute top-2 left-[72px] z-10 font-normal" onClick={toggleSidebar}>
          <PanelLeftOpenIcon />
        </Button>
      )}
      {boxes(view.layout).map((box) => (
        <PaneView
          key={box.pane}
          project={project}
          workspace={workspace}
          view={view}
          pane={panes.find(({ id }) => id === box.pane)!}
          box={box}
          sidebarHidden={sidebarHidden}
          waiting={waiting}
          onClose={requestClose}
        />
      ))}
      <AlertDialog open={closing !== undefined} onOpenChange={(open) => !open && setClosing(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {closing && labelOf(closing.tab)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {closing?.tab.name.replace(/ \d+$/, '')} is still running in this tab. Closing it ends the agent; the workspace stays in the sidebar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (closing) closeNow(workspace.path, closing.pane, closing.tab.key);
                setClosing(undefined);
              }}
            >
              Close tab
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
