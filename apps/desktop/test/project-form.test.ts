import { describe, expect, test } from 'vitest';
import { nameProblem, repositoryName, tildePath } from '../src/renderer/components/project-form';

// COCKPIT-72: the pure helpers of the Clone and Create dialogs.

describe('repositoryName', () => {
  test.each([
    ['https://host/a/b', 'b'],
    ['https://host/a/b.git', 'b'],
    ['https://host/a/b/', 'b'],
    ['git@host:a/b.git', 'b'],
    ['ssh://git@host/a/b.git', 'b'],
  ])('AC9 — %s gives %s', (url, name) => {
    expect(repositoryName(url)).toBe(name);
  });

  test('AC9 — keeps dots and dashes inside the name, and drops only a final .git', () => {
    expect(repositoryName('https://host/a/my.repo-v2.git')).toBe('my.repo-v2');
    expect(repositoryName('https://host/a/git.git')).toBe('git');
  });

  test('AC9 — gives an empty name for an empty URL', () => {
    expect(repositoryName('')).toBe('');
  });
});

describe('nameProblem', () => {
  test.each(['.', '..', 'a/b', '/b', 'b/'])('AC20 — %j is refused with the dialog\'s message', (name) => {
    expect(nameProblem(name)).toBe('A project name cannot be . or .. or contain /.');
  });

  test.each(['b', 'my.repo', '.github', '...', 'with space', 'a-b_c'])('AC20 — %j is a valid name', (name) => {
    expect(nameProblem(name)).toBeFalsy();
  });
});

describe('tildePath', () => {
  test('AC10 — writes the home folder as ~, alone or as the start of a path', () => {
    expect(tildePath('/Users/romain', '/Users/romain')).toBe('~');
    expect(tildePath('/Users/romain/projects', '/Users/romain')).toBe('~/projects');
    expect(tildePath('/Users/romain/a/b', '/Users/romain')).toBe('~/a/b');
  });

  test('AC10 — leaves a path outside the home folder as it is, a folder that merely starts with the same letters included', () => {
    expect(tildePath('/tmp/projects', '/Users/romain')).toBe('/tmp/projects');
    expect(tildePath('/Users/romain2/projects', '/Users/romain')).toBe('/Users/romain2/projects');
  });
});
