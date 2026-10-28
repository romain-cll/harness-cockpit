import { createFileRoute, rootRouteId, useLoaderData } from '@tanstack/react-router';
import { ChangesToggle, workspaceOf } from '@/components/changes-panel';
import { DaemonDown } from '@/components/daemon-down';
import { getSessionTerminal } from '@/components/live-terminals';
import { PageHeader } from '@/components/page-header';
import { Terminal } from '@/components/terminal';

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionPage,
});

function SessionPage() {
  const { sessionId } = Route.useParams();
  const { sessions, projects, daemon } = useLoaderData({ from: rootRouteId });
  const session = sessions.find(({ id }) => id === sessionId);
  // The store holds the terminals this page spawned or attached to: any other session, one that
  // ended while no window was attached included, has ended.
  const entry = getSessionTerminal(sessionId);

  return (
    <>
      <PageHeader title={session?.name ?? 'Session'}>{workspaceOf(session, projects) && <ChangesToggle />}</PageHeader>
      {daemon.status === 'down' ? (
        <DaemonDown status={daemon} />
      ) : entry ? (
        <div className="min-h-0 flex-1">
          <Terminal live={entry} focused />
        </div>
      ) : (
        <div className="flex flex-col gap-1 p-4 text-sm">
          {session ? (
            <>
              <p>This session has ended.</p>
              <p className="break-all text-xs text-muted-foreground">{session.directory}</p>
            </>
          ) : (
            <p>Session not found.</p>
          )}
        </div>
      )}
    </>
  );
}
