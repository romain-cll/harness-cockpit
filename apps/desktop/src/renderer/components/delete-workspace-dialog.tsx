import { LoaderCircleIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
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
import { Checkbox } from '@/components/ui/checkbox';

export function DeleteWorkspaceDialog({
  project,
  workspace,
  onClose,
  onRemoved,
}: {
  project: Project;
  workspace: Workspace;
  onClose: () => void;
  /** Called once the workspace is gone (its worktree, for a linked one); `branchKept` says its branch was not merged and stays. */
  onRemoved: (branchKept: boolean) => Promise<void>;
}) {
  // What the dialog read when it opened: whether the worktree holds uncommitted changes, whether the branch is
  // merged. Delete waits for it; a refused read shows its message and forces nothing.
  const [read, setRead] = useState(false);
  const [merged, setMerged] = useState<boolean | null>(null);
  // The warning on screen: found at opening, or by git's refusal of a worktree that changed since.
  const [warning, setWarning] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const labelId = useId();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The branch box is shown once the read answered, for a workspace listed with a branch.
  const boxShown = read && workspace.branch !== null && !workspace.main;
  // The teardown runs once per dialog, in a terminal the dialog shows; it ends with the dialog.
  const [terminal, setTerminal] = useState<LiveTerminal>();
  const tornDown = useRef(false);
  const shown = useRef<LiveTerminal>(undefined);
  const closed = useRef(false);
  // The teardown failed (or could not run): the user may delete the workspace anyway.
  const [teardownFailed, setTeardownFailed] = useState(false);
  // The teardown's terminal is up and its commands have not ended.
  const [tearingDown, setTearingDown] = useState(false);

  useEffect(() => {
    closed.current = false;
    void window.api.workspaces.removal(project.path, workspace.path).then((result) => {
      if (closed.current) return;
      if (result.status === 'read') {
        setWarning(result.uncommitted);
        setMerged(result.merged);
        setDeleteBranch(result.merged === true);
      } else {
        setMessage(result.message);
      }
      setRead(true);
    });
    return () => {
      closed.current = true;
      if (shown.current) closeLiveTerminal(shown.current);
    };
  }, [project.path, workspace.path]);

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
    setTearingDown(true);
    const exit = await result.exit;
    setTearingDown(false);
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
      // Send only what the dialog shows: the warning forces the removal; the checked box deletes the branch,
      // and with the "Not merged" hint on screen forces it, by the name shown.
      const result = await window.api.workspaces.remove(project.path, workspace.path, {
        force: warning || undefined,
        deleteBranch: (boxShown && deleteBranch) || undefined,
        forceBranch: boxShown && deleteBranch && merged === false ? workspace.branch! : undefined,
      });
      if (result.status === 'dirty') setWarning(true);
      else if (result.status === 'refused') setMessage(result.message);
      else await onRemoved(result.branchKept);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className={terminal && 'w-[460px]'}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {workspace.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {workspace.main
              ? `This ends its running sessions. Nothing is removed from the disk: the project's folder and its branch stay as they are.`
              : `This deletes the worktree, the workspace's folder on this Mac, and ends its running sessions.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="rounded-md border bg-muted px-2 py-1.5 text-xs break-all">{workspace.path}</div>
        {warning && <p className="text-xs/[18px] text-destructive">It has uncommitted changes. They will be lost.</p>}
        {boxShown && (
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={deleteBranch} onCheckedChange={setDeleteBranch} disabled={busy} aria-labelledby={labelId} />
              <span id={labelId}>Also delete the local branch {workspace.branch}</span>
            </label>
            {merged === false && <p className="pl-6 text-xs/[18px] text-muted-foreground">Not merged: its commits will be lost.</p>}
          </div>
        )}
        {terminal && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">{tearingDown ? 'Running teardown…' : 'Teardown'}</p>
            <div className="h-[120px] overflow-hidden rounded-md border">
              <Terminal live={terminal} focused={false} />
            </div>
          </div>
        )}
        {message && (
          <p role="status" className="text-xs break-words text-destructive">
            {message}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!read || busy} onClick={() => void remove()}>
            {busy && <LoaderCircleIcon className="animate-spin" />}
            {teardownFailed ? 'Delete anyway' : 'Delete'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
