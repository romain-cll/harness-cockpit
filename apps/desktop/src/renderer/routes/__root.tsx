import { createRootRoute, Outlet } from '@tanstack/react-router';
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
  return (
    <div className="flex h-screen">
      <AppSidebar version={version} projects={projects} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
