import type { SessionEventName } from './protocol';

export type { SessionEventName } from './protocol';

/** The values a session event can carry. */
export const SESSION_EVENTS = ['working', 'waiting', 'finished'] as const satisfies readonly SessionEventName[];

/**
 * The shell line a harness hook runs (by `/bin/sh -c`) to report an event of the session it
 * belongs to, found through `COCKPIT_SOCKET` (the daemon's `.sock`) and `COCKPIT_SESSION_ID`; the
 * token is the `.token` next to the socket. It always exits 0 and prints nothing, as a failing
 * hook shows an error in the harness and the stdout of some hooks reaches the model.
 */
export function statusCommand(event: SessionEventName): string {
  return (
    '[ -n "$COCKPIT_SOCKET" ] && curl -s -m 2 --unix-socket "$COCKPIT_SOCKET" ' +
    '-H "Authorization: Bearer $(cat "${COCKPIT_SOCKET%.sock}.token" 2>/dev/null)" ' +
    `-d "{\\"sessionId\\":\\"$COCKPIT_SESSION_ID\\",\\"event\\":\\"${event}\\"}" ` +
    'http://localhost/session-events >/dev/null 2>&1; exit 0'
  );
}
