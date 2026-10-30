import { useRouter } from '@tanstack/react-router';
import { FolderGitIcon, GitBranchIcon, MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AppsResult, AvailableApp, OpenWorkspaceResult, Project, Session, StartSessionResult, Workspace } from '../../shared/api';
import { DeleteWorkspaceDialog } from '@/components/delete-workspace-dialog';
import { NewWorkspaceDialog } from '@/components/new-workspace-dialog';
import { endSessions, getWorkspaceSetups, startSession, subscribe } from '@/components/live-terminals';
import { SessionLink } from '@/components/sessions';
import { StartSessionMenu } from '@/components/start-session-menu';
import { Button } from '@/components/ui/button';
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

// The workspace whose Delete dialog is open. Module-level so that the Changes sidebar can open it
// (`requestDeleteWorkspace`) as the workspace's "…" menu does.
let deletion: { project: Project; workspace: Workspace } | undefined;
const deletingListeners = new Set<() => void>();

function setDeleting(next: typeof deletion) {
  deletion = next;
  for (const listener of deletingListeners) listener();
}

function subscribeDeleting(listener: () => void) {
  deletingListeners.add(listener);
  return () => void deletingListeners.delete(listener);
}

/** Opens the Delete workspace dialog of `workspace`. */
export const requestDeleteWorkspace = (project: Project, workspace: Workspace) => setDeleting({ project, workspace });

const rowClass =
  'flex h-8 items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0';

// An entry of the list: its row, with the `trailing` label right-aligned when there is one, and the "…"
// menu shown on hover and focus, next to the `extra` button (shown the same way, left of it) when there
// is one. `onOpenChange` hears the menu open and close.
function Entry({
  title,
  icon,
  name,
  label,
  extra,
  trailing,
  onOpenChange,
  children,
}: {
  title: string;
  icon: ReactNode;
  name: string;
  label: string;
  extra?: ReactNode;
  trailing?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="group/entry relative">
      <div title={title} className={`${rowClass} ${extra ? 'pr-14' : 'pr-8'}`}>
        {icon}
        <span className="truncate">{name}</span>
        {trailing}
      </div>
      {extra}
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={label}
              className="absolute top-1.5 right-1 opacity-0 group-hover/entry:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// The items of a workspace's menu that open its worktree: the editor and the terminal shown first,
// the Finder, and a submenu of each kind listing every detected app.
function OpenItems({ apps, onOpen, onReveal }: { apps?: AppsResult; onOpen: (app: string) => void; onReveal: () => void }) {
  if (!apps) return null;
  const submenu = (kind: 'editor' | 'terminal', list: AvailableApp[]) => (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Open in {kind}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {list.map((app) => (
          <DropdownMenuItem key={app.id} onClick={() => onOpen(app.id)}>
            {app.name}
          </DropdownMenuItem>
        ))}
        {list.length === 0 && <DropdownMenuItem disabled>No {kind} found</DropdownMenuItem>}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
  const editor = apps.editors.find(({ id }) => id === apps.editor);
  const terminal = apps.terminals.find(({ id }) => id === apps.terminal);
  return (
    <>
      {editor && <DropdownMenuItem onClick={() => onOpen(editor.id)}>Open in {editor.name}</DropdownMenuItem>}
      {terminal && <DropdownMenuItem onClick={() => onOpen(terminal.id)}>Open in {terminal.name}</DropdownMenuItem>}
      <DropdownMenuItem onClick={onReveal}>Reveal in Finder</DropdownMenuItem>
      {submenu('editor', apps.editors)}
      {submenu('terminal', apps.terminals)}
      <DropdownMenuSeparator />
    </>
  );
}

// What the workspace's setup is doing: nothing once it is done.
function SetupLabel({ state }: { state?: 'running' | 'failed' }) {
  if (!state) return null;
  return state === 'running' ? (
    <span className="ml-auto shrink-0 text-muted-foreground">Setting up</span>
  ) : (
    <span className="ml-auto shrink-0 text-destructive">Setup failed</span>
  );
}

export function Projects({ projects, sessions }: { projects: Project[]; sessions: Session[] }) {
  const router = useRouter();
  // Why the last add or start was refused, or that a deletion kept its branch; cleared by the next add, start or deletion that succeeds.
  const [message, setMessage] = useState<string>();
  const [creatingIn, setCreatingIn] = useState<Project>();
  const deleting = useSyncExternalStore(subscribeDeleting, () => deletion);
  const setups = useSyncExternalStore(subscribe, getWorkspaceSetups);
  // The editors and terminals found when a workspace's menu last opened.
  const [apps, setApps] = useState<AppsResult>();

  async function add() {
    const result = await window.api.projects.add();
    if (result.status === 'cancelled') return;
    setMessage(result.status === 'refused' ? result.message : undefined);
    if (result.status === 'added') await router.invalidate();
  }

  // The sessions of a workspace (a project's when `directory` is omitted), newest first like `sessions`.
  const sessionsIn = (project: Project, directory?: string) =>
    sessions.filter((session) => session.project === project.path && (directory === undefined || session.directory === directory));

  async function remove(project: Project) {
    await window.api.projects.remove(project.path);
    endSessions(sessionsIn(project).map(({ id }) => id));
    await router.invalidate();
  }

  // Shows what starting a session came to: its page, or why it was refused.
  async function started(result: StartSessionResult) {
    if (result.status === 'refused') {
      setMessage(result.message);
      return;
    }
    setMessage(undefined);
    await router.invalidate();
    await router.navigate({ to: '/sessions/$sessionId', params: { sessionId: result.session.id } });
  }

  // Shows why opening a worktree was refused or failed; a success clears the message.
  function opened(result: OpenWorkspaceResult) {
    setMessage(result.status === 'refused' ? result.message : undefined);
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-px p-2">
      <header className="flex h-7 shrink-0 items-center justify-between pl-2 text-xs text-muted-foreground">
        <h2 className="font-medium">Projects</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Add project" onClick={() => void add()}>
          <PlusIcon />
        </Button>
      </header>
      {message && (
        <p role="status" className="shrink-0 px-2 py-1 text-xs break-words text-destructive">
          {message}
        </p>
      )}
      <ul className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        {projects.map((project) => (
          <li key={project.path}>
            <Entry
              title={project.path}
              icon={<FolderGitIcon />}
              name={project.name}
              label={`Actions for ${project.name}`}
            >
              <DropdownMenuItem onClick={() => setCreatingIn(project)}>New workspace…</DropdownMenuItem>
              <DropdownMenuItem className="flex-col items-start gap-0" onClick={() => void remove(project)}>
                <span>Remove from Cockpit</span>
                <span className="text-muted-foreground!">Files stay on disk</span>
              </DropdownMenuItem>
            </Entry>
            {project.error && <p className="px-2 py-1 pl-8 text-xs break-words text-muted-foreground">{project.error}</p>}
            {project.workspaces.length > 0 && (
              <ul className="flex flex-col gap-px pl-4">
                {project.workspaces.map((workspace) => (
                  <li key={workspace.path}>
                    <Entry
                      title={workspace.path}
                      icon={<GitBranchIcon />}
                      name={workspace.name}
                      label={`Actions for ${workspace.name}`}
                      trailing={<SetupLabel state={setups.get(workspace.path)} />}
                      onOpenChange={(open) => open && void window.api.workspaces.apps().then(setApps)}
                      extra={
                        <StartSessionMenu
                          label={`Start session in ${workspace.name}`}
                          className="absolute top-1.5 right-7 opacity-0 group-hover/entry:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                          onStart={(harness) =>
                            void startSession(harness, { workspace: { project: project.path, path: workspace.path } }).then(started)
                          }
                        />
                      }
                    >
                      <OpenItems
                        apps={apps}
                        onOpen={(app) => void window.api.workspaces.open(project.path, workspace.path, app).then(opened)}
                        onReveal={() => void window.api.workspaces.reveal(project.path, workspace.path).then(opened)}
                      />
                      <DropdownMenuItem onClick={() => setDeleting({ project, workspace })}>Delete workspace…</DropdownMenuItem>
                    </Entry>
                    <ul className="flex flex-col gap-px pl-4">
                      {sessionsIn(project, workspace.path).map((session) => (
                        <li key={session.id}>
                          <SessionLink session={session} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {creatingIn && (
        <NewWorkspaceDialog
          project={creatingIn}
          onClose={() => setCreatingIn(undefined)}
          onCreated={async (start) => {
            await router.invalidate();
            setCreatingIn(undefined);
            if (start) await started(start);
          }}
        />
      )}
      {deleting && (
        <DeleteWorkspaceDialog
          project={deleting.project}
          workspace={deleting.workspace}
          onClose={() => setDeleting(undefined)}
          onRemoved={async (branchKept) => {
            setMessage(branchKept ? `Branch ${deleting.workspace.branch} was kept: it is not merged.` : undefined);
            endSessions(sessionsIn(deleting.project, deleting.workspace.path).map(({ id }) => id));
            await router.invalidate();
            setDeleting(undefined);
          }}
        />
      )}
    </section>
  );
}
