import { Link, useRouter } from '@tanstack/react-router';
import { CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleXIcon, ChevronDownIcon, ChevronRightIcon, ContrastIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import type { DaemonStatus, Session } from '../../shared/api';
import { toggleSessions, useSessionsCollapsed } from '@/components/collapsed';
import { useRetrying } from '@/components/daemon-down';
import { getRunningIds, getSessionDots, startSession, subscribe } from '@/components/live-terminals';
import { StartSessionMenu } from '@/components/start-session-menu';

/** The classes of a 28 px sidebar row, with its icons at 14 px unless they set a size of their own. */
export const rowClass =
  'flex h-7 items-center gap-2 rounded-md px-2 text-xs hover:bg-hover [&_svg:not([class*=size-])]:size-3.5 [&_svg]:shrink-0';

/** The classes of a row that links to a page, filled while it is the current one. */
export const linkRowClass = `${rowClass} cursor-default aria-[current=page]:bg-sidebar-accent`;

// The icon and color of a status icon by its accessible name; "Ended" is any session the store does not
// hold (an earlier launch).
function statusIcon(label: string) {
  switch (label) {
    case 'Working':
      return { Icon: ContrastIcon, color: 'text-status-working' };
    case 'Needs input':
      return { Icon: CircleDotIcon, color: 'text-status-waiting' };
    case 'Ready':
      return { Icon: CircleCheckIcon, color: 'text-status-ready' };
    case 'Ended':
      return { Icon: CircleDashedIcon, color: 'text-muted-foreground' };
    default:
      return { Icon: CircleXIcon, color: 'text-status-exited' };
  }
}

// A session's link, with a status icon: what its agent last reported while it runs (a muted dashed
// circle without a name before its first report), "Ended" or "Exited N" once its process ended.
export function SessionLink({ session }: { session: Session }) {
  const dots = useSyncExternalStore(subscribe, getSessionDots);
  const running = useSyncExternalStore(subscribe, getRunningIds);
  const label = dots.get(session.id) ?? (running.has(session.id) ? undefined : 'Ended');
  const { Icon, color } = label ? statusIcon(label) : { Icon: CircleDashedIcon, color: 'text-muted-foreground' };
  return (
    <Link to="/sessions/$sessionId" params={{ sessionId: session.id }} className={linkRowClass}>
      {label ? (
        <span role="img" aria-label={label} title={label} className={`flex shrink-0 ${color}`}>
          <Icon className="size-3.5" />
        </span>
      ) : (
        <Icon aria-hidden="true" className={`size-3.5 ${color}`} />
      )}
      <span className="truncate">{session.name}</span>
    </Link>
  );
}

// The sessions outside any project; those of a workspace are listed under it.
export function Sessions({ sessions, daemon }: { sessions: Session[]; daemon: DaemonStatus }) {
  const router = useRouter();
  const retrying = useRetrying();
  const collapsed = useSessionsCollapsed();
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
    <section className="flex max-h-[40%] shrink-0 flex-col gap-px">
      <header className="flex h-6 shrink-0 items-center justify-between pr-1.5 text-[11px] text-muted-foreground">
        <h2>
          <button type="button" aria-expanded={!collapsed} onClick={toggleSessions} className="flex h-6 cursor-default items-center gap-1 pl-2">
            Sessions
            {collapsed ? <ChevronRightIcon className="size-2.5 text-subtle" /> : <ChevronDownIcon className="size-2.5 text-subtle" />}
          </button>
        </h2>
        <StartSessionMenu label="Start session" className="text-subtle" onStart={(harness) => void start(harness)} />
      </header>
      {daemon.status === 'down' && !retrying && (
        <p className="shrink-0 px-2 py-1 text-xs break-words text-muted-foreground">{`Cockpit's background service could not start: ${daemon.reason}`}</p>
      )}
      {message && (
        <p role="status" className="shrink-0 px-2 py-1 text-xs break-words text-destructive">
          {message}
        </p>
      )}
      {!collapsed && (
        <ul className="flex min-h-0 flex-col gap-px overflow-y-auto">
          {sessions
            .filter((session) => session.project === undefined)
            .map((session) => (
              <li key={session.id} title={session.directory}>
                <SessionLink session={session} />
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
