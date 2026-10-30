import type { SessionEventName, SetupEventName } from './protocol';

export type { SessionEventName } from './protocol';

/** The values a session event can carry. */
export const SESSION_EVENTS = ['working', 'waiting', 'finished'] as const satisfies readonly SessionEventName[];
/** The values only `cockpit setup` reports, besides `exited`. */
export const SETUP_EVENTS = ['setup-running', 'setup-done', 'setup-failed'] as const satisfies readonly SetupEventName[];
