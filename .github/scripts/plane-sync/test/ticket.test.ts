import { describe, expect, test } from 'vitest';

// The module under test does not exist yet: it is imported inside each test so that
// every test fails on its own instead of the whole file failing to load.
async function ticketFromPullRequest(title: string, branch: string): Promise<string | null> {
  const mod = await import('../src/index');
  return mod.ticketFromPullRequest(title, branch);
}

describe('ticketFromPullRequest', () => {
  test('AC1 — finds the id in a conventional PR title', async () => {
    expect(await ticketFromPullRequest('feat(x): y (COCKPIT-7)', 'feature/x')).toBe('COCKPIT-7');
  });

  test('AC2 — takes the last id of a title with two ids', async () => {
    expect(await ticketFromPullRequest('feat(x): follow-up of COCKPIT-3 (COCKPIT-7)', 'feature/x')).toBe(
      'COCKPIT-7',
    );
  });

  test('AC2 — a lower-case id in the title is returned upper-case', async () => {
    expect(await ticketFromPullRequest('feat(x): y (cockpit-7)', 'feature/x')).toBe('COCKPIT-7');
  });

  test('AC2 — the last id wins whatever its case', async () => {
    expect(await ticketFromPullRequest('fix: COCKPIT-3 then cockpit-12', 'feature/x')).toBe('COCKPIT-12');
    expect(await ticketFromPullRequest('fix: cockpit-3 then COCKPIT-12', 'feature/x')).toBe('COCKPIT-12');
  });

  test('AC2 — keeps every digit of the number', async () => {
    expect(await ticketFromPullRequest('feat: y (COCKPIT-144)', 'feature/x')).toBe('COCKPIT-144');
  });

  test('AC3 — falls back to a lower-case branch prefix', async () => {
    expect(await ticketFromPullRequest('Plane sync', 'cockpit-7-plane-sync')).toBe('COCKPIT-7');
  });

  test('AC3 — falls back to an upper-case branch prefix', async () => {
    expect(await ticketFromPullRequest('Plane sync', 'COCKPIT-7-plane-sync')).toBe('COCKPIT-7');
  });

  test('AC3 — a branch that is only the id counts', async () => {
    expect(await ticketFromPullRequest('Plane sync', 'cockpit-7')).toBe('COCKPIT-7');
  });

  test('AC3 — the title wins over the branch', async () => {
    expect(await ticketFromPullRequest('feat: y (COCKPIT-9)', 'cockpit-7-plane-sync')).toBe('COCKPIT-9');
  });

  test('AC4 — no id in the title or in a plain branch gives null', async () => {
    expect(await ticketFromPullRequest('chore: tidy', 'feature/x')).toBeNull();
  });

  test('AC4 — a branch that does not start with cockpit-N gives null', async () => {
    expect(await ticketFromPullRequest('chore: tidy', 'mycockpit-7-x')).toBeNull();
    expect(await ticketFromPullRequest('chore: tidy', 'feature/cockpit-7-x')).toBeNull();
    expect(await ticketFromPullRequest('chore: tidy', 'cockpit-7x')).toBeNull();
  });
});
