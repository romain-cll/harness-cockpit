import { FileDiffIcon, GitPullRequestIcon, PanelRightIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BranchStatusResult, ChangedFile, ChangesResult, FileDiff, Project, Workspace } from '../../shared/api';
import { DiffView } from '@/components/diff-view';
import { ShipSection } from '@/components/ship-section';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type BarTab = 'diff' | 'pull-request';

// The right column's state: whether the bar is open and the tab it shows, kept for the page's
// lifetime, so going to a page without a workspace and back finds it as it was. A reload shows the
// rail, and "Show right bar" opens on "Diff".
let state = { open: false, tab: 'diff' as BarTab };
const listeners = new Set<() => void>();

function update(next: Partial<typeof state>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const useRightBar = () => useSyncExternalStore(subscribe, () => state);

/** Opens the bar on `tab`, or on the tab selected last. */
export const openRightBar = (tab?: BarTab) => update({ open: true, ...(tab && { tab }) });

export const closeRightBar = () => update({ open: false });

/** The project and listed workspace whose worktree is `path`, `undefined` for any other path. */
export function workspaceOf(path: string | undefined, projects: Project[]) {
  for (const project of projects) {
    const workspace = project.workspaces.find((each) => each.path === path);
    if (workspace) return { project, workspace };
  }
  return undefined;
}

// No transition in the column: a color read right after a change (a scheme, a selected tab) is the final one.
const COLUMN = 'text-foreground [&_button]:transition-none [&_button]:font-normal [&_svg]:[stroke-width:1.25]';

/** The right column of a workspace page while the bar is closed: a button to open it, and one per tab. */
export function RightRail() {
  return (
    <div role="complementary" aria-label="Right bar" className={`flex w-10 shrink-0 flex-col items-center bg-background ${COLUMN}`}>
      <div className="app-drag flex h-11 w-full shrink-0 items-center justify-center">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Show right bar"
          title="Show right bar"
          className="app-no-drag text-muted-foreground"
          onClick={() => openRightBar()}
        >
          <PanelRightIcon className="size-3.5" />
        </Button>
      </div>
      <div className="mt-1 flex flex-col gap-1 rounded-lg bg-sidebar-accent p-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Diff"
          title="Diff"
          className="text-muted-foreground"
          onClick={() => openRightBar('diff')}
        >
          <FileDiffIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Pull request"
          title="Pull request"
          className="text-muted-foreground"
          onClick={() => openRightBar('pull-request')}
        >
          <GitPullRequestIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

const LETTERS = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;

const LETTER_COLORS = {
  added: 'text-diff-added-foreground',
  modified: 'text-status-working',
  deleted: 'text-diff-removed-foreground',
  renamed: 'text-status-working',
} as const;

function FileRow({ file, selected, onSelect }: { file: ChangedFile; selected: boolean; onSelect: () => void }) {
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const folder = file.path.slice(0, Math.max(slash, 0));
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex h-[26px] w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-hover ${selected ? 'bg-sidebar-accent hover:bg-sidebar-accent' : ''}`}
      >
        <span className={`w-3 shrink-0 font-mono text-[11px] ${LETTER_COLORS[file.status]}`}>{LETTERS[file.status]}</span>
        <span className="shrink-0 text-foreground">{name}</span>
        {file.oldPath !== undefined && (
          <span className="shrink-0 text-[11px] text-subtle">← {file.oldPath.slice(file.oldPath.lastIndexOf('/') + 1)}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] text-subtle">{folder}</span>
        {!!file.additions && <span className="shrink-0 text-[11px] text-diff-added-foreground">+{file.additions}</span>}
        {!!file.deletions && <span className="shrink-0 text-[11px] text-diff-removed-foreground">−{file.deletions}</span>}
      </button>
    </li>
  );
}

/**
 * The right bar of a workspace page, 320 px wide: a "Diff" tab (the files changed against the base
 * and the diff of the selected one) and a "Pull request" tab (see `ShipSection`). It reads again when
 * the main process says the worktree changed, and watches only while it is mounted, whichever tab
 * shows.
 */
export function ChangesPanel({ project: projectEntry, workspace }: { project: Project; workspace: Workspace }) {
  const { path: project } = projectEntry;
  const { path } = workspace;
  const { tab } = useRightBar();
  const [changes, setChanges] = useState<ChangesResult>();
  const [status, setStatus] = useState<BranchStatusResult>();
  // Reads the list and the git status again; set by the effect that watches the worktree.
  const reload = useRef(() => {});
  // `undefined` selects the first file, `null` none ("Close diff").
  const [selectedPath, setSelectedPath] = useState<string | null>();
  const [shown, setShown] = useState<{ path: string; diff: FileDiff }>();

  useEffect(() => {
    const { workspaces } = window.api;
    let current = true;
    let latest = 0;
    const refresh = () => {
      workspaces.status(project, path).then(
        (result) => current && setStatus(result),
        () => {},
      );
      const request = ++latest;
      workspaces.changes(project, path).then(
        (result) => {
          if (current && request === latest) setChanges(result);
        },
        (error: unknown) => {
          if (current && request === latest) {
            setChanges({ status: 'refused', message: error instanceof Error ? error.message : String(error) });
          }
        },
      );
    };
    reload.current = refresh;
    refresh();
    const stopping = workspaces.watch(project, path, refresh);
    // A change made while the watch was starting is never reported: read once more when it is live.
    void stopping.then(() => current && refresh(), () => {});
    return () => {
      current = false;
      void stopping.then((stop) => stop(), () => {});
    };
  }, [project, path]);

  const files = changes?.status === 'listed' ? changes.files : [];
  const selected = selectedPath === null ? undefined : (files.find((file) => file.path === selectedPath) ?? files[0]);
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  // The diff is read again whenever the changes are: the selected file may have changed.
  useEffect(() => {
    if (!selected) return;
    let current = true;
    window.api.workspaces.diff(project, path, selected).then(
      (result) => {
        if (current && result.status === 'shown') setShown({ path: selected.path, diff: result.diff });
      },
      () => {},
    );
    return () => {
      current = false;
    };
    // `selected` is a new object with every list, which is what triggers the read.
  }, [project, path, selected]);

  return (
    <div role="complementary" aria-label="Right bar" className={`flex w-80 shrink-0 flex-col border-l bg-background ${COLUMN}`}>
      <Tabs value={tab} onValueChange={(value) => update({ tab: value as BarTab })} className="min-h-0 flex-1 gap-0">
        <div className="app-drag flex h-11 shrink-0 items-center justify-between px-2 select-none">
          <TabsList className="h-6 gap-1 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-6">
            {(
              [
                ['diff', 'Diff'],
                ['pull-request', 'Pull request'],
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger key={value} value={value} className="app-no-drag h-6 flex-none px-2">
                {label}
                {value === 'diff' && files.length > 0 && <span className="text-[11px] text-subtle">{files.length}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
          <Button
            variant="selected"
            size="icon-sm"
            aria-label="Hide right bar"
            title="Hide right bar"
            className="app-no-drag"
            onClick={closeRightBar}
          >
            <PanelRightIcon className="size-3.5" />
          </Button>
        </div>
        <TabsContent value="diff" className="flex min-h-0 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 px-3">
            <span className="text-xs text-foreground">Changes</span>
            {changes?.status === 'listed' && <span className="truncate text-[11px] text-subtle">against {changes.base}</span>}
            <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
              {additions > 0 && <span className="text-diff-added-foreground">+{additions}</span>}
              {deletions > 0 && <span className="text-diff-removed-foreground">−{deletions}</span>}
            </span>
          </div>
          {changes?.status === 'refused' && <p className="px-3 py-2 text-xs text-muted-foreground">{changes.message}</p>}
          {changes?.status === 'listed' && files.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No changes against {changes.base}.</p>
          )}
          {files.length > 0 && (
            <ul className={`overflow-y-auto px-1 pb-1 ${selected ? 'max-h-[40%] shrink-0' : 'min-h-0 flex-1'}`}>
              {files.map((file) => (
                <FileRow key={file.path} file={file} selected={file === selected} onSelect={() => setSelectedPath(file.path)} />
              ))}
            </ul>
          )}
          {selected && (
            <div className="min-h-0 flex-1 overflow-auto border-t">
              <div className="sticky top-0 z-10 flex h-7 w-full min-w-0 items-center gap-2 border-b bg-background px-3">
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{selected.path}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Close diff"
                  title="Close diff"
                  className="size-4 shrink-0 text-muted-foreground"
                  onClick={() => setSelectedPath(null)}
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
              {shown?.path === selected.path && <DiffView diff={shown.diff} />}
            </div>
          )}
        </TabsContent>
        <TabsContent value="pull-request" keepMounted className="min-h-0 overflow-y-auto">
          <ShipSection project={projectEntry} workspace={workspace} changes={changes} status={status} onShipped={() => reload.current()} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
