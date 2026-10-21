import { createRootRoute, Outlet, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AppSidebar } from '@/components/app-sidebar';

export const Route = createRootRoute({
  loader: async () => {
    const [version, projects] = await Promise.all([window.api.getVersion(), window.api.projects.list()]);
    return { version, projects };
  },
  component: RootLayout,
});

function RootLayout() {
  const { version, projects } = Route.useLoaderData();
  const router = useRouter();
  // Worktrees may be added or removed outside the app: list them again when the window gains focus.
  useEffect(() => {
    const refresh = () => void router.invalidate();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [router]);
  return (
    <div className="flex h-screen">
      <AppSidebar version={version} projects={projects} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
