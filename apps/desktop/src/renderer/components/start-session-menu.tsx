import { PlusIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { AvailableHarness } from '../../shared/api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

// The detected agent CLIs, as the last detection answered, shared by every menu that lists them: a
// "Detect again" shows in all of them. `undefined` until the first answer.
let detected: AvailableHarness[] | undefined;
let latest = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Reads the detection (`again`: runs it again). The first run can take a while: it runs each CLI's `--version`. */
export async function detectHarnesses(again = false): Promise<void> {
  const request = ++latest;
  const found = await window.api.sessions.harnesses(again ? { again } : undefined);
  // An older answer never replaces a newer one.
  if (request !== latest) return;
  detected = found;
  for (const listener of listeners) listener();
}

export const useDetectedHarnesses = () => useSyncExternalStore(subscribe, () => detected);

// A `+` button whose menu lists the detected harnesses, read each time it opens.
// The first read can take a while: a disabled item says so.
export function StartSessionMenu({
  label,
  className,
  onStart,
}: {
  label: string;
  className?: string;
  onStart: (harness: string) => void;
}) {
  const harnesses = useDetectedHarnesses();

  return (
    <DropdownMenu onOpenChange={(open) => open && void detectHarnesses()}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} className={className} />}>
        <PlusIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto">
        {harnesses === undefined && <DropdownMenuItem disabled>Detecting agent CLIs…</DropdownMenuItem>}
        {harnesses?.map((harness) => (
          <DropdownMenuItem key={harness.id} onClick={() => onStart(harness.id)}>
            {harness.name}
          </DropdownMenuItem>
        ))}
        {harnesses?.length === 0 && <DropdownMenuItem disabled>No agent CLI found</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
