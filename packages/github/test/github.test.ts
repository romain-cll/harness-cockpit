import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { checksSummary, createPullRequest, findPullRequest, GitHubError } from '../src/index';

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
cat '${bin}/list.json'
`,
  );
  await chmod(join(bin, 'gh'), 0o755);
  return {
    bin,
    cwd,
    env: { PATH: `${bin}:/usr/bin:/bin`, MARKER: 'passed-env' },
    list: (json) => writeFile(join(bin, 'list.json'), json),
    runs: async () => {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text
        .split('\x1e')
        .filter(Boolean)
        .map((run) => run.split('\x1f').slice(0, -1));
    },
  };
}

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
  test('AC1 — runs gh pr list for the branch, all states, the newest one, in the given folder with GH_PROMPT_DISABLED=1 and the env passed', async () => {
    const stub = await makeStub();

    await findPullRequest(stub.cwd, 'feature/login', { env: stub.env });

    expect(await stub.runs()).toEqual([
      [
        stub.cwd,
        '1',
        'passed-env',
        'pr',
        'list',
        '--head',
        'feature/login',
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,title,url,state,statusCheckRollup',
      ],
    ]);
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

    expect(await findPullRequest(stub.cwd, 'feat', { env: stub.env })).toEqual({
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

    expect(await stub.runs()).toEqual([
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
      [
        stub.cwd,
        '1',
        'passed-env',
        'pr',
        'list',
        '--head',
        'feature/login',
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,title,url,state,statusCheckRollup',
      ],
    ]);
    expect(result).toEqual({
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
