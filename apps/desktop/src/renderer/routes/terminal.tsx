import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';
import { Terminal } from '@/components/terminal';

export const Route = createFileRoute('/terminal')({
  component: TerminalPage,
});

function TerminalPage() {
  return (
    <>
      <PageHeader title="Terminal" />
      <Terminal />
    </>
  );
}
