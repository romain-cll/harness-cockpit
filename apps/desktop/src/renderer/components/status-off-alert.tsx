import { TriangleAlertIcon } from 'lucide-react';

// Shown when the control endpoint could not start, so no session reports its status.
export function StatusOffAlert({ reason }: { reason: string }) {
  return (
    <div
      role="alert"
      className="mx-2 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-status-working/25 bg-status-working/10 p-2"
    >
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-status-working" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-xs text-status-working">Status icons are off</p>
        <p className="text-[11px] break-words text-muted-foreground">{reason}</p>
        <p className="text-[11px] text-muted-foreground">Fix it, then restart Cockpit.</p>
      </div>
    </div>
  );
}
