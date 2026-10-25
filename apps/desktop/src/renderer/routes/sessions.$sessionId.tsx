import { createFileRoute, rootRouteId, useLoaderData } from '@tanstack/react-router';
import { ChangesToggle, workspaceOf } from '@/components/changes-panel';
import { getSessionTerminal } from '@/components/live-terminals';
import { PageHeader } from '@/components/page-header';
import { Terminal } from '@/components/terminal';

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionPage,
});

function SessionPage() {
  const { sessionId } = Route.useParams();
  const { sessions, projects } = useLoaderData({ from: rootRouteId });
  const session = sessions.find(({ id }) => id === sessionId);
  // The store holds the terminals of this page's lifetime only: any other
  // session, a previous launch's or one that a reload ended, has ended.
  const entry = getSessionTerminal(sessionId);

  return (
    <>
      <PageHeader title={session?.name ?? 'Session'}>{workspaceOf(session, projects) && <ChangesToggle />}</PageHeader>
      {entry ? (
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
