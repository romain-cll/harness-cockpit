import { runDaemonEntry } from '@cockpit/daemon';

// Entry of the daemon, run by the app's own Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`),
// detached from the app: `<binary> daemon.js --cockpit-daemon <build>`, with `COCKPIT_HOME` set. It
// owns every pty and outlives the app; its output goes to `daemon-<protocol>-<build>.log`.
void runDaemonEntry(process.argv, process.env, { stderr: process.stderr, exit: (code) => process.exit(code) });
