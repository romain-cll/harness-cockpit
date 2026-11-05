import { createFileRoute, rootRouteId, useLoaderData } from '@tanstack/react-router';
import { workspaceOf } from '@/components/changes-panel';
import { DaemonDown, ServiceStopped } from '@/components/daemon-down';
import { PageHeader } from '@/components/page-header';
import { SettingUp, SetupRefused } from '@/components/workspace-setup';
import { WorkspacePanes } from '@/components/workspace-panes';

export const Route = createFileRoute('/workspace')({
  validateSearch: (search: Record<string, unknown>): { path: string } => ({ path: typeof search.path === 'string' ? search.path : '' }),
  component: WorkspacePage,
});

function WorkspacePage() {
  const { path } = Route.useSearch();
  const { projects, daemon, failedSetups } = useLoaderData({ from: rootRouteId });
  const found = workspaceOf(path, projects);
  const refused = failedSetups.find((failed) => failed.path === path);

  if (found?.workspace.settingUp) return <SettingUp workspace={found.workspace} />;
  if (!found && refused) return <SetupRefused failed={refused} />;

  // Panes are the page's top row; the other views have a header of their own.
  if (found && daemon.status !== 'down') {
    const banner = daemon.status === 'stopped' ? <ServiceStopped terminals={daemon.terminals} /> : undefined;
    return <WorkspacePanes key={path} project={found.project} workspace={found.workspace} banner={banner} />;
  }
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
