import { describe, expect, test } from 'vitest';
import { checksHeader, checkTime, overallReview, sortChecks } from '../src/renderer/components/pull-request-format';

// COCKPIT-75: the pure rules of the Pull request tab's Checks and Reviews sections.
//
// The contract these tests fix (the spec names the module and what it holds, not the signatures):
// - a check is `{ check: 'failing' | 'unknown' | 'pending' | 'passing', startedAt, completedAt }`, the times
//   being the ISO strings gh printed (`null` or absent when it printed none, gh's zero date included);
// - `sortChecks(checks)` gives a new array: failing, unknown, pending, passing, the given order within a group;
// - `checksHeader(checks)` gives the Checks header summary;
// - `checkTime(check, now)` gives the right text of a row, `now` (the time of the last read) in milliseconds since the epoch, `''` for none;
// - `overallReview(reviewDecision, reviews)` gives `'changes_requested' | 'approved' | 'review_required' | null`,
//   `reviews` being `{ state: 'changes_requested' | 'approved' | 'commented' | 'dismissed' | 'unknown' }`.

type Check = 'failing' | 'unknown' | 'pending' | 'passing';
const check = (state: Check, extra: { startedAt?: string | null; completedAt?: string | null; id?: string } = {}) => ({
  check: state,
  startedAt: null,
  completedAt: null,
  ...extra,
});

describe('sortChecks', () => {
  test('AC9 — failing first, then unknown, pending, passing, gh\'s order within a group', () => {
    const checks = [
      check('passing', { id: 'p1' }),
      check('failing', { id: 'f1' }),
      check('pending', { id: 'w1' }),
      check('unknown', { id: 'u1' }),
      check('failing', { id: 'f2' }),
      check('passing', { id: 'p2' }),
      check('pending', { id: 'w2' }),
    ];

    expect(sortChecks(checks).map((each) => each.id)).toEqual(['f1', 'f2', 'u1', 'w1', 'w2', 'p1', 'p2']);
    expect(checks[0]!.id, 'the given array is left as it was').toBe('p1');
  });
});

describe('checksHeader', () => {
  const many = (...states: Check[]) => states.map((state) => check(state));

  test.each([
    [['failing', 'passing', 'passing'] as Check[], '3 checks · 1 failing'],
    [['failing', 'failing', 'passing'] as Check[], '3 checks · 2 failing'],
    [['failing', 'pending', 'passing'] as Check[], '3 checks · 1 failing'],
    [['pending', 'passing', 'passing'] as Check[], '3 checks · 1 pending'],
    [['pending', 'unknown', 'pending'] as Check[], '3 checks · 2 pending'],
    [['passing', 'passing', 'passing'] as Check[], '3 checks'],
    [['unknown', 'passing', 'passing'] as Check[], '3 checks'],
    [['passing'] as Check[], '1 check'],
    [['failing'] as Check[], '1 check · 1 failing'],
  ])('AC11 — %j reads "%s"', (states, expected) => {
    expect(checksHeader(many(...states))).toBe(expected);
  });
});

describe('checkTime', () => {
  const at = (time: string) => Date.parse(`2026-11-05T${time}Z`);
  const finished = (started: string, completed: string) => check('passing', { startedAt: `2026-11-05T${started}Z`, completedAt: `2026-11-05T${completed}Z` });
  const NOW = at('12:00:00');

  test.each([
    ['10:00:00', '10:00:12', '12s'],
    ['10:00:00', '10:00:59', '59s'],
    ['10:00:00', '10:06:41', '6m 41s'],
    ['10:00:00', '11:02:05', '1h 2m'],
  ])('AC10 — a finished check from %s to %s reads "%s", whatever the state it ended in', (started, completed, expected) => {
    expect(checkTime(finished(started, completed), NOW)).toBe(expected);
    expect(checkTime({ ...finished(started, completed), check: 'failing' }, NOW)).toBe(expected);
  });

  test.each([
    ['11:57:55', 'Running · 2m'],
    ['11:57:00', 'Running · 3m'],
    ['11:59:48', 'Running · 12s'],
  ])('AC10 — a running check started at %s reads "%s" at the time of the last read', (started, expected) => {
    expect(checkTime(check('pending', { startedAt: `2026-11-05T${started}Z` }), NOW)).toBe(expected);
  });

  test('AC10 — a running check counts up to the time of the last read: a later read gives a later time', () => {
    const running = check('pending', { startedAt: '2026-11-05T11:59:48Z' });

    expect(checkTime(running, NOW)).toBe('Running · 12s');
    expect(checkTime(running, NOW + 60_000)).toBe('Running · 1m');
  });

  test.each([
    ['no start', check('pending')],
    ['a null start', check('pending', { startedAt: null, completedAt: null })],
    ['gh\'s zero date as start', check('pending', { startedAt: '0001-01-01T00:00:00Z', completedAt: '0001-01-01T00:00:00Z' })],
  ])('AC10 — a pending check with %s reads "Queued"', (_label, queued) => {
    expect(checkTime(queued, NOW)).toBe('Queued');
  });

  test.each([
    ['a finished check with no times', check('passing')],
    ['a failing check with no times', check('failing')],
    ['an unknown check', check('unknown')],
    ['an unknown check with times', { ...check('unknown'), startedAt: '2026-11-05T10:00:00Z', completedAt: '2026-11-05T10:00:12Z' }],
  ])('AC10 — %s reads nothing', (_label, each) => {
    expect(checkTime(each, NOW)).toBe('');
  });
});

describe('overallReview', () => {
  const reviews = (...states: Array<'changes_requested' | 'approved' | 'commented' | 'dismissed' | 'unknown'>) => states.map((state) => ({ state }));

  test.each([
    ['CHANGES_REQUESTED', 'changes_requested'],
    ['APPROVED', 'approved'],
    ['REVIEW_REQUIRED', 'review_required'],
  ])('AC13 — the decision %s is the overall state %s, whatever the reviews', (decision, expected) => {
    expect(overallReview(decision, [])).toBe(expected);
    expect(overallReview(decision, reviews('approved', 'changes_requested'))).toBe(expected);
  });

  test('AC13 — an empty decision is derived: any changes requested, else any approval, else nothing', () => {
    expect(overallReview('', reviews('approved', 'changes_requested', 'commented'))).toBe('changes_requested');
    expect(overallReview('', reviews('commented', 'approved'))).toBe('approved');
    expect(overallReview('', reviews('commented', 'dismissed', 'unknown'))).toBeNull();
    expect(overallReview('', [])).toBeNull();
  });

  test('AC13 — a decision gh may add one day reads as no overall state', () => {
    expect(overallReview('SOMETHING_NEW', reviews('approved'))).toBeNull();
  });
});
