import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectDaemon } from '@cockpit/daemon';
import { type ElementHandle, type Locator } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { sendFromComposer } from './composer';
import { daemonSocketIn, fifo, heldProcess, isAlive, MAIN_PROCESS_ERROR, type Session, terminalEnd, untilIn, untilRead, versionLabel } from './launch';
import { makeTestDir } from './run-root';
import { addRepository, agentPid, areaRect, captureRow, childPidsOf, clickClose, closeButton, contextMenu, createThroughComposer, createWorkspace, daemonLine, daemonPidIn, detectionDone, dispatchFocus, dragSeparator, expectKeyboardIn, expectLabels, expectPaneCount, expectSizeMatchesDisplay, type Fixture, gitIn, goHome, hasEnded, holdPtySpawn, isSame, labelsOf, launchBuiltWith, makeFixture, makeRepo, menuItemNamed, menuItems, newTab, newTabButton, normalized, notificationShown, onWorkspacePage, openHarnessSubmenu, openNewTabMenu, openWorkspace, pane, paneRect, paneWithKeyboard, pickContextItem, projectsMessage, releasePtySpawn, replacePtySpawn, reportStatus, restorePtySpawn, rowMenu, rowsOf, rowStatus, selectedLabelOf, selectTab, separatorLine, separatorOf, sessionNamed, sessionsInState, setDaemonLine, shellPid, sttySize, stubNotifications, tabLabeled, type TempRepo, terminalOf, tokenColor, topLevelItems, typeLine, versionRuns, visibleTerminals, waitForPrompt, waitForRow, waitForRowStatus, workspaceRow, worktreePath, writeConfig } from './support/panes';

describe('workspace panes: built app', () => {
  let fx: Fixture;
  let session: Session;
  let repo: TempRepo;
  let repoTwo: TempRepo;
  // The workspaces the tests work in, by branch.
  const ws = { alpha: '', beta: '', gamma: '' };
  const pids = { shell: 0, second: 0, third: 0, claude: 0, codex: 0, claudeTwo: 0, codexTwo: 0 };

  beforeAll(async () => {
    fx = makeFixture(['claude', 'codex']);
    repo = makeRepo('panes-repo');
    repoTwo = makeRepo('panes-other');
    writeConfig(repo, { setup: ['echo setup-one'] });
    session = await launchBuiltWith(fx.env());
    await session.page.getByText(versionLabel).waitFor();
    setDaemonLine(await connectDaemon(daemonSocketIn(session.cockpitHome)));
    await addRepository(session, repo);
    ws.alpha = await createWorkspace(session, repo, 'alpha');
    ws.beta = await createWorkspace(session, repo, 'beta');
    ws.gamma = await createWorkspace(session, repo, 'gamma');
  });

  afterAll(async () => {
    daemonLine?.close();
    setDaemonLine(undefined);
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    for (const each of [repo, repoTwo]) if (each) rmSync(each.parent, { recursive: true, force: true });
  });

  // A failing test must not leave a menu or a dialog that blocks the next ones. Never while the keyboard is in a
  // terminal: the Escape would reach its program.
  afterEach(async () => {
    const { page } = session;
    const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
    for (let attempt = 0; attempt < 4; attempt++) {
      const open = await overlays.count();
      if (open === 0 || (await page.evaluate(() => !!document.activeElement?.closest('.xterm')))) break;
      await page.keyboard.press('Escape');
      // The count falls below `open` when one of them has left the DOM.
      await overlays.nth(open - 1).waitFor({ state: 'detached' });
    }
  });

  // --- Sidebar ---

  test('AC4 — the sidebar has no Terminal link, "New workspace" is its one link, and the route tree has no /terminal', async () => {
    const { page } = session;
    expect(await page.getByRole('link', { name: 'Terminal', exact: true }).count()).toBe(0);
    expect(await page.locator('aside a[href="/terminal"]').count()).toBe(0);
    expect(await page.getByRole('link', { name: 'New workspace', exact: true }).count()).toBe(1);
    expect(await page.getByRole('link', { name: 'Home', exact: true }).count()).toBe(0);
    expect(readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'routeTree.gen.ts'), 'utf8')).not.toContain("'/terminal'");
  });

  test('AC2 — a workspace is one 28 px row with 30 px of left padding, named after its branch, with no git-branch icon and no session rows; its + and … buttons stay', async () => {
    const { page } = session;
    const row = workspaceRow(page, 'alpha');
    await row.waitFor();
    const facts = await row.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const item = element.closest('li')!;
      return {
        height: box.height,
        paddingLeft: getComputedStyle(element).paddingLeft,
        branchIcons: item.querySelectorAll('svg.lucide-git-branch').length,
        sessionLinks: item.querySelectorAll('a[href*="/sessions/"]').length,
        text: (element.textContent ?? '').trim(),
      };
    });
    expect(facts).toEqual({ height: 28, paddingLeft: '30px', branchIcons: 0, sessionLinks: 0, text: 'alpha' });

    await row.hover();
    expect(await page.getByRole('button', { name: 'Start session in alpha', exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Actions for alpha', exact: true }).count()).toBe(1);
  });

  test('AC1 — clicking the workspace row shows /workspace?path=<worktree path>, the row is the current page with the sidebar-accent fill, and an empty workspace shows "No tab open" and a "New tab" button', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    await page.mouse.move(700, 400);
    const row = workspaceRow(page, 'alpha');
    expect(await row.getAttribute('aria-current')).toBe('page');
    expect(await row.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(await tokenColor(page, '--sidebar-accent'));
    expect(await workspaceRow(page, 'beta').getAttribute('aria-current')).toBeNull();

    await page.getByText('No tab open', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'New tab', exact: true }).count()).toBeGreaterThan(0);
  });

  // --- The New tab menu ---

  test('AC9 — the menu shows the harnesses with logos, the "Open harness" submenu (versions on the right, a separator, "Detect again") and "Terminal"', async () => {
    const { page } = session;
    // The first render of the New workspace page (COCKPIT-66) started the detection at launch, long before this menu
    // opens: its "Detecting agent CLIs…" item is the composer's test now (the same state of the shared store).
    const menu = await openNewTabMenu(page);
    await detectionDone(page);

    expect(await topLevelItems(menu)).toEqual(['Claude Code', 'Codex', 'Open harness', 'Terminal']);
    const text = normalized(await menu.innerText());
    expect(text).not.toMatch(/Browser|File|[⌘⇧⌥⌃]/);
    for (const name of ['Claude Code', 'Codex']) {
      expect(await menuItemNamed(menu, name).locator('svg').count(), `the logo of ${name}`).toBeGreaterThan(0);
    }

    const submenu = await openHarnessSubmenu(page);
    const items = (await submenu.getByRole('menuitem').allInnerTexts()).map(normalized);
    expect(items).toEqual(['Claude Code 9.9.9', 'Codex 9.9.9', 'Detect again']);
    // The version is on the right of the name.
    const versionIsRight = await submenu.getByRole('menuitem').first().evaluate((item) => {
      const leaves = [...item.querySelectorAll('*')].filter((element) => element.children.length === 0);
      const version = leaves.find((element) => (element.textContent ?? '').trim() === '9.9.9');
      const name = leaves.find((element) => (element.textContent ?? '').trim() === 'Claude Code');
      return !!version && !!name && version.getBoundingClientRect().left >= name.getBoundingClientRect().right - 1;
    });
    expect(versionIsRight).toBe(true);
    // A separator sits between the harnesses and "Detect again".
    const order = await submenu.evaluate((menu) => {
      const y = (element: Element | undefined) => element?.getBoundingClientRect().top ?? NaN;
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const separator = menu.querySelector('[role="separator"]');
      return { codex: y(items[1]), separator: y(separator ?? undefined), detect: y(items[2]) };
    });
    expect(order.separator).toBeGreaterThan(order.codex);
    expect(order.detect).toBeGreaterThan(order.separator);
  });

  test('AC10, AC8 — a harness picked from the list starts a session in the worktree in a new selected tab with the keyboard, and one picked from the submenu a second one; clicking a tab selects it and gives it the keyboard', async () => {
    const { page } = session;
    await newTab(page, 'Claude Code');
    await expectLabels(page, 0, ['Claude Code 1'], 'Claude Code 1');
    const claude = await terminalOf(page, 0);
    await expectKeyboardIn(page, claude, 'the new Claude Code tab');
    await waitForRow(page, 'ready', claude);
    expect((await captureRow(page, /^cwd:(.+)$/, claude))[0]).toBe(ws.alpha);
    expect((await captureRow(page, /^args:(\d+):/, claude))[0]).toBe('0');
    pids.claude = await agentPid(page, claude);
    await typeLine(page, 'hello');
    await waitForRow(page, 'got:hello', claude);

    // Stored with the project, numbered per workspace, no prompt.
    const stored = sessionNamed(session.dataDir, 'Claude Code 1', ws.alpha);
    expect(stored).toMatchObject({ harness: 'claude-code', project: repo.root, directory: ws.alpha });

    await newTab(page, 'Codex', { submenu: true });
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1'], 'Codex 1');
    const codex = await terminalOf(page, 0);
    await expectKeyboardIn(page, codex, 'the new Codex tab');
    pids.codex = await agentPid(page, codex);
    expect(sessionNamed(session.dataDir, 'Codex 1', ws.alpha)).toMatchObject({ harness: 'codex', project: repo.root });
    // Only the selected tab's terminal is visible.
    expect(await visibleTerminals(page)).toHaveLength(1);

    await selectTab(page, 0, 'Claude Code 1');
    expect(await selectedLabelOf(await pane(page, 0))).toBe('Claude Code 1');
    const shown = await terminalOf(page, 0);
    expect(await isSame(shown, claude)).toBe(true);
    await expectKeyboardIn(page, shown, 'the clicked tab');
    await typeLine(page, 'again');
    await waitForRow(page, 'got:again', shown);
  });

  test('AC10 — a refused start adds no tab and shows its message in the Projects message slot', async () => {
    const { page } = session;
    const binary = join(fx.bin, 'claude');
    const before = sessionsInState(session.dataDir).length;
    renameSync(binary, `${binary}.off`);
    try {
      const menu = await openNewTabMenu(page);
      await menuItemNamed(menu, 'Claude Code').click();
      await projectsMessage(page).filter({ hasText: /^\s*Could not start Claude Code:/ }).first().waitFor();
      expect(await projectsMessage(page).first().innerText()).toContain('not found');
      expect(await labelsOf(await pane(page, 0))).toEqual(['Claude Code 1', 'Codex 1']);
      expect(sessionsInState(session.dataDir)).toHaveLength(before);
    } finally {
      renameSync(`${binary}.off`, binary);
    }
  });

  test('AC11 — "Terminal" starts a login shell in the worktree with the terminal environment in a new selected tab with the keyboard; a spawn that rejects writes [Could not start the shell: …] in that tab', async () => {
    const { page } = session;
    await newTab(page, 'Terminal');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal'], 'Terminal');
    const shell = await terminalOf(page, 0);
    await expectKeyboardIn(page, shell, 'the new shell tab');
    await waitForPrompt(page, shell);
    await typeLine(page, 'echo "env:$TERM:$COLORTERM:${COCKPIT_SOCKET:+socket}:$(pwd -P)"');
    expect((await captureRow(page, /^env:(.*)$/, shell))[0]).toBe(`xterm-256color:truecolor:socket:${ws.alpha}`);
    expect(readFileSync(fx.shellLog, 'utf8').split('\n').filter(Boolean)).toContain('-l');
    pids.shell = await shellPid(page, shell);

    await replacePtySpawn(session, `async () => { throw new Error('refused by the test'); }`);
    try {
      await newTab(page, 'Terminal');
      const broken = await terminalOf(page, 0);
      await waitForRow(page, /^\[Could not start the shell: .*refused by the test.*\]$/, broken);
    } finally {
      await restorePtySpawn(session);
    }
    // The failed tab goes with its close button.
    await clickClose(page, 0, 'Terminal', 1);
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal'], 'Terminal');
  });

  test('AC7 — a tab shows its program\'s title without the leading glyphs, falls back to the session name or "Terminal" when there is none or it is empty once stripped', async () => {
    const { page } = session;
    await selectTab(page, 0, 'Claude Code 1');
    const claude = await terminalOf(page, 0);
    await claude.click();
    await typeLine(page, 'title-spinner');
    await expectLabels(page, 0, ['Fix the tests', 'Codex 1', 'Terminal']);
    expect(await tabLabeled(await pane(page, 0), 'Fix the tests').getAttribute('title')).toBe('Fix the tests');

    await typeLine(page, 'title-empty');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal']);

    await selectTab(page, 0, 'Terminal');
    const shell = await terminalOf(page, 0);
    await shell.click();
    await typeLine(page, `printf '\\033]0;~ shell-title\\007'`);
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'shell-title']);
    await typeLine(page, `printf '\\033]0;\\007'`);
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal']);
  });

  test('AC6 — the tab bar, tabs, close buttons and terminal are measured as in the mockup', async () => {
    const { page } = session;
    await selectTab(page, 0, 'Codex 1');
    const list = await pane(page, 0);
    const accent = await tokenColor(page, '--sidebar-accent');

    // A long title is truncated, the full label is the title.
    await selectTab(page, 0, 'Claude Code 1');
    const claude = await terminalOf(page, 0);
    await claude.click();
    await typeLine(page, 'title-long');
    const long = 'Fix the tests of the workspace panes in the very long running feature branch right now';
    await expectLabels(page, 0, [long, 'Codex 1', 'Terminal']);
    await selectTab(page, 0, 'Codex 1');

    const facts = await list.evaluate((bar) => {
      const label = (tab: Element) => (tab.getAttribute('title') ?? tab.querySelector('[title]')?.getAttribute('title') ?? tab.textContent ?? '').trim();
      const tabs = [...bar.querySelectorAll('[role="tab"]')].map((tab) => {
        const name = label(tab);
        const close = [...bar.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === `Close ${name}`) as HTMLElement | undefined;
        let box: Element = tab;
        while (close && box !== bar && !box.contains(close)) box = box.parentElement!;
        const style = getComputedStyle(box);
        const icon = box.querySelector('svg');
        const leaf = [...box.querySelectorAll('*')].find((element) => element.children.length === 0 && (element.textContent ?? '').trim() === name.trim());
        const closeBox = close?.getBoundingClientRect();
        const closeStyle = close ? getComputedStyle(close) : undefined;
        return {
          label: name,
          selected: tab.getAttribute('aria-selected') === 'true',
          height: box.getBoundingClientRect().height,
          width: box.getBoundingClientRect().width,
          radius: style.borderTopLeftRadius,
          paddingLeft: style.paddingLeft,
          background: style.backgroundColor,
          border: `${style.borderTopWidth} ${style.borderTopColor}`,
          inset: style.boxShadow,
          iconWidth: icon?.getBoundingClientRect().width,
          fontSize: leaf ? getComputedStyle(leaf).fontSize : null,
          ellipsis: leaf ? getComputedStyle(leaf).textOverflow : null,
          truncated: leaf ? leaf.scrollWidth > leaf.clientWidth : null,
          closeSize: closeBox ? [closeBox.width, closeBox.height] : null,
          closeShown: closeStyle ? closeStyle.display !== 'none' && closeStyle.visibility !== 'hidden' && Number(closeStyle.opacity) > 0 : null,
          iconClass: icon?.getAttribute('class') ?? '',
        };
      });
      const barBox = bar.getBoundingClientRect();
      return { barHeight: barBox.height, barBorder: getComputedStyle(bar).borderBottomWidth, tabs };
    });

    expect(facts.barHeight).toBe(28);
    expect(facts.barBorder).toBe('0px');
    expect(facts.tabs.map((tab) => tab.label)).toEqual([long, 'Codex 1', 'Terminal']);
    for (const tab of facts.tabs) {
      expect(tab.height, tab.label).toBe(28);
      expect(tab.radius, tab.label).toBe('8px');
      expect(tab.width, tab.label).toBeLessThanOrEqual(200);
      expect(tab.paddingLeft, tab.label).toBe('8px');
      expect(tab.iconWidth, tab.label).toBe(14);
      expect(tab.fontSize, tab.label).toBe('12px');
      expect(tab.closeSize, tab.label).toEqual([16, 16]);
    }
    const [longTab, selected, shellTab] = facts.tabs;
    expect(longTab!.ellipsis).toBe('ellipsis');
    expect(longTab!.truncated).toBe(true);
    expect(shellTab!.iconClass).toContain('lucide-square-terminal');
    // Selected: the sidebar-accent fill and a visible close button; the others: no fill, a 1 px inside border of that colour.
    expect(selected!.selected).toBe(true);
    expect(selected!.background).toBe(accent);
    expect(selected!.closeShown).toBe(true);
    for (const other of [longTab!, shellTab!]) {
      expect(other.selected).toBe(false);
      expect(other.background).toMatch(/^rgba\(0, 0, 0, 0\)$|^transparent$/);
      const hasBorder = other.border === `1px ${accent}`;
      const hasInset = other.inset.includes(accent) && other.inset.includes('inset');
      expect(hasBorder || hasInset, `${other.label} has a 1 px inside border in ${accent}: ${other.border} / ${other.inset}`).toBe(true);
      expect(other.closeShown, `${other.label} hides its close button`).toBe(false);
    }
    // The close button of another tab shows on hover.
    await tabLabeled(list, 'Terminal').hover();
    const shown = await untilIn(
      (await closeButton(list, 'Terminal').elementHandle()) as ElementHandle<HTMLElement>,
      (button) => {
        const style = getComputedStyle(button);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      },
      (visible) => visible,
    );
    expect(shown, 'the close button of another tab shows on hover').toBe(true);

    // The terminal sits 8 px below the tab bar; only the selected tab's terminal is visible.
    const terminal = await terminalOf(page, 0);
    const gap = (await terminal.evaluate((element) => element.getBoundingClientRect().top)) - (await list.evaluate((bar) => bar.getBoundingClientRect().bottom));
    expect(gap).toBeGreaterThanOrEqual(8);
    expect(gap).toBeLessThanOrEqual(12);
    expect(await visibleTerminals(page)).toHaveLength(1);

    await selectTab(page, 0, long);
    await (await terminalOf(page, 0)).click();
    await typeLine(page, 'title-empty');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal']);
  });

  test('AC13, AC15 — right-clicking a tab opens a menu with "Split right", "Split down", "Copy path" and, after a separator, "Close tab", no shortcut; "Copy path" puts the worktree path on the clipboard', async () => {
    const { page } = session;
    const menu = await contextMenu(page, 0, 'Codex 1');
    expect(await topLevelItems(menu)).toEqual(['Split right', 'Split down', 'Copy path', 'Close tab']);
    expect(normalized(await menu.innerText())).not.toMatch(/[⌘⇧⌥⌃]/);
    const order = await menu.evaluate((menu) => {
      const y = (element: Element | null | undefined) => element?.getBoundingClientRect().top ?? NaN;
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      return { copy: y(items[2]), separator: y(menu.querySelector('[role="separator"]')), close: y(items[3]) };
    });
    expect(order.separator).toBeGreaterThan(order.copy);
    expect(order.close).toBeGreaterThan(order.separator);

    await session.evaluateInMain(`require('electron').clipboard.writeText('before')`);
    // The page copies with `navigator.clipboard.writeText`: the test tells when that write has settled.
    await page.evaluate(() => {
      const clipboard = navigator.clipboard;
      const original = clipboard.writeText.bind(clipboard);
      (window as unknown as { __copied: Promise<void> }).__copied = new Promise<void>((resolve) => {
        clipboard.writeText = async (text: string) => {
          await original(text);
          resolve();
        };
      });
    });
    await pickContextItem(menu, 'Copy path');
    await page.evaluate(() => (window as unknown as { __copied: Promise<void> }).__copied);
    expect(await session.evaluateInMain<string>(`require('electron').clipboard.readText()`)).toBe(ws.alpha);
  });

  test('AC14 — "Split right" and "Split down" divide a pane into equal halves with a new selected shell tab holding the keyboard; splits nest, panes are 8 px padded and 1 px apart in --border, and every terminal\'s stty size matches its display', async () => {
    const { page } = session;
    await selectTab(page, 0, 'Terminal');
    await pickContextItem(await contextMenu(page, 0, 'Terminal'), 'Split right');
    await expectPaneCount(page, 2);

    // The pane keeps its tabs on the left; the new pane on the right holds one shell tab, selected, with the keyboard.
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal'], 'Terminal');
    await expectLabels(page, 1, ['Terminal'], 'Terminal');
    const right = await terminalOf(page, 1);
    await expectKeyboardIn(page, right, 'the new pane');
    pids.second = await shellPid(page, right);
    expect(await paneWithKeyboard(page)).toBe(1);

    // Equal halves, 8 px of padding on each side of a 1 px divider in --border.
    const bars = await Promise.all([0, 1].map(async (index) => (await pane(page, index)).evaluate((bar) => {
      const { left, right, top, width } = bar.getBoundingClientRect();
      return { left, right, top, width };
    })));
    expect(Math.abs(bars[0]!.width - bars[1]!.width)).toBeLessThanOrEqual(1);
    expect(bars[0]!.top).toBe(bars[1]!.top);
    expect(bars[1]!.left - bars[0]!.right).toBeGreaterThanOrEqual(16.5);
    expect(bars[1]!.left - bars[0]!.right).toBeLessThanOrEqual(17.5);
    const border = await tokenColor(page, '--border');
    const divider = await page.evaluate(
      ([x, y]) =>
        document.elementsFromPoint(x!, y!).some((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const oneWide = box.width > 0 && box.width <= 1.01 && box.height > 100;
          return oneWide || style.borderLeftWidth === '1px' || style.borderRightWidth === '1px';
        }),
      [bars[0]!.right + 8.5, bars[0]!.top + 100] as const,
    );
    expect(divider, 'a 1 px divider between the panes').toBe(true);
    const dividerColor = await page.evaluate(
      ([x, y]) => {
        for (const element of document.elementsFromPoint(x!, y!)) {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (box.width > 0 && box.width <= 1.01 && box.height > 100) return style.backgroundColor;
          if (style.borderLeftWidth === '1px') return style.borderLeftColor;
          if (style.borderRightWidth === '1px') return style.borderRightColor;
        }
        return null;
      },
      [bars[0]!.right + 8.5, bars[0]!.top + 100] as const,
    );
    expect(dividerColor).toBe(border);

    // Split down on the right pane: three panes, the two on the right of equal height.
    await pickContextItem(await contextMenu(page, 1, 'Terminal'), 'Split down');
    await expectPaneCount(page, 3);
    await expectLabels(page, 2, ['Terminal'], 'Terminal');
    const bottom = await terminalOf(page, 2);
    await expectKeyboardIn(page, bottom, 'the pane split down');
    pids.third = await shellPid(page, bottom);
    const heights = await Promise.all([1, 2].map(async (index) => (await terminalOf(page, index)).evaluate((element) => element.getBoundingClientRect().height)));
    expect(Math.abs(heights[0]! - heights[1]!)).toBeLessThanOrEqual(24);
    expect(await visibleTerminals(page)).toHaveLength(3);

    for (const index of [0, 1, 2]) await expectSizeMatchesDisplay(page, await terminalOf(page, index));
  });

  // --- Resizing the splits (COCKPIT-45): alpha is p0 | (p1 / p2) from the test above, in equal halves ---

  test('AC1, AC3 — dragging the separator of a split right to 70% of the area resizes both panes (± 1 px), refits both terminals, and the terminal that held the keyboard still holds it', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    await expectPaneCount(page, 3);
    const area = await areaRect(page);
    const [left, right] = [await terminalOf(page, 0), await terminalOf(page, 1)];
    const before = { left: (await sttySize(page, left))[1], right: (await sttySize(page, right))[1] };

    // The right terminal holds the keyboard (the last click) when the separator is pressed.
    await dragSeparator(page, await separatorOf(page, 'vertical'), { x: area.left + 0.7 * area.width });
    await expectKeyboardIn(page, right, 'the terminal that held it before the drag');
    await typeLine(page, 'echo kb-$((7*6))');
    await waitForRow(page, 'kb-42', right);

    const widths = [(await paneRect(page, 0)).width, (await paneRect(page, 1)).width, (await paneRect(page, 2)).width];
    expect(Math.abs(widths[0]! - 0.7 * area.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(widths[1]! - 0.3 * area.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(widths[2]! - 0.3 * area.width)).toBeLessThanOrEqual(1);

    await expectSizeMatchesDisplay(page, left);
    await expectSizeMatchesDisplay(page, right);
    expect((await sttySize(page, left))[1], 'columns of the left terminal').toBeGreaterThan(before.left);
    expect((await sttySize(page, right))[1], 'columns of the right terminal').toBeLessThan(before.right);
  });

  test('AC2 — dragging the separator of a split down makes the heights follow the pointer (± 1 px) and refits both terminals', async () => {
    const { page } = session;
    const area = await areaRect(page);
    const [top, bottom] = [await terminalOf(page, 1), await terminalOf(page, 2)];
    const before = { top: (await sttySize(page, top))[0], bottom: (await sttySize(page, bottom))[0] };

    await dragSeparator(page, await separatorOf(page, 'horizontal'), { y: area.top + 0.6 * area.height });

    const heights = [(await paneRect(page, 1)).height, (await paneRect(page, 2)).height];
    expect(Math.abs(heights[0]! - 0.6 * area.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(heights[1]! - 0.4 * area.height)).toBeLessThanOrEqual(1);

    await expectSizeMatchesDisplay(page, top);
    await expectSizeMatchesDisplay(page, bottom);
    expect((await sttySize(page, top))[0], 'rows of the top terminal').toBeGreaterThan(before.top);
    expect((await sttySize(page, bottom))[0], 'rows of the bottom terminal').toBeLessThan(before.bottom);
  });

  test('AC7 — over a separator the cursor is col-resize (right split) or row-resize (down split), its line takes --ring while hovered or dragged, and --border otherwise', async () => {
    const { page } = session;
    const [ring, border] = [await tokenColor(page, '--ring'), await tokenColor(page, '--border')];
    const area = await areaRect(page);
    const away = { x: area.left + 60, y: area.top + area.height / 2 };

    for (const [orientation, cursor] of [['vertical', 'col-resize'], ['horizontal', 'row-resize']] as const) {
      const separator = await separatorOf(page, orientation);
      await page.mouse.move(away.x, away.y);
      expect(await separatorLine(separator, orientation), `${orientation} separator, pointer away`).toBe(border);

      await separator.hover();
      expect(await separator.evaluate((element) => getComputedStyle(element).cursor)).toBe(cursor);
      expect(await separatorLine(separator, orientation), `${orientation} separator, hovered`).toBe(ring);

      // Pressed and moved: still the ring, and the cursor does not change.
      await dragSeparator(page, separator, orientation === 'vertical' ? { x: (await paneRect(page, 1)).left + 12 } : { y: (await paneRect(page, 2)).top + 12 }, false);
      expect(await separatorLine(separator, orientation), `${orientation} separator, dragged`).toBe(ring);
      expect(await separator.evaluate((element) => getComputedStyle(element).cursor)).toBe(cursor);
      await page.mouse.up();

      await page.mouse.move(away.x, away.y);
      expect(await separatorLine(separator, orientation), `${orientation} separator, pointer away again`).toBe(border);
    }
  });

  test('AC5 — a drag to the edge of the window stops where a pane would be narrower than 160 px (split right) or shorter than 100 px (split down)', async () => {
    const { page } = session;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));

    await dragSeparator(page, await separatorOf(page, 'vertical'), { x: viewport.width - 1 });
    for (const index of [1, 2]) expect(Math.abs((await paneRect(page, index)).width - 160), `width of pane ${index}`).toBeLessThanOrEqual(1);
    expect((await paneRect(page, 0)).width).toBeGreaterThan(300);

    await dragSeparator(page, await separatorOf(page, 'horizontal'), { y: viewport.height - 1 });
    expect(Math.abs((await paneRect(page, 2)).height - 100), 'height of the bottom pane').toBeLessThanOrEqual(1);
    expect((await paneRect(page, 1)).height).toBeGreaterThan(300);
  });

  test('AC6 — a double-click on a separator goes back to equal halves (± 1 px) and refits both terminals', async () => {
    const { page } = session;
    const area = await areaRect(page);

    await (await separatorOf(page, 'vertical')).dblclick();
    const widths = [(await paneRect(page, 0)).width, (await paneRect(page, 1)).width];
    expect(Math.abs(widths[0]! - area.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(widths[1]! - area.width / 2)).toBeLessThanOrEqual(1);
    await expectSizeMatchesDisplay(page, await terminalOf(page, 0));
    await expectSizeMatchesDisplay(page, await terminalOf(page, 1));

    await (await separatorOf(page, 'horizontal')).dblclick();
    const heights = [(await paneRect(page, 1)).height, (await paneRect(page, 2)).height];
    expect(Math.abs(heights[0]! - area.height / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(heights[1]! - area.height / 2)).toBeLessThanOrEqual(1);
    await expectSizeMatchesDisplay(page, await terminalOf(page, 1));
    await expectSizeMatchesDisplay(page, await terminalOf(page, 2));
  });

  test('AC27 — with the sidebar hidden, "Show sidebar" sits at least 72 px from the left and the first tab starts right of it; the empty part of the top tab bar drags the window, its tabs and buttons do not', async () => {
    const { page } = session;
    await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    try {
      const show = page.getByRole('button', { name: 'Show sidebar', exact: true });
      await show.waitFor();
      const showBox = (await show.boundingBox())!;
      expect(showBox.x).toBeGreaterThanOrEqual(72);
      const first = (await tabLabeled(await pane(page, 0), 'Claude Code 1').boundingBox())!;
      expect(first.x).toBeGreaterThanOrEqual(showBox.x + showBox.width - 1);

      const regions = await (await pane(page, 0)).evaluate((bar) => {
        const effective = (point: [number, number]) => {
          for (let element = document.elementFromPoint(...point); element; element = element.parentElement) {
            const region = getComputedStyle(element).getPropertyValue('-webkit-app-region');
            if (region === 'drag' || region === 'no-drag') return region;
          }
          return 'none';
        };
        const box = bar.getBoundingClientRect();
        const centre = (element: Element): [number, number] => {
          const rect = element.getBoundingClientRect();
          return [rect.left + rect.width / 2, rect.top + rect.height / 2];
        };
        const tab = bar.querySelector('[role="tab"]')!;
        const buttons = [...bar.querySelectorAll('button')].concat(
          [...document.querySelectorAll('button')].filter((button) => (button.getAttribute('aria-label') ?? '').trim() === 'New tab'),
        );
        // The empty part: the right end of the first pane's bar, past its tabs and buttons.
        const last = [...bar.querySelectorAll('[role="tab"], button')].reduce((edge, element) => Math.max(edge, element.getBoundingClientRect().right), 0);
        return {
          empty: effective([Math.min(box.right - 4, last + 24), box.top + box.height / 2]),
          tab: effective(centre(tab)),
          buttons: buttons.filter((button) => button.getBoundingClientRect().width > 0).map((button) => effective(centre(button))),
        };
      });
      expect(regions.empty).toBe('drag');
      expect(regions.tab).toBe('no-drag');
      expect(regions.buttons.length).toBeGreaterThan(0);
      expect(regions.buttons.every((region) => region === 'no-drag')).toBe(true);
    } finally {
      await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
      await page.getByRole('button', { name: 'Hide sidebar', exact: true }).waitFor();
    }
  });

  test('AC23, AC8 — a workspace row\'s + menu starts the session in a new tab of the workspace\'s focused pane (the pane last clicked or typed in)', async () => {
    const { page } = session;
    // The pane last clicked: the first one.
    await selectTab(page, 0, 'Claude Code 1');
    await (await terminalOf(page, 0)).click();
    await workspaceRow(page, 'alpha').hover();
    await page.getByRole('button', { name: 'Start session in alpha', exact: true }).click();
    await detectionDone(page);
    await menuItemNamed(rowMenu(page, 'alpha'), 'Claude Code').click();
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Claude Code 2'], 'Claude Code 2');
    const claudeTwo = await terminalOf(page, 0);
    await expectKeyboardIn(page, claudeTwo, 'the new tab');
    pids.claudeTwo = await agentPid(page, claudeTwo);

    // Then the second pane.
    await (await terminalOf(page, 1)).click();
    await workspaceRow(page, 'alpha').hover();
    await page.getByRole('button', { name: 'Start session in alpha', exact: true }).click();
    await detectionDone(page);
    await menuItemNamed(rowMenu(page, 'alpha'), 'Codex').click();
    await expectLabels(page, 1, ['Terminal', 'Codex 2'], 'Codex 2');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Claude Code 2']);
    pids.codexTwo = await agentPid(page, await terminalOf(page, 1));
  });

  // --- Status of the row ---

  test('AC3, AC2 — a workspace row shows the icon of its most urgent session (Needs input, Working, Ready, Exited N); with none, the muted dashed circle with aria-hidden; the sessions are not rows', async () => {
    const { page } = session;
    // `beta` never had a session: the muted dashed circle, hidden from assistive technology.
    const none = await rowStatus(page, 'beta');
    expect(none).toMatchObject({ label: null, hiddenIcon: true, iconSize: 14 });
    expect(none.nameColor).toBe(await tokenColor(page, '--muted-foreground'));

    await workspaceRow(page, 'beta').hover();
    for (let n = 1; n <= 3; n++) {
      await page.getByRole('button', { name: 'Start session in beta', exact: true }).click();
      await detectionDone(page);
      await menuItemNamed(rowMenu(page, 'beta'), 'Claude Code').click();
      await onWorkspacePage(page, ws.beta);
      await expectLabels(page, 0, Array.from({ length: n }, (_, index) => `Claude Code ${index + 1}`), `Claude Code ${n}`);
      await workspaceRow(page, 'beta').hover();
    }
    const id = (name: string) => sessionNamed(session.dataDir, name, ws.beta)!.id;
    const [one, two, three] = [id('Claude Code 1'), id('Claude Code 2'), id('Claude Code 3')] as [string, string, string];
    // Numbered per workspace: alpha has its own "Claude Code 1" and "Claude Code 2".
    expect(sessionNamed(session.dataDir, 'Claude Code 1', ws.alpha)).toBeDefined();
    // Running sessions that have not reported yet have no status.
    expect((await rowStatus(page, 'beta')).label).toBeNull();

    await reportStatus(session, one, 'working');
    await reportStatus(session, two, 'waiting');
    const waiting = await waitForRowStatus(page, 'beta', 'Needs input');
    expect(waiting).toMatchObject({ label: 'Needs input', title: 'Needs input', iconSize: 14, hiddenIcon: false });

    await reportStatus(session, two, 'finished');
    expect((await waitForRowStatus(page, 'beta', 'Working')).label).toBe('Working');
    await reportStatus(session, one, 'finished');
    expect((await waitForRowStatus(page, 'beta', 'Ready')).label).toBe('Ready');

    // Both end with code 3 while the third runs without a status: "Exited 3".
    for (const label of ['Claude Code 1', 'Claude Code 2']) {
      await selectTab(page, 0, label);
      await (await terminalOf(page, 0)).click();
      await typeLine(page, 'exit');
      await waitForRow(page, '[Process exited with code 3]', await terminalOf(page, 0));
    }
    expect((await waitForRowStatus(page, 'beta', 'Exited 3')).label).toBe('Exited 3');
    // An exit with code 0 does not outrank it.
    await reportStatus(session, three, 'finished');
    await selectTab(page, 0, 'Claude Code 3');
    await (await terminalOf(page, 0)).click();
    await typeLine(page, 'quit');
    await waitForRow(page, '[Process exited with code 0]', await terminalOf(page, 0));
    expect((await rowStatus(page, 'beta')).label).toBe('Exited 3');
    // No session row under the workspace.
    expect(await workspaceRow(page, 'beta').evaluate((row) => row.closest('li')!.querySelectorAll('a[href*="/sessions/"]').length)).toBe(0);
  });

  // --- Leaving and coming back ---

  test('AC18, AC20, AC9 — Home, another workspace and back keep the panes, their sizes, tabs, selections, outputs, processes and the keyboard; a window resized meanwhile is fitted on return, in the shown and in a hidden tab', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const done = join(session.dataDir, 'later.flag');
    rmSync(done, { force: true });
    // The command of the bottom pane holds until the test releases it, and tells when it has printed and written `done`.
    const held = heldProcess();
    const ended = fifo();
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Claude Code 2'], 'Claude Code 2');
    await expectLabels(page, 1, ['Terminal', 'Codex 2'], 'Codex 2');
    // COCKPIT-45 AC9: the splits are left at 60% (right split) and 40% (down split), not equal halves.
    const areaBefore = await areaRect(page);
    await dragSeparator(page, await separatorOf(page, 'vertical'), { x: areaBefore.left + 0.6 * areaBefore.width });
    await dragSeparator(page, await separatorOf(page, 'horizontal'), { y: areaBefore.top + 0.4 * areaBefore.height });
    const ratios = async () => {
      const area = await areaRect(page);
      return { column: (await paneRect(page, 0)).width / area.width, row: (await paneRect(page, 1)).height / area.height };
    };
    const resized = await ratios();
    expect(Math.abs(resized.column - 0.6), 'left column after the drag').toBeLessThanOrEqual(0.01);
    expect(Math.abs(resized.row - 0.4), 'top right pane after the drag').toBeLessThanOrEqual(0.01);
    // Markers in the shells, a command that prints later in the bottom pane, the keyboard there.
    await selectTab(page, 1, 'Terminal');
    const second = await terminalOf(page, 1);
    await second.click();
    await typeLine(page, 'echo m2-$((20+2))');
    await waitForRow(page, 'm2-22', second);
    const bottom = await terminalOf(page, 2);
    await bottom.click();
    await typeLine(page, 'echo m3-$((30+3))');
    await waitForRow(page, 'm3-33', bottom);
    await typeLine(page, `${held.snippet}; echo later-$((6*7)); : > '${done}'; echo > '${ended.path}'`);

    try {
      await goHome(page);
      expect(existsSync(done), 'the command has not printed yet when the user leaves').toBe(false);
      for (const pid of Object.values(pids)) if (pid) expect(isAlive(pid), `process ${pid} while Home`).toBe(true);
      await page.setViewportSize({ width: viewport.width - 300, height: viewport.height - 150 });
      await held.release();
      await ended.line();
      expect(existsSync(done), 'the command ended while Home').toBe(true);

      // Another workspace meanwhile: the processes of the workspace not shown keep running.
      await openWorkspace(page, 'beta', ws.beta);
      for (const pid of Object.values(pids)) if (pid) expect(isAlive(pid), `process ${pid} on another workspace`).toBe(true);
      await openWorkspace(page, 'alpha', ws.alpha);

      await expectPaneCount(page, 3);
      // COCKPIT-45 AC9: the proportions survive Home and back, the window being smaller.
      const returned = await ratios();
      expect(Math.abs(returned.column - resized.column), 'left column share after Home and back').toBeLessThanOrEqual(0.01);
      expect(Math.abs(returned.row - resized.row), 'top right pane share after Home and back').toBeLessThanOrEqual(0.01);
      await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Claude Code 2'], 'Claude Code 2');
      await expectLabels(page, 1, ['Terminal', 'Codex 2'], 'Terminal');
      await expectLabels(page, 2, ['Terminal'], 'Terminal');
      const back = await terminalOf(page, 2);
      await waitForRow(page, 'm3-33', back);
      await waitForRow(page, 'later-42', back);
      await waitForRow(page, 'm2-22', await terminalOf(page, 1));
      // The keyboard is where it was: no click before typing.
      await expectKeyboardIn(page, back, 'the bottom pane');
      await typeLine(page, 'echo kb-$((3*3))');
      await waitForRow(page, 'kb-9', back);

      // stty size is what the terminals display, in a shown shell and in the one of a tab that was hidden meanwhile.
      await expectSizeMatchesDisplay(page, back);
      await selectTab(page, 0, 'Terminal');
      await expectSizeMatchesDisplay(page, await terminalOf(page, 0));
      for (const pid of Object.values(pids)) if (pid) expect(isAlive(pid)).toBe(true);
    } finally {
      await page.setViewportSize(viewport);
    }
  });

  // --- Closing ---

  test('AC16, AC17 — closing a shell tab ends its process and selects the tab on its left; the last tab of a pane removes the pane and its sibling takes the keyboard; a running agent asks first (Cancel and Escape change nothing); an agent that ended closes at once', async () => {
    const { page } = session;
    // The bottom pane's only tab: the pane goes, the pane above fills the area and takes the keyboard.
    await pickContextItem(await contextMenu(page, 2, 'Terminal'), 'Close tab');
    await expectPaneCount(page, 2);
    expect(await hasEnded(pids.third), 'the closed shell is gone').toBe(true);
    await expectLabels(page, 1, ['Terminal', 'Codex 2']);
    await expectKeyboardIn(page, await terminalOf(page, 1), 'the sibling pane');

    // A running agent: a dialog first.
    await clickClose(page, 1, 'Codex 2');
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'Close Codex 2?' });
    await dialog.waitFor();
    expect(normalized(await dialog.innerText())).toContain('Codex is still running in this tab. Closing it ends the agent; the workspace stays in the sidebar.');
    expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await clickClose(page, 1, 'Codex 2');
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await expectLabels(page, 1, ['Terminal', 'Codex 2']);
    expect(isAlive(pids.codexTwo)).toBe(true);

    await clickClose(page, 1, 'Codex 2');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Close tab', exact: true }).click();
    await expectLabels(page, 1, ['Terminal'], 'Terminal');
    expect(await hasEnded(pids.codexTwo), 'the agent is gone').toBe(true);
    // The session stays stored and the workspace row stays.
    expect(sessionNamed(session.dataDir, 'Codex 2', ws.alpha)).toBeDefined();
    expect(await workspaceRow(page, 'alpha').count()).toBe(1);

    // The last tab of the pane: it goes, the first pane fills the window and takes the keyboard.
    await clickClose(page, 1, 'Terminal');
    await expectPaneCount(page, 1);
    expect(await hasEnded(pids.second)).toBe(true);
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Claude Code 2']);
    await expectKeyboardIn(page, await terminalOf(page, 0), 'the remaining pane');

    // A shell tab closed from the tab bar: the tab on its left gets the selection.
    await selectTab(page, 0, 'Terminal');
    await clickClose(page, 0, 'Terminal');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Claude Code 2'], 'Codex 1');
    expect(await hasEnded(pids.shell)).toBe(true);

    // An agent that ended closes with no dialog.
    await selectTab(page, 0, 'Claude Code 2');
    await (await terminalOf(page, 0)).click();
    await typeLine(page, 'exit');
    await waitForRow(page, '[Process exited with code 3]', await terminalOf(page, 0));
    await clickClose(page, 0, 'Claude Code 2');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1'], 'Codex 1');
    expect(await page.getByRole('alertdialog').or(page.getByRole('dialog')).count()).toBe(0);
    expect(await hasEnded(pids.claudeTwo)).toBe(true);
    expect(isAlive(pids.claude) && isAlive(pids.codex)).toBe(true);
  });

  test('AC16 — closing the workspace\'s last tab shows "No tab open"', async () => {
    const { page } = session;
    await openWorkspace(page, 'gamma', ws.gamma);
    await newTab(page, 'Terminal');
    await expectLabels(page, 0, ['Terminal'], 'Terminal');
    const shell = await terminalOf(page, 0);
    const pid = await shellPid(page, shell);
    await clickClose(page, 0, 'Terminal');
    await page.getByText('No tab open', { exact: true }).waitFor();
    expect(await hasEnded(pid)).toBe(true);
    expect(await page.getByRole('button', { name: 'New tab', exact: true }).count()).toBeGreaterThan(0);
  });

  // --- Detecting again ---

  test('AC12 — "Detect again" runs every found harness\'s --version once more: a stub added to a PATH folder appears (without a version when it prints none), one removed disappears, and the workspace row\'s Start session menu shows the same; with none left the menu says "No agent CLI found" and "Terminal" still works', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    // Waits for every menu to be gone, so the next click never meets an open popup.
    const closeMenus = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const open = await page.getByRole('menu').count();
        if (open === 0) break;
        await page.keyboard.press('Escape');
        // The count falls below `open` when one of them has left the DOM (a submenu goes before its parent).
        await page.getByRole('menu').nth(open - 1).waitFor({ state: 'detached' });
      }
      await page.getByRole('menu').first().waitFor({ state: 'detached' });
    };
    // The popup mounts a moment after the click: read the items once the first one is there.
    const readMenuItems = async (menu: Locator) => {
      await menuItems(menu).first().waitFor();
      await detectionDone(page);
      return (await menuItems(menu).allInnerTexts()).map(normalized);
    };
    // The items of the "New tab" menu once they are the ones `wait` asks for: a menu opened right after "Detect again"
    // lists what was detected before until the new answer arrives, and the DOM is the only place that tells when it does.
    const readMenu = async (wait: { equals: string[] } | { includes: string }) => {
      const menu = await openNewTabMenu(page);
      await detectionDone(page);
      const items = await untilIn(
        (await menu.elementHandle()) as ElementHandle<HTMLElement>,
        (element) => [...element.querySelectorAll('[role="menuitem"]')].map((item) => (item as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
        (found, arg: { equals?: string[]; includes?: string }) => (arg.equals ? JSON.stringify(found) === JSON.stringify(arg.equals) : found.includes(arg.includes!)),
        wait,
      );
      await closeMenus();
      return items;
    };
    const detectAgain = async () => {
      const before = versionRuns(fx).length;
      await openNewTabMenu(page);
      await detectionDone(page);
      const submenu = await openHarnessSubmenu(page);
      await submenu.getByRole('menuitem').filter({ hasText: 'Detect again' }).click();
      await closeMenus();
      return before;
    };
    const restoreStubs = () => {
      for (const name of ['claude', 'codex']) {
        if (existsSync(join(fx.bin, `${name}.off`))) renameSync(join(fx.bin, `${name}.off`), join(fx.bin, name));
      }
      for (const name of ['opencode', 'opencode.off', 'opencode.noversion']) rmSync(join(fx.bin, name), { force: true });
    };

    try {
      expect(await readMenu({ equals: ['Claude Code', 'Codex', 'Open harness', 'Terminal'] })).toEqual(['Claude Code', 'Codex', 'Open harness', 'Terminal']);
      fx.install('opencode');
      writeFileSync(join(fx.bin, 'opencode.noversion'), '');
      const before = await detectAgain();
      // OpenCode is listed once the detection has run every `--version` again.
      expect(await readMenu({ equals: ['Claude Code', 'Codex', 'OpenCode', 'Open harness', 'Terminal'] })).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Open harness', 'Terminal']);
      // Each found harness once more.
      expect(versionRuns(fx).slice(before).sort()).toEqual(['claude --version', 'codex --version', 'opencode --version']);
      await openNewTabMenu(page);
      await detectionDone(page);
      const submenu = await openHarnessSubmenu(page);
      expect((await submenu.getByRole('menuitem').allInnerTexts()).map(normalized)).toEqual(['Claude Code 9.9.9', 'Codex 9.9.9', 'OpenCode', 'Detect again']);
      await closeMenus();

      // The workspace row's menu shows the same result (the composer's agent select is COCKPIT-66's).
      await workspaceRow(page, 'alpha').hover();
      await page.getByRole('button', { name: 'Start session in alpha', exact: true }).click();
      expect(await readMenuItems(rowMenu(page, 'alpha'))).toEqual(['Claude Code', 'Codex', 'OpenCode']);
      await closeMenus();

      // Removing the stubs: they disappear, and with none left, nothing but "Terminal" starts.
      for (const name of ['claude', 'codex', 'opencode']) renameSync(join(fx.bin, name), join(fx.bin, `${name}.off`));
      await detectAgain();
      expect(await readMenu({ includes: 'No agent CLI found' })).toContain('No agent CLI found');
      const menu = await openNewTabMenu(page);
      await detectionDone(page);
      const none = page.getByRole('menuitem').filter({ hasText: 'No agent CLI found' });
      expect(await none.count()).toBe(1);
      expect(await none.first().isDisabled()).toBe(true);
      expect(await menuItemNamed(menu, 'Terminal').isDisabled()).toBe(false);
      await closeMenus();
    } finally {
      await closeMenus().catch(() => undefined);
      restoreStubs();
    }

    const restored = await detectAgain();
    expect(await readMenu({ equals: ['Claude Code', 'Codex', 'Open harness', 'Terminal'] })).toEqual(['Claude Code', 'Codex', 'Open harness', 'Terminal']);
    expect(versionRuns(fx).length).toBeGreaterThan(restored);
  });

  // --- Restoring ---

  test('AC19, AC7 — after a reload each workspace\'s running sessions and shells are the tabs of one pane in creation order, the first selected, with their screens and the fallback labels; the layout is not saved', async () => {
    const { page } = session;
    await newTab(page, 'Terminal');
    const shell = await terminalOf(page, 0);
    const shellId = await shellPid(page, shell);
    await typeLine(page, 'echo marker-before-reload');
    await waitForRow(page, 'marker-before-reload', shell);
    // A title set by the program is not kept across a reload.
    await selectTab(page, 0, 'Claude Code 1');
    await (await terminalOf(page, 0)).click();
    await typeLine(page, 'title-spinner');
    await expectLabels(page, 0, ['Fix the tests', 'Codex 1', 'Terminal']);
    await pickContextItem(await contextMenu(page, 0, 'Terminal'), 'Split right');
    await expectPaneCount(page, 2);

    await page.reload();
    await page.getByText(versionLabel).waitFor();
    await page.waitForURL((url) => url.pathname === '/workspace');
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Terminal'], 'Claude Code 1');
    await expectPaneCount(page, 1);
    expect(await visibleTerminals(page)).toHaveLength(1);
    for (const pid of [pids.claude, pids.codex, shellId]) expect(isAlive(pid), `process ${pid}`).toBe(true);
    // The screens come back.
    const first = await terminalOf(page, 0);
    await waitForRow(page, 'got:again', first);
    await selectTab(page, 0, 'Terminal');
    await waitForRow(page, 'marker-before-reload', await terminalOf(page, 0));
    // Another workspace whose processes ended: nothing to restore.
    await openWorkspace(page, 'beta', ws.beta);
    await page.getByText('No tab open', { exact: true }).waitFor();
  });

  // --- Entry points ---

  test('AC21 — the composer with an agent opens the workspace page with one selected agent tab that runs the setup through the CLI, then the agent; the row says Setting up meanwhile', async () => {
    const { page } = session;
    // The setup holds after its first command until the test releases it.
    const held = heldProcess();
    writeConfig(repo, { setup: ['echo setup-one', held.snippet] });
    await createThroughComposer(page, repo, 'dagent', 'Claude Code');
    const path = worktreePath(session, repo, 'dagent');
    await onWorkspacePage(page, path);
    await expectLabels(page, 0, ['Claude Code 1'], 'Claude Code 1');
    const terminal = await terminalOf(page, 0);
    await waitForRow(page, /^cockpit setup · dagent · \.cockpit\/config\.json$/, terminal);
    await waitForRow(page, '$ echo setup-one', terminal);
    // The CLI has read its commands: the next workspaces' setup is the plain one again.
    writeConfig(repo, { setup: ['echo setup-one'] });
    await waitForRow(page, 'setup-one', terminal);
    const item = workspaceRow(page, 'dagent').locator('xpath=ancestor::li[1]');
    await item.filter({ hasText: 'Setting up' }).waitFor();
    expect(await item.innerText()).toContain('Setting up');
    await held.release();
    await waitForRow(page, '✓ Setup done', terminal);
    await waitForRow(page, 'ready', terminal);
    expect((await captureRow(page, /^cwd:(.+)$/, terminal))[0]).toBe(path);
    await item.filter({ hasNotText: 'Setting up' }).waitFor();
    expect(sessionNamed(session.dataDir, 'Claude Code 1', path)).toMatchObject({ project: repo.root });
  });

  test('AC22 — the composer with "Terminal" and a project opens the workspace page with one shell tab running `cockpit setup --shell`: header, $ lines, output, ✓ Setup done, then the login shell prompt; no session, no label; with no setup command, the login shell at once', async () => {
    const { page } = session;
    await createThroughComposer(page, repo, 'dnone');
    const path = worktreePath(session, repo, 'dnone');
    await onWorkspacePage(page, path);
    await expectLabels(page, 0, ['Terminal'], 'Terminal');
    const terminal = await terminalOf(page, 0);
    await waitForRow(page, /^cockpit setup · dnone · \.cockpit\/config\.json$/, terminal);
    await waitForRow(page, '$ echo setup-one', terminal);
    await waitForRow(page, 'setup-one', terminal);
    await waitForRow(page, '✓ Setup done', terminal);
    await waitForRow(page, /^login-shell>/, terminal);
    expect(sessionsInState(session.dataDir).filter((stored) => stored.directory === path)).toEqual([]);
    expect(await workspaceRow(page, 'dnone').locator('xpath=ancestor::li[1]').innerText()).not.toMatch(/Setting up|Setup failed/);

    writeConfig(repo, { setup: [] });
    await createThroughComposer(page, repo, 'dplain');
    await onWorkspacePage(page, worktreePath(session, repo, 'dplain'));
    await expectLabels(page, 0, ['Terminal'], 'Terminal');
    const plain = await terminalOf(page, 0);
    await waitForRow(page, /^login-shell>/, plain);
    expect((await rowsOf(plain)).some((row) => row.includes('cockpit setup'))).toBe(false);
  });

  test('AC24 — clicking the notification of a workspace session shows that workspace\'s page with the session\'s tab selected; a session outside any project opens its session page', async () => {
    const { page } = session;
    await stubNotifications(session);
    await openWorkspace(page, 'alpha', ws.alpha);
    await selectTab(page, 0, 'Codex 1');
    const claudeId = sessionNamed(session.dataDir, 'Claude Code 1', ws.alpha)!.id;
    await goHome(page);

    await reportStatus(session, claudeId, 'waiting');
    await notificationShown(session);
    expect(await session.evaluateInMain('globalThis.__notified.at(-1).title')).toBe('Claude Code 1');
    await session.evaluateInMain(`(() => {
      const window = require('electron').BrowserWindow.getAllWindows()[0];
      window.show = () => {};
      window.focus = () => {};
      globalThis.__notified.at(-1).notification.emit('click');
    })()`);
    await onWorkspacePage(page, ws.alpha);
    await expectLabels(page, 0, ['Claude Code 1', 'Codex 1', 'Terminal', 'Terminal'], 'Claude Code 1');

    // A session outside any project: its page, as before.
    const outside = (await sendFromComposer(page, 'none', { prompt: 'outside', agent: 'Claude Code' })).id!;
    await goHome(page);
    await session.evaluateInMain('globalThis.__notified.length = 0');
    await reportStatus(session, outside, 'waiting');
    await notificationShown(session);
    await session.evaluateInMain('globalThis.__notified.at(-1).notification.emit("click")');
    await page.waitForURL((url) => url.pathname === `/sessions/${outside}`);
  });

  test('AC5 — a session outside any project keeps its page: one terminal, no tabs', async () => {
    const { page } = session;
    await goHome(page);
    await sendFromComposer(page, 'none', { prompt: 'outside', agent: 'Codex' });
    await page.getByRole('heading', { name: 'Codex 1', exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toMatch(/^\/sessions\/[^/]+$/);
    expect(await page.locator('[role="tablist"]').count()).toBe(0);
    // One terminal shows on the page: waited for as a count of the terminals that are visible.
    await untilRead(
      page,
      () => [...document.querySelectorAll('.xterm')].filter((element) => element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility === 'visible').length,
      (count) => count === 1,
    );
    const terminals = await visibleTerminals(page);
    expect(terminals).toHaveLength(1);
    await waitForRow(page, 'ready', terminals[0]!);
  });

  // --- COCKPIT-80: deterministic page and menu lookups ---

  test('COCKPIT-80 AC4 — with beta\'s page shown, alpha\'s page and its "New tab" button do not exist; after openWorkspace(alpha) the button that is clicked is inside alpha\'s region and the new tab is listed in alpha\'s pane', async () => {
    const { page } = session;
    const regionOf = (name: string) => page.getByRole('region', { name, exact: true });
    const newTabOf = (name: string) => regionOf(name).getByRole('button', { name: 'New tab', exact: true });

    await openWorkspace(page, 'beta', ws.beta);
    await newTabOf('beta').first().waitFor();
    expect(await regionOf('alpha').count(), "alpha's page").toBe(0);
    expect(await newTabOf('alpha').count(), "alpha's New tab button").toBe(0);

    await openWorkspace(page, 'alpha', ws.alpha);
    const before = await labelsOf(await pane(page, 0));
    const button = await newTabButton(page);
    expect(await button.evaluate((element) => element.closest('[role="region"]')?.getAttribute('aria-label'))).toBe('alpha');
    expect(await newTabOf('beta').count(), "beta's page is gone").toBe(0);
    await newTab(page, 'Terminal');
    expect(await labelsOf(await pane(page, 0))).toEqual([...before, 'Terminal']);

    // Leaves alpha as it was for the tests that follow.
    await clickClose(page, 0, 'Terminal', before.filter((label) => label === 'Terminal').length);
    await expectLabels(page, 0, before);
  });

  test('COCKPIT-80 AC5 — a project "Actions" menu closing with its animations frozen stays in the DOM; the pane\'s "New tab" menu is found by its name and reads its own items; once animations run again, the closing menu leaves the DOM', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    const actions = page.getByRole('menu', { name: `Actions for ${repo.name}`, exact: true });
    const frozen = await page.context().newCDPSession(page);
    try {
      await page.getByRole('button', { name: `Actions for ${repo.name}`, exact: true }).click();
      await actions.waitFor();
      await frozen.send('Animation.enable');
      await frozen.send('Animation.setPlaybackRate', { playbackRate: 0 });
      await page.keyboard.press('Escape');
      await page.locator('[role="menu"][data-closed]').waitFor({ state: 'attached' });

      const menu = await openNewTabMenu(page);
      await detectionDone(page);
      expect(await actions.count(), 'the closing menu is still in the DOM').toBe(1);
      expect(await page.getByRole('menu').count(), 'two menus, told apart by their names').toBe(2);
      expect(await topLevelItems(menu)).toEqual(['Claude Code', 'Codex', 'Open harness', 'Terminal']);

      await frozen.send('Animation.setPlaybackRate', { playbackRate: 1 });
      await actions.waitFor({ state: 'detached' });
      expect(await page.getByRole('menu').count()).toBe(1);

      // The test closes the menu it opened, so no later test starts with it open.
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
    } finally {
      await frozen.send('Animation.setPlaybackRate', { playbackRate: 1 }).catch(() => undefined);
      await frozen.detach().catch(() => undefined);
    }
  });

  test('AC26 — on the workspace page the right column is the rail at the right edge of the window; "Show right bar" opens the bar for that workspace and "Hide right bar" brings the rail back; Home shows neither', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    const column = page.getByRole('complementary', { name: 'Right bar', exact: true });
    const show = page.getByRole('button', { name: 'Show right bar', exact: true });
    await show.waitFor();
    const rail = (await column.boundingBox())!;
    expect(Math.abs(rail.x + rail.width - (await page.evaluate(() => innerWidth)))).toBeLessThanOrEqual(1);
    expect(rail.width, 'the rail').toBeLessThan(100);

    await show.click();
    await page.getByText('against main', { exact: true }).waitFor();
    expect((await column.boundingBox())!.width, 'the bar').toBeGreaterThan(300);

    await page.getByRole('button', { name: 'Hide right bar', exact: true }).click();
    await show.waitFor();
    expect((await column.boundingBox())!.width, 'the rail is back').toBeLessThan(100);

    await goHome(page);
    expect(await column.count(), 'no right column on Home').toBe(0);
    expect(await show.count()).toBe(0);
  });

  // --- Deleting and removing ---

  test('AC25 — deleting a workspace ends every one of its processes and drops its tabs; removing its project does the same for the others', async () => {
    const { page } = session;
    await openWorkspace(page, 'gamma', ws.gamma);
    await newTab(page, 'Terminal');
    const shell = await terminalOf(page, 0);
    const shellId = await shellPid(page, shell);
    await newTab(page, 'Claude Code');
    const agent = await agentPid(page, await terminalOf(page, 0));
    writeFileSync(join(ws.gamma, 'README.md'), 'uncommitted\n');

    await workspaceRow(page, 'gamma').hover();
    await page.getByRole('button', { name: 'Actions for gamma', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete workspace…' }).click();
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'Delete gamma?' });
    // The dialog read the uncommitted changes at opening: one click removes the workspace (COCKPIT-68 AC9).
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await workspaceRow(page, 'gamma').waitFor({ state: 'detached' });
    expect(await hasEnded(shellId), 'the shell is gone').toBe(true);
    expect(await hasEnded(agent), 'the agent is gone').toBe(true);

    // Removing a project ends the processes of its workspaces, which come back with no tab.
    await addRepository(session, repoTwo);
    const omega = await createWorkspace(session, repoTwo, 'omega');
    await openWorkspace(page, 'omega', omega);
    await newTab(page, 'Terminal');
    const omegaShell = await shellPid(page, await terminalOf(page, 0));
    await newTab(page, 'Codex');
    const omegaAgent = await agentPid(page, await terminalOf(page, 0));
    await page.getByRole('button', { name: `Actions for ${repoTwo.name}`, exact: true }).hover();
    await page.getByRole('button', { name: `Actions for ${repoTwo.name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Remove project…', exact: true }).click();
    await page.getByRole('alertdialog').filter({ hasText: `Remove ${repoTwo.name}?` }).getByRole('button', { name: 'Remove', exact: true }).click();
    expect(await hasEnded(omegaShell)).toBe(true);
    expect(await hasEnded(omegaAgent)).toBe(true);
    await addRepository(session, repoTwo);
    await openWorkspace(page, 'omega', omega);
    await page.getByText('No tab open', { exact: true }).waitFor();
    expect(isAlive(pids.claude), 'the other project\'s processes are untouched').toBe(true);
  });

  // --- The Terminal page's guarantees, in workspace tabs ---

  test('AC20 — keys typed before the spawn resolves reach the shell in order, and a shell that starts during a resize ends at its displayed size', async () => {
    const { page } = session;
    await openWorkspace(page, 'alpha', ws.alpha);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await holdPtySpawn(session);
    let released = false;
    try {
      await newTab(page, 'Terminal');
      const terminal = await terminalOf(page, 0);
      await expectKeyboardIn(page, terminal, 'the new tab, whose shell has not started');
      await page.keyboard.type('echo early-$((6*7))');
      await page.keyboard.press('Enter');
      await page.setViewportSize({ width: viewport.width - 300, height: viewport.height - 150 });
      await releasePtySpawn(session);
      released = true;
      await waitForRow(page, 'early-42', terminal);
      await expectSizeMatchesDisplay(page, terminal);
    } finally {
      if (!released) await releasePtySpawn(session);
      await page.setViewportSize(viewport);
    }
  });

  test('AC20 — with the daemon stopped, keys typed reach the shell after SIGCONT, and a spawn pending across a reload is killed when the daemon resumes with no handler error', async () => {
    const { page } = session;
    const daemon = daemonPidIn(session.cockpitHome);
    const last = (await labelsOf(await pane(page, 0))).filter((label) => label === 'Terminal').length - 1;
    await selectTab(page, 0, 'Terminal', last);
    const terminal = await terminalOf(page, 0);
    await terminal.click();
    await waitForPrompt(page, terminal);
    process.kill(daemon, 'SIGSTOP');
    try {
      await typeLine(page, 'echo resumed-$((6*7))');
    } finally {
      process.kill(daemon, 'SIGCONT');
    }
    await waitForRow(page, 'resumed-42', terminal);

    // A spawn left pending across a reload: killed once the daemon answers. The main process tells when its `pty:spawn`
    // has answered (the terminal exists in the daemon, and has been asked to end), and the daemon when that terminal ended.
    const children = childPidsOf(daemon).sort((a, b) => a - b);
    const known = new Set((await daemonLine!.list()).map((terminal) => terminal.id));
    const mark = session.output().length;
    await replacePtySpawn(
      session,
      `async (...args) => { try { return await original(...args); } finally { globalThis.__spawnSettled?.(); } }`,
    );
    await session.evaluateInMain(`(() => { globalThis.__spawnAnswered = new Promise((resolve) => { globalThis.__spawnSettled = resolve; }); })()`);
    process.kill(daemon, 'SIGSTOP');
    try {
      await newTab(page, 'Terminal');
      await page.reload();
      await page.getByText(versionLabel).waitFor();
    } finally {
      process.kill(daemon, 'SIGCONT');
    }
    await session.evaluateInMain(`globalThis.__spawnAnswered`);
    await restorePtySpawn(session);
    for (const { id } of (await daemonLine!.list()).filter((terminal) => !known.has(terminal.id))) await terminalEnd(daemonLine!, id);
    expect(childPidsOf(daemon).sort((a, b) => a - b)).toEqual(children);
    expect(session.output().slice(mark)).not.toContain('Error occurred in handler');
    expect(session.output().slice(mark)).not.toMatch(MAIN_PROCESS_ERROR);
  });

  test('AC20 — with the daemon killed every tab shows [Process ended], and a new tab runs a command in a new daemon', async () => {
    const { page } = session;
    await page.waitForURL((url) => url.pathname === '/workspace');
    const labels = await labelsOf(await pane(page, 0));
    expect(labels.length).toBeGreaterThan(2);
    const old = daemonPidIn(session.cockpitHome);
    // The tabs show the daemon's end once the app has seen its connection close, which the process's end brings.
    process.kill(old, 'SIGKILL');

    for (let index = 0; index < labels.length; index++) {
      await (await pane(page, 0)).getByRole('tab').nth(index).click();
      await waitForRow(page, /^\[Process ended\]$/, await terminalOf(page, 0));
    }
    expect(session.isRunning()).toBe(true);

    await newTab(page, 'Terminal');
    const fresh = await terminalOf(page, 0);
    await waitForPrompt(page, fresh);
    await typeLine(page, 'echo fresh-$((1+2))');
    await waitForRow(page, 'fresh-3', fresh);
    expect(daemonPidIn(session.cockpitHome)).not.toBe(old);
    expect(session.output()).not.toMatch(MAIN_PROCESS_ERROR);
  });
});

// =============================================================================
// AC28: the background service cannot start
// =============================================================================

describe('workspace panes: the background service cannot start', () => {
  let fx: Fixture;
  let session: Session;
  let repo: TempRepo;

  beforeAll(async () => {
    fx = makeFixture(['claude']);
    repo = makeRepo('panes-down');
    const dataDir = makeTestDir('d-');
    // COCKPIT_HOME is a regular file: the daemon cannot start.
    const home = join(dataDir, 'h');
    writeFileSync(home, 'a file, not a folder');
    session = await launchBuiltWith(fx.env(), dataDir, home);
    await session.page.getByText(versionLabel).waitFor();
  });

  afterAll(async () => {
    const dataDir = session?.dataDir;
    await session?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  test('AC28 — the workspace page shows the failure view in place of the panes', async () => {
    const { page } = session;
    await addRepository(session, repo);
    // Workspaces do not need the daemon; a worktree made with git is listed like one made by the app.
    const path = join(session.dataDir, 'wt-down');
    gitIn(repo.root, 'worktree', 'add', '-b', 'down', path);
    await dispatchFocus(page);
    await page.locator('aside').getByText('down', { exact: true }).first().waitFor();
    await workspaceRow(page, 'down').click();
    await page.waitForURL((url) => url.pathname === '/workspace');
    await page.getByText("Cockpit's background service could not start", { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Try again', exact: true }).count()).toBe(1);
    expect(await page.locator('[role="tablist"]').count()).toBe(0);
    expect(await page.locator('.xterm').count()).toBe(0);
  });
});

// =============================================================================
// Smoke paths: the dev server and the packaged app; the launchd environment's shell test
// =============================================================================
