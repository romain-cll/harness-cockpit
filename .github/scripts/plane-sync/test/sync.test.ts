import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

// The module under test does not exist yet: it is imported inside each test so that
// every test fails on its own instead of the whole file failing to load.
async function sync(args: {
  title: string;
  branch: string;
  apiKey?: string;
  baseUrl: string;
  log: (line: string) => void;
}): Promise<void> {
  const mod = await import('../src/index');
  await mod.syncMergedPullRequest({ workspace: WORKSPACE, apiKey: API_KEY, ...args });
}

const WORKSPACE = 'romain-project';
const API_KEY = 'test-key';
const PROJECT = 'project-1';
const packageDir = join(import.meta.dirname, '..');

// ---------------------------------------------------------------------------------
// A fake Plane REST API v1, held in memory. It mirrors the shapes of Plane's docs:
//   GET   /api/v1/workspaces/{ws}/work-items/COCKPIT-N/                 -> { id, project, state, sequence_id }
//   GET   /api/v1/workspaces/{ws}/projects/{p}/states/                  -> { results: [{ id, name, group }] }
//   GET   /api/v1/workspaces/{ws}/projects/{p}/work-items/{id}/         -> same shape as the first
//   PATCH /api/v1/workspaces/{ws}/projects/{p}/work-items/{id}/         -> { state } sets the state
//   GET   /api/v1/workspaces/{ws}/[projects/{p}/]work-items/{id}/relations/
//                                                                       -> { blocking: id[], blocked_by: id[], ... }
// Every request is recorded, failed ones included. A request without the right
// X-API-Key header answers 401.
// ---------------------------------------------------------------------------------

type StateName = 'Backlog' | 'Todo' | 'In Progress' | 'Done' | 'Cancelled';

const STATES: { id: string; name: StateName; group: string }[] = [
  { id: 'state-backlog', name: 'Backlog', group: 'backlog' },
  { id: 'state-todo', name: 'Todo', group: 'unstarted' },
  { id: 'state-progress', name: 'In Progress', group: 'started' },
  { id: 'state-done', name: 'Done', group: 'completed' },
  { id: 'state-cancelled', name: 'Cancelled', group: 'cancelled' },
];
const stateId = (name: StateName) => STATES.find((s) => s.name === name)!.id;

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

interface Plane {
  url: string;
  requests: Recorded[];
  patches: () => Recorded[];
  stateOf: (sequence: number) => StateName;
}

interface Seed {
  /** sequence number -> state name */
  tickets: Record<number, StateName>;
  /** [blocker, blocked] sequence numbers */
  blocks?: [number, number][];
  /** answers this status for the first request whose "METHOD path" matches */
  fail?: { match: RegExp; status: number };
}

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const idOf = (sequence: number) => `item-${sequence}`;

async function startPlane(seed: Seed): Promise<Plane> {
  const items = new Map<string, { id: string; project: string; state: string; sequence_id: number }>();
  for (const [seq, name] of Object.entries(seed.tickets)) {
    const sequence_id = Number(seq);
    items.set(idOf(sequence_id), {
      id: idOf(sequence_id),
      project: PROJECT,
      state: stateId(name),
      sequence_id,
    });
  }
  const blocks = seed.blocks ?? [];
  const requests: Recorded[] = [];
  const base = `/api/v1/workspaces/${WORKSPACE}`;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const method = req.method ?? 'GET';
      const path = (req.url ?? '').split('?')[0] ?? '';
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method, path, body: raw ? JSON.parse(raw) : undefined });

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.headers['x-api-key'] !== API_KEY) return send(401, { detail: 'bad key' });
      if (seed.fail?.match.test(`${method} ${path}`)) {
        return send(seed.fail.status, { detail: 'failure' });
      }

      let m: RegExpExecArray | null;

      if (method === 'GET' && (m = new RegExp(`^${base}/work-items/COCKPIT-(\\d+)/$`).exec(path))) {
        const item = items.get(idOf(Number(m[1])));
        return item ? send(200, item) : send(404, { detail: 'not found' });
      }

      if (method === 'GET' && (m = new RegExp(`^${base}/projects/([^/]+)/states/$`).exec(path))) {
        return m[1] === PROJECT ? send(200, { results: STATES }) : send(404, { detail: 'not found' });
      }

      // Relations, with or without the project segment.
      if (
        method === 'GET' &&
        (m = new RegExp(`^${base}/(?:projects/([^/]+)/)?work-items/([^/]+)/relations/$`).exec(path))
      ) {
        const item = items.get(m[2]!);
        if (!item || (m[1] && m[1] !== PROJECT)) return send(404, { detail: 'not found' });
        const n = item.sequence_id;
        return send(200, {
          blocking: blocks.filter(([a]) => a === n).map(([, b]) => idOf(b)),
          blocked_by: blocks.filter(([, b]) => b === n).map(([a]) => idOf(a)),
          duplicate: [],
          relates_to: [],
          start_after: [],
          start_before: [],
          finish_after: [],
          finish_before: [],
        });
      }

      if ((method === 'GET' || method === 'PATCH') && (m = new RegExp(`^${base}/(?:projects/([^/]+)/)?work-items/([^/]+)/$`).exec(path))) {
        const item = items.get(m[2]!);
        if (!item || (m[1] && m[1] !== PROJECT)) return send(404, { detail: 'not found' });
        if (method === 'PATCH') {
          const patch = JSON.parse(raw) as { state?: string };
          if (patch.state) item.state = patch.state;
        }
        return send(200, item);
      }

      return send(404, { detail: 'not found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(server);
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    patches: () => requests.filter((r) => r.method === 'PATCH'),
    stateOf: (sequence) => {
      const item = items.get(idOf(sequence));
      return STATES.find((s) => s.id === item?.state)!.name;
    },
  };
}

function logger() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

const patchesTo = (plane: Plane, sequence: number) =>
  plane.patches().filter((r) => r.path.endsWith(`/work-items/${idOf(sequence)}/`));

// ---------------------------------------------------------------------------------

describe('syncMergedPullRequest — merged ticket', () => {
  test.each(['Backlog', 'Todo', 'In Progress', 'Cancelled'] as const)(
    'AC1 — a ticket in %s ends in Done, with one PATCH and a log line',
    async (initial) => {
      const plane = await startPlane({ tickets: { 7: initial } });
      const { lines, log } = logger();

      await sync({ title: 'feat(x): y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

      expect(plane.stateOf(7)).toBe('Done');
      expect(plane.patches()).toHaveLength(1);
      expect(plane.patches()[0]).toMatchObject({
        method: 'PATCH',
        path: `/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT}/work-items/${idOf(7)}/`,
        body: { state: stateId('Done') },
      });
      expect(lines).toContain('COCKPIT-7 → Done');
    },
  );

  test('AC1 — requests carry the API key in X-API-Key', async () => {
    const plane = await startPlane({ tickets: { 7: 'In Progress' } });
    const { log } = logger();

    // The fake answers 401 to any other key, so a wrong header would fail the sync.
    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

    expect(plane.requests.length).toBeGreaterThan(0);
    expect(plane.stateOf(7)).toBe('Done');
  });

  test('AC1 — a ticket already in Done is not patched', async () => {
    const plane = await startPlane({ tickets: { 7: 'Done' } });
    const { lines, log } = logger();

    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

    expect(plane.patches()).toHaveLength(0);
    expect(plane.stateOf(7)).toBe('Done');
    expect(lines).not.toContain('COCKPIT-7 → Done');
  });

  test('AC2 — with two ids in the title, the last one is the ticket', async () => {
    const plane = await startPlane({ tickets: { 3: 'In Progress', 7: 'In Progress' } });
    const { lines, log } = logger();

    await sync({
      title: 'feat(x): follow-up of COCKPIT-3 (COCKPIT-7)',
      branch: 'feature/x',
      baseUrl: plane.url,
      log,
    });

    expect(plane.stateOf(7)).toBe('Done');
    expect(plane.stateOf(3)).toBe('In Progress');
    expect(lines).toContain('COCKPIT-7 → Done');
  });

  test('AC2 — a lower-case id in the title is the ticket', async () => {
    const plane = await startPlane({ tickets: { 7: 'In Progress' } });
    const { log } = logger();

    await sync({ title: 'feat(x): y (cockpit-7)', branch: 'feature/x', baseUrl: plane.url, log });

    expect(plane.stateOf(7)).toBe('Done');
  });

  test.each(['cockpit-7-plane-sync', 'COCKPIT-7-plane-sync'])(
    'AC3 — with no id in the title, the branch %s gives the ticket',
    async (branch) => {
      const plane = await startPlane({ tickets: { 7: 'In Progress' } });
      const { lines, log } = logger();

      await sync({ title: 'Plane sync', branch, baseUrl: plane.url, log });

      expect(plane.stateOf(7)).toBe('Done');
      expect(lines).toContain('COCKPIT-7 → Done');
    },
  );
});

describe('syncMergedPullRequest — no ticket id', () => {
  test.each(['feature/x', 'mycockpit-7-x'])(
    'AC4 — branch %s and a title without id: no request, a log line',
    async (branch) => {
      const plane = await startPlane({ tickets: { 7: 'In Progress' } });
      const { lines, log } = logger();

      await sync({ title: 'chore: tidy', branch, baseUrl: plane.url, log });

      expect(plane.requests).toHaveLength(0);
      expect(plane.stateOf(7)).toBe('In Progress');
      expect(lines.some((l) => /no ticket id/i.test(l))).toBe(true);
    },
  );
});

describe('syncMergedPullRequest — unblocking dependents', () => {
  test('AC5 — a Backlog dependent whose only blocker is the merged ticket goes to Todo', async () => {
    const plane = await startPlane({
      tickets: { 7: 'In Progress', 8: 'Backlog' },
      blocks: [[7, 8]],
    });
    const { lines, log } = logger();

    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

    expect(plane.stateOf(7)).toBe('Done');
    expect(plane.stateOf(8)).toBe('Todo');
    expect(patchesTo(plane, 8)).toHaveLength(1);
    expect(patchesTo(plane, 8)[0]?.body).toEqual({ state: stateId('Todo') });
    expect(lines).toContain('COCKPIT-8 → Todo');
  });

  test('AC5 — a Backlog dependent whose other blockers are all Done goes to Todo', async () => {
    const plane = await startPlane({
      tickets: { 3: 'Done', 4: 'Done', 7: 'In Progress', 8: 'Backlog' },
      blocks: [
        [3, 8],
        [4, 8],
        [7, 8],
      ],
    });
    const { lines, log } = logger();

    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

    expect(plane.stateOf(8)).toBe('Todo');
    expect(lines).toContain('COCKPIT-8 → Todo');
  });

  test('AC5 — every Backlog dependent is handled independently', async () => {
    const plane = await startPlane({
      tickets: { 5: 'In Progress', 7: 'In Progress', 8: 'Backlog', 9: 'Backlog' },
      blocks: [
        [7, 8],
        [7, 9],
        [5, 9],
      ],
    });
    const { log } = logger();

    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

    expect(plane.stateOf(8)).toBe('Todo');
    expect(plane.stateOf(9)).toBe('Backlog');
  });

  test.each(['Todo', 'In Progress', 'Cancelled'] as const)(
    'AC6 — another blocker in %s keeps the dependent in Backlog and the log names it',
    async (blockerState) => {
      const plane = await startPlane({
        tickets: { 3: blockerState, 7: 'In Progress', 8: 'Backlog' },
        blocks: [
          [3, 8],
          [7, 8],
        ],
      });
      const { lines, log } = logger();

      await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

      expect(plane.stateOf(7)).toBe('Done');
      expect(plane.stateOf(8)).toBe('Backlog');
      expect(patchesTo(plane, 8)).toHaveLength(0);
      expect(lines.some((l) => l.includes('COCKPIT-3'))).toBe(true);
      expect(lines).not.toContain('COCKPIT-8 → Todo');
    },
  );

  test('AC6 — a Backlog blocker keeps the dependent in Backlog too', async () => {
    const plane = await startPlane({
      tickets: { 3: 'Backlog', 7: 'In Progress', 8: 'Backlog' },
      blocks: [
        [3, 8],
        [7, 8],
      ],
    });
    const { lines, log } = logger();

    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

    expect(plane.stateOf(8)).toBe('Backlog');
    expect(lines.some((l) => l.includes('COCKPIT-3'))).toBe(true);
  });

  test('AC7 — dependents in Todo, In Progress, Done and Cancelled do not change', async () => {
    const plane = await startPlane({
      tickets: { 1: 'Todo', 2: 'In Progress', 3: 'Done', 4: 'Cancelled', 5: 'Backlog', 7: 'In Progress' },
      // 5 is a Backlog blocker of every dependent: the rule must not depend on the blockers.
      blocks: [
        [7, 1],
        [7, 2],
        [7, 3],
        [7, 4],
        [5, 1],
        [5, 2],
        [5, 3],
        [5, 4],
      ],
    });
    const { lines, log } = logger();

    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

    expect(plane.stateOf(1)).toBe('Todo');
    expect(plane.stateOf(2)).toBe('In Progress');
    expect(plane.stateOf(3)).toBe('Done');
    expect(plane.stateOf(4)).toBe('Cancelled');
    for (const n of [1, 2, 3, 4]) expect(patchesTo(plane, n)).toHaveLength(0);
    expect(lines.filter((l) => l.includes('→ Todo'))).toHaveLength(0);
  });

  test('AC7 — dependents in Todo whose blockers are all Done stay in Todo', async () => {
    const plane = await startPlane({
      tickets: { 2: 'Todo', 7: 'In Progress' },
      blocks: [[7, 2]],
    });
    const { log } = logger();

    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

    expect(patchesTo(plane, 2)).toHaveLength(0);
  });

  test('AC1 — tickets that the merged one does not block are left alone', async () => {
    const plane = await startPlane({
      tickets: { 6: 'Backlog', 7: 'In Progress', 8: 'Backlog' },
      blocks: [
        [6, 7],
        [8, 6],
      ],
    });
    const { log } = logger();

    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log });

    expect(plane.stateOf(6)).toBe('Backlog');
    expect(plane.stateOf(8)).toBe('Backlog');
    expect(plane.patches()).toHaveLength(1);
  });
});

describe('syncMergedPullRequest — idempotence', () => {
  test('AC8 — a second run on the same PR sends no PATCH', async () => {
    const plane = await startPlane({
      tickets: { 3: 'Done', 7: 'In Progress', 8: 'Backlog', 9: 'Backlog', 10: 'Todo' },
      blocks: [
        [3, 8],
        [7, 8],
        [7, 9],
        [10, 9],
      ],
    });
    const first = logger();
    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log: first.log });
    // The ticket and its unblocked dependent moved; the other dependent is still blocked.
    expect(plane.patches()).toHaveLength(2);
    expect(plane.stateOf(7)).toBe('Done');
    expect(plane.stateOf(8)).toBe('Todo');
    expect(plane.stateOf(9)).toBe('Backlog');

    const before = plane.requests.length;
    const second = logger();
    await sync({ title: 'feat: y (COCKPIT-7)', branch: 'feature/x', baseUrl: plane.url, log: second.log });

    expect(plane.requests.slice(before).filter((r) => r.method === 'PATCH')).toHaveLength(0);
    expect(plane.patches()).toHaveLength(2);
    expect(plane.stateOf(8)).toBe('Todo');
    expect(plane.stateOf(9)).toBe('Backlog');
  });
});

describe('syncMergedPullRequest — failures', () => {
  test('AC9 — a failed request rejects with its method, path and status, and nothing follows', async () => {
    const plane = await startPlane({
      tickets: { 7: 'In Progress', 8: 'Backlog' },
      blocks: [[7, 8]],
      fail: { match: /^GET .*\/work-items\/item-7\/relations\/$/, status: 500 },
    });
    const { log } = logger();

    const error = await sync({
      title: 'feat: y (COCKPIT-7)',
      branch: 'feature/x',
      baseUrl: plane.url,
      log,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('GET');
    expect(message).toMatch(/work-items\/item-7\/relations\//);
    expect(message).toContain('500');
    // The run stops at the failing request: it is the last one the fake saw.
    const last = plane.requests.at(-1);
    expect(last?.method).toBe('GET');
    expect(last?.path).toMatch(/\/work-items\/item-7\/relations\/$/);
    expect(plane.stateOf(8)).toBe('Backlog');
  });

  test('AC9 — a failed PATCH rejects with PATCH, the path and the status', async () => {
    const plane = await startPlane({
      tickets: { 7: 'In Progress', 8: 'Backlog' },
      blocks: [[7, 8]],
      fail: { match: /^PATCH .*\/work-items\/item-7\/$/, status: 403 },
    });
    const { log } = logger();

    const error = await sync({
      title: 'feat: y (COCKPIT-7)',
      branch: 'feature/x',
      baseUrl: plane.url,
      log,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('PATCH');
    expect(message).toMatch(/work-items\/item-7\//);
    expect(message).toContain('403');
    expect(plane.requests.at(-1)?.method).toBe('PATCH');
    expect(plane.stateOf(8)).toBe('Backlog');
  });

  test('AC9 — an unknown ticket (404) rejects', async () => {
    const plane = await startPlane({ tickets: { 7: 'In Progress' } });
    const { log } = logger();

    await expect(
      sync({ title: 'feat: y (COCKPIT-99)', branch: 'feature/x', baseUrl: plane.url, log }),
    ).rejects.toThrow(/GET.*COCKPIT-99.*404/s);
  });
});

// ---------------------------------------------------------------------------------
// main.ts, spawned for real against the fake API.
// ---------------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runMain(env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const base: Record<string, string | undefined> = { ...process.env };
    delete base.PLANE_API_KEY;
    delete base.PR_TITLE;
    delete base.PR_BRANCH;
    delete base.PLANE_API_URL;
    const child = spawn('bun', ['src/main.ts'], {
      cwd: packageDir,
      env: Object.fromEntries(Object.entries({ ...base, ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c));
    child.stderr.on('data', (c: Buffer) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('main.ts', () => {
  test('AC1 — moves the ticket to Done and exits 0', async () => {
    const plane = await startPlane({ tickets: { 7: 'In Progress' } });

    const result = await runMain({
      PLANE_API_KEY: API_KEY,
      PR_TITLE: 'feat(x): y (COCKPIT-7)',
      PR_BRANCH: 'feature/x',
      PLANE_API_URL: plane.url,
    });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('COCKPIT-7 → Done');
    expect(plane.stateOf(7)).toBe('Done');
  });

  test('AC3 — reads the branch when the title has no id', async () => {
    const plane = await startPlane({ tickets: { 7: 'In Progress' } });

    const result = await runMain({
      PLANE_API_KEY: API_KEY,
      PR_TITLE: 'Plane sync',
      PR_BRANCH: 'cockpit-7-plane-sync',
      PLANE_API_URL: plane.url,
    });

    expect(result.code).toBe(0);
    expect(plane.stateOf(7)).toBe('Done');
  });

  test('AC4 — no ticket id: no request, a message, exit code 0', async () => {
    const plane = await startPlane({ tickets: { 7: 'In Progress' } });

    const result = await runMain({
      PLANE_API_KEY: API_KEY,
      PR_TITLE: 'chore: tidy',
      PR_BRANCH: 'mycockpit-7-x',
      PLANE_API_URL: plane.url,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/no ticket id/i);
    expect(plane.requests).toHaveLength(0);
  });

  test('AC4 — no ticket id and no API key still exits 0', async () => {
    const plane = await startPlane({ tickets: { 7: 'In Progress' } });

    const result = await runMain({
      PR_TITLE: 'chore: tidy',
      PR_BRANCH: 'feature/x',
      PLANE_API_URL: plane.url,
    });

    expect(result.code).toBe(0);
    expect(plane.requests).toHaveLength(0);
  });

  test.each([
    ['empty', ''],
    ['unset', undefined],
  ])('AC9 — an %s PLANE_API_KEY exits non-zero, names the variable, sends no request', async (_label, key) => {
    const plane = await startPlane({ tickets: { 7: 'In Progress' } });

    const result = await runMain({
      PLANE_API_KEY: key,
      PR_TITLE: 'feat(x): y (COCKPIT-7)',
      PR_BRANCH: 'feature/x',
      PLANE_API_URL: plane.url,
    });

    expect(result.code).not.toBe(0);
    expect(result.code).not.toBeNull();
    expect(result.stderr).toContain('PLANE_API_KEY');
    expect(plane.requests).toHaveLength(0);
    expect(plane.stateOf(7)).toBe('In Progress');
  });

  test('AC9 — a 500 on the relations call exits non-zero with method, path and status', async () => {
    const plane = await startPlane({
      tickets: { 7: 'In Progress', 8: 'Backlog' },
      blocks: [[7, 8]],
      fail: { match: /^GET .*\/work-items\/item-7\/relations\/$/, status: 500 },
    });

    const result = await runMain({
      PLANE_API_KEY: API_KEY,
      PR_TITLE: 'feat(x): y (COCKPIT-7)',
      PR_BRANCH: 'feature/x',
      PLANE_API_URL: plane.url,
    });

    expect(result.code).not.toBe(0);
    expect(result.code).not.toBeNull();
    expect(result.stderr).toContain('GET');
    expect(result.stderr).toMatch(/work-items\/item-7\/relations\//);
    expect(result.stderr).toContain('500');
    expect(plane.stateOf(8)).toBe('Backlog');
  });
});
