import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BranchStatusResult, ChangesResult, Project, PullRequestResult, Workspace } from '../../shared/api';
import { readPullRequests } from '@/components/pull-request-reads';
import { requestDeleteWorkspace } from '@/components/projects';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const CHECKS = {
  pending: 'Checks pending',
  passing: 'Checks passing',
  failing: 'Checks failing',
  unknown: 'Checks unknown',
} as const;

const STATES = { open: 'Open', merged: 'Merged', closed: 'Closed' } as const;

/** Why a call to the main process could not be made, as a message. */
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

function CreatePullRequestDialog({
  project,
  workspace,
  base,
  subject,
  onClose,
  onCreated,
}: {
  project: Project;
  workspace: Workspace;
  base: string;
  subject: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState(subject);
  const [body, setBody] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const titleField = useRef<HTMLInputElement>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (title.trim() === '' || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await window.api.workspaces.createPullRequest(project.path, workspace.path, title, body);
      if (result.status === 'refused') setMessage(result.message);
      else onCreated();
    } catch (error) {
      setMessage(reason(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent initialFocus={titleField}>
        <DialogHeader>
          <DialogTitle>Create pull request</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {workspace.name} into {base}
          </p>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void create(event)}>
          <div className="grid gap-2">
            <Label htmlFor="pull-request-title">Title</Label>
            <Input id="pull-request-title" ref={titleField} value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pull-request-body">Description</Label>
            <Textarea id="pull-request-body" value={body} onChange={(event) => setBody(event.target.value)} />
          </div>
          {message && (
            <p role="status" className="text-xs break-words text-destructive">
              {message}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={title.trim() === '' || busy}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The block of the Changes sidebar between its strip and the file list: the commit field, the Push
 * button and the workspace's pull request. It reads the pull request through `gh` (see
 * `readPullRequests`) while mounted; `status` is the git state the sidebar read, and `onShipped` asks
 * the sidebar to read it again after a commit or a push.
 */
export function ShipSection({
  project,
  workspace,
  changes,
  status,
  onShipped,
}: {
  project: Project;
  workspace: Workspace;
  changes: ChangesResult | undefined;
  status: BranchStatusResult | undefined;
  onShipped: () => void;
}) {
  const [pullRequest, setPullRequest] = useState<PullRequestResult>();
  const reads = useRef<ReturnType<typeof readPullRequests>>(undefined);
  const [message, setMessage] = useState('');
  // Why the last commit or push failed.
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  // The sidebar is keyed by workspace, so one workspace is read for the section's lifetime.
  useEffect(() => {
    reads.current = readPullRequests(project.path, workspace.path, setPullRequest);
    return () => reads.current?.stop();
  }, [project.path, workspace.path]);

  const git = status?.status === 'read' ? status : undefined;
  const found = pullRequest?.status === 'read' ? pullRequest.pullRequest : undefined;

  // Runs a commit or a push; once it succeeded, the sidebar and the pull request are read again.
  async function ship(run: () => Promise<{ status: string; message?: string }>) {
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await run();
      if (result.status === 'refused') {
        setFailure(result.message);
        return false;
      }
      onShipped();
      reads.current?.refresh();
      return true;
    } catch (error) {
      setFailure(reason(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function commit(event: FormEvent) {
    event.preventDefault();
    if (!git?.uncommitted || message.trim() === '' || busy) return;
    if (await ship(() => window.api.workspaces.commit(project.path, workspace.path, message))) setMessage('');
  }

  const base = changes?.status === 'listed' ? changes.base.replace(/^origin\//, '') : undefined;
  const pushed = git !== undefined && git.upstream !== null && !git.unpushed;
  // Pull requests are offered once `gh` answered, for a branch with no pull request or only a closed one.
  const canOffer = pullRequest?.status === 'read' && (found === null || found?.state === 'closed') && git?.branch != null;

  return (
    <section className="flex shrink-0 flex-col gap-3 border-b p-3 text-xs">
      <form className="flex gap-2" onSubmit={(event) => void commit(event)}>
        <Input aria-label="Commit message" placeholder="Commit message" value={message} onChange={(event) => setMessage(event.target.value)} />
        <Button type="submit" size="sm" disabled={!git?.uncommitted || message.trim() === '' || busy}>
          Commit
        </Button>
      </form>
      {git?.unpushed && (
        <div>
          <Button size="sm" disabled={busy} onClick={() => void ship(() => window.api.workspaces.push(project.path, workspace.path))}>
            Push
          </Button>
        </div>
      )}
      {failure && <p role="status" className="break-words text-destructive">{failure}</p>}
      {pullRequest?.status === 'refused' && <p className="break-words text-muted-foreground">{pullRequest.message}</p>}
      {found && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a href={found.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">
            #{found.number} {found.title}
          </a>
          <span className="text-muted-foreground">{STATES[found.state]}</span>
          {found.state === 'open' && found.checks !== 'none' && <span className="text-muted-foreground">{CHECKS[found.checks]}</span>}
          {found.state === 'merged' && (
            <Button size="sm" onClick={() => requestDeleteWorkspace(project, workspace)}>
              Delete workspace…
            </Button>
          )}
        </div>
      )}
      {canOffer && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!pushed || base === undefined} onClick={() => setCreating(true)}>
            Create pull request
          </Button>
          {!pushed && <span className="text-muted-foreground">Push the branch first.</span>}
        </div>
      )}
      {creating && base !== undefined && git && (
        <CreatePullRequestDialog
          project={project}
          workspace={workspace}
          base={base}
          subject={git.subject}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reads.current?.refresh();
          }}
        />
      )}
    </section>
  );
}
