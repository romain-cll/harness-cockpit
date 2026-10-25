import type { useRouter } from '@tanstack/react-router';
import type { PtyExit } from '../../shared/api';
import { closeLiveTerminal, runWorkspaceCommands, startSession, type LiveTerminal } from './live-terminals';

type Router = ReturnType<typeof useRouter>;

// The setup commands of the workspaces created in this window, kept for the page's lifetime like the
// session terminals: leaving the setup page and coming back finds the terminal and the process as they
// were, and a reload drops the store, which ends the processes with the page.
export interface Setup {
  project: string;
  workspace: { path: string; name: string };
  terminal?: LiveTerminal;
  status: 'running' | 'done' | 'failed';
  /** Why the setup failed: the exit status line, or the message of the refusal when nothing ran. */
  failure?: string;
  /** Why the session that follows the setup was refused. */
  sessionRefusal?: string;
  /** The session to start once the setup passes (or when the user says so); cleared once a start was attempted. */
  agent?: { harness: string; prompt: string };
}

// Keyed by the worktree's path. A setup is replaced, never mutated, so `useSyncExternalStore` sees stable snapshots.
const setups = new Map<string, Setup>();
const listeners = new Set<() => void>();

function set(path: string, setup: Setup) {
  setups.set(path, setup);
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const getSetup = (path: string) => setups.get(path);

// Whether the setup page of that workspace is the one shown.
function isShown(router: Router, path: string): boolean {
  const { pathname, search } = router.state.location;
  return pathname === '/setup' && (search as { path?: string }).path === path;
}

// Starts the agent the user chose, once. The session's page opens when `open` is true or the setup page
// is still shown; otherwise the session is only listed under its workspace.
async function startAgent(router: Router, path: string, open: boolean): Promise<void> {
  const setup = setups.get(path);
  if (!setup?.agent) return;
  const { harness, prompt } = setup.agent;
  set(path, { ...setup, agent: undefined });
  const result = await startSession(harness, { workspace: { project: setup.project, path }, prompt }).catch((error: unknown) => ({
    status: 'refused' as const,
    message: error instanceof Error ? error.message : String(error),
  }));
  if (result.status === 'refused') {
    const current = setups.get(path);
    if (current) set(path, { ...current, sessionRefusal: result.message });
    return;
  }
  await router.invalidate();
  if (open || isShown(router, path)) {
    await router.navigate({ to: '/sessions/$sessionId', params: { sessionId: result.session.id } });
  }
}

async function succeed(router: Router, path: string): Promise<void> {
  const setup = setups.get(path);
  if (!setup) return;
  set(path, { ...setup, status: 'done', failure: undefined });
  await startAgent(router, path, false);
}

async function finish(router: Router, path: string, terminal: LiveTerminal, { exitCode }: PtyExit): Promise<void> {
  const setup = setups.get(path);
  // The setup was run again or ended meanwhile.
  if (setup?.terminal !== terminal) return;
  if (exitCode === 0) {
    await succeed(router, path);
    return;
  }
  const failure = exitCode === null ? 'Setup ended before it finished.' : `Setup failed with exit code ${exitCode}`;
  set(path, { ...setup, status: 'failed', failure });
}

// Runs the setup commands in a terminal of the setup, which has none; `initial` is the setup to store
// when it is not stored yet. `onShown` runs once the terminal is stored, before its exit is
// looked at. Resolves `none` when the config holds no setup command.
async function launch(router: Router, path: string, initial?: Setup, onShown?: () => Promise<void>): Promise<'none' | 'ran'> {
  const asked = setups.get(path) ?? initial!;
  const result = await runWorkspaceCommands(asked.project, path, 'setup');
  if (result.status === 'none') return 'none';
  const setup = setups.get(path) ?? initial;
  if (!setup) {
    // The workspace was deleted while the commands were starting.
    if (result.status === 'started') closeLiveTerminal(result.entry);
    return 'ran';
  }
  if (result.status === 'refused') {
    set(path, { ...setup, status: 'failed', failure: result.message });
    await onShown?.();
    return 'ran';
  }
  set(path, { ...setup, terminal: result.entry, status: 'running', failure: undefined });
  void (async () => {
    await onShown?.();
    await finish(router, path, result.entry, await result.exit);
  })();
  return 'ran';
}

/**
 * Runs the setup of a new workspace and opens its page, or resolves `none` when the config holds no
 * setup command (nothing is stored). On success the `agent` starts, as its page opens if the setup
 * page is still shown; on failure it waits for `retrySetup` or `startAnyway`.
 */
export function setUpWorkspace(
  router: Router,
  project: string,
  workspace: { path: string; name: string },
  agent?: { harness: string; prompt: string },
): Promise<'none' | 'ran'> {
  const initial: Setup = { project, workspace, status: 'running', agent };
  return launch(router, workspace.path, initial, () => router.navigate({ to: '/setup', search: { path: workspace.path } }));
}

/** Runs a failed setup again, reading the config again. */
export async function retrySetup(router: Router, path: string): Promise<void> {
  const setup = setups.get(path);
  if (!setup || setup.status !== 'failed') return;
  // The old terminal goes at once: the new one takes its place on the page when it starts.
  if (setup.terminal) closeLiveTerminal(setup.terminal);
  set(path, { ...setup, terminal: undefined, status: 'running', failure: undefined, sessionRefusal: undefined });
  // The config no longer holds a setup command: there is nothing left to wait for.
  if ((await launch(router, path)) === 'none') await succeed(router, path);
}

/** Starts the pending agent without waiting for the setup to pass. */
export async function startAnyway(router: Router, path: string): Promise<void> {
  const setup = setups.get(path);
  if (setup) set(path, { ...setup, sessionRefusal: undefined });
  await startAgent(router, path, true);
}

/** Ends the setups among `paths` (their workspace or project is gone) and drops them. */
export function endSetups(paths: string[]): void {
  for (const path of paths) {
    const terminal = setups.get(path)?.terminal;
    if (terminal) closeLiveTerminal(terminal);
    setups.delete(path);
  }
  for (const listener of listeners) listener();
}
