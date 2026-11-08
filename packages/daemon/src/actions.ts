import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { detectHarnesses, harnesses, statusLaunch, type DetectedHarness, type Harness } from '@cockpit/harnesses';
import { resolveShellEnv } from '@cockpit/shell-env';
import {
  addProject,
  addSession,
  closeSession,
  loadState,
  ProjectExistsError,
  rememberApp,
  removeProject,
  saveState,
  sessionName,
  setHarnessSessionId,
  setMainWorkspace,
  updateProjectPath,
  type Session,
  type State,
} from '@cockpit/state';
import {
  availableBranch,
  createWorktree,
  findRepositoryRoot,
  listBranches,
  listWorktrees,
  nameWorkspace,
  readWorkspaceConfig,
  removeWorktree,
  repairWorktrees,
  reservedPath,
  WorkspaceError,
} from '@cockpit/workspaces';
import { terminalEnv, withSpawnDefaults, type SpawnRequest } from './environment';
import { describeFailure, findWorkspace, hasMainWorkspace, isMainWorkspace, toProject, workspaceName } from './projects';
import type {
  AddProjectResult,
  CallMethod,
  Calls,
  CreateWorkspaceResult,
  FailedSetup,
  Refused,
  RemoveWorkspaceResult,
  SessionReport,
  SettledSetup,
  Setup,
  SpawnOptions,
  StartSessionOptions,
  StartSessionResult,
  StateSnapshot,
  TerminalInfo,
  TerminalKind,
  TerminalSize,
} from './protocol';
import { WRONG_BUILD } from './protocol';
import type { createTerminals, Subscriber } from './terminals';

export interface ActionsOptions {
  home: string;
  /** The folder holding `state.json`. */
  stateDir: string;
  /** The `cockpit` binary the sessions' hooks and `cockpit setup` run. */
  cli: string;
  /** This daemon's socket: the `cockpit` commands of a terminal report to it. */
  socket: string;
  terminals: ReturnType<typeof createTerminals>;
  /** Another build's daemon took over: this one writes nothing to `state.json`. */
  superseded(): boolean;
  /** Tells every connection the state after a change. */
  announceState(snapshot: StateSnapshot): void;
  announceSettled(settled: SettledSetup): void;
  /** Tells the other connections a terminal exists; `requester` has the answer. */
  announceSpawned(terminal: TerminalInfo, requester?: Subscriber): void;
}

// The terminal size a workspace's first terminal starts at; the page that shows it resizes it.
const SETUP_SIZE = { cols: 80, rows: 24 };

const refuse = (message: string): Refused => ({ status: 'refused', message });

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * The state of the app and what changes it: `state.json` is loaded here and written only here. Everything a
 * `call` request runs lives in this closure, which the server dispatches to.
 */
export function createActions({ home, stateDir, cli, socket, terminals, superseded, announceState, announceSettled, announceSpawned }: ActionsOptions) {
  const worktreesRoot = join(home, 'worktrees');
  // Throws when the file cannot be loaded (a newer version): the daemon does not start.
  let state: State = loadState(stateDir);
  // The login shell's environment, resolved once, on the first use.
  let login: Promise<NodeJS.ProcessEnv> | undefined;
  const loginEnv = () => (login ??= resolveShellEnv());
  const context = async () => ({ env: await loginEnv(), socket, cli, home });
  // Detected on the first call that needs it, never at startup: detecting runs each CLI's `--version`.
  let detection: Promise<DetectedHarness[]> | undefined;
  const detected = () => (detection ??= loginEnv().then((env) => detectHarnesses(env)));

  // The sessions the composer started in a new workspace, waiting for the title their agent derives from the
  // prompt (session id to worktree and harness). In memory only. The first accepted title, the agent's exit or
  // the end of the terminal clears the entry.
  const pendingNames = new Map<string, { worktree: string; harness: Harness }>();
  // The workspaces the composer sent and the daemon is still making (by worktree path).
  const setups = new Map<string, Setup>();
  // The sends whose worktree could not be created, kept until the user dismisses them.
  let failedSetups: FailedSetup[] = [];

  const snapshot = (): StateSnapshot => ({ state, setups: [...setups.values()], failedSetups });
  const announce = () => announceState(snapshot());

  // Saves `next` and makes it the state; a refusal when the save fails leaves the state as it was. The one way
  // to the file: a superseded daemon's copy is stale, and what the newer build wrote since must stay.
  function commit(next: State): Refused | undefined {
    if (superseded()) return refuse(WRONG_BUILD);
    try {
      saveState(stateDir, next);
    } catch (error) {
      return refuse(`Cockpit could not save its data: ${error instanceof Error ? error.message : String(error)}`);
    }
    state = next;
    announce();
    return undefined;
  }

  function commitOrThrow(next: State): void {
    const refused = commit(next);
    if (refused) throw new Error(refused.message);
  }

  // A workspace session is marked open from its start until its tab closes (`session-dismiss`), its terminal
  // exits by itself, or its workspace or project goes (the session stays stored): one still marked that no daemon
  // holds lost its terminal with a daemon.
  function markClosed(match: (session: Session) => boolean): void {
    const open = state.sessions.filter((session) => session.open && match(session));
    if (open.length > 0) commit(open.reduce((current, { id }) => closeSession(current, id), state));
  }

  // A removed workspace keeps no session: its terminals end (the answer waits for their exits), then its marks close.
  async function endWorkspace(path: string): Promise<void> {
    await terminals.end(({ workspace }) => workspace === path);
    markClosedAfterAnswer(({ directory }) => directory === path);
  }

  // The repository's teardown, as the app's dialog runs it: `cockpit teardown` in the worktree with the sessions'
  // environment. A refusal says how it failed, `undefined` when it passed or there was none.
  async function runTeardown(project: string, path: string): Promise<string | undefined> {
    const env = await loginEnv();
    if ((await readWorkspaceConfig({ repo: project, path, env })).teardown.length === 0) return undefined;
    const sessionEnv = terminalEnv(await context());
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(cli, ['teardown'], { cwd: path, env: sessionEnv, stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', resolve);
    });
    return code === 0 ? undefined : `The teardown of ${basename(path)} failed (${code === null ? 'killed' : `exit ${code}`}).`;
  }

  // Once the answer is on its way: closing the marks is no part of what a removal answers, and the `state` event that
  // follows says it is done.
  const markClosedAfterAnswer = (match: (session: Session) => boolean) => void setImmediate(() => markClosed(match));

  // Keeps the harness's id for a session's conversation, an opaque string: the last one reported wins, and
  // nothing is written when it is the one stored.
  function storeHarnessSessionId(sessionId: string, harnessSessionId: string): void {
    const session = state.sessions.find(({ id }) => id === sessionId);
    if (session && session.harnessSessionId !== harnessSessionId) commit(setHarnessSessionId(state, sessionId, harnessSessionId));
  }

  // What a refused worktree creation says, for the errors that name the branch or the worktrees folder.
  function creationRefusal(error: WorkspaceError, name: string): string | undefined {
    if (error.code === 'BRANCH_EXISTS') return `A branch named ${name} already exists.`;
    if (error.code === 'INVALID_BRANCH_NAME') return `${name} is not a valid branch name.`;
    if (error.code === 'FS_FAILED') {
      const errno = (error.cause as NodeJS.ErrnoException | undefined)?.code ?? error.message;
      return `Cockpit could not create its worktrees folder ${worktreesRoot}: ${errno}.`;
    }
    return undefined;
  }

  // Runs `action` for a project of the state, turning a git failure into a refusal (or into what `handle` makes of it).
  async function forProject<Result extends { status: string }>(
    project: string,
    action: () => Promise<Result | Refused>,
    handle: (error: WorkspaceError) => Result | Refused | undefined | Promise<Result | Refused | undefined> = () => undefined,
  ): Promise<Result | Refused> {
    if (!state.projects.some((entry) => entry.path === project)) return refuse(`${project} is not a project in Cockpit.`);
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      return (await handle(error)) ?? refuse(describeFailure(error, project));
    }
  }

  // Starts a terminal owned by the daemon; `requester`, when there is one, receives its output.
  async function spawnTerminal(
    kind: TerminalKind,
    request: SpawnRequest,
    { sessionId, workspace, agentTitles }: { sessionId?: string; workspace?: string; agentTitles?: SpawnOptions['agentTitles'] },
    requester?: Subscriber,
  ): Promise<TerminalInfo> {
    const options = withSpawnDefaults(request, await context());
    const id = terminals.spawn(
      { kind, ...options, ...(sessionId !== undefined && { sessionId }), ...(workspace !== undefined && { workspace }), ...(agentTitles && { agentTitles }) },
      requester,
    );
    return terminals.info(id);
  }

  // The one way a repository becomes a project: add its root to the state, save, list it. A refusal changes nothing.
  async function addRoot(root: string): Promise<AddProjectResult> {
    try {
      const refused = commit(addProject(state, root));
      if (refused) return refused;
      return { status: 'added', project: await toProject({ path: root }, setups.values(), await loginEnv()) };
    } catch (error) {
      if (error instanceof ProjectExistsError) return refuse(`${basename(error.path)} is already in Cockpit.`);
      throw error;
    }
  }

  // Makes the worktree (none for the main workspace, which opens the project's folder), then starts the agent (or
  // the setup shell) in it. The row is a "setting up" one until this ends.
  async function runSetup({ project, path, branch, base, harness, task }: Setup): Promise<void> {
    const settle = (settled: SettledSetup) => {
      setups.delete(path);
      announce();
      announceSettled(settled);
    };
    if (base !== null) {
      try {
        await createWorktree({ repo: project, root: worktreesRoot, branch, base, env: await loginEnv() });
      } catch (error) {
        const message =
          error instanceof WorkspaceError ? (creationRefusal(error, branch) ?? describeFailure(error, project)) : error instanceof Error ? error.message : String(error);
        failedSetups.push({ id: randomUUID(), project, path, name: branch, message, prompt: task, agent: harness, base });
        return settle({ path });
      }
    }
    let message: string | undefined;
    try {
      if (harness === 'terminal') {
        // As the agent's start does: no shell for a project that is gone.
        const found = await findWorkspace(state, { project, path }, await loginEnv());
        if ('status' in found) message = found.message;
        // The repository's setup, then the login shell (the main workspace runs no setup).
        else {
          const command = base === null ? {} : { command: cli, args: ['setup', '--shell'] };
          announceSpawned(await spawnTerminal('shell', { ...SETUP_SIZE, cwd: path, ...command }, { workspace: path }));
        }
      } else {
        const started = await startSession(undefined, harness, SETUP_SIZE, {
          workspace: { project, path },
          setup: base !== null,
          prompt: task,
          nameFromTitle: base !== null,
        });
        if (started.status === 'refused') message = started.message;
      }
    } catch (error) {
      message = `Could not start Terminal: ${error instanceof Error ? error.message : String(error)}`;
    }
    settle({ path, ...(message !== undefined && { message }) });
  }

  // Starts the harness for `requester`, the connection that receives the terminal's output, or for none. With
  // `resume`, a stored session that lost its terminal: the same record and id, the harness resuming its conversation.
  async function startSession(
    requester: Subscriber | undefined,
    harnessId: string,
    size: TerminalSize,
    options?: StartSessionOptions,
    resume?: Session & { harnessSessionId: string },
  ): Promise<StartSessionResult> {
    // `terminal` is no agent CLI: the login shell, always available, never detected.
    const shell = harnessId === 'terminal';
    const catalogued = harnesses.find(({ id }) => id === harnessId);
    const found = shell ? undefined : (await detected()).find(({ id }) => id === harnessId);
    const harness = shell ? { id: 'terminal', name: 'Terminal' } : catalogued;
    if (!harness || (!shell && !found)) return refuse(`${harness?.name ?? harnessId} is not installed.`);
    // Detected at launch, removed since: nothing is created or spawned.
    if (found && !isFile(found.path)) return refuse(`Could not start ${harness.name}: ${found.path} not found.`);

    // In a workspace the session runs in the worktree, which is the user's: nothing is created or removed there.
    // Otherwise it gets a folder of its own, removed if the start fails.
    const workspace = options?.workspace;
    if (workspace) {
      const checked = await findWorkspace(state, workspace, await loginEnv());
      if ('status' in checked) return checked;
    }
    const id = resume?.id ?? randomUUID();
    const directory = workspace?.path ?? join(home, 'sessions', id);
    const prompt = options?.prompt?.trim() || undefined;
    let terminal: TerminalInfo | undefined;
    try {
      if (!workspace) mkdirSync(directory, { recursive: true });
      let env = terminalEnv(await context(), {
        COCKPIT_SESSION_ID: id,
        ...(workspace && { COCKPIT_WORKSPACE_PATH: workspace.path }),
      });
      const viaSetup = workspace && options?.setup;
      let command: { command?: string; args?: string[] };
      if (catalogued && found) {
        // The harness is told, through its arguments and environment, to report its status to the daemon.
        const status = await statusLaunch(catalogued.id, { cli, pluginsDir: join(home, 'plugins'), env });
        env = status.env as Record<string, string>;
        // From the composer the terminal runs `cockpit setup`, which runs the repository's setup, then
        // the agent, then the login shell. The agent follows `--then` by the path detection found, so
        // that binary is the one that runs.
        const agentArgs = [...status.args, ...(resume ? catalogued.resume(resume.harnessSessionId) : catalogued.start(prompt))];
        command = viaSetup
          ? { command: cli, args: ['setup', '--shell', '--then', found.path, ...agentArgs] }
          : { command: found.path, args: agentArgs };
      } else {
        // The login shell: the spawn defaults run `$SHELL -l`.
        command = {};
      }
      // The composer names the workspace after the first title the agent derives from the prompt. The
      // entry exists before the spawn, so no title can arrive ahead of it.
      if (workspace && options?.nameFromTitle && catalogued) pendingNames.set(id, { worktree: workspace.path, harness: catalogued });
      terminal = await spawnTerminal(
        'session',
        { ...size, ...command, cwd: directory, env },
        {
          sessionId: id,
          workspace: workspace?.path,
          // A harness with no hook on an interrupt: the daemon reads the end of a turn from the title.
          ...(catalogued?.turnTitles && { agentTitles: { ...catalogued.turnTitles, marked: Boolean(viaSetup) } }),
        },
        requester,
      );
      if (resume) {
        announceSpawned(terminal, requester);
        return { status: 'started', session: resume, terminal };
      }
      const session: Session = {
        id,
        name: sessionName(state, harness, workspace?.path),
        harness: harness.id,
        directory,
        createdAt: new Date().toISOString(),
        ...(workspace && { project: workspace.project, open: true }),
      };
      commitOrThrow(addSession(state, session));
      // After the state: whoever hears of the terminal finds its session.
      announceSpawned(terminal, requester);
      return { status: 'started', session, terminal };
    } catch (error) {
      pendingNames.delete(id);
      if (terminal) {
        terminals.kill(terminal.id);
        // Whoever hears of its exit must know the terminal: the requester has it in the refusal, the others are told now.
        if (!requester) announceSpawned(terminal);
      }
      if (!workspace) rmSync(directory, { recursive: true, force: true });
      return { ...refuse(`Could not start ${harness.name}: ${error instanceof Error ? error.message : String(error)}`), ...(terminal && { terminal }) };
    }
  }

  const handlers: { [Method in CallMethod]: (params: Calls[Method]['params'], requester: Subscriber) => Calls[Method]['result'] | Promise<Calls[Method]['result']> } = {
    state: snapshot,

    'project-list': async () => {
      const env = await loginEnv();
      return Promise.all(state.projects.map((project) => toProject(project, setups.values(), env)));
    },

    harnesses: async ({ again, known }) => {
      if (known) detection = Promise.resolve(known as DetectedHarness[]);
      else if (again) detection = undefined;
      return (await detected()).map(({ id, version, path }) => ({ id, name: harnesses.find((harness) => harness.id === id)!.name, version, path }));
    },

    'project-add': async ({ folder }) => {
      try {
        return await addRoot(await findRepositoryRoot(folder, { env: await loginEnv() }));
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'NOT_A_REPOSITORY') return { status: 'not-a-repository', folder };
        if (error instanceof WorkspaceError) return refuse(error.message);
        throw error;
      }
    },

    'project-remove': ({ path }) => {
      const next = removeProject(state, path);
      if (next.projects.length === state.projects.length) return;
      commitOrThrow(next);
      markClosed(({ project }) => project === path);
    },

    // The project at `from` moved: its repository is found again at `folder`. Its worktrees are reconnected after
    // the state is saved, and a repair that fails (the workspaces then show git's error) does not undo the update.
    'project-update-path': async ({ from, folder }) => {
      // The caller's list can be stale (the project was removed from another window).
      if (!state.projects.some((project) => project.path === from)) return refuse(`${from} is not a project in Cockpit.`);
      try {
        const env = await loginEnv();
        const root = await findRepositoryRoot(folder, { env });
        const refused = commit(updateProjectPath(state, from, root));
        if (refused) return refused;
        await repairWorktrees(root, { env }).catch(() => {});
        return { status: 'updated' };
      } catch (error) {
        if (error instanceof ProjectExistsError) return refuse(`${basename(error.path)} is already in Cockpit.`);
        if (error instanceof WorkspaceError) {
          return refuse(error.code === 'NOT_A_REPOSITORY' ? `${folder} is not in a git repository.` : error.message);
        }
        throw error;
      }
    },

    // The branch is named after the task, with a free name: not a local branch, not an existing worktree folder.
    // Without a `base` the repository's default base is the one.
    'workspace-create': ({ project, task, base }) => {
      let name = task;
      return forProject<CreateWorkspaceResult>(
        project,
        async () => {
          const env = await loginEnv();
          const from = base ?? (await listBranches(project, { env })).defaultBase;
          if (from === null) return refuse('There is no base branch to create the workspace from.');
          name = await availableBranch(project, task, { env, root: worktreesRoot });
          const { path, branch } = await createWorktree({ repo: project, root: worktreesRoot, branch: name, base: from, env });
          // The worktree is no part of the state, but the windows list it.
          announce();
          return { status: 'created', workspace: { path, name: branch ?? basename(path), branch } };
        },
        (error) => {
          const message = creationRefusal(error, name);
          return message === undefined ? undefined : refuse(message);
        },
      );
    },

    // Reserves the branch and the worktree's path, answers, and sets the workspace up in the background. A `null`
    // base is the main workspace: the project is marked and its path is the workspace's, named after its branch.
    'workspace-compose': ({ project, task, base, harness }) => {
      let name = task;
      return forProject(
        project,
        async () => {
          const env = await loginEnv();
          let path = project;
          if (base === null) {
            name = workspaceName((await listWorktrees(project, { env })).find((worktree) => worktree.main)!);
            if (!hasMainWorkspace(state, project)) {
              const refused = commit(setMainWorkspace(state, project, true));
              if (refused) return refused;
            }
          } else {
            const taken = [...setups.values()].filter((setup) => setup.project === project).map((setup) => setup.branch);
            name = await availableBranch(project, task, { env, root: worktreesRoot, reserved: taken });
            path = await reservedPath({ repo: project, root: worktreesRoot, branch: name, env });
          }
          const setup: Setup = { project, path, branch: name, base, harness, task };
          setups.set(path, setup);
          announce();
          void runSetup(setup);
          return { status: 'reserved' as const, path, name };
        },
        (error) => {
          const message = creationRefusal(error, name);
          return message === undefined ? undefined : refuse(message);
        },
      );
    },

    'workspace-remove': ({ project, path, options }) =>
      forProject<Exclude<RemoveWorkspaceResult, Refused>>(
        project,
        async () => {
          // The folder is the user's: only the mark goes, and the sessions end.
          if (isMainWorkspace(state, project, path)) {
            const refused = commit(setMainWorkspace(state, project, false));
            if (refused) throw new Error(refused.message);
            await endWorkspace(path);
            return { status: 'removed', branchKept: false };
          }
          const failed = options.teardown ? await runTeardown(project, path) : undefined;
          if (failed && !options.force) return refuse(failed);
          await removeWorktree({
            repo: project,
            path,
            force: options.force,
            deleteBranch: options.deleteBranch,
            forceBranch: options.forceBranch,
            env: await loginEnv(),
          });
          announce();
          await endWorkspace(path);
          return { status: 'removed', branchKept: false };
        },
        async (error) => {
          if (error.code === 'BRANCH_NOT_MERGED') {
            announce();
            await endWorkspace(path);
            return { status: 'removed', branchKept: true };
          }
          if (error.code === 'DIRTY_WORKTREE') return { status: 'dirty' };
          return undefined;
        },
      ),

    'dismiss-setup': ({ id }) => {
      failedSetups = failedSetups.filter((failed) => failed.id !== id);
      announce();
    },

    'session-start': ({ harness, size, options, subscribe }, requester) =>
      startSession(subscribe ? requester : undefined, harness, size, options),

    'session-resume': ({ sessionId, size, subscribe }, requester) => {
      const session = state.sessions.find(({ id }) => id === sessionId);
      const { project, harnessSessionId } = session ?? {};
      if (!session || project === undefined || harnessSessionId === undefined) return refuse('This session has no conversation to resume.');
      return startSession(subscribe ? requester : undefined, session.harness, size, { workspace: { project, path: session.directory } }, { ...session, harnessSessionId });
    },

    'session-dismiss': ({ sessionId }) => markClosed(({ id }) => id === sessionId),

    'remember-app': ({ kind, id }) => {
      if (state[kind] !== id) commitOrThrow(rememberApp(state, kind, id));
    },

    'harness-session': ({ sessionId, harnessSessionId }) => storeHarnessSessionId(sessionId, harnessSessionId),
  };

  return {
    call: <Method extends CallMethod>(method: Method, params: Calls[Method]['params'], requester: Subscriber) =>
      (handlers[method] as (params: Calls[Method]['params'], requester: Subscriber) => Calls[Method]['result'] | Promise<Calls[Method]['result']>)(params, requester),

    /** A session reported through the status endpoint of a daemon of this build. */
    report({ sessionId, ...rest }: SessionReport): void {
      if (rest.event === 'harness-session') storeHarnessSessionId(sessionId, rest.harnessSessionId);
      else if (rest.event === 'exited') pendingNames.delete(sessionId);
    },

    /** A terminal ended. One that ended by itself (not killed) closes its session's open mark. */
    terminalEnded({ sessionId }: TerminalInfo, killed: boolean): void {
      if (sessionId === undefined) return;
      pendingNames.delete(sessionId);
      if (!killed) markClosed(({ id }) => id === sessionId);
    },

    // A session's program set a terminal title. The terminals forward only those between the markers
    // `cockpit setup` writes around the agent, so the setup's and the login shell's never get here. The
    // first one its harness derives from the prompt names the workspace: the branch follows it (`nameWorkspace`).
    async title(sessionId: string, title: string): Promise<void> {
      const pending = pendingNames.get(sessionId);
      if (!pending) return;
      const name = pending.harness.promptTitle(title);
      if (name === null) return;
      pendingNames.delete(sessionId);
      try {
        await nameWorkspace({ worktree: pending.worktree, name, env: await loginEnv() });
      } catch {
        // The workspace keeps the name it has.
        return;
      }
      // The windows list again.
      announce();
    },
  };
}

export type Actions = ReturnType<typeof createActions>;
