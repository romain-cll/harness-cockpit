import { createFileRoute, rootRouteId, useLoaderData } from '@tanstack/react-router';
import { NoProjects } from '@/components/add-project';
import { NewWorkspace } from '@/components/new-workspace';

export const Route = createFileRoute('/')({
  // `project` is a project's path, or `none` for no project.
  validateSearch: (search): { project?: string } => (typeof search.project === 'string' ? { project: search.project } : {}),
  component: Home,
});

// With no project the home page shows how to add one; `?project=none` is still the composer.
function Home() {
  const { projects } = useLoaderData({ from: rootRouteId });
  const requested = Route.useSearch({ select: (search) => search.project });
  return projects.length === 0 && requested !== 'none' ? <NoProjects /> : <NewWorkspace />;
}
