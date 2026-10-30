import { useSyncExternalStore } from 'react';

// What the sidebar has folded away: the sidebar itself, the Projects and Sessions lists and the
// workspaces of some projects. Kept for the page's lifetime, so going to another page and back finds
// it as it was; a reload shows everything again.
let sidebar = false;
let projects = false;
let sessions = false;
let collapsedProjects: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const useSidebarCollapsed = () => useSyncExternalStore(subscribe, () => sidebar);
export const useProjectsCollapsed = () => useSyncExternalStore(subscribe, () => projects);
export const useSessionsCollapsed = () => useSyncExternalStore(subscribe, () => sessions);
export const useCollapsedProjects = () => useSyncExternalStore(subscribe, () => collapsedProjects);

export function toggleSidebar() {
  sidebar = !sidebar;
  notify();
}

export function toggleProjects() {
  projects = !projects;
  notify();
}

export function toggleSessions() {
  sessions = !sessions;
  notify();
}

/** Folds the workspaces of the project at `path` away, or shows them again. */
export function toggleProject(path: string) {
  const next = new Set(collapsedProjects);
  if (!next.delete(path)) next.add(path);
  collapsedProjects = next;
  notify();
}
