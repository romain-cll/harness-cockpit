import { useRouter } from '@tanstack/react-router';
import { TriangleAlertIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { restoreTerminals } from '@/components/live-terminals';
import { restoreTabs } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import type { DaemonStatus } from '../../shared/api';

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

// Shown in the main area of the pages that need the background service, when it could not start.
// Projects and workspaces do not need it and stay usable.
export function DaemonDown({ status }: { status: Extract<DaemonStatus, { status: 'down' }> }) {
  const router = useRouter();
  const retrying = useRetrying();

  async function retry() {
    setRetrying(true);
    try {
      if ((await window.api.daemon.retry()).status === 'running') restoreTabs(await restoreTerminals(true));
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  }

  if (retrying) {
    return <p className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">Starting the background service…</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <TriangleAlertIcon className="size-6 text-muted-foreground" />
      <h2 className="font-heading text-sm font-medium">Cockpit's background service could not start</h2>
      <p className="text-xs text-muted-foreground">Terminals and agents run in this service. Your projects and workspaces are untouched.</p>
      <pre className="max-w-lg rounded-md border bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap">{status.reason}</pre>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => void retry()}>
          Try again
        </Button>
        {status.log && (
          <Button variant="ghost" onClick={() => void window.api.daemon.showLog()}>
            Show log
          </Button>
        )}
      </div>
    </div>
  );
}
