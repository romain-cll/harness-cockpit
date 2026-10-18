export function PageHeader({ title }: { title: string }) {
  return (
    <header className="app-drag flex h-12 shrink-0 items-center border-b px-4 select-none">
      <h1 className="font-heading text-sm font-medium">{title}</h1>
    </header>
  );
}
