import { ArrowUpIcon, ChevronRightIcon, ExternalLinkIcon, FileDiffIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BranchStatusResult, ChangedFile, ChangesResult, Project, PullRequestResult, Workspace } from '../../shared/api';
import { openRightBar } from '@/components/changes-panel';
import { ChecksSection, DescriptionSection, MergeRow, ReviewsSection } from '@/components/pull-request-details';
import { readPullRequests } from '@/components/pull-request-reads';
import { refreshPullRequestStates } from '@/components/pull-request-states';
import { requestDeleteWorkspace } from '@/components/projects';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const STATES = {
  open: { label: 'Open', Icon: GitPullRequestIcon, color: 'bg-status-ready/14 text-status-ready' },
  merged: { label: 'Merged', Icon: GitMergeIcon, color: 'bg-status-merged/14 text-status-merged' },
  closed: { label: 'Closed', Icon: GitPullRequestClosedIcon, color: 'bg-status-exited/14 text-status-exited' },
} as const;

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

// The files changed against the base with the Diff tab's totals, which it leads to.
function DiffRow({ files }: { files: ChangedFile[] }) {
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return (
    <button
      type="button"
      className="flex h-8 w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left hover:bg-hover"
      onClick={() => openRightBar('diff')}
    >
      <FileDiffIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-xs text-foreground">{`${files.length} ${files.length === 1 ? 'file' : 'files'} changed`}</span>
      {additions > 0 && <span className="text-[11px] text-diff-added-foreground">+{additions}</span>}
      {deletions > 0 && <span className="text-[11px] text-diff-removed-foreground">−{deletions}</span>}
      <span className="ml-auto flex items-center gap-0.5 text-[11px] text-muted-foreground">
        View diff
        <ChevronRightIcon className="size-3.5" />
      </span>
    </button>
  );
}

/**
 * The content of the right bar's "Pull request" tab: the workspace's pull request with its merge row, the
 * button that creates one, the files changed, the commit and push section, then the checks, reviews and
 * description of the pull request. It reads the pull request through `gh` (see
 * `readPullRequests`) while mounted; `status` is the git state the bar read, and `onShipped` asks
 * the bar to read it again after a commit or a push.
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
  // When the pull request was read: a running check counts from it.
  const [readAt, setReadAt] = useState(0);
  const reads = useRef<ReturnType<typeof readPullRequests>>(undefined);
  const [message, setMessage] = useState('');
  // Why the last commit or push failed.
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  // The sidebar is keyed by workspace, so one workspace is read for the section's lifetime.
  useEffect(() => {
    reads.current = readPullRequests(project.path, workspace.path, (result) => {
      setPullRequest(result);
      setReadAt(Date.now());
    });
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

  // The bar's pull request and the sidebar's icons are read again, with no window focus.
  function pullRequestChanged() {
    reads.current?.refresh();
    refreshPullRequestStates(project.path);
  }

  const files = changes?.status === 'listed' ? changes.files : [];
  const base = changes?.status === 'listed' ? changes.base.replace(/^origin\//, '') : undefined;
  const unpushed = git?.unpushed ?? 0;
  const pushed = git !== undefined && git.upstream !== null && unpushed === 0;
  // Pull requests are offered once `gh` answered, for a branch with no pull request or only a closed one.
  const canOffer = pullRequest?.status === 'read' && (found === null || found?.state === 'closed') && git?.branch != null;
  const state = found && STATES[found.state];

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 p-3">
        {pullRequest?.status === 'refused' && <p className="text-xs break-words text-muted-foreground">{pullRequest.message}</p>}
        {found && state && (
          <div className="flex flex-col gap-2">
            <div className="flex h-6 items-center gap-2">
              <span className={`inline-flex h-5 items-center gap-1 rounded-lg px-2 text-[11px] ${state.color}`}>
                <state.Icon className="size-3" />
                {state.label}
              </span>
              <span className="text-[11px] text-muted-foreground">{`#${found.number} · ${found.author}`}</span>
              <a
                href={found.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open on GitHub"
                title="Open on GitHub"
                className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover"
              >
                <ExternalLinkIcon className="size-3.5" />
              </a>
            </div>
            <p className="text-[13px] leading-[18px] break-words text-foreground">{found.title}</p>
            {git?.branch && (
              <p className="font-mono text-[11px] break-all text-muted-foreground">{`${git.branch} → ${found.base}`}</p>
            )}
            {found.state === 'open' && (
              <MergeRow
                project={project}
                workspace={workspace}
                pullRequest={found}
                onMerged={pullRequestChanged}
              />
            )}
            {found.state === 'merged' && (
              <div>
                <Button size="sm" onClick={() => requestDeleteWorkspace(project, workspace)}>
                  Delete workspace…
                </Button>
              </div>
            )}
          </div>
        )}
        {canOffer && (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!pushed || base === undefined} onClick={() => setCreating(true)}>
              Create pull request
            </Button>
            {!pushed && <span className="text-[11px] text-muted-foreground">Push the branch first.</span>}
          </div>
        )}
        {files.length > 0 && <DiffRow files={files} />}
      </div>
      <section className="flex flex-col gap-2 border-t p-3">
        <h3 className="text-[11px] text-subtle">{'Commit & push'}</h3>
        <form className="flex gap-2" onSubmit={(event) => void commit(event)}>
          <Input
            aria-label="Commit message"
            placeholder="Commit message"
            className="h-8"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <Button type="submit" variant="outline" size="lg" disabled={!git?.uncommitted || message.trim() === '' || busy}>
            Commit
          </Button>
        </form>
        {unpushed > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">{unpushed === 1 ? '1 commit to push' : `${unpushed} commits to push`}</span>
            <Button size="sm" disabled={busy} onClick={() => void ship(() => window.api.workspaces.push(project.path, workspace.path))}>
              <ArrowUpIcon />
              Push
            </Button>
          </div>
        )}
        {failure && (
          <p role="status" className="text-xs break-words text-destructive">
            {failure}
          </p>
        )}
      </section>
      {found && (
        <>
          <ChecksSection checkRuns={found.checkRuns} now={readAt} />
          <ReviewsSection reviewDecision={found.reviewDecision} reviews={found.reviews} />
          <DescriptionSection body={found.body} />
        </>
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
            pullRequestChanged();
          }}
        />
      )}
    </div>
  );
}
