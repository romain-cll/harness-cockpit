import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return <PageHeader title="Home" />;
}
