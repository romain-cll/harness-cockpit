import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { versionLabel } from '../src/renderer/components/version-label';

// COCKPIT-23: the sidebar footer shows an alpha version `0.0.0-alpha.N` as `Alpha N`, any other form as it is.

describe('versionLabel', () => {
  test('AC1 — 0.0.0-alpha.N reads Cockpit Alpha N', () => {
    expect(versionLabel('0.0.0-alpha.0')).toBe('Cockpit Alpha 0');
    expect(versionLabel('0.0.0-alpha.12')).toBe('Cockpit Alpha 12');
  });

  test('AC1 — a version of another form is shown as it is', () => {
    expect(versionLabel('0.1.0')).toBe('Cockpit 0.1.0');
    expect(versionLabel('1.0.0-beta.1')).toBe('Cockpit 1.0.0-beta.1');
  });

  test('AC1 — the app is on an alpha version, so its footer reads Cockpit Alpha N', () => {
    const { version } = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect(version).toMatch(/^0\.0\.0-alpha\.\d+$/);
    expect(versionLabel(version)).toMatch(/^Cockpit Alpha \d+$/);
  });
});
