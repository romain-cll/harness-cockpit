import { Link, useRouter } from '@tanstack/react-router';
import { BotIcon, PlusIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import type { AvailableHarness, Session } from '../../shared/api';
import { getRunningIds, startSession, subscribe } from '@/components/session-terminals';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export function Sessions({ sessions }: { sessions: Session[] }) {
  const router = useRouter();
  const running = useSyncExternalStore(subscribe, getRunningIds);
  // The detected harnesses, fetched each time the menu opens.
  const [harnesses, setHarnesses] = useState<AvailableHarness[]>();
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
        <DropdownMenu onOpenChange={(open) => open && void window.api.sessions.harnesses().then(setHarnesses)}>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Start session" />}>
            <PlusIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto">
            {harnesses?.map((harness) => (
              <DropdownMenuItem key={harness.id} onClick={() => void start(harness.id)}>
                {harness.name}
              </DropdownMenuItem>
            ))}
            {harnesses?.length === 0 && <DropdownMenuItem disabled>No agent CLI found</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {message && (
        <p role="status" className="shrink-0 px-2 py-1 text-xs break-words text-destructive">
          {message}
        </p>
      )}
      <ul className="flex min-h-0 flex-col gap-px overflow-y-auto">
        {sessions.map((session) => (
          <li key={session.id} title={session.directory}>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: session.id }}
              className="flex h-8 cursor-default items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
            >
              <BotIcon />
              <span className="truncate">{session.name}</span>{' '}
              {!running.has(session.id) && <span className="ml-auto shrink-0 text-muted-foreground">Ended</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
