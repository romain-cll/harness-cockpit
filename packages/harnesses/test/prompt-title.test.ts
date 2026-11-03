import { describe, expect, test } from 'vitest';
import { harnesses } from '../src/index';

// COCKPIT-66: the terminal title a harness sets from the user's first prompt, as the OSC 0/2 title
// the daemon forwards. `promptTitle(title)` gives the name to use, or null when the title is not
// prompt-derived (the idle title, an unrelated title, the empty title). The formats were read in the
// CLIs' sources; these tests pin the recorded titles. No real CLI is run.

function titleOf(id: string, title: string): string | null {
  const harness = harnesses.find((candidate) => candidate.id === id);
  if (!harness) throw new Error(`no harness ${id}`);
  return harness.promptTitle(title);
}

describe('Claude Code', () => {
  test.each([
    ['✳ Fix the login redirect loop', 'Fix the login redirect loop'],
    ['◐ Fix the login redirect loop', 'Fix the login redirect loop'],
    ['◑ Fix the login redirect loop', 'Fix the login redirect loop'],
    ['✳ Fix: the (login) loop', 'Fix: the (login) loop'],
  ])('AC21 — %j gives %j', (title, name) => {
    expect(titleOf('claude-code', title)).toBe(name);
  });

  test.each(['✳ Claude Code', '◐ Claude Code', '◑ Claude Code', 'Claude Code', '', '✳', '✳ ', 'bash', 'Fix the login redirect loop', '~/projects/app'])(
    'AC23 — %j is not a prompt-derived title',
    (title) => {
      expect(titleOf('claude-code', title)).toBeNull();
    },
  );
});

describe('Codex', () => {
  test.each([
    ['Fix login | my-project', 'Fix login'],
    ['⠋ Fix login | my-project', 'Fix login'],
    ['⠙ ⠹ Fix login | my-project', 'Fix login'],
    ['● Fix login | my-project', 'Fix login'],
    ['[ ! ] Action Required | Fix login | my-project', 'Fix login'],
    ['● [ ! ] Action Required | Fix login | my-project', 'Fix login'],
    ['[ . ] Action Required | Fix login | my-project', 'Fix login'],
    ['Fix | the login thing | my-project', 'Fix | the login thing'],
  ])('AC21 — %j gives %j', (title, name) => {
    expect(titleOf('codex', title)).toBe(name);
  });

  test.each(['my-project', '⠋ my-project', '[ ! ] Action Required | my-project', '⠋ | my-project', '⠋ ⠙ | my-project', '', 'bash'])(
    'AC23 — %j is not a prompt-derived title',
    (title) => {
      expect(titleOf('codex', title)).toBeNull();
    },
  );
});

describe('OpenCode', () => {
  test.each([
    ['OC | Fix login', 'Fix login'],
    ['OC | Fix the login redirect loop and more…', 'Fix the login redirect loop and more'],
    ['OC | Title: with | bars', 'Title: with | bars'],
  ])('AC21 — %j gives %j', (title, name) => {
    expect(titleOf('opencode', title)).toBe(name);
  });

  test.each(['OpenCode', '', 'OC |', 'OC | ', 'OC', 'bash', 'Fix login'])('AC23 — %j is not a prompt-derived title', (title) => {
    expect(titleOf('opencode', title)).toBeNull();
  });
});
