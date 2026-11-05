import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { launchBuilt, MAIN_PROCESS_ERROR, type Session, untilRead, versionLabel } from './launch';
import { expectNoErrors } from './support/sessions';
import { consoleErrorsOf, dropTerminalWorkspace, exitsOf, killPtyHost, openTerminal, ptyKill, ptyResize, type PtyWindow, ptyWrite, readTerminalColorsNow, spawnShell, type TerminalColors, terminalRows, terminalSize, typeLine, waitForExit, waitForOutput, waitForRow, watchFrontmost } from './support/terminal';

describe('built app', () => {
  let session: Session;
  let front: Awaited<ReturnType<typeof watchFrontmost>>;

  beforeAll(async () => {
    front = await watchFrontmost();
    session = await launchBuilt();
    await session.page.getByText(versionLabel).waitFor();
  });

  // What `logs no error and keeps running` checks on the modes' own launch, for this file's.
  afterAll(async () => {
    try {
      await expectNoErrors(session);
      expect(await front.activated(session.pid)).toBe(false);
    } finally {
      await front?.stop();
      await session?.close();
    }
    if (session) expect(existsSync(session.dataDir)).toBe(false);
  });

  // The repository `openTerminal` made goes after each test, so the tests that follow list only their own projects.
  afterEach(async () => {
    if (session) await dropTerminalWorkspace(session);
  });

  test('AC2 — resizes the pty', async () => {
    const { page } = session;
    const id = await spawnShell(page);

    await ptyResize(page, id, 100, 30);
    await ptyWrite(page, id, 'stty size\n');
    await waitForOutput(page, id, '30 100');

    await ptyKill(page, id);
  });

  test('AC3 — kill ends the session with a single exit, and later calls on it do nothing', async () => {
    const { page } = session;
    const id = await spawnShell(page);

    await ptyKill(page, id);
    await waitForExit(page, id);

    const thrown = await page.evaluate(async (id) => {
      try {
        const { pty } = (window as unknown as PtyWindow).api;
        pty.write(id, 'echo late\n');
        pty.resize(id, 120, 40);
        pty.kill(id);
        // The answer of `list` comes after the main process handled the three calls above (one channel, in order):
        // a second exit would have been sent for them by then, since the daemon has nothing left to say about a gone shell.
        await pty.list();
        return null;
      } catch (error) {
        return String(error);
      }
    }, id);
    expect(thrown).toBeNull();

    expect(await exitsOf(page, id)).toHaveLength(1);
    expect(await consoleErrorsOf(page)).toEqual([]);
  });

  test('terminal AC3 — resizing the viewport resizes the pty to the terminal columns and rows', async () => {
    const { page } = session;
    await openTerminal(session);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const screenWidth = () => page.evaluate(() => document.querySelector('.xterm-screen')!.getBoundingClientRect().width);
    const renderedRows = async () => (await terminalRows(page)).length;

    const [rowsBefore, colsBefore] = await terminalSize(page);
    expect(rowsBefore).toBe(await renderedRows());
    const widthBefore = await screenWidth();

    try {
      await page.setViewportSize({ width: viewport.width - 300, height: viewport.height - 150 });
      await untilRead(page, () => document.querySelector('.xterm-screen')!.getBoundingClientRect().width, (width, before: number) => width !== before, widthBefore);

      const [rowsAfter, colsAfter] = await terminalSize(page);
      expect(colsAfter).not.toBe(colsBefore);
      expect(rowsAfter).toBe(await renderedRows());
    } finally {
      await page.setViewportSize(viewport);
    }
  });

  test('terminal AC4 — exit shows the exit code, and later keys do nothing', async () => {
    const { page } = session;
    await openTerminal(session);

    await typeLine(page, 'exit 3');
    await waitForRow(page, '[Process exited with code 3]');

    const before = await terminalRows(page);
    await page.keyboard.type('still-typing');
    await page.keyboard.press('Enter');
    // The keys went to the main process as writes to a gone terminal; the answer of `list` comes after them,
    // and two frames after it paint whatever they would have changed.
    await page.evaluate(async () => {
      await (window as unknown as PtyWindow).api.pty.list();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(await terminalRows(page)).toEqual(before);
    expect(await page.pageErrors()).toEqual([]);
    expect(await consoleErrorsOf(page)).toEqual([]);
  });

  test('terminal AC5 — copy puts the selected word in the clipboard data as text/plain', async () => {
    const { page } = session;
    await openTerminal(session);
    await typeLine(page, 'echo copy-me-123');
    await waitForRow(page, 'copy-me-123');

    // The echoed command line holds the word too: double-click the output line.
    // xterm.js sets `pointer-events: none` on `.xterm-rows`, so Playwright refuses
    // a locator `dblclick` on a row: the mouse goes to the word's position, where
    // the event lands on `.xterm-screen`, which handles the selection.
    const index = (await terminalRows(page)).indexOf('copy-me-123');
    expect(index).toBeGreaterThanOrEqual(0);
    const box = (await page.locator('.xterm-rows > div').nth(index).boundingBox())!;
    await page.mouse.dblclick(box.x + 5, box.y + box.height / 2);

    // The selection is painted in the DOM, which is what the wait is on.
    const copied = await untilRead(
      page,
      () => {
        const clipboardData = new DataTransfer();
        document.querySelector('.xterm')!.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
        return clipboardData.getData('text/plain');
      },
      (text) => text !== '',
    );
    expect(copied).toBe('copy-me-123');
  });

  test('terminal AC6 — pasting text then pressing Enter runs it', async () => {
    const { page } = session;
    await openTerminal(session);

    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'echo pasted-$((2*21))');
      document.querySelector('.xterm')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await page.keyboard.press('Enter');

    await waitForRow(page, 'pasted-42');
  });

  test('terminal AC7 — text, background and ANSI red follow the tokens as the color scheme changes', async () => {
    const { page } = session;
    await openTerminal(session);
    await page.emulateMedia({ colorScheme: 'dark' });
    await typeLine(page, "printf '\\033[31mred\\033[0m\\n'");
    await page.locator('.xterm-rows span.xterm-fg-1', { hasText: 'red' }).first().waitFor();

    const settled = (colors: TerminalColors) => JSON.stringify(colors.actual) === JSON.stringify(colors.expected);

    // The terminal repaints in the new colours with DOM changes: the wait is on them.
    const dark = await untilRead(page, readTerminalColorsNow, settled);
    expect(dark.actual).toEqual(dark.expected);

    // Without reloading.
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await untilRead(page, readTerminalColorsNow, settled);
    expect(light.actual).toEqual(light.expected);

    // The two schemes really differ, so the checks above are not vacuous.
    expect(light.expected.text).not.toBe(dark.expected.text);
    expect(light.expected.background).not.toBe(dark.expected.background);
    expect(light.expected.red).not.toBe(light.expected.text);
  });

  // --- Several terminals: tabs, splits and lifecycle (COCKPIT-24) -------------

  // Last of the session on purpose: the refusal must come without any error, and
  // an app that lets the failure through would log one that the "logs no error"
  // checks of the tests above would then report in their place.
  test('tabs AC9 — once the pty host is dead, spawn resolves with an id no session used', async () => {
    const { page } = session;
    // Kills the host (again): `old` is the last session it ran.
    const old = await killPtyHost(page);

    const fresh = await spawnShell(page);
    expect(fresh).toBeGreaterThan(old);

    await ptyKill(page, fresh);
    await waitForExit(page, fresh);
    expect(session.isRunning()).toBe(true);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
    expect(await consoleErrorsOf(page)).toEqual([]);
  });
});
