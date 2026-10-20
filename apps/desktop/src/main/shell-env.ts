import { resolveShellEnv } from '@cockpit/shell-env';

// The environment of the user's login shell, which an app started from the
// Finder or the Dock does not inherit. Resolved once, without blocking startup:
// git, harness detection and ptys must spawn with `await shellEnv`.
export const shellEnv = resolveShellEnv();
