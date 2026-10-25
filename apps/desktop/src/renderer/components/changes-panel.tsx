import { GitCompareIcon } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BranchStatusResult, ChangedFile, ChangesResult, FileDiff, Project, Session, Workspace } from '../../shared/api';
import { DiffView } from '@/components/diff-view';
import { ShipSection } from '@/components/ship-section';
import { Button } from '@/components/ui/button';

// Whether the sidebar is open: kept for the page's lifetime, so going to a page without a
// workspace and back finds it as it was. A reload starts with it closed.
let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean) {
  open = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const useChangesOpen = () => useSyncExternalStore(subscribe, () => open);

/** The workspace a session runs in: its project and listed worktree, `undefined` for any other session. */
export function workspaceOf(session: Session | undefined, projects: Project[]) {
  if (!session?.project) return undefined;
  const project = projects.find(({ path }) => path === session.project);
  const workspace = project?.workspaces.find(({ path }) => path === session.directory);
  return project && workspace ? { project, workspace } : undefined;
}

/** The "Changes" button of a workspace page's header. */
export function ChangesToggle() {
  const pressed = useChangesOpen();
  return (
    <Button variant="ghost" size="sm" aria-pressed={pressed} className="aria-pressed:bg-muted" onClick={() => setOpen(!pressed)}>
      <GitCompareIcon />
      Changes
    </Button>
  );
}

const LETTERS = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;

function FileRow({ file, selected, onSelect }: { file: ChangedFile; selected: boolean; onSelect: () => void }) {
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const folder = file.path.slice(0, Math.max(slash, 0));
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-sidebar-accent ${selected ? 'bg-sidebar-accent' : ''}`}
      >
        <span className="w-3 shrink-0 font-mono">{LETTERS[file.status]}</span>
        <span className="shrink-0">{name}</span>
        {file.oldPath !== undefined && (
          <span className="shrink-0 text-muted-foreground">← {file.oldPath.slice(file.oldPath.lastIndexOf('/') + 1)}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{folder}</span>
        {!!file.additions && <span className="shrink-0">+{file.additions}</span>}
        {!!file.deletions && <span className="shrink-0">−{file.deletions}</span>}
      </button>
    </li>
  );
}

/**
 * The right sidebar of a workspace page: the files changed against the base and the diff of the
 * selected one. It reads again when the main process says the worktree changed, and watches only
 * while it is mounted.
 */
export function ChangesPanel({ project: projectEntry, workspace }: { project: Project; workspace: Workspace }) {
  const { path: project } = projectEntry;
  const { path } = workspace;
  const [changes, setChanges] = useState<ChangesResult>();
  const [status, setStatus] = useState<BranchStatusResult>();
  // Reads the list and the git status again; set by the effect that watches the worktree.
  const reload = useRef(() => {});
  const [selectedPath, setSelectedPath] = useState<string>();
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
    return () => {
      current = false;
      void stopping.then((stop) => stop(), () => {});
    };
  }, [project, path]);

  const files = changes?.status === 'listed' ? changes.files : [];
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];

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
    <aside className="flex w-[360px] shrink-0 flex-col border-l bg-sidebar text-sidebar-foreground">
      <header className="app-drag flex h-12 shrink-0 items-center gap-2 border-b px-4 select-none">
        <h2 className="font-heading text-sm font-medium">Changes</h2>
        {changes?.status === 'listed' && <span className="truncate text-xs text-muted-foreground">against {changes.base}</span>}
      </header>
      <ShipSection project={projectEntry} workspace={workspace} changes={changes} status={status} onShipped={() => reload.current()} />
      {changes?.status === 'refused' && <p className="p-3 text-xs text-muted-foreground">{changes.message}</p>}
      {changes?.status === 'listed' && files.length === 0 && (
        <p className="p-3 text-xs text-muted-foreground">No changes against {changes.base}.</p>
      )}
      {files.length > 0 && (
        <ul className="max-h-[40%] shrink-0 overflow-y-auto border-b py-1">
          {files.map((file) => (
            <FileRow key={file.path} file={file} selected={file === selected} onSelect={() => setSelectedPath(file.path)} />
          ))}
        </ul>
      )}
      {selected && (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 z-10 w-full min-w-0 border-b bg-sidebar px-3 py-1.5 text-xs font-medium">{selected.path}</div>
          {shown?.path === selected.path && <DiffView diff={shown.diff} />}
        </div>
      )}
    </aside>
  );
}
