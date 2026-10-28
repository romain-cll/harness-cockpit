import { createRootRoute, Outlet, useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { ChangesPanel, useChangesOpen, workspaceOf } from '@/components/changes-panel';
import { restoreTerminals } from '@/components/live-terminals';
import { restoreTabs } from '@/components/terminal-tabs';

export const Route = createRootRoute({
  loader: async () => {
    const [version, projects, sessions, daemon] = await Promise.all([
      window.api.getVersion(),
      window.api.projects.list(),
      window.api.sessions.list(),
      window.api.daemon.status(),
      // The shells and sessions the daemons run come back with their screens, once per page load.
      restoreTerminals().then(restoreTabs),
    ]);
    return { version, projects, sessions, daemon };
  },
  component: RootLayout,
});

function RootLayout() {
  const { version, projects, sessions, daemon } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  // The Changes sidebar belongs to the page of a session that runs in a workspace.
  const { sessionId } = useParams({ strict: false });
  const workspace = workspaceOf(sessions.find(({ id }) => id === sessionId), projects);
  const changesOpen = useChangesOpen();
  // Worktrees may be added or removed outside the app: list them again when the window gains focus.
  useEffect(() => {
    const refresh = () => void router.invalidate();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [router]);
  // A clicked notification opens its session's page.
  useEffect(
    () => window.api.sessions.onOpen((sessionId) => void navigate({ to: '/sessions/$sessionId', params: { sessionId } })),
    [navigate],
  );
  return (
    <div className="flex h-screen">
      <AppSidebar version={version} projects={projects} sessions={sessions} daemon={daemon} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
      {changesOpen && workspace && <ChangesPanel key={workspace.workspace.path} project={workspace.project} workspace={workspace.workspace} />}
    </div>
  );
}
