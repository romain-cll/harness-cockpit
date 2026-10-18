import { createRootRoute, Outlet } from '@tanstack/react-router';
import { AppSidebar } from '@/components/app-sidebar';

export const Route = createRootRoute({
  loader: () => window.api.getVersion(),
  component: RootLayout,
});

function RootLayout() {
  const version = Route.useLoaderData();
  return (
    <div className="flex h-screen">
      <AppSidebar version={version} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
