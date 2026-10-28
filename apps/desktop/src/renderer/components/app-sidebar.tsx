import { Link } from '@tanstack/react-router';
import { HouseIcon, SquareTerminalIcon } from 'lucide-react';
import type { Project, Session } from '../../shared/api';
import { Projects } from '@/components/projects';
import { Sessions } from '@/components/sessions';
import { StatusOffAlert } from '@/components/status-off-alert';

export function AppSidebar({
  version,
  projects,
  sessions,
  statusOff,
}: {
  version: string;
  projects: Project[];
  sessions: Session[];
  statusOff: string | null;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none">
      {/* Draggable strip; on macOS it holds the window controls. */}
      <div className="app-drag h-12 shrink-0" />
      <nav className="flex shrink-0 flex-col gap-px p-2">
        <Link
          to="/"
          className="flex h-8 cursor-default items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
        >
          <HouseIcon />
          Home
        </Link>
        <Link
          to="/terminal"
          className="flex h-8 cursor-default items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
        >
          <SquareTerminalIcon />
          Terminal
        </Link>
      </nav>
      {statusOff !== null && <StatusOffAlert reason={statusOff} />}
      <Projects projects={projects} sessions={sessions} />
      <Sessions sessions={sessions} />
      <footer className="shrink-0 px-4 py-3 text-xs text-muted-foreground">Cockpit {version}</footer>
    </aside>
  );
}
