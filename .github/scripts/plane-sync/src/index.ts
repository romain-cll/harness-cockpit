export interface SyncOptions {
  title: string;
  branch: string;
  apiKey: string;
  /** Origin of the Plane API, without a trailing slash. */
  baseUrl: string;
  workspace: string;
  log: (line: string) => void;
}

interface WorkItem {
  id: string;
  project: string;
  state: string;
  sequence_id: number;
}

interface State {
  id: string;
  group: string;
}

interface Relations {
  blocking: string[];
  blocked_by: string[];
}

/**
 * The ticket a pull request closes: the last `COCKPIT-N` of its title, else the
 * `cockpit-N` its branch starts with. Upper-case, or `null` when there is none.
 */
export function ticketFromPullRequest(title: string, branch: string): string | null {
  const inTitle = [...title.matchAll(/COCKPIT-(\d+)/gi)].at(-1)?.[1];
  const number = inTitle ?? /^cockpit-(\d+)(?:-|$)/i.exec(branch)?.[1];
  return number ? `COCKPIT-${number}` : null;
}

/**
 * Moves the ticket of a merged pull request to Done, then moves each Backlog ticket
 * it blocks to Todo once all of that ticket's blockers are Done. Running it again
 * sends no change. Rejects on the first request Plane answers with a non-2xx status.
 */
export async function syncMergedPullRequest(options: SyncOptions): Promise<void> {
  const { title, branch, apiKey, baseUrl, workspace, log } = options;
  const ticket = ticketFromPullRequest(title, branch);
  if (!ticket) {
    log(`no ticket id in the title "${title}" or the branch "${branch}"`);
    return;
  }

  async function request<T>(method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/api/v1/workspaces/${workspace}${path}`, {
      method,
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
    return (await response.json()) as T;
  }

  const merged = await request<WorkItem>('GET', `/work-items/${ticket}/`);
  const projectPath = `/projects/${merged.project}`;

  const { results: states } = await request<{ results: State[] }>('GET', `${projectPath}/states/`);
  const stateOfGroup = (group: string): string => {
    const inGroup = states.filter((state) => state.group === group);
    if (inGroup.length !== 1) {
      throw new Error(`expected one state in the group ${group}, found ${inGroup.length}`);
    }
    return inGroup[0]!.id;
  };
  const backlog = stateOfGroup('backlog');
  const todo = stateOfGroup('unstarted');
  const done = stateOfGroup('completed');

  const getItem = (id: string) => request<WorkItem>('GET', `${projectPath}/work-items/${id}/`);
  const getRelations = (id: string) =>
    request<Relations>('GET', `${projectPath}/work-items/${id}/relations/`);
  const setState = (id: string, state: string) =>
    request('PATCH', `${projectPath}/work-items/${id}/`, { state });

  if (merged.state !== done) {
    await setState(merged.id, done);
    log(`COCKPIT-${merged.sequence_id} → Done`);
  }

  // The merged ticket counts as Done whatever the order of the requests.
  const blockerItems = new Map<string, WorkItem>([[merged.id, { ...merged, state: done }]]);
  const blocker = async (id: string): Promise<WorkItem> => {
    const known = blockerItems.get(id) ?? (await getItem(id));
    blockerItems.set(id, known);
    return known;
  };

  for (const id of (await getRelations(merged.id)).blocking) {
    const dependent = await getItem(id);
    if (dependent.state !== backlog) continue;
    const name = `COCKPIT-${dependent.sequence_id}`;

    let pending: WorkItem | undefined;
    for (const blockerId of (await getRelations(id)).blocked_by) {
      const item = await blocker(blockerId);
      if (item.state !== done) {
        pending = item;
        break;
      }
    }
    if (pending) {
      log(`${name} stays in Backlog: COCKPIT-${pending.sequence_id} is not Done`);
      continue;
    }
    await setState(id, todo);
    log(`${name} → Todo`);
  }
}
