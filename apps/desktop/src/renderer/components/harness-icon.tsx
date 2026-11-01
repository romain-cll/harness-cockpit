import { BotIcon } from 'lucide-react';
import type { ComponentProps, ReactElement } from 'react';

// The logo of each agent CLI of the catalogue (`@cockpit/harnesses`), drawn in `currentColor` so it
// follows the theme: a spark for Claude Code, a hexagon holding a prompt for Codex, a framed block for
// OpenCode. An agent the catalogue gains later shows a generic bot until it gets its own.
const LOGOS: Record<string, (props: ComponentProps<'svg'>) => ReactElement> = {
  'claude-code': (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" {...props}>
      <path d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M18.7 5.3 5.3 18.7" />
    </svg>
  ),
  codex: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 2.5 20.2 7.25v9.5L12 21.5l-8.2-4.75v-9.5z" />
      <path d="m9 10 2.5 2L9 14M13 14.5h2.5" />
    </svg>
  ),
  opencode: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" {...props}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
    </svg>
  ),
};

/** The logo of an agent CLI, by its catalogue id. */
export function HarnessIcon({ harness, className }: { harness: string; className?: string }) {
  const Logo = LOGOS[harness];
  return Logo ? <Logo aria-hidden="true" className={className} /> : <BotIcon aria-hidden="true" className={className} />;
}
