import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

// COCKPIT-55 (AC16): the global setup (`global-teardown.ts`) makes one folder for the whole test
// run and hands its path to the test files through this variable. Every folder a test makes is made
// inside it, so the teardown finds the run's daemons under it (and nobody else's), and removes it.
export const RUN_ROOT_ENV = 'COCKPIT_TEST_RUN_ROOT';

export function runRoot(): string {
  const root = process.env[RUN_ROOT_ENV];
  if (!root) throw new Error(`${RUN_ROOT_ENV} is not set: the vitest global setup (test/global-teardown.ts) has not run`);
  return root;
}

/**
 * A new folder inside the run's root. Keep `prefix` short (at most 3 characters): a socket path
 * is limited to 103 bytes on macOS, and `daemon-1-<build>.sock` sits a few folders below.
 */
export const makeTestDir = (prefix: string): string => mkdtempSync(join(runRoot(), prefix));
