import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import type { AvailableHarness } from '../../shared/api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

// A `+` button whose menu lists the detected harnesses, fetched each time it opens.
// The first fetch can take a while (it runs each CLI's `--version`): a disabled item says so.
export function StartSessionMenu({
  label,
  className,
  onStart,
}: {
  label: string;
  className?: string;
  onStart: (harness: string) => void;
}) {
  const [harnesses, setHarnesses] = useState<AvailableHarness[]>();

  return (
    <DropdownMenu onOpenChange={(open) => open && void window.api.sessions.harnesses().then(setHarnesses)}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} className={className} />}>
        <PlusIcon />
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
