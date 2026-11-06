import { createRootRoute, Outlet, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AddProject } from '@/components/add-project';
import { AppSidebar } from '@/components/app-sidebar';
import { useSidebarCollapsed } from '@/components/collapsed';
import { RestartServiceDialog } from '@/components/daemon-down';
import { ChangesPanel, RightRail, useRightBar, workspaceOf } from '@/components/changes-panel';
import { restoreFromDaemon, selectSessionTab } from '@/components/workspace-panes';

export const Route = createRootRoute({
  loader: async () => {
    const [version, projects, sessions, daemon, git, failedSetups] = await Promise.all([
      window.api.getVersion(),
      window.api.projects.list(),
      window.api.sessions.list(),
      window.api.daemon.status(),
      window.api.projects.git(),
      window.api.workspaces.failedSetups(),
    ]);
    // The shells and sessions the daemons run come back with their screens, once per page load. The page
    // does not wait for them: a daemon that does not answer must not keep it from opening.
    void restoreFromDaemon();
    return { version, projects, sessions, daemon, git, failedSetups };
  },
  component: RootLayout,
});

function RootLayout() {
  const { version, projects, sessions, daemon, git, failedSetups } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  // The right column belongs to the workspace page.
  const { pathname, search } = useLocation();
  const workspace = workspaceOf(pathname === '/workspace' ? (search as { path?: string }).path : undefined, projects);
  const { open: rightBarOpen } = useRightBar();
  const sidebarHidden = useSidebarCollapsed();
  // Worktrees may be added or removed outside the app: list them again when the window gains focus.
  useEffect(() => {
    const refresh = () => void router.invalidate();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [router]);
  // The main process changed a workspace (named after its agent's title): list the projects again.
  useEffect(() => window.api.projects.onChanged(() => void router.invalidate()), [router]);
  // The service died, started or failed to start: read its status again.
  useEffect(() => window.api.daemon.onChanged(() => void router.invalidate()), [router]);
  // A session the sidebar does not list yet (started by another caller than its menus) reported: list again.
  useEffect(
    () => window.api.sessions.onStatus((sessionId) => sessions.some(({ id }) => id === sessionId) || void router.invalidate()),
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
      {!sidebarHidden && <AppSidebar version={version} projects={projects} sessions={sessions} daemon={daemon} git={git} failedSetups={failedSetups} />}
      <main className="flex min-w-0 flex-1 flex-col bg-background p-2">
        <Outlet />
      </main>
      <AddProject />
      <RestartServiceDialog />
      {workspace && !workspace.workspace.settingUp &&
        (rightBarOpen ? (
          <ChangesPanel key={workspace.workspace.path} project={workspace.project} workspace={workspace.workspace} />
        ) : (
          <RightRail />
        ))}
    </div>
  );
}
