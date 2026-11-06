// Pure helpers of the Clone and Create dialogs. Imported by the main process and by a vitest test: no `@/` import.

/** The repository a clone URL names: its last path segment without a final `.git` (`''` for an empty URL). */
export function repositoryName(url: string): string {
  const last = url.trim().replace(/\/+$/, '').split(/[/:]/).at(-1) ?? '';
  return last.replace(/\.git$/, '');
}

/** Why `name` cannot be a project's folder name, `undefined` when it can. */
export function nameProblem(name: string): string | undefined {
  return name === '.' || name === '..' || name.includes('/') ? 'A project name cannot be . or .. or contain /.' : undefined;
}

/** `path` with the home folder written as `~`. */
export function tildePath(path: string, home: string): string {
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
