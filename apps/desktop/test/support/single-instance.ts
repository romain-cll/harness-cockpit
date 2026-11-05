import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { statSync } from 'node:fs';
import { expect } from 'vitest';
import { appDir, daemonSocketIn, MAIN_PROCESS_ERROR, type Session, stopGroup } from '../launch';
import { stateSnapshot } from './projects';
import { controlTokenIn, postSessionEvent } from './sessions';

// --- Single instance (COCKPIT-54) ----------------------------------------------

export interface SecondLaunch {
  exit: { code: number | null; signal: NodeJS.Signals | null };
  /** Everything the second process wrote to stdout and stderr. */
  output: string;
  elapsedMs: number;
}

// Starts the app a second time with the environment of a running one and waits for it to exit. It
// takes no debugging port: a second launch is expected to leave before it opens a window. A launch
// that never ends is the test's own guard; its group is stopped either way.
export async function runSecondLaunch(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<SecondLaunch> {
  const child = spawn(command, args, { cwd: appDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const started = Date.now();
  try {
    // 'close' fires once the process ended and all its stdio streams are closed (its helpers hold them too), so
    // every chunk it wrote has been read.
    const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    return { exit: { code, signal }, output, elapsedMs: Date.now() - started };
  } finally {
    await stopGroup(child);
  }
}

// Replaces the focus calls of the running app's window and of `app` with recorders, so a second
// launch never takes the user's focus. `isMinimized` answers what `setMinimized` says.
export const stubFocus = (session: Session) =>
  session.evaluateInMain(`(() => {
    const { app, BrowserWindow } = require('electron');
    const calls = (globalThis.__focusCalls = []);
    globalThis.__minimized = false;
    const window = BrowserWindow.getAllWindows()[0];
    window.show = () => {
      calls.push('show');
      globalThis.__onShow?.();
    };
    window.focus = () => void calls.push('focus');
    window.restore = () => void calls.push('restore');
    window.isMinimized = () => globalThis.__minimized;
    app.focus = (options) => void calls.push('app.focus ' + JSON.stringify(options));
  })()`);

export const focusCalls = (session: Session) => session.evaluateInMain<string[]>('globalThis.__focusCalls.slice()');
export const clearFocusCalls = (session: Session) => session.evaluateInMain('(globalThis.__focusCalls.length = 0, globalThis.__onShow = undefined)');
export const setMinimized = (session: Session, minimized: boolean) => session.evaluateInMain(`globalThis.__minimized = ${minimized}`);
export const windowCount = (session: Session) => session.evaluateInMain<number>(`require('electron').BrowserWindow.getAllWindows().length`);

// What a second launch must leave alone in the running app's folders.
export const filesOfRunningApp = (session: Session) => {
  const socket = daemonSocketIn(session.cockpitHome);
  return {
    state: stateSnapshot(session.dataDir),
    socketInode: statSync(socket).ino,
    token: controlTokenIn(session.cockpitHome),
  };
};

// The socket still answers 401 to a request without the token.
export async function expectSocketAnswers401(session: Session) {
  const answer = await postSessionEvent(daemonSocketIn(session.cockpitHome), { body: { sessionId: randomUUID(), event: 'working' } });
  expect(answer).toEqual({ status: 401, text: '' });
}

// A second launch on the running app's folders: exits 0 within 10 s, prints no error, opens no
// window, leaves state.json and the daemon's socket and token alone, and the first process runs on.
export async function expectSecondLaunchLeaves(session: Session, launch: () => Promise<SecondLaunch>) {
  const before = filesOfRunningApp(session);
  const second = await launch();
  expect(second.exit, `the second launch exited (output: ${second.output})`).toEqual({ code: 0, signal: null });
  expect(second.elapsedMs).toBeLessThan(10_000);
  expect(second.output).not.toMatch(MAIN_PROCESS_ERROR);
  expect(second.output).not.toContain("Cockpit's background service could not start");
  expect(filesOfRunningApp(session)).toEqual(before);
  await expectSocketAnswers401(session);
  expect(await windowCount(session)).toBe(1);
  expect(session.isRunning()).toBe(true);
  expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
}

// The calls the running app made to bring its window to the front, once the second launch has
// reached it.
// `second-instance` calls `show`, then `focus` and `app.focus` in the same turn: the stub of `show` tells.
export const frontCalls = async (session: Session) => {
  await session.evaluateInMain(`new Promise((resolve) => {
    if (globalThis.__focusCalls.includes('show')) resolve(true);
    else globalThis.__onShow = () => resolve(true);
  })`);
  return focusCalls(session);
};

export const FRONT_CALLS = ['app.focus {"steal":true}', 'focus', 'show'];
