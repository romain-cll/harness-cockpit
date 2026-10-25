import { Link, useRouter } from '@tanstack/react-router';
import { BotIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import type { Session } from '../../shared/api';
import { getRunningIds, getSessionDots, startSession, subscribe } from '@/components/live-terminals';
import { StartSessionMenu } from '@/components/start-session-menu';

// The color of a dot by its accessible name; "Ended" is any session the store does not hold (an earlier launch).
function dotColor(label: string): string {
  switch (label) {
    case 'Working':
      return 'bg-status-working';
    case 'Needs input':
      return 'bg-status-waiting';
    case 'Ready':
      return 'bg-status-ready';
    case 'Ended':
      return 'bg-muted-foreground';
    default:
      return 'bg-destructive';
  }
}

// A session's link, with a dot: what its agent last reported while it runs (none before its first
// report), "Ended" or "Exited N" once its process ended.
export function SessionLink({ session }: { session: Session }) {
  const dots = useSyncExternalStore(subscribe, getSessionDots);
  const running = useSyncExternalStore(subscribe, getRunningIds);
  const label = dots.get(session.id) ?? (running.has(session.id) ? undefined : 'Ended');
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: session.id }}
      className="flex h-8 cursor-default items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
    >
      <BotIcon />
      <span className="truncate">{session.name}</span>{' '}
      {label && <span role="img" aria-label={label} title={label} className={`ml-auto size-2 shrink-0 rounded-full ${dotColor(label)}`} />}
    </Link>
  );
}

// The sessions outside any project; those of a workspace are listed under it.
export function Sessions({ sessions, statusOff }: { sessions: Session[]; statusOff: string | null }) {
  const router = useRouter();
  // Why the last start was refused; cleared by the next one that succeeds.
  const [message, setMessage] = useState<string>();

  async function start(harness: string) {
    const result = await startSession(harness);
    if (result.status === 'refused') {
      setMessage(result.message);
      return;
    }
    setMessage(undefined);
    await router.invalidate();
    await router.navigate({ to: '/sessions/$sessionId', params: { sessionId: result.session.id } });
  }

  return (
    <section className="flex max-h-[40%] shrink-0 flex-col gap-px p-2">
      <header className="flex h-7 shrink-0 items-center justify-between pl-2 text-xs text-muted-foreground">
        <h2 className="font-medium">Sessions</h2>
        <StartSessionMenu label="Start session" onStart={(harness) => void start(harness)} />
      </header>
      {statusOff !== null && (
        <p className="shrink-0 px-2 py-1 text-xs break-words text-muted-foreground">Session status is off: {statusOff}</p>
      )}
      {message && (
        <p role="status" className="shrink-0 px-2 py-1 text-xs break-words text-destructive">
          {message}
        </p>
      )}
      <ul className="flex min-h-0 flex-col gap-px overflow-y-auto">
        {sessions
          .filter((session) => session.project === undefined)
          .map((session) => (
            <li key={session.id} title={session.directory}>
              <SessionLink session={session} />
            </li>
          ))}
      </ul>
    </section>
  );
}
