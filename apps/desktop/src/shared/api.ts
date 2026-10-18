/**
 * The only surface the renderer may use to reach the main process, exposed by
 * the preload script on `window.api`. A web build would implement the same
 * interface over HTTP.
 */
export interface Api {
  /** The app version, from `package.json`. */
  getVersion(): Promise<string>;
}
