export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** `null` / `null` when the pty host died while the session was open. */
export interface PtyExit {
  exitCode: number | null;
  signal: number | null;
}

/** Client (main process) to host (utility process). */
export type HostRequest =
  | { type: 'spawn'; id: number; options: PtySpawnOptions }
  | { type: 'write'; id: number; data: string }
  | { type: 'resize'; id: number; cols: number; rows: number }
  | { type: 'kill'; id: number };

/** Host (utility process) to client (main process). */
export type HostReply =
  | { type: 'spawned'; id: number }
  | { type: 'spawn-error'; id: number; message: string }
  | { type: 'data'; id: number; data: string }
  | ({ type: 'exit'; id: number } & PtyExit);
