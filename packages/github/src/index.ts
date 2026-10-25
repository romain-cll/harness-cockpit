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

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  checks: ChecksSummary;
}

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

type Check = Exclude<ChecksSummary, 'none'>;

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

/** The newest pull request of `branch`, whatever its state, or `null` when it has none. */
export async function findPullRequest(
  cwd: string,
  branch: string,
  { env }: { env?: NodeJS.ProcessEnv } = {},
): Promise<PullRequest | null> {
  const stdout = await gh(
    ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,title,url,state,statusCheckRollup'],
    cwd,
    env,
  );
  let found: { number: number; title: string; url: string; state: string; statusCheckRollup: Record<string, unknown>[] }[];
  try {
    found = JSON.parse(stdout);
  } catch (error) {
    throw new GitHubError('GH_FAILED', `unreadable answer from gh: ${stdout.trim()}`, { cause: error });
  }
  const [newest] = found;
  if (!newest) return null;
  return {
    number: newest.number,
    title: newest.title,
    url: newest.url,
    state: STATES[newest.state] ?? 'open',
    checks: checksSummary(newest.statusCheckRollup ?? []),
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
