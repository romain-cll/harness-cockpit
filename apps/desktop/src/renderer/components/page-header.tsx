import type { ReactNode } from 'react';

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="app-drag flex h-12 shrink-0 items-center border-b px-4 select-none">
      <h1 className="font-heading text-sm font-medium">{title}</h1>
      {children && <div className="app-no-drag ml-4 flex min-w-0 items-center gap-1">{children}</div>}
    </header>
  );
}
