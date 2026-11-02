import { createRootRoute, Outlet, useLocation, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { useSidebarCollapsed } from '@/components/collapsed';
import { ChangesPanel, RightRail, useRightBar, workspaceOf } from '@/components/changes-panel';
import { restoreFromDaemon, selectSessionTab } from '@/components/workspace-panes';

let loaderRuns = 0;

export const Route = createRootRoute({
  loader: async () => {
    // COCKPIT-80 diagnosis (throwaway).
    const run = ++loaderRuns;
    const t0 = performance.now();
    const timed = <T,>(name: string, promise: Promise<T>) =>
      promise.then((value) => {
        console.debug(`[ck80] ${Date.now()} loader#${run} ${name} after ${Math.round(performance.now() - t0)} ms`);
        return value;
      });
    console.debug(`[ck80] ${Date.now()} loader#${run} start ${location.href}`);
    const [version, projects, sessions, daemon, git] = await Promise.all([
      timed('getVersion', window.api.getVersion()),
      timed('projects.list', window.api.projects.list()),
      timed('sessions.list', window.api.sessions.list()),
      timed('daemon.status', window.api.daemon.status()),
      timed('projects.git', window.api.projects.git()),
    ]);
    console.debug(`[ck80] ${Date.now()} loader#${run} end after ${Math.round(performance.now() - t0)} ms, workspaces ${JSON.stringify(projects.map((p) => p.workspaces?.map((w) => w.name)))} daemon ${daemon.status}`);
    // The shells and sessions the daemons run come back with their screens, once per page load. The page
    // does not wait for them: a daemon that does not answer must not keep it from opening.
    void restoreFromDaemon();
    return { version, projects, sessions, daemon, git };
  },
  component: RootLayout,
});

function RootLayout() {
  const { version, projects, sessions, daemon, git } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  // The right column belongs to the workspace page.
  const { pathname, search } = useLocation();
  const workspace = workspaceOf(pathname === '/workspace' ? (search as { path?: string }).path : undefined, projects);
  const { open: rightBarOpen } = useRightBar();
  const sidebarHidden = useSidebarCollapsed();
  // COCKPIT-80 diagnosis (throwaway): every change of the router's state.
  const routerState = useRouterState({
    select: (s) =>
      `status=${s.status} isLoading=${s.isLoading} isTransitioning=${s.isTransitioning} loc=${s.location.href} resolved=${s.resolvedLocation?.href} matches=${s.matches.map((m) => `${m.routeId}:${m.status}${m.isFetching ? '(fetching)' : ''}`).join(',')} pending=${(s.pendingMatches ?? []).map((m) => `${m.routeId}:${m.status}`).join(',')}`,
  });
  useEffect(() => console.debug(`[ck80] ${Date.now()} router ${routerState}`), [routerState]);
  // Worktrees may be added or removed outside the app: list them again when the window gains focus.
  useEffect(() => {
    const refresh = () => {
      console.debug(`[ck80] ${Date.now()} window focus → invalidate`);
      void router.invalidate();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [router]);
  // A session the sidebar does not list yet (started by another caller than its menus) reported: list again.
  useEffect(
    () =>
      window.api.sessions.onStatus((sessionId) => {
        const known = sessions.some(({ id }) => id === sessionId);
        console.debug(`[ck80] ${Date.now()} sessions.onStatus ${sessionId} known=${known}${known ? '' : ' → invalidate'}`);
        return known || void router.invalidate();
      }),
    [router, sessions],
  );
  // A clicked notification opens its session's page, or its workspace's with the session's tab selected.
  useEffect(
    () =>
      window.api.sessions.onOpen((sessionId) => {
        const session = sessions.find(({ id }) => id === sessionId);
        if (session?.project && workspaceOf(session.directory, projects)) {
          selectSessionTab(session.directory, sessionId);
          void navigate({ to: '/workspace', search: { path: session.directory } });
        } else {
          void navigate({ to: '/sessions/$sessionId', params: { sessionId } });
        }
      }),
    [navigate, sessions, projects],
  );
  return (
    <div className="flex h-screen">
      {!sidebarHidden && <AppSidebar version={version} projects={projects} sessions={sessions} daemon={daemon} git={git} />}
      <main className="flex min-w-0 flex-1 flex-col bg-background p-2">
        <Outlet />
      </main>
      {workspace &&
        (rightBarOpen ? (
          <ChangesPanel key={workspace.workspace.path} project={workspace.project} workspace={workspace.workspace} />
        ) : (
          <RightRail />
        ))}
    </div>
  );
}
