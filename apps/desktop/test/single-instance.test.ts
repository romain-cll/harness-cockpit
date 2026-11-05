import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { launchBuilt, launchEnv, MAIN_PROCESS_ERROR, type Session, versionLabel } from './launch';
import { makeTestDir } from './run-root';
import { launchBuiltWith } from './support/sessions';
import { clearFocusCalls, expectSecondLaunchLeaves, FRONT_CALLS, frontCalls, runSecondLaunch, setMinimized, stubFocus, windowCount } from './support/single-instance';
import { watchFrontmost } from './support/terminal';

describe('single instance: built app', () => {
  let session: Session;
  let dataDir: string;
  let front: Awaited<ReturnType<typeof watchFrontmost>>;
  const electron: string = createRequire(import.meta.url)('electron');
  const secondLaunch = () =>
    runSecondLaunch(
      electron,
      ['--remote-debugging-port=0', '--inspect=0', '.'],
      launchEnv(true, dataDir, { ...process.env, SHELL: '/bin/sh' }, session.cockpitHome).env,
    );

  beforeAll(async () => {
    front = await watchFrontmost();
    dataDir = makeTestDir('d-');
    session = await launchBuiltWith({ ...process.env, SHELL: '/bin/sh' }, dataDir);
    await session.page.getByText(versionLabel).waitFor();
    await stubFocus(session);
  });

  afterAll(async () => {
    await front?.stop();
    await session?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('AC1 — a second launch on the same userData folder exits with code 0 within 10 s, prints no error, opens no window and leaves state.json and the daemon\'s socket and token untouched while the first process keeps running', async () => {
    await expectSecondLaunchLeaves(session, () => secondLaunch());
  });

  test('AC2 — a second launch makes the running app show its window, focus it and activate the app, without restoring a window that is not minimized', async () => {
    await clearFocusCalls(session);
    await setMinimized(session, false);

    await secondLaunch();

    const calls = await frontCalls(session);
    expect([...new Set(calls)].sort()).toEqual(FRONT_CALLS);
    expect(calls).not.toContain('restore');
  });

  test('AC2 — a minimized window is restored before it is shown', async () => {
    await clearFocusCalls(session);
    await setMinimized(session, true);

    await secondLaunch();

    const calls = await frontCalls(session);
    expect(calls).toContain('restore');
    expect(calls.indexOf('restore')).toBeLessThan(calls.indexOf('show'));
    expect([...new Set(calls)].sort()).toEqual(['app.focus {"steal":true}', 'focus', 'restore', 'show']);
    await setMinimized(session, false);
    // The stubbed calls never took the user's focus: the app was not frontmost at any time.
    expect(await front.activated(session.pid)).toBe(false);
  });

  test('AC4 — two launches with their own userData folders and COCKPIT_HOME, started together, both render the home page and neither prints that the background service could not start', async () => {
    const [one, two] = await Promise.all([launchBuilt(), launchBuilt()]);
    try {
      for (const other of [one, two]) {
        await other.page.getByText(versionLabel).waitFor();
        await other.page.getByText('No projects yet', { exact: true }).waitFor();
        expect(other.output()).not.toContain("Cockpit's background service could not start");
        expect(other.output()).not.toMatch(MAIN_PROCESS_ERROR);
      }
      expect(one.dataDir).not.toBe(two.dataDir);
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  });

  // Last: it destroys the window the other tests stubbed.
  test('AC3 — with no window open, a second launch opens one new window that loads the home page', async () => {
    await session.evaluateInMain(`require('electron').BrowserWindow.getAllWindows().forEach((window) => window.destroy())`);
    expect(await windowCount(session)).toBe(0);
    expect(session.isRunning()).toBe(true);

    const second = await secondLaunch();
    expect(second.exit).toEqual({ code: 0, signal: null });

    // The window is there (or created when the second launch's event reaches the app) and its page has loaded.
    const loaded = await session.evaluateInMain<{ url: string; loading: boolean }>(`new Promise((resolve) => {
      const { app, BrowserWindow } = require('electron');
      const loaded = (contents) => {
        const done = () => setImmediate(() => resolve({ url: contents.getURL(), loading: contents.isLoading() }));
        if (contents.getURL() !== '' && !contents.isLoading()) done();
        // Not did-finish-load: isLoading() is still true then, and false at did-stop-loading.
        else contents.once('did-stop-loading', done);
      };
      const [existing] = BrowserWindow.getAllWindows();
      if (existing) loaded(existing.webContents);
      else app.once('browser-window-created', (_event, window) => loaded(window.webContents));
    })`);
    const url = new URL(loaded.url);
    // `URL.origin` is "null" for a custom protocol: rebuild it.
    expect(`${url.protocol}//${url.host}`).toBe('app://renderer');
    expect(url.pathname).toBe('/');
    expect(loaded.loading).toBe(false);
    expect(await windowCount(session)).toBe(1);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});
