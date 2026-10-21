import { useRouter } from '@tanstack/react-router';
import { FolderGitIcon, GitBranchIcon, MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Project, Workspace } from '../../shared/api';
import { DeleteWorkspaceDialog } from '@/components/delete-workspace-dialog';
import { NewWorkspaceDialog } from '@/components/new-workspace-dialog';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const rowClass =
  'flex h-8 items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 pr-8 text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0';

// An entry of the list: its row, and the "…" menu shown on hover and focus.
function Entry({ title, icon, name, label, children }: { title: string; icon: ReactNode; name: string; label: string; children: ReactNode }) {
  return (
    <div className="group/entry relative">
      <div title={title} className={rowClass}>
        {icon}
        <span className="truncate">{name}</span>
      </div>
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

export function Projects({ projects }: { projects: Project[] }) {
  const router = useRouter();
  // Why the last add was refused, or that a deletion kept its branch; cleared by the next add or deletion that succeeds.
  const [message, setMessage] = useState<string>();
  const [creatingIn, setCreatingIn] = useState<Project>();
  const [deleting, setDeleting] = useState<{ project: Project; workspace: Workspace }>();

  async function add() {
    const result = await window.api.projects.add();
    if (result.status === 'cancelled') return;
    setMessage(result.status === 'refused' ? result.message : undefined);
    if (result.status === 'added') await router.invalidate();
  }

  async function remove(path: string) {
    await window.api.projects.remove(path);
    await router.invalidate();
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
              <DropdownMenuItem className="flex-col items-start gap-0" onClick={() => void remove(project.path)}>
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
                    >
                      <DropdownMenuItem onClick={() => setDeleting({ project, workspace })}>Delete workspace…</DropdownMenuItem>
                    </Entry>
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
          onCreated={async () => {
            await router.invalidate();
            setCreatingIn(undefined);
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
            await router.invalidate();
            setDeleting(undefined);
          }}
        />
      )}
    </section>
  );
}
