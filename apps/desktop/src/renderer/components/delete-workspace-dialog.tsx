import { useEffect, useRef, useState } from 'react';
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
import { closeLiveTerminal, failureLine, passed, runWorkspaceTeardown, type LiveTerminal } from '@/components/live-terminals';
import { Terminal } from '@/components/terminal';
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
  // The teardown runs once per dialog, in a terminal the dialog shows; it ends with the dialog.
  const [terminal, setTerminal] = useState<LiveTerminal>();
  const tornDown = useRef(false);
  const shown = useRef<LiveTerminal>(undefined);
  const closed = useRef(false);
  // The teardown failed (or could not run): the user may delete the workspace anyway.
  const [teardownFailed, setTeardownFailed] = useState(false);

  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (shown.current) closeLiveTerminal(shown.current);
    };
  }, []);

  // Whether the teardown passed (or there was none); otherwise says why in the dialog.
  async function teardown(): Promise<boolean> {
    const result = await runWorkspaceTeardown(project.path, workspace.path);
    if (result.status === 'none') return true;
    if (result.status === 'refused') {
      setMessage(result.message);
      return false;
    }
    // The dialog was closed while the commands were starting.
    if (closed.current) {
      closeLiveTerminal(result.entry);
      return false;
    }
    shown.current = result.entry;
    setTerminal(result.entry);
    const exit = await result.exit;
    // The commands are over: the terminal gives the keyboard back, so Escape closes the dialog (xterm.js would swallow it).
    result.entry.term.blur();
    if (passed(exit)) return true;
    setMessage(failureLine(exit));
    return false;
  }

  async function remove() {
    setBusy(true);
    setMessage(undefined);
    try {
      if (!tornDown.current) {
        const passed = await teardown();
        tornDown.current = true;
        if (!passed) {
          setTeardownFailed(true);
          return;
        }
      }
      const result = await window.api.workspaces.remove(project.path, workspace.path, { force: dirty });
      if (result.status === 'dirty') setDirty(true);
      else if (result.status === 'refused') setMessage(result.message);
      else await onRemoved(result.branchKept);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className={terminal && 'data-[size=default]:sm:max-w-2xl'}>
        <AlertDialogHeader>
          <AlertDialogTitle>{dirty ? `${workspace.name} has uncommitted changes` : `Delete ${workspace.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {dirty
              ? `The folder ${workspace.path} is deleted from disk and its uncommitted changes will be lost.`
              : `The folder ${workspace.path} is deleted from disk.${workspace.branch === null ? '' : ` The branch ${workspace.branch} is deleted too if it is merged.`}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {terminal && (
          <div className="h-48 overflow-hidden rounded-md border">
            <Terminal live={terminal} focused={false} />
          </div>
        )}
        {message && (
          <p role="status" className="text-xs break-words text-destructive">
            {message}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {dirty || teardownFailed ? 'Delete anyway' : 'Delete'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
