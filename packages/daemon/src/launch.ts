import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonFiles } from './paths';
import { PROTOCOL_VERSION } from './protocol';

/** How to start the daemon of the app's build; the app writes it at each launch for the CLI. */
export interface Launch {
  /** The binary that runs the bundle: the app's Electron, as Node. */
  executable: string;
  /** The daemon's entry (`--cockpit-daemon <build>` follows). */
  bundle: string;
  build: string;
  /** The folder holding `state.json`: the app's `userData`. */
  stateDir: string;
  /** The `cockpit` binary the daemon's sessions run. */
  cli: string;
}

const launchPath = (home: string) => join(home, 'daemon-launch.json');

/** Written by rename, so a CLI never reads half of it. */
export function writeLaunch(home: string, launch: Launch): void {
  mkdirSync(home, { recursive: true });
  const temporaryPath = `${launchPath(home)}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(launch));
  renameSync(temporaryPath, launchPath(home));
}

/** `undefined` when the app wrote none, or one that is not a launch. */
export function readLaunch(home: string): Launch | undefined {
  try {
    const { executable, bundle, build, stateDir, cli } = JSON.parse(readFileSync(launchPath(home), 'utf8')) as Record<string, unknown>;
    if ([executable, bundle, build, stateDir, cli].some((field) => typeof field !== 'string')) return undefined;
    return { executable, bundle, build, stateDir, cli } as Launch;
  } catch {
    return undefined;
  }
}

/**
 * Starts the daemon of `launch`: the app's own Electron binary as Node, detached into its own session so it
 * outlives whoever started it, with its output in the log. `stdio[3]` is the pipe it says it is ready on.
 */
export function startDaemonProcess(home: string, launch: Launch): ChildProcess {
  mkdirSync(home, { recursive: true });
  const { log: logPath } = daemonFiles(home, PROTOCOL_VERSION, launch.build);
  const log = openSync(logPath, 'a');
  try {
    const child = spawn(launch.executable, [launch.bundle, '--cockpit-daemon', launch.build], {
      detached: true,
      stdio: ['ignore', log, log, 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', COCKPIT_HOME: home, COCKPIT_STATE_DIR: launch.stateDir, COCKPIT_CLI: launch.cli },
    });
    child.on('error', (error) => {
      appendFileSync(logPath, `${error.message}\n`);
      child.emit('exit', 1, null);
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}
