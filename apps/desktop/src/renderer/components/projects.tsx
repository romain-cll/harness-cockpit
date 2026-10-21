import { useRouter } from '@tanstack/react-router';
import { FolderGitIcon, MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import type { Project } from '../../shared/api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export function Projects({ projects }: { projects: Project[] }) {
  const router = useRouter();
  // Why the last add was refused; cleared by the next one that succeeds.
  const [message, setMessage] = useState<string>();

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
    <section className="flex flex-col gap-px p-2">
      <header className="flex h-7 items-center justify-between pl-2 text-xs text-muted-foreground">
        <h2 className="font-medium">Projects</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Add project" onClick={() => void add()}>
          <PlusIcon />
        </Button>
      </header>
      {message && (
        <p role="status" className="px-2 py-1 text-xs break-words text-destructive">
          {message}
        </p>
      )}
      <ul className="flex flex-col gap-px">
        {projects.map((project) => (
          <li key={project.path} title={project.path} className="group/project relative">
            <div className="flex h-8 items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 pr-8 text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0">
              <FolderGitIcon />
              <span className="truncate">{project.name}</span>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Actions for ${project.name}`}
                    className="absolute top-1.5 right-1 opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                  />
                }
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto">
                <DropdownMenuItem className="flex-col items-start gap-0" onClick={() => void remove(project.path)}>
                  <span>Remove from Cockpit</span>
                  <span className="text-muted-foreground!">Files stay on disk</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
    </section>
  );
}
