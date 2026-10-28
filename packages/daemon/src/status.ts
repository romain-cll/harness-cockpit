import type { SessionEventName } from './protocol';

export type { SessionEventName } from './protocol';

/** The values a session event can carry. */
export const SESSION_EVENTS = ['working', 'waiting', 'finished'] as const satisfies readonly SessionEventName[];
