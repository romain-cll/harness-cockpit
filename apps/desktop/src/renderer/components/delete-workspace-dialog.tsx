import { useState } from 'react';
import type { Project, Workspace } from '../../shared/api';
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

export function DeleteWorkspaceDialog({
  project,
  workspace,
  onClose,
  onRemoved,
}: {
  project: Project;
  workspace: Workspace;
  onClose: () => void;
  /** Called once the worktree is gone; `branchKept` says its branch was not merged and stays. */
  onRemoved: (branchKept: boolean) => Promise<void>;
}) {
  // Second step: git found uncommitted changes, and the user must agree to lose them.
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    setMessage(undefined);
    const result = await window.api.workspaces.remove(project.path, workspace.path, { force: dirty });
    setBusy(false);
    if (result.status === 'dirty') setDirty(true);
    else if (result.status === 'refused') setMessage(result.message);
    else await onRemoved(result.branchKept);
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{dirty ? `${workspace.name} has uncommitted changes` : `Delete ${workspace.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {dirty
              ? `The folder ${workspace.path} is deleted from disk and its uncommitted changes will be lost.`
              : `The folder ${workspace.path} is deleted from disk.${workspace.branch === null ? '' : ` The branch ${workspace.branch} is deleted too if it is merged.`}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {message && (
          <p role="status" className="text-xs break-words text-destructive">
            {message}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {dirty ? 'Delete anyway' : 'Delete'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
