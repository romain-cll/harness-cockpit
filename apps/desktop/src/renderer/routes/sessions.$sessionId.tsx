import { createFileRoute, rootRouteId, useLoaderData } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { PageHeader } from '@/components/page-header';
import { getSessionTerminal, type SessionTerminal } from '@/components/session-terminals';

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionPage,
});

// Shows the session's terminal, which lives in the store: its element is moved
// into the page and moved out again, never disposed.
function LiveTerminal({ entry }: { entry: SessionTerminal }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { term, fit } = entry;
    const element = container.current!;
    if (term.element) element.appendChild(term.element);
    else term.open(element);
    fit.fit();
    term.focus();
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    return () => {
      observer.disconnect();
      term.element?.remove();
    };
  }, [entry]);

  return <div ref={container} className="min-h-0 flex-1 overflow-hidden bg-background px-2 py-1" />;
}

function SessionPage() {
  const { sessionId } = Route.useParams();
  const { sessions } = useLoaderData({ from: rootRouteId });
  const session = sessions.find(({ id }) => id === sessionId);
  // The store holds the terminals of this page's lifetime only: any other
  // session, a previous launch's or one that a reload ended, has ended.
  const entry = getSessionTerminal(sessionId);

  return (
    <>
      <PageHeader title={session?.name ?? 'Session'} />
      {entry ? (
        <LiveTerminal entry={entry} />
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
