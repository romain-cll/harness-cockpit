import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { State } from '@cockpit/state';
import { listWorktrees, WorkspaceError, type Worktree } from '@cockpit/workspaces';
import type { Project, Refused, Setup, Workspace } from './protocol';

// Whether the project has its main workspace, the one with no worktree.
export const hasMainWorkspace = (state: State, project: string) =>
  state.projects.some((entry) => entry.path === project && entry.mainWorkspace === true);

// The main workspace's path is its project's.
export const isMainWorkspace = (state: State, project: string, path: string) => path === project && hasMainWorkspace(state, project);

// What the user calls a workspace: its branch, or its folder name when detached.
export const workspaceName = ({ branch, path }: Worktree) => branch ?? basename(path);

// Why git could not do what was asked of `path`, in words for the user.
export function describeFailure(error: WorkspaceError, path: string): string {
  return error.code === 'NOT_A_REPOSITORY' ? `${path} is not a git repository.` : error.message;
}

// A workspace is a project of the state and one of its linked worktrees (git tells), or its main working tree when it has its main workspace.
export async function findWorkspace(
  state: State,
  { project, path }: { project: string; path: string },
  env: NodeJS.ProcessEnv,
): Promise<Worktree | Refused> {
  if (!state.projects.some((entry) => entry.path === project)) {
    return { status: 'refused', message: `${project} is not a project in Cockpit.` };
  }
  try {
    const worktrees = await listWorktrees(project, { env });
    const found = worktrees.find((worktree) => (!worktree.main || hasMainWorkspace(state, project)) && worktree.path === path);
    if (found) return found;
    return { status: 'refused', message: `${path} is not a workspace of ${basename(project)}.` };
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return { status: 'refused', message: describeFailure(error, project) };
  }
}

// A project with its workspaces, which git tells: the linked worktrees, and the main working tree when the project has its main workspace.
export async function toProject(
  { path, mainWorkspace }: { path: string; mainWorkspace?: boolean },
  setups: Iterable<Setup>,
  env: NodeJS.ProcessEnv,
): Promise<Project> {
  const project = { path, name: basename(path) };
  // An absent folder, or a path that is not a folder (a file took its place), is "not found"; any other failure
  // (EACCES, EIO…) goes on to git, as before.
  const gone = await stat(path).then(
    (found) => !found.isDirectory(),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR',
  );
  if (gone) return { ...project, workspaces: [], missing: true };
  try {
    const worktrees = await listWorktrees(path, { env });
    const workspaces: Workspace[] = worktrees
      .filter((worktree) => mainWorkspace || !worktree.main)
      .map(({ path, branch, name, main }): Workspace =>
        main ? { path, name: branch ?? basename(path), branch, main: true } : { path, name: name ?? branch ?? basename(path), branch },
      );
    // A workspace being set up is a row from the reservation on, whether git lists its worktree yet or not.
    for (const setup of setups) {
      if (setup.project !== path) continue;
      const listed = workspaces.find((workspace) => workspace.path === setup.path);
      if (listed) listed.settingUp = true;
      else workspaces.push({ path: setup.path, name: setup.branch, branch: setup.branch, settingUp: true });
    }
    return { ...project, workspaces };
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return { ...project, workspaces: [], error: describeFailure(error, path) };
  }
}
