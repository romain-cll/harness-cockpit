import { projectColour } from '@/components/project-colour';

/** A project's 16 px badge: its first character on the colour its path picks. */
export function ProjectBadge({ path, name }: { path: string; name: string }) {
  return (
    <span
      className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9px] leading-none text-project-foreground ${projectColour(path)}`}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
