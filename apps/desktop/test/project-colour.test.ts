import { describe, expect, test } from 'vitest';
import { projectColour } from '../src/renderer/components/project-colour';

// COCKPIT-65 AC8: a project's badge colour is one of a fixed palette of six, picked from its path:
// the same path always gets the same colour.

const PALETTE = ['bg-project-1', 'bg-project-2', 'bg-project-3', 'bg-project-4', 'bg-project-5', 'bg-project-6'];

const PATHS = [
  '/Users/romain/projects/cockpit',
  '/Users/romain/projects/superset',
  '/Users/romain/work/api',
  '/Users/romain/work/web',
  '/tmp/ck/p-1/alpha',
  '/private/var/folders/xy/T/bravo-redesign',
];

describe('projectColour', () => {
  test('AC8 — the same path always gets the same colour', () => {
    for (const path of PATHS) expect(projectColour(path)).toBe(projectColour(path));
  });

  test('AC8 — every result is one of the six palette classes', () => {
    for (let index = 0; index < 100; index++) expect(PALETTE).toContain(projectColour(`/Users/romain/projects/repo-${index}`));
  });

  test('AC8 — six different paths do not all get the same colour', () => {
    expect(new Set(PATHS.map(projectColour)).size).toBeGreaterThan(1);
  });
});
