// The background class of a project's badge: one of six palette colours, picked from the path so that
// the same path always gets the same one.
const COLOURS = ['bg-project-1', 'bg-project-2', 'bg-project-3', 'bg-project-4', 'bg-project-5', 'bg-project-6'];

export function projectColour(path: string): string {
  let hash = 0;
  for (const character of path) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length]!;
}
