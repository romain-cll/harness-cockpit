import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleQuestionMarkIcon,
  CircleXIcon,
  FileDiffIcon,
  GitMergeIcon,
  MessageSquareIcon,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { MergeMethod, Project, PullRequest, Workspace } from '../../shared/api';
import { checksHeader, checkTime, overallReview, sortChecks } from '@/components/pull-request-format';
import { projectColour } from '@/components/project-colour';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const METHODS: Record<MergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
};

const MERGE_BUTTON = 'bg-brand text-brand-foreground hover:bg-brand/90';

/**
 * The merge button, the menu of its method and the confirmation dialog of an open pull request. `onMerged` asks for
 * the pull request to be read again. Why `gh` refused a merge shows under the row.
 */
export function MergeRow({
  project,
  workspace,
  pullRequest,
  base,
  unpushed,
  onMerged,
}: {
  project: Project;
  workspace: Workspace;
  pullRequest: PullRequest;
  /** The branch the pull request goes into, `undefined` until the changes are read. */
  base: string | undefined;
  unpushed: number;
  onMerged: () => void;
}) {
  const [method, setMethod] = useState<MergeMethod>('squash');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const label = METHODS[method];

  async function merge() {
    setConfirming(false);
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await window.api.workspaces.mergePullRequest(project.path, workspace.path, pullRequest.number, method, pullRequest.headOid);
      if (result.status === 'refused') setFailure(result.message);
      else onMerged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-px">
        <Button
          disabled={busy || base === undefined}
          className={`h-7 flex-1 gap-1.5 rounded-l-lg rounded-r-none text-xs ${MERGE_BUTTON}`}
          onClick={() => setConfirming(true)}
        >
          <GitMergeIcon className="size-3.5" />
          {label}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button aria-label="Merge method" disabled={busy} className={`size-7 rounded-l-none rounded-r-lg ${MERGE_BUTTON}`} />}>
            <ChevronDownIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuRadioGroup value={method} onValueChange={(value) => setMethod(value as MergeMethod)}>
              {(Object.keys(METHODS) as MergeMethod[]).map((each) => (
                <DropdownMenuRadioItem key={each} value={each} closeOnClick>
                  {METHODS[each]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {failure && (
        <p role="status" className="text-xs break-words text-destructive">
          {failure}
        </p>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`${label} #${pullRequest.number} into ${base}?`}</AlertDialogTitle>
            {unpushed > 0 && (
              <AlertDialogDescription>
                {`${unpushed} local ${unpushed === 1 ? 'commit is' : 'commits are'} not pushed and will not be merged.`}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void merge()}>{label}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const SECTION = 'flex flex-col gap-0.5 border-t pt-3 pr-3 pb-3 pl-2';

function SectionHeader({ title, summary, summaryClass = 'text-muted-foreground' }: { title: string; summary?: string; summaryClass?: string }) {
  return (
    <div className="flex h-6 items-center justify-between gap-2 px-1">
      <h3 className="text-[11px] text-subtle">{title}</h3>
      {summary && <span className={`text-[11px] ${summaryClass}`}>{summary}</span>}
    </div>
  );
}

const CHECK_ICONS = {
  failing: { Icon: CircleXIcon, color: 'text-status-exited' },
  unknown: { Icon: CircleQuestionMarkIcon, color: 'text-muted-foreground' },
  pending: { Icon: CircleDashedIcon, color: 'text-status-working' },
  passing: { Icon: CircleCheckIcon, color: 'text-status-ready' },
} as const;

/** Each check, failing first, with its time as of `now` (milliseconds since the epoch); nothing without a check. */
export function ChecksSection({ checkRuns, now }: { checkRuns: PullRequest['checkRuns']; now: number }) {
  if (checkRuns.length === 0) return null;
  return (
    <section className={SECTION}>
      <SectionHeader title="Checks" summary={checksHeader(checkRuns)} />
      {sortChecks(checkRuns).map((run, index) => {
        const { Icon, color } = CHECK_ICONS[run.check];
        return (
          <div key={index} className="flex h-[26px] items-center gap-2 px-1">
            <Icon className={`size-3.5 shrink-0 ${color}`} />
            <span title={run.name} className="min-w-0 flex-1 truncate text-xs text-foreground">
              {run.name}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{checkTime(run, now)}</span>
          </div>
        );
      })}
    </section>
  );
}

const REVIEW_STATES = {
  changes_requested: { label: 'Changes requested', Icon: FileDiffIcon, color: 'text-status-exited' },
  approved: { label: 'Approved', Icon: CircleCheckIcon, color: 'text-status-ready' },
  commented: { label: 'Commented', Icon: MessageSquareIcon, color: 'text-muted-foreground' },
  dismissed: { label: 'Dismissed', Icon: MessageSquareIcon, color: 'text-muted-foreground' },
  unknown: { label: 'Unknown', Icon: CircleQuestionMarkIcon, color: 'text-muted-foreground' },
} as const;

const OVERALL = {
  changes_requested: { label: 'Changes requested', color: 'text-diff-removed-foreground' },
  approved: { label: 'Approved', color: 'text-status-ready' },
  review_required: { label: 'Review required', color: 'text-muted-foreground' },
} as const;

/** Each reviewer's latest review and the overall state; nothing without either. */
export function ReviewsSection({ reviewDecision, reviews }: { reviewDecision: string; reviews: PullRequest['reviews'] }) {
  const overall = overallReview(reviewDecision, reviews);
  if (overall === null && reviews.length === 0) return null;
  return (
    <section className={SECTION}>
      <SectionHeader title="Reviews" summary={overall ? OVERALL[overall].label : undefined} summaryClass={overall ? OVERALL[overall].color : undefined} />
      {reviews.map(({ login, state }, index) => {
        const { label, Icon, color } = REVIEW_STATES[state];
        return (
          <div key={index} className="flex h-7 items-center gap-1 px-1">
            <span className={`flex size-[18px] shrink-0 items-center justify-center rounded-full text-[9px] leading-none text-project-foreground ${projectColour(login)}`}>
              {login.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate pl-1 text-xs text-foreground">{login}</span>
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Icon className={`size-3.5 ${color}`} />
              {label}
            </span>
          </div>
        );
      })}
    </section>
  );
}

/** The height a description is folded to, in pixels (Tailwind's `max-h-24`). */
const FOLDED = 96;

/** The pull request's body as Markdown: raw HTML is not rendered, an image is its alt text, a link opens outside. */
export function DescriptionSection({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const [tall, setTall] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Whether the body, shown whole, is taller than the folded height. A tab that is not shown has no height: the
  // observer measures again when the section gets one.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setTall(element.scrollHeight > FOLDED);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [body, expanded]);

  if (body.trim() === '') return null;
  return (
    <section className="flex flex-col gap-1.5 border-t pt-3 pr-4 pb-3.5 pl-3">
      <h3 className="text-[11px] text-subtle">Description</h3>
      <div
        ref={box}
        className={`text-xs/[18px] break-words text-foreground [&_:is(h1,h2,h3,h4,h5,h6)]:text-muted-foreground [&_a]:text-brand [&_a]:underline [&_code]:font-mono [&_code]:text-[11px] [&_ol]:list-decimal [&_ol]:pl-4 [&_p:not(:first-child)]:mt-2 [&_strong]:font-normal [&_ul]:list-disc [&_ul]:pl-4 ${expanded ? '' : 'max-h-24 overflow-hidden'}`}
      >
        <Markdown
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
            img: ({ alt }) => <span>{alt}</span>,
          }}
        >
          {body}
        </Markdown>
      </div>
      {tall && (
        <button type="button" className="self-start text-[11px] text-brand" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </section>
  );
}
