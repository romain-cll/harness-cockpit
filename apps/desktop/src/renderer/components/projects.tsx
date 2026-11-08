import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CheckIcon,
  CodeXmlIcon,
  CopyIcon,
  FolderMinusIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SquareTerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AppsResult, AvailableApp, FailedSetup, OpenWorkspaceResult, Project, Session, StartSessionResult, Workspace } from '../../shared/api';
import { showRefusal, useAddProject } from '@/components/add-project';
import { toggleProject, toggleProjects, useCollapsedProjects, useProjectsCollapsed } from '@/components/collapsed';
import { DeleteWorkspaceDialog } from '@/components/delete-workspace-dialog';
import { endSessions, getWorkspaceSetups, startSession, subscribe } from '@/components/live-terminals';
import { claimNavigation } from '@/components/navigation-claim';
import { ProjectBadge } from '@/components/project-badge';
import { usePullRequestState, usePullRequestStates } from '@/components/pull-request-states';
import { RemoveProjectDialog } from '@/components/remove-project-dialog';
import { linkRowClass, rowClass, StatusIcon } from '@/components/sessions';
import { StartSessionMenu } from '@/components/start-session-menu';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { addSessionTab, closeWorkspace, setProjectsMessage, useProjectsMessage, useWorkspaceStatus } from '@/components/workspace-panes';
import { RefusedSetups } from '@/components/workspace-setup';
import { cn } from 'cn';

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

// An entry of the list: its row (`after` follows the name, the `trailing` label is right-aligned), and the
// "…" menu shown on hover and focus, next to the `extra` button (shown the same way, left of it) when
// there is one. `onOpenChange` hears the menu open and close. `row` replaces the plain row, for a link.
function Entry({
  title,
  icon,
  name,
  after,
  label,
  extra,
  trailing,
  row,
  onOpenChange,
  children,
}: {
  title: string;
  icon: ReactNode;
  name: ReactNode;
  after?: ReactNode;
  label: string;
  extra?: ReactNode;
  trailing?: ReactNode;
  row?: (props: { className: string; children: ReactNode }) => ReactNode;
  onOpenChange?: (open: boolean) => void;
  /** The items of the "…" menu; an entry without any has no menu. */
  children?: ReactNode;
}) {
  const content = (
    <>
      {icon}
      {name} {after} {trailing}
    </>
  );
  const className = extra ? 'pr-14' : children ? 'pr-8' : 'pr-2';
  return (
    <div className="group/entry relative">
      {row ? (
        row({ className, children: content })
      ) : (
        <div title={title} className={`${rowClass} ${className}`}>
          {content}
        </div>
      )}
      {extra}
      {children && (
        <DropdownMenu onOpenChange={onOpenChange}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={label}
                className="absolute top-1 right-1 opacity-0 group-hover/entry:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-50">
            {children}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

// An app's placeholder badge in a submenu: its first letter on neutral tokens.
const AppBadge = ({ name }: { name: string }) => (
  <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-muted text-[9px] leading-none text-muted-foreground">
    {name.charAt(0).toUpperCase()}
  </span>
);

const kindIcon = { editor: CodeXmlIcon, terminal: SquareTerminalIcon };

// The items of a workspace's menu that open its worktree: the editor and the terminal shown first, a
// submenu of each kind listing every detected app (the one shown first checked), the Finder and the path.
function OpenItems({
  apps,
  onOpen,
  onReveal,
  onCopyPath,
}: {
  apps?: AppsResult;
  onOpen: (app: string) => void;
  onReveal: () => void;
  onCopyPath: () => void;
}) {
  if (!apps) return null;
  const submenu = (kind: 'editor' | 'terminal', list: AvailableApp[]) => {
    const Icon = kindIcon[kind];
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Icon />
          Open in {kind}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {list.map((app) => (
            <DropdownMenuItem key={app.id} onClick={() => onOpen(app.id)}>
              <AppBadge name={app.name} />
              {app.name}
              {app.id === apps[kind] && <CheckIcon className="ml-auto" />}
            </DropdownMenuItem>
          ))}
          {list.length === 0 && <DropdownMenuItem disabled>No {kind} found</DropdownMenuItem>}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };
  const editor = apps.editors.find(({ id }) => id === apps.editor);
  const terminal = apps.terminals.find(({ id }) => id === apps.terminal);
  return (
    <>
      {editor && (
        <DropdownMenuItem onClick={() => onOpen(editor.id)}>
          <CodeXmlIcon />
          <span className="truncate">Open in {editor.name}</span>
        </DropdownMenuItem>
      )}
      {terminal && (
        <DropdownMenuItem onClick={() => onOpen(terminal.id)}>
          <SquareTerminalIcon />
          <span className="truncate">Open in {terminal.name}</span>
        </DropdownMenuItem>
      )}
      {submenu('editor', apps.editors)}
      {submenu('terminal', apps.terminals)}
      <DropdownMenuItem onClick={onReveal}>
        <FolderOpenIcon />
        Reveal in Finder
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onCopyPath}>
        <CopyIcon />
        Copy path
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

// What the workspace's setup is doing: nothing once it is done.
function SetupLabel({ state }: { state?: 'running' | 'failed' }) {
  if (!state) return null;
  return state === 'running' ? (
    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">Setting up</span>
  ) : (
    <span className="ml-auto shrink-0 text-[11px] text-destructive">Setup failed</span>
  );
}

// A workspace's row: a link to its page, with the icon of its most urgent session, else of its branch's pull request.
// A workspace being set up is no entry of the list yet: its link has no title, the path is on its name.
function WorkspaceName({ project, workspace }: { project: string; workspace: Workspace }) {
  const status = useWorkspaceStatus(workspace.path);
  const pullRequest = usePullRequestState(project, workspace.branch);
  return (
    <>
      <StatusIcon label={status ?? (pullRequest === 'open' || pullRequest === 'merged' ? `Pull request ${pullRequest}` : undefined)} />
      <span title={workspace.settingUp ? workspace.path : undefined} className={cn('truncate', !status && 'text-muted-foreground')}>
        {workspace.name}
      </span>
    </>
  );
}

export function Projects({ projects, sessions, failedSetups }: { projects: Project[]; sessions: Session[]; failedSetups: FailedSetup[] }) {
  const router = useRouter();
  const navigate = useNavigate();
  // Why the last start was refused, or that a deletion kept its branch; cleared by the next add, start or deletion that succeeds.
  const message = useProjectsMessage();
  const setMessage = setProjectsMessage;
  const deleting = useSyncExternalStore(subscribeDeleting, () => deletion);
  const setups = useSyncExternalStore(subscribe, getWorkspaceSetups);
  const collapsed = useProjectsCollapsed();
  const collapsedProjects = useCollapsedProjects();
  // The expanded projects and their branches: their pull request states are read while the sidebar shows them.
  // A workspace still setting up is left out: its worktree is not listed yet, so a read now would skip its branch and no later change would trigger another.
  usePullRequestStates(
    collapsed
      ? []
      : projects.flatMap(({ path, workspaces }) => {
          const branches = workspaces.flatMap(({ branch, settingUp }) => (branch === null || settingUp ? [] : [branch]));
          return collapsedProjects.has(path) || branches.length === 0 ? [] : [{ project: path, branches }];
        }),
  );
  // The editors and terminals found when a workspace's or project's menu last opened.
  const [apps, setApps] = useState<AppsResult>();
  const editor = apps?.editors.find(({ id }) => id === apps.editor);
  // The project whose removal dialog is open.
  const [removing, setRemoving] = useState<Project>();

  const adding = useAddProject();

  // The moved project's repository, picked again: the project keeps its place under the new path.
  async function updatePath(project: Project) {
    const result = await window.api.projects.updatePath(project.path);
    if (result.status === 'refused') showRefusal('Cannot update path', result.message);
    else if (result.status === 'updated') await router.invalidate();
  }

  // The sessions of a workspace (a project's when `directory` is omitted), newest first like `sessions`.
  const sessionsIn = (project: Project, directory?: string) =>
    sessions.filter((session) => session.project === project.path && (directory === undefined || session.directory === directory));

  // The reason it was refused, if it was.
  async function remove(project: Project): Promise<string | undefined> {
    const refused = await window.api.projects.remove(project.path);
    if (refused) return refused.message;
    endSessions(sessionsIn(project).map(({ id }) => id));
    for (const { path } of project.workspaces) closeWorkspace(path);
    await router.invalidate();
    return undefined;
  }

  // Shows what starting a session came to: its tab on the workspace's page, or why it was refused.
  async function started(result: StartSessionResult, mayNavigate: () => boolean) {
    if (result.status === 'refused') {
      setMessage(result.message);
      return;
    }
    setMessage(undefined);
    addSessionTab(result.session);
    await router.invalidate();
    if (mayNavigate()) await router.navigate({ to: '/workspace', search: { path: result.session.directory } });
  }

  // Shows why opening a worktree was refused or failed; a success clears the message.
  function opened(result: OpenWorkspaceResult) {
    setMessage(result.status === 'refused' ? result.message : undefined);
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-px">
      <header className="flex h-6 shrink-0 items-center justify-between pr-1.5 text-[11px] text-muted-foreground">
        <h2>
          <button type="button" aria-expanded={!collapsed} onClick={toggleProjects} className="flex h-6 cursor-default items-center gap-1 pl-2">
            Projects
            {collapsed ? <ChevronRightIcon className="size-2.5 text-subtle" /> : <ChevronDownIcon className="size-2.5 text-subtle" />}
          </button>
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Add project" className="text-subtle" />}>
            <PlusIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-50">
            <DropdownMenuItem onClick={() => void adding.open()}>
              <FolderOpenIcon className="text-muted-foreground" />
              Open project…
              <DropdownMenuShortcut className="text-[11px] tracking-normal text-subtle">⌘O</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={adding.clone}>
              <GitBranchIcon className="text-muted-foreground" />
              Clone from Git…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={adding.create}>
              <FolderPlusIcon className="text-muted-foreground" />
              Create new…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {message && (
        <p role="status" className="shrink-0 px-2 py-1 text-xs break-words text-destructive">
          {message}
        </p>
      )}
      <RefusedSetups failedSetups={failedSetups} />
      {!collapsed && (
        <ul className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
          {projects.map((project) => {
            const expanded = !collapsedProjects.has(project.path);
            return (
              <li key={project.path}>
                <Entry
                  title={project.path}
                  icon={<ProjectBadge path={project.path} name={project.name} />}
                  name={<span className="truncate">{project.name}</span>}
                  after={
                    project.missing ? (
                      <TriangleAlertIcon className="size-3.5 text-destructive" />
                    ) : (
                      <button
                        type="button"
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`}
                        aria-expanded={expanded}
                        onClick={() => toggleProject(project.path)}
                        className="flex size-5 shrink-0 cursor-default items-center justify-center rounded-sm text-subtle hover:text-foreground"
                      >
                        {expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
                      </button>
                    )
                  }
                  label={`Actions for ${project.name}`}
                  onOpenChange={(open) => open && void window.api.workspaces.apps().then(setApps)}
                >
                  <DropdownMenuItem onClick={() => void navigate({ to: '/', search: { project: project.path } })}>
                    <PlusIcon />
                    New workspace
                  </DropdownMenuItem>
                  {!project.missing && (
                    <>
                      {editor && (
                        <DropdownMenuItem onClick={() => void window.api.projects.open(project.path, editor.id).then(opened)}>
                          <CodeXmlIcon />
                          <span className="truncate">Open in {editor.name}</span>
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => void window.api.projects.reveal(project.path).then(opened)}>
                        <FolderOpenIcon />
                        Reveal in Finder
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setRemoving(project)}>
                    <FolderMinusIcon />
                    Remove project…
                  </DropdownMenuItem>
                </Entry>
                {project.missing && (
                  <div className="flex flex-col gap-1.5 pt-0.5 pr-2 pb-1.5 pl-[30px] text-[11px] break-words">
                    <p className="text-destructive">Folder not found</p>
                    <p className="text-muted-foreground">{project.path}</p>
                    <Button variant="outline" className="h-auto w-full rounded-md border-foreground/10 px-2 py-[5px] text-xs" onClick={() => setRemoving(project)}>
                      Remove from Cockpit
                    </Button>
                    <Button variant="outline" className="h-auto w-full rounded-md border-foreground/10 px-2 py-[5px] text-xs" onClick={() => void updatePath(project)}>
                      Update path…
                    </Button>
                  </div>
                )}
                {project.error && <p className="px-2 py-1 pl-8 text-xs break-words text-muted-foreground">{project.error}</p>}
                {expanded && project.workspaces.length > 0 && (
                  <ul className="flex flex-col gap-px">
                    {project.workspaces.map((workspace) => (
                      <li key={workspace.path}>
                        <Entry
                          title={workspace.path}
                          icon={null}
                          name={<WorkspaceName project={project.path} workspace={workspace} />}
                          label={`Actions for ${workspace.name}`}
                          trailing={<SetupLabel state={workspace.settingUp ? 'running' : setups.get(workspace.path)} />}
                          row={({ className, children }) => (
                            <Link
                              to="/workspace"
                              search={{ path: workspace.path }}
                              title={workspace.settingUp ? undefined : workspace.path}
                              className={cn(linkRowClass, 'pl-[30px]', className)}
                            >
                              {children}
                            </Link>
                          )}
                          onOpenChange={(open) => open && void window.api.workspaces.apps().then(setApps)}
                          extra={
                            !workspace.settingUp && (
                              <StartSessionMenu
                                label={`Start session in ${workspace.name}`}
                                className="absolute top-1 right-7 opacity-0 group-hover/entry:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                                onStart={(harness) => {
                                  const mayNavigate = claimNavigation(router.history);
                                  void startSession(harness, { workspace: { project: project.path, path: workspace.path } }).then((result) =>
                                    started(result, mayNavigate),
                                  );
                                }}
                              />
                            )
                          }
                        >
                          {!workspace.settingUp && (
                            <>
                              <OpenItems
                                apps={apps}
                                onOpen={(app) => void window.api.workspaces.open(project.path, workspace.path, app).then(opened)}
                                onReveal={() => void window.api.workspaces.reveal(project.path, workspace.path).then(opened)}
                                onCopyPath={() => void navigator.clipboard.writeText(workspace.path)}
                              />
                              <DropdownMenuItem variant="destructive" onClick={() => setDeleting({ project, workspace })}>
                                <Trash2Icon />
                                Delete workspace…
                              </DropdownMenuItem>
                            </>
                          )}
                        </Entry>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {removing && <RemoveProjectDialog project={removing} onClose={() => setRemoving(undefined)} onRemove={() => remove(removing)} />}
      {deleting && (
        <DeleteWorkspaceDialog
          project={deleting.project}
          workspace={deleting.workspace}
          onClose={() => setDeleting(undefined)}
          onRemoved={async (branchKept) => {
            setMessage(branchKept ? `Branch ${deleting.workspace.branch} was kept: it is not merged.` : undefined);
            endSessions(sessionsIn(deleting.project, deleting.workspace.path).map(({ id }) => id));
            closeWorkspace(deleting.workspace.path);
            await router.invalidate();
            setDeleting(undefined);
          }}
        />
      )}
    </section>
  );
}
