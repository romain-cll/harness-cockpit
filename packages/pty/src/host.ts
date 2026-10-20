import { spawn, type IPty } from 'node-pty';
import type { HostReply, HostRequest } from './protocol';

/** The shape of Electron's `process.parentPort`. */
export interface HostPort {
  on(event: 'message', listener: (event: { data: HostRequest }) => void): unknown;
  postMessage(message: HostReply): void;
}

/** Runs in the utility process: owns the node-pty sessions the client asks for. */
export function runPtyHost(port: HostPort): void {
  const sessions = new Map<number, IPty>();

  // node-pty throws on a bad size, and on a session whose pty closed but whose
  // exit was not reported yet. An error escaping the listener would kill the
  // host and with it every session, so a failure stays with its own session.
  const withSession = (id: number, operation: (pty: IPty) => void) => {
    const pty = sessions.get(id);
    if (!pty) return;
    try {
      operation(pty);
    } catch {
      // The session ends through its own exit event.
    }
  };

  port.on('message', ({ data: request }) => {
    switch (request.type) {
      case 'spawn': {
        const { id, options } = request;
        try {
          const pty = spawn(options.command, options.args, {
            name: options.env.TERM ?? 'xterm-256color',
            cwd: options.cwd,
            env: options.env,
            cols: options.cols,
            rows: options.rows,
          });
          sessions.set(id, pty);
          pty.onData((data) => port.postMessage({ type: 'data', id, data }));
          pty.onExit(({ exitCode, signal }) => {
            sessions.delete(id);
            port.postMessage({ type: 'exit', id, exitCode, signal: signal ?? null });
          });
          port.postMessage({ type: 'spawned', id });
        } catch (error) {
          port.postMessage({ type: 'spawn-error', id, message: error instanceof Error ? error.message : String(error) });
        }
        break;
      }
      case 'write':
        withSession(request.id, (pty) => pty.write(request.data));
        break;
      case 'resize':
        withSession(request.id, (pty) => pty.resize(request.cols, request.rows));
        break;
      case 'kill':
        withSession(request.id, (pty) => pty.kill());
        break;
    }
  });
}
