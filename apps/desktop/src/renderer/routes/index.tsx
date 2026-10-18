import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/')({
  loader: () => window.api.ping(),
  component: Home,
});

function Home() {
  const reply = Route.useLoaderData();
  return (
    <>
      <PageHeader title="Home" />
      <div className="flex-1 overflow-auto p-4 text-xs text-muted-foreground">
        Main process: {reply}
      </div>
    </>
  );
}
