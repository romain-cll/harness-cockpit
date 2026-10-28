import { runDaemon } from './server';

export interface EntryIo {
  stderr: { write(text: string): unknown };
  exit(code: number): unknown;
}

/**
 * The logic of the daemon's entry, started as `<binary> daemon.js --cockpit-daemon <build>` with
 * `COCKPIT_HOME` set: runs the daemon of that build until it is told to stop or superseded. Without
 * the marker and a build after it, writes the usage, exits with code 2 and creates nothing. The
 * output goes to `daemon-<protocol>-<build>.log`, whose last line is the reason a failed start shows.
 */
export async function runDaemonEntry(argv: readonly string[], env: NodeJS.ProcessEnv, { stderr, exit }: EntryIo): Promise<void> {
  const marker = argv.indexOf('--cockpit-daemon');
  const build = marker === -1 ? undefined : argv[marker + 1];
  const home = env.COCKPIT_HOME;
  if (!build) {
    stderr.write('usage: cockpit daemon --cockpit-daemon <build>\n');
    exit(2);
    return;
  }
  if (!home) {
    stderr.write('COCKPIT_HOME is not set\n');
    exit(2);
    return;
  }

  try {
    const daemon = await runDaemon({ home, build });
    stderr.write(`daemon ${build} (pid ${process.pid}) listening on ${daemon.socketPath}\n`);
    // Superseded and out of terminals: the daemon closes itself.
    void daemon.closed.then(() => exit(0));
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void daemon.close());
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  }
}
