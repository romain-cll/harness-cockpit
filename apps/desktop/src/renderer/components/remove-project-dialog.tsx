import { useState } from 'react';
import type { Project } from '../../shared/api';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export function RemoveProjectDialog({
  project,
  onClose,
  onRemove,
}: {
  project: Project;
  onClose: () => void;
  /** Removes the project from Cockpit and ends its sessions; resolves to why it could not, if it could not. */
  onRemove: () => Promise<string | undefined>;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();

  async function remove() {
    setBusy(true);
    try {
      const refused = await onRemove();
      if (refused) return setRefusal(refused);
    } finally {
      setBusy(false);
    }
    onClose();
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {project.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the project from Cockpit. The repository stays on disk, and the sessions running in its workspaces end.
          </AlertDialogDescription>
          {refusal && (
            <p role="alert" className="text-xs break-words text-destructive">
              {refusal}
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
