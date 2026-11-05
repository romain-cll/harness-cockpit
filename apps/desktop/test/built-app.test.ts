import { expect, test } from 'vitest';
import { launchBuilt } from './launch';
import { describeMode } from './support/mode-checks';
import { unexpectedConsoleErrors } from './support/terminal';

describeMode('built app', launchBuilt);

// The matcher of the navigation tests (tabs AC12): the refusal of the file:// URL
// the test tried is the only console error they allow.
test('tabs AC12 — only the refusal of the exact file:// URL tried is allowed, any other "Not allowed to load local resource" fails', () => {
  const tried = 'file:///tmp/cockpit/test.ts';
  expect(unexpectedConsoleErrors([`Not allowed to load local resource: ${tried}`], tried)).toEqual([]);
  const other = [
    'Not allowed to load local resource: file:///etc/hosts',
    `Not allowed to load local resource: ${tried}/more`,
    'Not allowed to load local resource: ',
    'Not allowed to load local resource',
  ];
  for (const message of other) expect(unexpectedConsoleErrors([message], tried), message).toEqual([message]);
  expect(unexpectedConsoleErrors(['TypeError: x'], tried)).toEqual(['TypeError: x']);
});
