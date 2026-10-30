import { Link } from '@tanstack/react-router';
import { HouseIcon, PanelLeftCloseIcon, SquareTerminalIcon, TriangleAlertIcon } from 'lucide-react';
import type { DaemonStatus, Project, Session } from '../../shared/api';
import { toggleSidebar } from '@/components/collapsed';
import { Projects } from '@/components/projects';
import { linkRowClass, Sessions } from '@/components/sessions';
import { Button } from '@/components/ui/button';

export function AppSidebar({
  version,
  projects,
  sessions,
  daemon,
  git,
}: {
  version: string;
  projects: Project[];
  sessions: Session[];
  daemon: DaemonStatus;
  git: 'ok' | 'missing';
}) {
  return (
    <aside className="flex w-[220px] shrink-0 flex-col gap-3 bg-sidebar p-2 text-sidebar-foreground select-none [&_button]:font-normal [&_svg]:[stroke-width:1.25]">
      {/* Draggable strip; on macOS it holds the window controls, then the button that hides the sidebar. */}
      <div className="app-drag flex h-7 shrink-0 items-center justify-end pl-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="Hide sidebar" className="app-no-drag" onClick={toggleSidebar}>
          <PanelLeftCloseIcon className="size-4" />
        </Button>
      </div>
      <nav className="flex shrink-0 flex-col">
        <Link to="/" className={linkRowClass}>
          <HouseIcon />
          Home
        </Link>
        <Link to="/terminal" className={linkRowClass}>
          <SquareTerminalIcon />
          Terminal
        </Link>
      </nav>
      {git === 'missing' && (
        <div className="flex shrink-0 gap-2 rounded-md border border-status-working/25 bg-status-working/10 p-2 text-xs text-status-working">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p>Git is not installed</p>
            <p className="text-[11px] text-muted-foreground">Projects and workspaces need git 2.36 or later. Install it, then restart Cockpit.</p>
          </div>
        </div>
      )}
      <Projects projects={projects} sessions={sessions} />
      <Sessions sessions={sessions} daemon={daemon} />
      <footer className="shrink-0 px-2 text-[11px] text-subtle">Cockpit {version}</footer>
    </aside>
  );
}
