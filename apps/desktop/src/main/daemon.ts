import { runDaemon } from '@cockpit/daemon';

// Entry of the daemon, run by the app's own Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`),
// detached from the app: `<binary> daemon.js --cockpit-daemon <build>`, with `COCKPIT_HOME` set. It
// owns every pty and outlives the app; its output goes to `daemon-<protocol>-<build>.log`.
const build = process.argv[process.argv.indexOf('--cockpit-daemon') + 1];

if (!build || !process.env.COCKPIT_HOME) {
  console.error('usage: COCKPIT_HOME=<folder> daemon --cockpit-daemon <build>');
  process.exit(2);
}

runDaemon({ home: process.env.COCKPIT_HOME, build }).then(
  (daemon) => {
    console.error(`daemon ${build} (pid ${process.pid}) listening on ${daemon.socketPath}`);
    // Superseded and out of terminals: the daemon closes itself.
    void daemon.closed.then(() => process.exit(0));
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void daemon.close());
  },
  (error: unknown) => {
    // The last line of the log is the reason the app shows.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
