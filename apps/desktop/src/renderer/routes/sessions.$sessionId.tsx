import { createFileRoute, rootRouteId, useLoaderData, useNavigate } from '@tanstack/react-router';
import { useEffect, useSyncExternalStore } from 'react';
import { workspaceOf } from '@/components/changes-panel';
import { DaemonDown, ServiceStopped } from '@/components/daemon-down';
import { getSessionTerminal, subscribe } from '@/components/live-terminals';
import { PageHeader } from '@/components/page-header';
import { Terminal } from '@/components/terminal';
import { selectSessionTab, useRestoring, whenRestored } from '@/components/workspace-panes';

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionPage,
});

function SessionPage() {
  const { sessionId } = Route.useParams();
  const { sessions, projects, daemon } = useLoaderData({ from: rootRouteId });
  const session = sessions.find(({ id }) => id === sessionId);
  const navigate = useNavigate();
  // A session of a workspace is a tab of the workspace's page (a notification may open it here).
  const workspace = session?.project ? workspaceOf(session.directory, projects) : undefined;
  useEffect(() => {
    if (!session || !workspace) return;
    // The tab is there once the terminals of the previous page are shown again.
    void whenRestored().then(() => {
      selectSessionTab(session.directory, session.id);
      return navigate({ to: '/workspace', search: { path: session.directory }, replace: true });
    });
  }, [session, workspace, navigate]);
  // The store holds the terminals this page spawned or attached to: any other session, one that
  // ended while no window was attached included, has ended.
  const entry = useSyncExternalStore(subscribe, () => getSessionTerminal(sessionId));
  // The terminals of the previous page are being attached to: a session is not ended until they are.
  const restoring = useRestoring();
  if (workspace) return null;

  return (
    <>
      <PageHeader title={session?.name ?? 'Session'} />
      {daemon.status === 'stopped' && <ServiceStopped terminals={daemon.terminals} className="mb-2" />}
      {daemon.status === 'down' ? (
        <DaemonDown status={daemon} />
      ) : entry ? (
        <div className="min-h-0 flex-1">
          <Terminal live={entry} focused />
        </div>
      ) : restoring ? null : (
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
