import { createFileRoute, rootRouteId, useLoaderData } from '@tanstack/react-router';
import { DaemonDown } from '@/components/daemon-down';
import { PageHeader } from '@/components/page-header';
import { TerminalTabs } from '@/components/terminal-tabs';

export const Route = createFileRoute('/terminal')({
  component: TerminalPage,
});

function TerminalPage() {
  const { daemon } = useLoaderData({ from: rootRouteId });
  if (daemon.status === 'running') return <TerminalTabs />;
  return (
    <>
      <PageHeader title="Terminal" />
      <DaemonDown status={daemon} />
    </>
  );
}
