import { PanelLeftOpenIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { toggleSidebar, useSidebarCollapsed } from '@/components/collapsed';
import { Button } from '@/components/ui/button';

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  const sidebarHidden = useSidebarCollapsed();
  return (
    // With the sidebar hidden the row leaves room for the window controls, then holds the button that brings it back.
    <header className={`app-drag flex mb-1 h-7 shrink-0 items-center select-none ${sidebarHidden ? 'pl-16' : ''}`}>
      {sidebarHidden && (
        <Button variant="ghost" size="icon" aria-label="Show sidebar" className="app-no-drag mr-1 font-normal" onClick={toggleSidebar}>
          <PanelLeftOpenIcon />
        </Button>
      )}
      <h1 className="font-heading text-xs font-medium">{title}</h1>
      {children && <div className="app-no-drag ml-4 flex min-w-0 items-center gap-1">{children}</div>}
    </header>
  );
}
