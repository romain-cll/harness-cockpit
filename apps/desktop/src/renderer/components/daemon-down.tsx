import { useRouter } from '@tanstack/react-router';
import { ServerCrashIcon, SquareTerminalIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { STATUS_DOTS } from '@/components/live-terminals';
import { StatusIcon } from '@/components/sessions';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { restoreFromDaemon } from '@/components/workspace-panes';
import { stoppedMessage } from '@/components/workspace-layout';
import { cn } from 'cn';
import type { DaemonStatus, OutdatedTerminal } from '../../shared/api';

// Whether "Try again" is waiting for the service. The failure view and the sidebar's line both go
// while it does, and come back (with the new reason) or stay gone once it ended.
let inProgress = false;
const listeners = new Set<() => void>();

function setRetrying(value: boolean) {
  inProgress = value;
  for (const listener of listeners) listener();
}

export function useRetrying(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => inProgress,
  );
}

/** Starts the service again ("Try again" of the failure view, "Restart" of the banner), then loads the pages again. */
function useRetry() {
  const router = useRouter();
  return async () => {
    setRetrying(true);
    try {
      if ((await window.api.daemon.retry()).status !== 'down') await restoreFromDaemon(true);
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  };
}

// Shown in the main area of the pages that need the background service, when it could not start.
// Projects and workspaces do not need it and stay usable.
export function DaemonDown({ status }: { status: Extract<DaemonStatus, { status: 'down' }> }) {
  const retrying = useRetrying();
  const retry = useRetry();

  if (retrying) {
    return <p className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">Starting the background service…</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <ServerCrashIcon className="size-5 text-destructive" />
      <h2 className="font-heading text-sm font-medium">Cockpit's background service could not start</h2>
      <p className="text-xs text-muted-foreground">Terminals and agents run in this service. Your projects and workspaces are untouched.</p>
      <pre className="max-w-lg rounded-md bg-hover p-3 font-mono text-xs break-words whitespace-pre-wrap text-subtle">{status.reason}</pre>
      <div className="flex gap-2">
        <Button className="bg-brand text-brand-foreground hover:bg-brand/90" onClick={() => void retry()}>
          Try again
        </Button>
        {status.log && (
          <Button variant="outline" onClick={() => void window.api.daemon.showLog()}>
            Show log
          </Button>
        )}
      </div>
    </div>
  );
}

/** The banner of a page after the service died with `terminals` terminals, with the button that starts it again. */
export function ServiceStopped({ terminals, className }: { terminals: number; className?: string }) {
  const retry = useRetry();
  return (
    <div className={cn('flex h-8 shrink-0 items-center justify-between gap-2 rounded-md border border-status-working/25 bg-status-working/10 pr-1 pl-3 text-xs', className)}>
      <span className="flex items-center gap-2 text-status-working">
        <TriangleAlertIcon className="size-3.5 shrink-0" />
        <span>{stoppedMessage(terminals)}</span>
      </span>
      <Button variant="outline" size="sm" onClick={() => void retry()}>
        Restart
      </Button>
    </div>
  );
}

/**
 * Offered once per launch when a service of another protocol still holds terminals: ending it ends them.
 * "Later" keeps it until the next launch.
 */
export function RestartServiceDialog() {
  const router = useRouter();
  const [terminals, setTerminals] = useState<OutdatedTerminal[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void window.api.daemon.outdated().then((found) => {
      setTerminals(found);
      setOpen(found.length > 0);
    });
  }, []);

  function later() {
    setOpen(false);
    void window.api.daemon.later();
  }

  async function restart() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.api.daemon.restart();
      if (result.status === 'refused') {
        setError(result.message);
        return;
      }
      setOpen(false);
      // The sessions it held are not held any more: their tabs come back as ended.
      await restoreFromDaemon(true);
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && later()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart the background service?</AlertDialogTitle>
          <AlertDialogDescription>Restarting it ends {terminals.length === 1 ? 'this terminal' : `these ${terminals.length} terminals`}:</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex flex-col gap-1 text-xs">
          {terminals.map(({ kind, name, program, status }, index) => (
            <li key={index} className="flex items-center gap-2">
              {kind === 'shell' ? <SquareTerminalIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <StatusIcon label={status && STATUS_DOTS[status]} />}
              <span className="truncate">{name}</span>
              <span className="text-subtle">·</span>
              <span className="truncate text-muted-foreground">{program}</span>
            </li>
          ))}
        </ul>
        {error !== undefined && (
          <p role="alert" className="text-xs break-words text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Later</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void restart()}>
            Restart and end terminals
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
