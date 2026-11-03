import { createFileRoute } from '@tanstack/react-router';
import { NewWorkspace } from '@/components/new-workspace';

export const Route = createFileRoute('/')({
  // `project` is a project's path, or `none` for no project.
  validateSearch: (search): { project?: string } => (typeof search.project === 'string' ? { project: search.project } : {}),
  component: NewWorkspace,
});
