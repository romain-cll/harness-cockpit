import type { PtyExit, PtySpawnOptions } from '@cockpit/pty';

/**
 * The only surface the renderer may use to reach the main process, exposed by
 * the preload script on `window.api`. A web build would implement the same
 * interface over HTTP.
 */
export interface Api {
  /** The app version, from `package.json`. */
  getVersion(): Promise<string>;
  /** Pseudo-terminals, which run in a utility process. */
  pty: {
    /** Resolves to the session id; rejects when the pty host is not running. */
    spawn(options: PtySpawnOptions): Promise<number>;
    write(id: number, data: string): void;
    resize(id: number, cols: number, rows: number): void;
    kill(id: number): void;
    /** Each listener registration returns its unsubscribe function. */
    onData(listener: (id: number, data: string) => void): () => void;
    onExit(listener: (id: number, exit: PtyExit) => void): () => void;
  };
  /** The `PATH` of the user's login shell, the only part of its environment the renderer sees. */
  getShellPath(): Promise<string>;
}
