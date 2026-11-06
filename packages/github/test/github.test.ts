import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { checksSummary, createPullRequest, findPullRequest, GitHubError, mergePullRequest, pullRequestStates } from '../src/index';

// COCKPIT-38: the pull request of a branch, read and created through `gh`. The `gh` is a `#!/bin/sh` stub
// on a temporary `PATH` that logs what it was run with and answers from files; the real `gh` never runs.

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temporary folder, resolved to its real path (macOS `/var` is `/private/var`). */
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-github-')));
  created.push(dir);
  return dir;
}

interface Stub {
  /** The folder the stub is in: the `PATH` to run with. */
  bin: string;
  /** A folder to run `gh` in. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** What `pr list` prints, set before the call. */
  list(json: string): Promise<void>;
  /** What `api graphql` prints, set before the call. */
  graphql(json: string): Promise<void>;
  /** `[cwd, GH_PROMPT_DISABLED, MARKER, ...arguments]` of every run, in order. */
  runs(): Promise<string[][]>;
}

/**
 * A `gh` that logs each run (separated by RS, fields by US, so a multi-line argument survives), prints the
 * content of `list.json` for `pr list`, prints a URL for `pr create`, and exits with the code in `code`
 * after writing `stderr`, when those files exist. `pr create` fails only with `create-stderr`.
 */
async function makeStub(): Promise<Stub> {
  const bin = await tempDir();
  const cwd = await tempDir();
  const log = join(bin, 'runs.log');
  await writeFile(join(bin, 'list.json'), '[]');
  await writeFile(join(bin, 'graphql.json'), '{}');
  await writeFile(
    join(bin, 'gh'),
    `#!/bin/sh
printf '%s\\037' "$(pwd -P)" "$GH_PROMPT_DISABLED" "$MARKER" "$@" >> '${log}'
printf '\\036' >> '${log}'
if [ "$1 $2" = "pr create" ]; then
  if [ -s '${bin}/create-stderr' ]; then cat '${bin}/create-stderr' >&2; exit 1; fi
  echo 'https://github.test/acme/app/pull/7'
  exit 0
fi
[ -s '${bin}/stderr' ] && cat '${bin}/stderr' >&2
[ -e '${bin}/code' ] && exit "$(cat '${bin}/code')"
if [ "$1" = api ]; then cat '${bin}/graphql.json'; exit 0; fi
cat '${bin}/list.json'
`,
  );
  await chmod(join(bin, 'gh'), 0o755);
  return {
    bin,
    cwd,
    env: { PATH: `${bin}:/usr/bin:/bin`, MARKER: 'passed-env' },
    list: (json) => writeFile(join(bin, 'list.json'), json),
    graphql: (json) => writeFile(join(bin, 'graphql.json'), json),
    runs: async () => {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text
        .split('\x1e')
        .filter(Boolean)
        .map((run) => run.split('\x1f').slice(0, -1));
    },
  };
}

/** The fields of the `--json` argument of a run, sorted: the order gh is asked in does not matter. */
const jsonFields = (args: string[]) => args[args.indexOf('--json') + 1]!.split(',').sort();
const LIST_FIELDS = ['author', 'baseRefName', 'body', 'headRefOid', 'isCrossRepository', 'latestReviews', 'number', 'reviewDecision', 'state', 'statusCheckRollup', 'title', 'url'];

const failWith = (stub: Stub, { code, stderr }: { code: number; stderr: string }) =>
  Promise.all([writeFile(join(stub.bin, 'code'), String(code)), writeFile(join(stub.bin, 'stderr'), stderr)]);

const listJson = (...pullRequests: object[]) => JSON.stringify(pullRequests);
const pr = (over: object = {}) => ({
  number: 7,
  title: 'Fix the bug',
  url: 'https://github.test/acme/app/pull/7',
  state: 'OPEN',
  statusCheckRollup: [],
  ...over,
});

async function failure(promise: Promise<unknown>): Promise<GitHubError> {
  const outcome = await promise.then(
    (value) => ({ resolved: true as const, value }),
    (error: unknown) => ({ resolved: false as const, error }),
  );
  if (outcome.resolved) throw new Error(`expected a rejection, got ${JSON.stringify(outcome.value)}`);
  expect(outcome.error).toBeInstanceOf(GitHubError);
  return outcome.error as GitHubError;
}

describe('findPullRequest', () => {
  test('AC1 — runs gh pr list for the branch, all states, the newest 30, in the given folder with GH_PROMPT_DISABLED=1 and the env passed, asking for the author, body, head, reviews, checks and whether it is cross-repository', async () => {
    const stub = await makeStub();

    await findPullRequest(stub.cwd, 'feature/login', { env: stub.env });

    const [run] = await stub.runs();
    expect(await stub.runs()).toHaveLength(1);
    expect(run!.slice(0, 11)).toEqual([stub.cwd, '1', 'passed-env', 'pr', 'list', '--head', 'feature/login', '--state', 'all', '--limit', '30']);
    expect(run![11]).toBe('--json');
    expect(jsonFields(run!)).toEqual(LIST_FIELDS);
    expect(run).toHaveLength(13);
  });

  test('COCKPIT-71 AC18 — a newer pull request from a fork is ignored: the repository\'s own, older, is the answer', async () => {
    const stub = await makeStub();
    await stub.list(
      listJson(
        pr({ number: 9, title: 'From a fork', state: 'OPEN', isCrossRepository: true }),
        pr({ number: 7, title: 'Our own', state: 'MERGED', isCrossRepository: false }),
      ),
    );

    expect(await findPullRequest(stub.cwd, 'main', { env: stub.env })).toMatchObject({ number: 7, title: 'Our own', state: 'merged' });
  });

  test('COCKPIT-71 AC18 — only pull requests from forks is no pull request', async () => {
    const stub = await makeStub();
    await stub.list(listJson(pr({ number: 9, isCrossRepository: true }), pr({ number: 8, isCrossRepository: true })));

    expect(await findPullRequest(stub.cwd, 'main', { env: stub.env })).toBeNull();
  });

  test('AC1 — gives null when the branch has no pull request', async () => {
    const stub = await makeStub();
    await stub.list('[]');

    expect(await findPullRequest(stub.cwd, 'feat', { env: stub.env })).toBeNull();
  });

  test.each([
    ['OPEN', 'open'],
    ['CLOSED', 'closed'],
    ['MERGED', 'merged'],
  ])('AC1 — maps the state %s to %s, with the number, title and url', async (state, expected) => {
    const stub = await makeStub();
    await stub.list(listJson(pr({ state })));

    expect(await findPullRequest(stub.cwd, 'feat', { env: stub.env })).toMatchObject({
      number: 7,
      title: 'Fix the bug',
      url: 'https://github.test/acme/app/pull/7',
      state: expected,
      checks: 'none',
    });
  });

  test('AC1 — summarises the checks of the rollup', async () => {
    const stub = await makeStub();
    await stub.list(
      listJson(
        pr({
          statusCheckRollup: [
            { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
          ],
        }),
      ),
    );

    expect((await findPullRequest(stub.cwd, 'feat', { env: stub.env }))?.checks).toBe('pending');
  });
});

describe('checksSummary', () => {
  const run = (status: string, conclusion = '') => ({ __typename: 'CheckRun', status, conclusion });
  const context = (state: string) => ({ __typename: 'StatusContext', state });

  test('AC1 — no check is none', () => {
    expect(checksSummary([])).toBe('none');
  });

  test.each(['SUCCESS', 'NEUTRAL', 'SKIPPED'])('AC1 — a completed check run concluding %s is passing', (conclusion) => {
    expect(checksSummary([run('COMPLETED', conclusion)])).toBe('passing');
  });

  test.each(['IN_PROGRESS', 'QUEUED', 'WAITING', 'PENDING', 'REQUESTED'])('AC1 — a check run in status %s is pending', (status) => {
    expect(checksSummary([run(status)])).toBe('pending');
  });

  test.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])(
    'AC1 — a completed check run concluding %s is failing',
    (conclusion) => {
      expect(checksSummary([run('COMPLETED', conclusion)])).toBe('failing');
    },
  );

  test('AC1 — a status context is passing on SUCCESS, pending on PENDING and EXPECTED, failing on FAILURE and ERROR', () => {
    expect(checksSummary([context('SUCCESS')])).toBe('passing');
    expect(checksSummary([context('PENDING')])).toBe('pending');
    expect(checksSummary([context('EXPECTED')])).toBe('pending');
    expect(checksSummary([context('FAILURE')])).toBe('failing');
    expect(checksSummary([context('ERROR')])).toBe('failing');
  });

  test('AC1 — one failing check makes the pull request failing, then one pending, then passing: failing > unknown > pending > passing', () => {
    const passing = run('COMPLETED', 'SUCCESS');
    const pending = run('QUEUED');
    const failing = context('FAILURE');
    expect(checksSummary([passing, pending, failing])).toBe('failing');
    expect(checksSummary([passing, pending])).toBe('pending');
    expect(checksSummary([passing, passing])).toBe('passing');
  });

  test.each([
    ['a conclusion', run('COMPLETED', 'STALE')],
    ['a status', run('SOMETHING_NEW')],
    ['a status context state', context('SOMETHING_NEW')],
    ['a __typename', { __typename: 'SomethingNew', status: 'COMPLETED', conclusion: 'SUCCESS', state: 'SUCCESS' }],
  ])('AC4b — an unknown %s is unknown, never passing', (_label, entry) => {
    expect(checksSummary([entry])).toBe('unknown');
    expect(checksSummary([run('COMPLETED', 'SUCCESS'), entry])).toBe('unknown');
  });

  test('AC4b — unknown with a failing check is failing, unknown with a pending one is unknown', () => {
    const unknown = run('COMPLETED', 'STALE');
    expect(checksSummary([unknown, run('COMPLETED', 'FAILURE')])).toBe('failing');
    expect(checksSummary([unknown, run('IN_PROGRESS')])).toBe('unknown');
    expect(checksSummary([run('IN_PROGRESS'), unknown])).toBe('unknown');
  });
});

describe('gh failures', () => {
  test('AC5 — no gh on PATH is GH_MISSING', async () => {
    const empty = await tempDir();

    const error = await failure(findPullRequest(empty, 'feat', { env: { PATH: empty } }));

    expect(error.code).toBe('GH_MISSING');
  });

  test('AC5 — exit code 4 is GH_UNAUTHENTICATED', async () => {
    const stub = await makeStub();
    await failWith(stub, { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });

    const error = await failure(findPullRequest(stub.cwd, 'feat', { env: stub.env }));

    expect(error.code).toBe('GH_UNAUTHENTICATED');
  });

  test('AC5 — any other failure is GH_FAILED, its message the trimmed stderr', async () => {
    const stub = await makeStub();
    await failWith(stub, { code: 1, stderr: '\n  GraphQL: Could not resolve to a Repository\n\n' });

    const error = await failure(findPullRequest(stub.cwd, 'feat', { env: stub.env }));

    expect(error.code).toBe('GH_FAILED');
    expect(error.message).toBe('GraphQL: Could not resolve to a Repository');
  });
});

describe('createPullRequest', () => {
  const input = { base: 'main', head: 'feature/login', title: 'Add the login', body: 'Line one\nLine two $(not run)' };

  test('AC10 — runs gh pr create with the base, head, title and body as single arguments, then reads the pull request', async () => {
    const stub = await makeStub();
    await stub.list(listJson(pr({ title: 'Add the login' })));

    const result = await createPullRequest(stub.cwd, input, { env: stub.env });

    const runs = await stub.runs();
    expect(runs).toHaveLength(2);
    const [createRun, listRun] = runs;
    expect([createRun]).toEqual([
      [
        stub.cwd,
        '1',
        'passed-env',
        'pr',
        'create',
        '--base',
        'main',
        '--head',
        'feature/login',
        '--title',
        'Add the login',
        '--body',
        'Line one\nLine two $(not run)',
      ],
    ]);
    expect(listRun!.slice(0, 11)).toEqual([stub.cwd, '1', 'passed-env', 'pr', 'list', '--head', 'feature/login', '--state', 'all', '--limit', '30']);
    expect(jsonFields(listRun!)).toEqual(LIST_FIELDS);
    expect(result).toMatchObject({
      number: 7,
      title: 'Add the login',
      url: 'https://github.test/acme/app/pull/7',
      state: 'open',
      checks: 'none',
    });
  });

  test('AC10 — an empty description is passed as an empty --body', async () => {
    const stub = await makeStub();
    await stub.list(listJson(pr()));

    await createPullRequest(stub.cwd, { ...input, body: '' }, { env: stub.env });

    const [create] = await stub.runs();
    expect(create!.slice(-2)).toEqual(['--body', '']);
  });

  test('AC10 — a failing gh pr create is GH_FAILED with the trimmed stderr', async () => {
    const stub = await makeStub();
    await writeFile(join(stub.bin, 'create-stderr'), '  a pull request for branch "feature/login" already exists\n\n');

    const error = await failure(createPullRequest(stub.cwd, input, { env: stub.env }));

    expect(error.code).toBe('GH_FAILED');
    expect(error.message).toBe('a pull request for branch "feature/login" already exists');
  });
});

// COCKPIT-75: what the Pull request tab shows, read with the same `gh pr list`.
describe('findPullRequest: the fields of the Pull request tab', () => {
  const run = (over: object) => ({ __typename: 'CheckRun', name: 'check', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', ...over });
  const read = async (over: object) => {
    const stub = await makeStub();
    await stub.list(listJson(pr(over)));
    return findPullRequest(stub.cwd, 'feat', { env: stub.env });
  };

  test('AC1 — gives the login of the author, the body and the head commit', async () => {
    const found = await read({ author: { login: 'romain-cll', id: 'x' }, body: 'The **body**', headRefOid: 'abc123def456' });

    expect(found).toMatchObject({ author: 'romain-cll', body: 'The **body**', headOid: 'abc123def456' });
  });

  test('AC1 — gives the base the pull request is into, as baseRefName', async () => {
    expect(await read({ baseRefName: 'develop' })).toMatchObject({ base: 'develop' });
  });

  test('AC1 — a missing or null author reads ghost, and absent arrays read empty', async () => {
    expect(await read({})).toMatchObject({ author: 'ghost', checkRuns: [], reviews: [] });
    expect(await read({ author: null })).toMatchObject({ author: 'ghost' });
    expect(await read({ statusCheckRollup: undefined, latestReviews: undefined })).toMatchObject({ checks: 'none', checkRuns: [], reviews: [] });
  });

  test('AC9 — checkRuns lists each check in gh\'s order, named "<workflow> / <name>", "<name>" without a workflow, the context for a status context', async () => {
    const found = await read({
      statusCheckRollup: [
        run({ name: 'test', conclusion: 'FAILURE' }),
        run({ name: 'lint', workflowName: '' }),
        run({ name: 'build', workflowName: undefined, status: 'IN_PROGRESS', conclusion: '' }),
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' },
        run({ name: 'odd', conclusion: 'STALE' }),
      ],
    });

    expect(found!.checkRuns.map(({ name, check }) => [name, check])).toEqual([
      ['CI / test', 'failing'],
      ['lint', 'passing'],
      ['build', 'pending'],
      ['ci/legacy', 'pending'],
      ['CI / odd', 'unknown'],
    ]);
    expect(found!.checks).toBe('failing');
  });

  test('AC10 — a check run keeps its start and completion times as gh gave them, a missing one is null', async () => {
    const found = await read({
      statusCheckRollup: [
        run({ startedAt: '2026-11-05T10:00:00Z', completedAt: '2026-11-05T10:06:41Z' }),
        run({ name: 'running', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-11-05T10:00:00Z' }),
        run({ name: 'bare' }),
      ],
    });

    expect(found!.checkRuns[0]).toMatchObject({ startedAt: '2026-11-05T10:00:00Z', completedAt: '2026-11-05T10:06:41Z' });
    expect(found!.checkRuns[1]).toMatchObject({ startedAt: '2026-11-05T10:00:00Z' });
    expect(found!.checkRuns[1]!.completedAt ?? null).toBeNull();
    expect(found!.checkRuns[2]!.startedAt ?? null).toBeNull();
    expect(found!.checkRuns[2]!.completedAt ?? null).toBeNull();
  });

  test('AC12 — reviews lists each reviewer of latestReviews in gh\'s order with a normalised state; a PENDING review is not listed and any other state is unknown', async () => {
    const found = await read({
      latestReviews: [
        { author: { login: 'alice' }, state: 'CHANGES_REQUESTED' },
        { author: { login: 'bob' }, state: 'APPROVED' },
        { author: { login: 'carol' }, state: 'COMMENTED' },
        { author: { login: 'dave' }, state: 'DISMISSED' },
        { author: { login: 'erin' }, state: 'PENDING' },
        { author: { login: 'frank' }, state: 'SOMETHING_NEW' },
        { author: null, state: 'APPROVED' },
      ],
    });

    expect(found!.reviews).toEqual([
      { login: 'alice', state: 'changes_requested' },
      { login: 'bob', state: 'approved' },
      { login: 'carol', state: 'commented' },
      { login: 'dave', state: 'dismissed' },
      { login: 'frank', state: 'unknown' },
      { login: 'ghost', state: 'approved' },
    ]);
  });

  test.each(['CHANGES_REQUESTED', 'APPROVED', 'REVIEW_REQUIRED', ''])('AC13 — reviewDecision %j is given as gh printed it', async (decision) => {
    expect(await read({ reviewDecision: decision })).toMatchObject({ reviewDecision: decision });
  });
});

describe('mergePullRequest', () => {
  test.each([
    ['squash', '--squash'],
    ['merge', '--merge'],
    ['rebase', '--rebase'],
  ] as const)('AC6 — the %s method runs gh pr merge <number> %s --match-head-commit <head> in the folder, and nothing else', async (method, flag) => {
    const stub = await makeStub();

    await mergePullRequest(stub.cwd, { number: 7, method, headOid: 'abc123def456' }, { env: stub.env });

    expect(await stub.runs()).toEqual([[stub.cwd, '1', 'passed-env', 'pr', 'merge', '7', flag, '--match-head-commit', 'abc123def456']]);
  });

  test('AC7 — a refusal of gh is GH_FAILED with its trimmed message', async () => {
    const stub = await makeStub();
    await failWith(stub, { code: 1, stderr: '\n  X Pull request #7 is not mergeable: the head branch is not up to date\n\n' });

    const error = await failure(mergePullRequest(stub.cwd, { number: 7, method: 'squash', headOid: 'abc' }, { env: stub.env }));

    expect(error.code).toBe('GH_FAILED');
    expect(error.message).toBe('X Pull request #7 is not mergeable: the head branch is not up to date');
  });
});

describe('pullRequestStates', () => {
  const answer = (aliases: Record<string, string | null>) =>
    JSON.stringify({
      data: { repository: Object.fromEntries(Object.entries(aliases).map(([alias, state]) => [alias, { nodes: state === null ? [] : [{ state }] }])) },
    });

  test('AC17 — one gh api graphql run for all the branches, each branch a -f variable and never part of the query', async () => {
    const stub = await makeStub();
    await stub.graphql(answer({ b0: 'OPEN', b1: 'MERGED', b2: null }));
    const branches = ['feat-a', 'feat/b', 'weird"} {x'];

    await pullRequestStates(stub.cwd, branches, { env: stub.env });

    const runs = await stub.runs();
    expect(runs).toHaveLength(1);
    const [cwd, prompt, marker, ...args] = runs[0]!;
    expect([cwd, prompt, marker]).toEqual([stub.cwd, '1', 'passed-env']);
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    const flagged = (flag: string) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));
    expect(flagged('-f').filter((value) => /^b\d+=/.test(value))).toEqual(['b0=feat-a', 'b1=feat/b', 'b2=weird"} {x']);
    const query = flagged('-f').find((value) => value.startsWith('query='))!;
    expect(query).toBeDefined();
    for (const branch of branches) expect(query).not.toContain(branch);
    for (const variable of ['$b0', '$b1', '$b2']) expect(query).toContain(variable);
    expect([...flagged('-F'), ...flagged('-f')].join(' ')).toContain('owner={owner}');
    expect([...flagged('-F'), ...flagged('-f')].join(' ')).toContain('repo={repo}');
  });

  // Each alias holds the nodes `gh` answers, newest first, with the `isCrossRepository` the query asks for.
  const nodesAnswer = (aliases: Record<string, Array<{ state: string; isCrossRepository: boolean }>>) =>
    JSON.stringify({ data: { repository: Object.fromEntries(Object.entries(aliases).map(([alias, nodes]) => [alias, { nodes }])) } });

  test('COCKPIT-71 AC18 — the query reads 30 pull requests per branch with isCrossRepository', async () => {
    const stub = await makeStub();
    await stub.graphql(nodesAnswer({ b0: [] }));

    await pullRequestStates(stub.cwd, ['a'], { env: stub.env });

    const [, , , ...args] = (await stub.runs())[0]!;
    const query = args.find((arg) => arg.startsWith('query='))!;
    expect(query).toContain('first:30');
    expect(query).toContain('isCrossRepository');
    expect(query).not.toContain('first:1,');
  });

  test('COCKPIT-71 AC18 — a newer pull request from a fork is ignored (the own one gives the state); a branch with only forks\' pull requests has no state', async () => {
    const stub = await makeStub();
    await stub.graphql(
      nodesAnswer({
        b0: [
          { state: 'OPEN', isCrossRepository: true },
          { state: 'MERGED', isCrossRepository: false },
        ],
        b1: [{ state: 'OPEN', isCrossRepository: true }],
        b2: [
          { state: 'CLOSED', isCrossRepository: false },
          { state: 'OPEN', isCrossRepository: true },
        ],
      }),
    );

    const states = await pullRequestStates(stub.cwd, ['own-older', 'fork-only', 'own-newest'], { env: stub.env });

    expect(states).toEqual({ 'own-older': 'merged', 'own-newest': 'closed' });
    expect('fork-only' in states).toBe(false);
  });

  test('AC16 — gives the state of the newest pull request of each branch, in lower case, a branch with none has no state', async () => {
    const stub = await makeStub();
    await stub.graphql(answer({ b0: 'OPEN', b1: 'MERGED', b2: 'CLOSED', b3: null }));

    const states = await pullRequestStates(stub.cwd, ['a', 'b', 'c', 'd'], { env: stub.env });

    expect(states.a).toBe('open');
    expect(states.b).toBe('merged');
    expect(states.c).toBe('closed');
    expect(states.d ?? null).toBeNull();
  });

  test('AC18 — no branch runs no gh and gives no state', async () => {
    const stub = await makeStub();

    const states = await pullRequestStates(stub.cwd, [], { env: stub.env });

    expect(await stub.runs()).toEqual([]);
    expect(Object.keys(states)).toEqual([]);
  });

  test.each([
    ['not JSON', 'oops'],
    ['no data', '{}'],
    ['a repository that is null', '{"data":{"repository":null}}'],
  ])('AC19 — an unreadable answer (%s) is GH_FAILED', async (_label, text) => {
    const stub = await makeStub();
    await stub.graphql(text);

    expect((await failure(pullRequestStates(stub.cwd, ['a'], { env: stub.env }))).code).toBe('GH_FAILED');
  });
});
