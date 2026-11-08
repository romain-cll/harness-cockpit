import { reportReady, runDaemonEntry } from '@cockpit/daemon';

// Entry of the daemon, run by the app's own Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`),
// detached from the app (or started by the `cockpit` command from the launch file): `<binary> daemon.js
// --cockpit-daemon <build>`, with `COCKPIT_HOME`, `COCKPIT_STATE_DIR` and `COCKPIT_CLI` set. It owns every pty and
// `state.json` and outlives the app; its output goes to `daemon-<protocol>-<build>.log`.
void runDaemonEntry(process.argv, process.env, { stderr: process.stderr, exit: (code) => process.exit(code), ready: () => reportReady() });
