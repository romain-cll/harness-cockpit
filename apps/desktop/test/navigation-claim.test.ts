import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, test } from 'vitest';
import { claimNavigation } from '../src/renderer/components/navigation-claim';

// COCKPIT-86 AC4: a flow that navigates after an `await` claims the navigation at the user's action and asks the
// claim right before it navigates: it may only if it is the latest claim and the user went nowhere since. The
// module imports nothing through `@/` (it is imported here), only a type from the router's history.

const memory = () => createMemoryHistory({ initialEntries: ['/start'] });

describe('claimNavigation', () => {
  test('AC4 — a claim with nothing changed since may navigate, and keeps that answer when asked again', () => {
    const history = memory();
    const mayNavigate = claimNavigation(history);
    expect(mayNavigate()).toBe(true);
    expect(mayNavigate()).toBe(true);
  });

  test('AC4 — a push after the claim takes it away', () => {
    const history = memory();
    const mayNavigate = claimNavigation(history);
    history.push('/elsewhere');
    expect(mayNavigate()).toBe(false);
  });

  test('AC4 — a replace after the claim takes it away', () => {
    const history = memory();
    const mayNavigate = claimNavigation(history);
    history.replace('/elsewhere');
    expect(mayNavigate()).toBe(false);
  });

  test('AC4 — going back after the claim takes it away', () => {
    const history = memory();
    history.push('/second');
    const mayNavigate = claimNavigation(history);
    history.back();
    expect(mayNavigate()).toBe(false);
  });

  test('AC4 — of two claims only the later may navigate, whichever is asked first', () => {
    const history = memory();
    const first = claimNavigation(history);
    const second = claimNavigation(history);
    expect(first()).toBe(false);
    expect(second()).toBe(true);

    const earlier = claimNavigation(history);
    const later = claimNavigation(history);
    expect(later()).toBe(true);
    expect(earlier()).toBe(false);
  });
});
