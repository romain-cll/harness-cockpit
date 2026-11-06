import { execFile } from 'node:child_process';

export type GitHubErrorCode = 'GH_MISSING' | 'GH_UNAUTHENTICATED' | 'GH_FAILED';

/** The only error this package throws: a string `code` survives serialization over IPC. */
export class GitHubError extends Error {
  readonly code: GitHubErrorCode;

  constructor(code: GitHubErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitHubError';
    this.code = code;
  }
}

export type ChecksSummary = 'none' | 'pending' | 'passing' | 'failing' | 'unknown';

export type Check = Exclude<ChecksSummary, 'none'>;

export interface CheckRun {
  /** `<workflow> / <name>`, `<name>` without a workflow, the context for a status context. */
  name: string;
  check: Check;
  /** gh's raw strings (a zero date included), `null` when absent. */
  startedAt: string | null;
  completedAt: string | null;
}

export type ReviewState = 'changes_requested' | 'approved' | 'commented' | 'dismissed' | 'unknown';

export interface Review {
  login: string;
  state: ReviewState;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  checks: ChecksSummary;
  /** `ghost` when GitHub has no author (a deleted account). */
  author: string;
  body: string;
  headOid: string;
  /** `baseRefName`: the branch the pull request is into. */
  base: string;
  /** gh's raw `reviewDecision`, `''` when the repository requires no review. */
  reviewDecision: string;
  checkRuns: CheckRun[];
  reviews: Review[];
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** `gh help exit-codes`: 4 is "authentication required". */
const EXIT_AUTH_REQUIRED = 4;

/** Runs `gh` without a shell and resolves to its stdout. */
function gh(args: string[], cwd: string, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, env: { ...(env ?? process.env), GH_PROMPT_DISABLED: '1' } }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      // `code` is the exit code (a number) when the process ran, an errno name (a string) when it did not.
      const code: unknown = (error as { code?: unknown }).code;
      const message = stderr.trim() || error.message;
      if (code === 'ENOENT') reject(new GitHubError('GH_MISSING', message, { cause: error }));
      else if (code === EXIT_AUTH_REQUIRED) reject(new GitHubError('GH_UNAUTHENTICATED', message, { cause: error }));
      else reject(new GitHubError('GH_FAILED', message, { cause: error }));
    });
  });
}

// GitHub's GraphQL enums for `statusCheckRollup`; anything else reads as unknown.
const RUN_PENDING = ['IN_PROGRESS', 'QUEUED', 'WAITING', 'PENDING', 'REQUESTED'];
const RUN_PASSING = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
const RUN_FAILING = ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const CONTEXT_PENDING = ['PENDING', 'EXPECTED'];
const CONTEXT_PASSING = ['SUCCESS'];
const CONTEXT_FAILING = ['FAILURE', 'ERROR'];

function checkOf(entry: Record<string, unknown>): Check {
  if (entry.__typename === 'CheckRun') {
    if (RUN_PENDING.includes(entry.status as string)) return 'pending';
    if (entry.status !== 'COMPLETED') return 'unknown';
    if (RUN_PASSING.includes(entry.conclusion as string)) return 'passing';
    return RUN_FAILING.includes(entry.conclusion as string) ? 'failing' : 'unknown';
  }
  if (entry.__typename === 'StatusContext') {
    if (CONTEXT_PENDING.includes(entry.state as string)) return 'pending';
    if (CONTEXT_PASSING.includes(entry.state as string)) return 'passing';
    return CONTEXT_FAILING.includes(entry.state as string) ? 'failing' : 'unknown';
  }
  return 'unknown';
}

/** Failing wins over unknown, which wins over pending, which wins over passing; `none` without a check. */
export function checksSummary(rollup: readonly Record<string, unknown>[]): ChecksSummary {
  if (rollup.length === 0) return 'none';
  const checks = rollup.map(checkOf);
  return (['failing', 'unknown', 'pending'] as const).find((check) => checks.includes(check)) ?? 'passing';
}

const STATES: Record<string, PullRequest['state']> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

const REVIEW_STATES: Record<string, ReviewState> = {
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED: 'approved',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

interface ListedPullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  body?: string;
  headRefOid?: string;
  baseRefName?: string;
  reviewDecision?: string;
  author?: { login?: string } | null;
  statusCheckRollup?: Record<string, unknown>[] | null;
  latestReviews?: { author?: { login?: string } | null; state?: string }[] | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function checkRunOf(entry: Record<string, unknown>): CheckRun {
  const isContext = entry.__typename === 'StatusContext';
  const name = (isContext ? text(entry.context) : text(entry.name)) ?? '';
  const workflow = isContext ? null : text(entry.workflowName);
  return {
    name: workflow ? `${workflow} / ${name}` : name,
    check: checkOf(entry),
    startedAt: text(entry.startedAt),
    completedAt: text(entry.completedAt),
  };
}

/** The newest pull request of `branch`, whatever its state, or `null` when it has none. */
export async function findPullRequest(
  cwd: string,
  branch: string,
  { env }: { env?: NodeJS.ProcessEnv } = {},
): Promise<PullRequest | null> {
  const stdout = await gh(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      'number,title,url,state,author,baseRefName,body,headRefOid,latestReviews,reviewDecision,statusCheckRollup',
    ],
    cwd,
    env,
  );
  let found: ListedPullRequest[];
  try {
    found = JSON.parse(stdout);
  } catch (error) {
    throw new GitHubError('GH_FAILED', `unreadable answer from gh: ${stdout.trim()}`, { cause: error });
  }
  const [newest] = found;
  if (!newest) return null;
  const rollup = newest.statusCheckRollup ?? [];
  return {
    number: newest.number,
    title: newest.title,
    url: newest.url,
    state: STATES[newest.state] ?? 'open',
    checks: checksSummary(rollup),
    author: newest.author?.login ?? 'ghost',
    body: newest.body ?? '',
    headOid: newest.headRefOid ?? '',
    base: newest.baseRefName ?? '',
    reviewDecision: newest.reviewDecision ?? '',
    checkRuns: rollup.map(checkRunOf),
    reviews: (newest.latestReviews ?? [])
      .filter((review) => review.state !== 'PENDING')
      .map((review) => ({ login: review.author?.login ?? 'ghost', state: REVIEW_STATES[review.state ?? ''] ?? 'unknown' })),
  };
}

/** Opens a pull request of `head` into `base` with `gh pr create`, then reads it. */
export async function createPullRequest(
  cwd: string,
  { base, head, title, body }: { base: string; head: string; title: string; body: string },
  { env }: { env?: NodeJS.ProcessEnv } = {},
): Promise<PullRequest> {
  await gh(['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body], cwd, env);
  const created = await findPullRequest(cwd, head, { env });
  if (!created) throw new GitHubError('GH_FAILED', `no pull request found for ${head} after creating it`);
  return created;
}

const MERGE_FLAGS: Record<MergeMethod, string> = { squash: '--squash', merge: '--merge', rebase: '--rebase' };

/**
 * Merges pull request `number` with `gh pr merge`. `--match-head-commit` makes gh refuse when the head moved since
 * `headOid` was read. Never `--admin`, `--auto` or `--delete-branch`.
 */
export async function mergePullRequest(
  cwd: string,
  { number, method, headOid }: { number: number; method: MergeMethod; headOid: string },
  { env }: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await gh(['pr', 'merge', String(number), MERGE_FLAGS[method], '--match-head-commit', headOid], cwd, env);
}

/** `{owner}` and `{repo}` are gh's placeholders, resolved from the cwd's remote; branches travel as `-f` variables. */
const STATES_QUERY = (count: number) => {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variables = indexes.map((index) => `$b${index}:String!`).join(',');
  const aliases = indexes
    .map(
      (index) =>
        `b${index}:pullRequests(headRefName:$b${index},first:1,orderBy:{field:CREATED_AT,direction:DESC}){nodes{state}}`,
    )
    .join(' ');
  return `query($owner:String!,$repo:String!,${variables}){repository(owner:$owner,name:$repo){${aliases}}}`;
};

/** The state of the newest pull request of each branch in one `gh` run; a branch with none has no key. */
export async function pullRequestStates(
  cwd: string,
  branches: readonly string[],
  { env }: { env?: NodeJS.ProcessEnv } = {},
): Promise<Record<string, PullRequest['state']>> {
  if (branches.length === 0) return {};
  const stdout = await gh(
    [
      'api',
      'graphql',
      '-F',
      'owner={owner}',
      '-F',
      'repo={repo}',
      ...branches.flatMap((branch, index) => ['-f', `b${index}=${branch}`]),
      '-f',
      `query=${STATES_QUERY(branches.length)}`,
    ],
    cwd,
    env,
  );
  const unreadable = (cause?: unknown) =>
    new GitHubError('GH_FAILED', `unreadable answer from gh: ${stdout.trim()}`, { cause });
  let repository: Record<string, { nodes?: { state?: string }[] }> | null | undefined;
  try {
    repository = JSON.parse(stdout)?.data?.repository;
  } catch (error) {
    throw unreadable(error);
  }
  if (!repository || typeof repository !== 'object') throw unreadable();
  const states: Record<string, PullRequest['state']> = {};
  branches.forEach((branch, index) => {
    const state = STATES[repository[`b${index}`]?.nodes?.[0]?.state ?? ''];
    if (state) states[branch] = state;
  });
  return states;
}
