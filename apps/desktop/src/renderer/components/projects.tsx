import { useRouter } from '@tanstack/react-router';
import { FolderGitIcon, GitBranchIcon, MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Project, Session, StartSessionResult, Workspace } from '../../shared/api';
import { DeleteWorkspaceDialog } from '@/components/delete-workspace-dialog';
import { NewWorkspaceDialog } from '@/components/new-workspace-dialog';
import { endSessions, startSession } from '@/components/live-terminals';
import { SessionLink } from '@/components/sessions';
import { StartSessionMenu } from '@/components/start-session-menu';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const rowClass =
  'flex h-8 items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0';

// An entry of the list: its row, and the "…" menu shown on hover and focus, next to the `extra` button
// (shown the same way, left of it) when there is one.
function Entry({
  title,
  icon,
  name,
  label,
  extra,
  children,
}: {
  title: string;
  icon: ReactNode;
  name: string;
  label: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="group/entry relative">
      <div title={title} className={`${rowClass} ${extra ? 'pr-14' : 'pr-8'}`}>
        {icon}
        <span className="truncate">{name}</span>
      </div>
      {extra}
      <DropdownMenu>
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

export function Projects({ projects, sessions }: { projects: Project[]; sessions: Session[] }) {
  const router = useRouter();
  // Why the last add or start was refused, or that a deletion kept its branch; cleared by the next add, start or deletion that succeeds.
  const [message, setMessage] = useState<string>();
  const [creatingIn, setCreatingIn] = useState<Project>();
  const [deleting, setDeleting] = useState<{ project: Project; workspace: Workspace }>();

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
