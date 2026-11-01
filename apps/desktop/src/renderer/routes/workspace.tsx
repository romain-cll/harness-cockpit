import { createFileRoute, rootRouteId, useLoaderData } from '@tanstack/react-router';
import { workspaceOf } from '@/components/changes-panel';
import { DaemonDown } from '@/components/daemon-down';
import { PageHeader } from '@/components/page-header';
import { WorkspacePanes } from '@/components/workspace-panes';

export const Route = createFileRoute('/workspace')({
  validateSearch: (search: Record<string, unknown>): { path: string } => ({ path: typeof search.path === 'string' ? search.path : '' }),
  component: WorkspacePage,
});

function WorkspacePage() {
  const { path } = Route.useSearch();
  const { projects, daemon } = useLoaderData({ from: rootRouteId });
  const found = workspaceOf(path, projects);

  // Panes are the page's top row; the other views have a header of their own.
  if (found && daemon.status === 'running') return <WorkspacePanes key={path} project={found.project} workspace={found.workspace} />;
  return (
    <>
      <PageHeader title={found?.workspace.name ?? 'Workspace'} />
      {daemon.status === 'down' ? (
        <DaemonDown status={daemon} />
      ) : (
        <p className="p-4 text-sm">Workspace not found.</p>
      )}
    </>
  );
}
