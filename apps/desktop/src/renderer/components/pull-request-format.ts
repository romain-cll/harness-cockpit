// The pure rules of the Pull request tab's Checks and Reviews sections. No `@/` import: a vitest test imports this module.

type CheckState = 'failing' | 'unknown' | 'pending' | 'passing';

interface TimedCheck {
  check: CheckState;
  startedAt?: string | null;
  completedAt?: string | null;
}

const ORDER: readonly CheckState[] = ['failing', 'unknown', 'pending', 'passing'];

/** Failing first, then unknown, pending, passing, the given order within a group; a new array. */
export function sortChecks<T extends { check: CheckState }>(checks: readonly T[]): T[] {
  return ORDER.flatMap((state) => checks.filter((each) => each.check === state));
}

/** `3 checks · 1 failing`, else `3 checks · 1 pending`, else `3 checks` (`1 check` for one). */
export function checksHeader(checks: readonly { check: CheckState }[]): string {
  const count = (state: CheckState) => checks.filter((each) => each.check === state).length;
  const title = `${checks.length} ${checks.length === 1 ? 'check' : 'checks'}`;
  if (count('failing') > 0) return `${title} · ${count('failing')} failing`;
  if (count('pending') > 0) return `${title} · ${count('pending')} pending`;
  return title;
}

/** A time gh printed, in milliseconds; `null` for none and for gh's zero date (year 1). */
function instant(time: string | null | undefined): number | null {
  const ms = time ? Date.parse(time) : NaN;
  return ms > 0 ? ms : null;
}

/** `12s`, `6m 41s`, `1h 2m`. */
function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The right text of a check's row at `now` (milliseconds since the epoch); `''` for nothing to say. */
export function checkTime(check: TimedCheck, now: number): string {
  if (check.check === 'unknown') return '';
  const started = instant(check.startedAt);
  const completed = instant(check.completedAt);
  if (started !== null && completed !== null) return duration(completed - started);
  if (check.check !== 'pending') return '';
  if (started === null) return 'Queued';
  const elapsed = Math.max(0, now - started);
  return elapsed < 60_000 ? `Running · ${Math.floor(elapsed / 1000)}s` : `Running · ${Math.floor(elapsed / 60_000)}m`;
}

type OverallReview = 'changes_requested' | 'approved' | 'review_required';

const DECISIONS: Record<string, OverallReview> = {
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED: 'approved',
  REVIEW_REQUIRED: 'review_required',
};

/**
 * The overall review state: GitHub's `reviewDecision`, else (a repository requiring no review) derived from the
 * reviews: any changes requested, else any approval, else `null`. An unknown decision is `null` too.
 */
export function overallReview(decision: string, reviews: readonly { state: string }[]): OverallReview | null {
  if (decision !== '') return DECISIONS[decision] ?? null;
  if (reviews.some((review) => review.state === 'changes_requested')) return 'changes_requested';
  return reviews.some((review) => review.state === 'approved') ? 'approved' : null;
}
