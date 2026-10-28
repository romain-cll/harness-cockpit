import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

export interface DaemonFiles {
  socket: string;
  token: string;
  pid: string;
  log: string;
}

/**
 * The files of a daemon, flat in the Cockpit home (macOS caps a socket path at 103 bytes, so no
 * subfolder): `daemon-<protocol>-<build>` plus `.sock`, `.token`, `.pid` and `.log`.
 */
export function daemonFiles(home: string, protocol: number, build: string): DaemonFiles {
  const base = join(home, `daemon-${protocol}-${build}`);
  return { socket: `${base}.sock`, token: `${base}.token`, pid: `${base}.pid`, log: `${base}.log` };
}

/** The token sits next to its socket. */
export const tokenPathOf = (socketPath: string) => socketPath.replace(/\.sock$/, '.token');

/** The daemons a home holds files of, whatever their protocol. */
export function listDaemonFiles(home: string): Array<{ protocol: number; build: string } & DaemonFiles> {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  const found = new Map<string, { protocol: number; build: string }>();
  for (const name of names) {
    const match = /^daemon-(\d+)-(.+)\.(?:sock|token|pid|log)$/.exec(name);
    if (match) found.set(`${match[1]}-${match[2]}`, { protocol: Number(match[1]), build: match[2]! });
  }
  return [...found.values()].map((daemon) => ({ ...daemon, ...daemonFiles(home, daemon.protocol, daemon.build) }));
}

/** Unlinks a socket nobody listens on; throws when one is live or the path is not a socket. */
export async function clearStaleSocket(socketPath: string): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(socketPath).isSocket();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!isSocket) throw new Error(`${socketPath} is not a socket`);

  await new Promise<void>((resolve, reject) => {
    const probe = connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error(`another Cockpit holds ${socketPath}`));
    });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNREFUSED') return reject(error);
      // A throw here would escape the promise and leave the start pending: it rejects instead.
      try {
        unlinkSync(socketPath);
      } catch (unlinkError) {
        // Already gone: another start removed it meanwhile.
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') return reject(unlinkError);
      }
      resolve();
    });
  });
}
