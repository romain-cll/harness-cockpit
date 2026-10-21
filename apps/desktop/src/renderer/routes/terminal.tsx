import { createFileRoute } from '@tanstack/react-router';
import { TerminalTabs } from '@/components/terminal-tabs';

export const Route = createFileRoute('/terminal')({
  component: TerminalTabs,
});
