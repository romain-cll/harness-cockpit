import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Session, startClock, untilRead, versionLabel } from './launch';
import { addRepository, dispatchFocus, errorMark, expectNoNewErrors, gitIn, makeRepo, mutedColor, removeThroughMenu, type TempRepo, tokenColor, waitForNoEntry, worktreePath } from './support/projects';
import { addGhFixture, type BarTab, barTab, centreOf, CHANGED_NAMES, changedEvents, changesApi, commonAncestor, diffLineLook, fileRow, fsEventWatchersOf, GIT_APP_ENV, gitRunsIn, heaviestWeight, hideRightBar, hunkHeaders, hunkRowLook, iconIn, listedNames, type Locator, lookOf, lookOfHandle, makeChangesRepo, markChangesPanel, near, openSessionById, PANEL, panelText, railButton, readFileRow, readListArea, readScreenWidth, regionAt, rightBar, selectBarTab, selectChangedFile, selectedTabName, setChangesOpen, showRightBar, startWatching, stopWatching, TRANSPARENT, untilPanel, untilUnwatches, unwatchesSeen, waitForBar, waitForChangedEvent, waitForDiffLine, waitForHunkHeaders, waitForListed, waitForPanelText, watchUnwatches, writeChanges } from './support/right-bar';
import { createWorkspaceWithAgent, expectNoErrors, launchBuiltWith, makeSessionsFixture, moveMouseAway, type SessionsFixture, startSession } from './support/sessions';
import { goHome } from './support/terminal';

describe('changes sidebar: built app', () => {
  let fx: SessionsFixture;
  let session: Session;
  let repo: TempRepo;
  const A = { path: '', id: '' };
  const B = { path: '', id: '' };

  beforeAll(async () => {
    fx = makeSessionsFixture(['claude'], { gitLog: true });
    // A stub `gh` on the launch's PATH, so the open bar never reaches a real one (COCKPIT-38).
    addGhFixture(fx);
    repo = makeChangesRepo('changes-ws');
    session = await launchBuiltWith({ ...fx.env(), ...GIT_APP_ENV });
    await session.page.getByText(versionLabel).waitFor();
    await addRepository(session, repo);
    // Two workspaces with a running session each (created through the composer, which records the base).
    A.id = await createWorkspaceWithAgent(session.page, repo, { agent: 'Claude Code', prompt: 'ws-a' }, 'Claude Code 1');
    A.path = worktreePath(session, repo, 'ws-a');
    B.id = await createWorkspaceWithAgent(session.page, repo, { agent: 'Claude Code', prompt: 'ws-b' }, 'Claude Code 1');
    B.path = worktreePath(session, repo, 'ws-b');
    writeChanges(A.path);
  });

  afterAll(async () => {
    await session?.close();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    if (repo) rmSync(repo.parent, { recursive: true, force: true });
  });

  const windowWidth = (page: Page) => page.evaluate(() => window.innerWidth);

  // No right column: no "Right bar", no "Show right bar", and `<main>` reaches the window's right edge.
  async function expectNoRightColumn(page: Page, where: string) {
    expect(await rightBar(page).count(), `${where}: no right column`).toBe(0);
    expect(await showRightBar(page).count(), `${where}: no "Show right bar" button`).toBe(0);
    const main = await lookOf(page.locator('main'));
    expect(near(main.right, await windowWidth(page)), `${where}: <main> reaches the right edge (${main.right})`).toBe(true);
  }

  test('right bar AC1 — on a workspace page, first shown after a launch, the right column is the 40 px rail: the fill of <main> in both schemes and no border, a "Show right bar" button 22 px from the top, the Diff and Pull request pill below, and no "Changes" button in the header', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    const rail = rightBar(page);
    await rail.waitFor();
    const width = await windowWidth(page);
    expect(await markChangesPanel(page), 'the rail, not the bar').toBe(false);

    const box = await lookOf(rail);
    expect(near(box.width, 40), `the rail is 40 px wide: ${box.width}`).toBe(true);
    expect(near(box.right, width), 'against the right edge').toBe(true);
    expect([box.borderTop, box.borderRight, box.borderBottom, box.borderLeft], 'no border').toEqual(['0px', '0px', '0px', '0px']);
    expect(near((await lookOf(page.locator('main'))).right, box.left, 2), '<main> ends where the rail starts').toBe(true);
    try {
      for (const [scheme, fill] of [['dark', 'rgb(14, 14, 16)'], ['light', 'rgb(255, 255, 255)']] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        expect((await lookOf(rail)).background, `the rail's fill, ${scheme}`).toBe(fill);
        expect((await lookOf(page.locator('main'))).background, `<main>'s fill, ${scheme}`).toBe(fill);
      }
    } finally {
      await page.emulateMedia({ colorScheme: null });
    }

    const show = showRightBar(page);
    const showLook = await lookOf(show);
    expect([near(showLook.width, 24), near(showLook.height, 24)], '24 px square').toEqual([true, true]);
    expect(near((showLook.top + showLook.bottom) / 2, 22), `centred 22 px from the top: ${(showLook.top + showLook.bottom) / 2}`).toBe(true);
    const showIcon = await iconIn(show);
    expect(showIcon.className).toMatch(/lucide-panel-right(\s|$)/);
    expect(showIcon.stroke).toBe(1.25);
    expect(showIcon.color, 'muted').toBe(await mutedColor(page));

    const diff = railButton(page, 'Diff');
    const pullRequest = railButton(page, 'Pull request');
    const pillLook = await lookOfHandle(await commonAncestor(page, diff, pullRequest));
    expect(near(pillLook.top, 48), `the pill starts 4 px below the 44 px header slot: ${pillLook.top}`).toBe(true);
    expect(pillLook.radius).toBe('10px');
    expect([pillLook.paddingLeft, pillLook.paddingRight]).toEqual(['4px', '4px']);
    expect(pillLook.background).toBe(await tokenColor(page, '--sidebar-accent'));
    const [first, second] = await Promise.all([lookOf(diff), lookOf(pullRequest)]);
    expect(Math.max(second.left - first.right, second.top - first.bottom), 'a 4 px gap between the buttons').toBeGreaterThanOrEqual(3);
    expect(Math.max(second.left - first.right, second.top - first.bottom)).toBeLessThanOrEqual(5);
    for (const [button, name, icon] of [[diff, 'Diff', /lucide-file-diff(\s|$)/], [pullRequest, 'Pull request', /lucide-git-pull-request(\s|$)/]] as const) {
      const look = await lookOf(button);
      expect([near(look.width, 24), near(look.height, 24)], `${name}: 24 px`).toEqual([true, true]);
      const svg = await iconIn(button);
      expect(svg.className, `${name}: icon`).toMatch(icon);
      expect([svg.width, svg.height], `${name}: 14 px icon`).toEqual([14, 14]);
      expect(svg.stroke).toBe(1.25);
      expect(svg.color, `${name}: muted`).toBe(await mutedColor(page));
      expect(await button.getAttribute('aria-label')).toBe(name);
      expect((await button.getAttribute('title')) ?? '', `${name}: a title`).not.toBe('');
      expect((await button.innerText()).trim(), `${name}: no text or number`).toBe('');
    }
    expect(await page.getByRole('button', { name: 'Changes', exact: true }).count(), 'the page header has no "Changes" button').toBe(0);

    // Constraints: nothing heavier than 400; the top strip drags the window, its button does not.
    expect(await heaviestWeight(rail), 'nothing in the rail is heavier than 400').toBeLessThanOrEqual(400);
    expect(await regionAt(page, box.left + box.width / 2, 3), 'the strip drags').toBe('drag');
    expect(await regionAt(page, ...centreOf(showLook)), 'the "Show right bar" button does not').toBe('no-drag');
  });

  test('right bar AC2 — Home and the page of a session outside any project have no right column and no "Show right bar" button, and <main> reaches the window\'s right edge', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await showRightBar(page).waitFor();

    await goHome(page);
    await expectNoRightColumn(page, 'Home');
    await startSession(page, 'Claude Code', 'Claude Code 1');
    await expectNoRightColumn(page, 'a session outside any project');

    await openSessionById(page, A.id);
    await showRightBar(page).waitFor();
  });

  test('right bar AC3 — "Show right bar" turns the rail into the 320 px bar (the fill of <main>, a 1 px left border in --border, the tabs at the left and a "Hide right bar" button 8 px from the edge, 22 px from the top), the terminal narrows by at least 260 px, and "Hide right bar" brings the rail and the width back', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await showRightBar(page).waitFor();
    const screen = page.locator('.xterm-screen:visible').first();
    await screen.waitFor();
    const widthBefore = (await screen.boundingBox())!.width;
    const width = await windowWidth(page);

    await showRightBar(page).click();
    await waitForBar(page, true);
    const bar = rightBar(page);
    const look = await lookOf(bar);
    expect(near(look.width, 320), `the bar is 320 px wide: ${look.width}`).toBe(true);
    expect(near(look.right, width), 'against the right edge').toBe(true);
    expect(look.background, "the fill of <main>").toBe((await lookOf(page.locator('main'))).background);
    expect(look.borderLeft).toBe('1px');
    expect(look.borderLeftColor, '--border').toBe(await tokenColor(page, '--border'));

    const diffTab = await lookOf(barTab(page, 'Diff'));
    const pullRequestTab = await lookOf(barTab(page, 'Pull request'));
    expect(diffTab.left - look.left, 'the tabs sit at the left of the strip').toBeLessThan(20);
    expect(pullRequestTab.left).toBeGreaterThan(diffTab.right - 1);
    expect(near((diffTab.top + diffTab.bottom) / 2, 22), 'the tabs are centred in the 44 px strip').toBe(true);
    const hide = await lookOf(hideRightBar(page));
    expect([near(hide.width, 24), near(hide.height, 24)], '"Hide right bar" is 24 px').toEqual([true, true]);
    expect(near(hide.right, width - 8), `8 px from the window's edge: ${width - hide.right}`).toBe(true);
    expect(near((hide.top + hide.bottom) / 2, 22), 'centred 22 px from the top').toBe(true);
    expect(hide.background, 'the --sidebar-accent fill').toBe(await tokenColor(page, '--sidebar-accent'));
    expect(await heaviestWeight(bar), 'nothing in the bar is heavier than 400').toBeLessThanOrEqual(400);
    expect(await regionAt(page, (pullRequestTab.right + hide.left) / 2, 22), 'the empty part of the strip drags').toBe('drag');
    expect(await regionAt(page, ...centreOf(diffTab)), 'a tab does not').toBe('no-drag');
    expect(await regionAt(page, ...centreOf(hide)), '"Hide right bar" does not').toBe('no-drag');
    // The terminal fits its new width with changes of its own DOM, which the wait is on.
    const narrower = await untilRead(page, readScreenWidth, (value, before: number) => value <= before - 260, widthBefore);
    expect(narrower, 'the terminal narrows by at least 260 px').toBeLessThanOrEqual(widthBefore - 260);

    await hideRightBar(page).click();
    await showRightBar(page).waitFor();
    expect(await waitForBar(page, false)).toBe(false);
    expect(near((await lookOf(bar)).width, 40), 'the rail is back').toBe(true);
    const restored = await untilRead(page, readScreenWidth, (value, before: number) => Math.abs(value - before) <= 10, widthBefore);
    expect(Math.abs(restored - widthBefore), 'the terminal gets its width back').toBeLessThanOrEqual(10);
  });

  test('right bar AC4 — "Show right bar" opens on the tab selected last ("Diff" when none was selected since the page loaded), the rail\'s "Pull request" and "Diff" buttons open on their own tab', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await showRightBar(page).waitFor();
    const tabAfter = async (expected: BarTab) => {
      await rightBar(page).getByRole('tab', { name: new RegExp(`^${expected}`), selected: true }).waitFor();
      return selectedTabName(page);
    };
    const hide = async () => {
      await hideRightBar(page).click();
      await showRightBar(page).waitFor();
    };

    // No tab was selected since the page loaded (the tests before this one only open and close the bar).
    await showRightBar(page).click();
    expect(await tabAfter('Diff')).toBe('Diff');
    await hide();

    await railButton(page, 'Pull request').click();
    expect(await tabAfter('Pull request')).toBe('Pull request');
    await hide();

    await railButton(page, 'Diff').click();
    expect(await tabAfter('Diff')).toBe('Diff');
    await barTab(page, 'Pull request').click();
    expect(await tabAfter('Pull request')).toBe('Pull request');
    await hide();

    await showRightBar(page).click();
    expect(await tabAfter('Pull request'), 'the tab selected last').toBe('Pull request');
    await hide();
  });

  test('right bar AC5 — the bar open on "Pull request" stays open there after Home and on another workspace\'s page, which lists its own data; after a reload the rail shows and "Show right bar" opens on "Diff"', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await setChangesOpen(page, true, 'Pull request');
    // A has changes: its "Diff" tab shows their number.
    await barTab(page, 'Diff').filter({ hasText: /Diff\s*7$/ }).waitFor();

    await goHome(page);
    await expectNoRightColumn(page, 'Home');
    await openSessionById(page, B.id);
    expect(await waitForBar(page, true), 'the bar is open on the other workspace').toBe(true);
    expect(await selectedTabName(page)).toBe('Pull request');
    // B has no change: no number after "Diff".
    await barTab(page, 'Diff').filter({ hasNotText: /\d/ }).waitFor();

    await page.reload();
    await page.getByText(versionLabel).waitFor();
    await showRightBar(page).waitFor();
    expect(await markChangesPanel(page), 'the rail shows after a reload').toBe(false);
    await showRightBar(page).click();
    await rightBar(page).getByRole('tab', { name: /^Diff/, selected: true }).waitFor();
    expect(await selectedTabName(page)).toBe('Diff');
    await setChangesOpen(page, false);
  });

  test('right bar AC6 — in both color schemes, each tab is 24 px tall with a radius of 8 px, 8 px side padding and 12 px text; the selected one is filled with --sidebar-accent in --foreground, the other has a 1 px --sidebar-accent border in --muted-foreground; "Diff" shows the number of files in 11 px --subtle', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await setChangesOpen(page, true, 'Diff');
    const count = barTab(page, 'Diff').getByText(String(CHANGED_NAMES.length), { exact: true });
    await count.waitFor();
    try {
      for (const scheme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const accent = await tokenColor(page, '--sidebar-accent');
        const foreground = await tokenColor(page, '--foreground');
        const muted = await mutedColor(page);

        for (const [selected, other] of [['Diff', 'Pull request'], ['Pull request', 'Diff']] as const) {
          await selectBarTab(page, selected);
          const on = await lookOf(barTab(page, selected));
          const off = await lookOf(barTab(page, other));
          for (const [name, look] of [[selected, on], [other, off]] as const) {
            expect([near(look.height, 24), look.radius, look.paddingLeft, look.paddingRight, look.fontSize], `${scheme}, ${name}: 24 px, radius 8, padding 8, 12 px text`).toEqual([true, '8px', '8px', '8px', '12px']);
          }
          expect(await barTab(page, selected).getAttribute('aria-selected')).toBe('true');
          expect(await barTab(page, other).getAttribute('aria-selected')).toBe('false');
          expect([on.background, on.color], `${scheme}: ${selected} selected`).toEqual([accent, foreground]);
          expect(off.background, `${scheme}: ${other}: no fill`).toBe(TRANSPARENT);
          expect([off.borderTop, off.borderTopColor, off.color], `${scheme}: ${other}: a 1 px --sidebar-accent border, muted text`).toEqual(['1px', accent, muted]);
        }
        const number = await lookOf(count);
        expect([number.fontSize, number.color], `${scheme}: the number of files`).toEqual(['11px', await tokenColor(page, '--subtle')]);
      }
    } finally {
      await page.emulateMedia({ colorScheme: null });
    }
  });

  test('right bar AC7 — the Diff tab\'s 36 px row shows "Changes", "against main" and the sums "+15005" and "−6" of the files\' counts in their tokens; with no change it shows "No changes against main." and no sum', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await setChangesOpen(page, true, 'Diff');
    await waitForPanelText(page, (text) => text.includes('main.ts'));
    // The Pull request panel stays mounted: its diff row also shows "+N" and "−N".
    const diffPanel = rightBar(page).getByRole('tabpanel', { name: 'Diff' });
    const title = diffPanel.getByText('Changes', { exact: true }).first();
    const against = diffPanel.getByText('against main', { exact: true });
    const plus = diffPanel.getByText(/^\+15005$/);
    const minus = diffPanel.getByText(/^[−-]6$/);
    await plus.waitFor();
    await minus.waitFor();

    const titleLook = await lookOf(title);
    expect([titleLook.fontSize, titleLook.color]).toEqual(['12px', await tokenColor(page, '--foreground')]);
    const againstLook = await lookOf(against);
    expect([againstLook.fontSize, againstLook.color]).toEqual(['11px', await tokenColor(page, '--subtle')]);
    expect((await lookOf(plus)).color, 'additions: --diff-added-foreground').toBe(await tokenColor(page, '--diff-added-foreground'));
    expect((await lookOf(minus)).color, 'deletions: --diff-removed-foreground').toBe(await tokenColor(page, '--diff-removed-foreground'));
    const row = await lookOfHandle(await commonAncestor(page, title, against, plus, minus));
    expect(near(row.height, 36), `a 36 px row: ${row.height}`).toBe(true);

    await openSessionById(page, B.id);
    await waitForPanelText(page, (text) => text.includes('No changes against main.'));
    expect(await rightBar(page).getByRole('tabpanel', { name: 'Diff' }).getByText(/^[+−-]\d+$/).count(), 'no sum without a change').toBe(0);
  });

  test('right bar AC8 — each file is a 26 px row (radius 8 px) with its status letter in 11 px monospace in its token, the name, the muted folder and the counts in their tokens; the first file is selected when the bar opens and a click selects another', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await setChangesOpen(page, false);
    await setChangesOpen(page, true, 'Diff');
    await waitForPanelText(page, (text) => text.includes('main.ts'));
    const [added, removed, working, foreground, subtle, accent] = await Promise.all(
      ['--diff-added-foreground', '--diff-removed-foreground', '--status-working', '--foreground', '--subtle', '--sidebar-accent'].map((token) => tokenColor(page, token)),
    );
    const row = async (name: string) => {
      const found = await fileRow(page, name, CHANGED_NAMES.filter((other) => other !== name));
      expect(found, `a row for ${name}`).not.toBeNull();
      return found!;
    };

    for (const [name, letter, color] of [['a.txt', 'M', working], ['new.txt', 'A', added], ['c.txt', 'D', removed], ['e.txt', 'R', working]] as const) {
      const found = await row(name);
      expect(found.tokens[0], `${name}: status letter`).toBe(letter);
      expect(near(found.row.height, 26), `${name}: a 26 px row (${found.row.height})`).toBe(true);
      expect(found.row.radius, `${name}: radius 8`).toBe(8);
      expect([found.leaves[letter]!.fontSize, /mono/.test(found.leaves[letter]!.fontFamily), found.leaves[letter]!.color], `${name}: the letter`).toEqual(['11px', true, color]);
      expect([found.leaves[name]!.fontSize, found.leaves[name]!.color], `${name}: the name`).toEqual(['12px', foreground]);
    }
    const a = await row('a.txt');
    expect([a.leaves['+2']!.color, a.leaves['-2']!.color], 'counts in their tokens').toEqual([added, removed]);
    expect(a.tokens.filter((token) => /^[+-]\d+$/.test(token))).toEqual(['+2', '-2']);
    const renamed = await row('e.txt');
    expect(renamed.tokens).toContain('d.txt');
    expect(renamed.tokens.filter((token) => /^[+-]\d+$/.test(token)), 'a pure rename has no counts').toEqual([]);
    const binary = await row('bin.dat');
    expect(binary.tokens.filter((token) => /^[+-]\d+$/.test(token)), 'nothing for a binary file').toEqual([]);
    const main = await row('main.ts');
    const folder = Object.keys(main.leaves).find((key) => /^src\/?$/.test(key));
    expect(folder, 'the folder of src/main.ts').toBeTruthy();
    expect([main.leaves[folder!]!.fontSize, main.leaves[folder!]!.color], 'the folder: 11 px --subtle').toEqual(['11px', subtle]);

    // The first file is selected when the bar opens; a click selects another.
    expect(a.row.background, 'a.txt is selected').toBe(accent);
    expect((await row('new.txt')).row.background, 'new.txt is not').not.toBe(accent);
    await selectChangedFile(page, 'new.txt');
    const selected = await untilPanel(page, readFileRow, (found, arg: { name: string; others: string[]; accent?: string }) => found?.row.background === arg.accent, {
      name: 'new.txt',
      others: CHANGED_NAMES.filter((other) => other !== 'new.txt'),
      accent,
    });
    expect(selected!.row.background).toBe(accent);
    expect((await row('a.txt')).row.background).not.toBe(accent);
    await selectChangedFile(page, 'a.txt');
  });

  test('right bar AC9 — the selected file\'s diff sits under the list: a sticky 28 px row with its path and a "Close diff" × button, a 22 px hunk row on --diff-hunk with its text 42 px in, and 18 px lines with a 36 px gutter, the prefix 6 px after it and the added and removed lines on their fills', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await setChangesOpen(page, true, 'Diff');
    const headers = await waitForHunkHeaders(page, 2);
    expect(headers[0]).toContain('@@ -1,5 +1,5 @@');
    await waitForDiffLine(page, 2, '+', 'line two');

    const close = rightBar(page).getByRole('button', { name: 'Close diff', exact: true });
    const closeLook = await lookOf(close);
    expect([near(closeLook.width, 16), near(closeLook.height, 16)], '"Close diff" is 16 px').toEqual([true, true]);
    const closeIcon = await iconIn(close);
    expect(closeIcon.className).toMatch(/lucide-x(\s|$)/);
    expect([closeIcon.stroke, closeIcon.color]).toEqual([1.25, await mutedColor(page)]);

    const pathRow = await close.evaluateHandle((button) => {
      for (let node = button.parentElement; node; node = node.parentElement) if ((node.textContent ?? '').includes('a.txt')) return node;
      return button;
    });
    const rowLook = await lookOfHandle(pathRow);
    expect([near(rowLook.height, 28), rowLook.position, rowLook.borderBottom], 'a sticky 28 px row with a bottom border').toEqual([true, 'sticky', '1px']);
    const pathLook = await (pathRow as unknown as Locator).evaluate((row) => {
      const leaf = [...row.querySelectorAll('*')].find((element) => element.children.length === 0 && (element.textContent ?? '').trim() === 'a.txt');
      if (!leaf) return null;
      const style = getComputedStyle(leaf);
      return { fontSize: style.fontSize, color: style.color };
    });
    expect(pathLook, 'the path in the row').toEqual({ fontSize: '11px', color: await tokenColor(page, '--foreground') });
    const borders = await (pathRow as unknown as Locator).evaluate((row) => {
      const found: Array<[string, string]> = [];
      for (let node = row.parentElement; node && node.getAttribute('role') !== 'complementary'; node = node.parentElement) {
        found.push([getComputedStyle(node).borderTopWidth, getComputedStyle(node).borderTopColor]);
      }
      return found;
    });
    const borderColor = await tokenColor(page, '--border');
    expect(borders.some(([width, color]) => width === '1px' && color === borderColor), 'a top border in --border above the diff').toBe(true);

    const hunk = await hunkRowLook(page, '@@ -1,5 +1,5 @@');
    expect(hunk, 'a hunk row').not.toBeNull();
    expect([near(hunk!.height, 22), hunk!.fontSize, /mono/.test(hunk!.fontFamily), hunk!.color], 'the hunk row: 22 px, 11 px monospace, muted').toEqual([true, '11px', true, await mutedColor(page)]);
    expect(hunk!.background, '--diff-hunk').toBe(await tokenColor(page, '--diff-hunk'));
    expect(near(hunk!.textOffset, 42), `its text is 42 px from the left: ${hunk!.textOffset}`).toBe(true);

    const foreground = await tokenColor(page, '--foreground');
    const subtle = await tokenColor(page, '--subtle');
    for (const [number, prefix, content, token] of [[2, '+', 'line two', '--diff-added'], [2, '-', 'line 2', '--diff-removed']] as const) {
      const look = await diffLineLook(page, number, prefix, content);
      expect(look, `the line ${prefix}${content}`).not.toBeNull();
      expect([near(look!.height, 18), look!.fontSize, /mono/.test(look!.fontFamily)], `${prefix}${content}: 18 px, 11 px monospace`).toEqual([true, '11px', true]);
      expect([near(look!.gutterWidth, 36), ['right', 'end'].includes(look!.gutterAlign), look!.gutterColor], `${prefix}${content}: a 36 px gutter, number right-aligned in --subtle`).toEqual([true, true, subtle]);
      expect(near(look!.gap, 6), `${prefix}${content}: the prefix 6 px after the gutter: ${look!.gap}`).toBe(true);
      expect(look!.textColor, `${prefix}${content}: --foreground text`).toBe(foreground);
      expect(look!.fill, `${prefix}${content}: ${token}`).toBe(await tokenColor(page, token));
    }
  });

  test('right bar AC10 — "Close diff" hides the diff, selects no row and lets the list take the height; a file written meanwhile updates the list and shows no diff; a click shows it again; closing and opening the bar selects the first file again', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await setChangesOpen(page, true, 'Diff');
    await waitForHunkHeaders(page, 2);
    const accent = await tokenColor(page, '--sidebar-accent');
    const close = rightBar(page).getByRole('button', { name: 'Close diff', exact: true });
    const listArea = () => page.evaluate(readListArea, { selector: PANEL });
    const rows = (names: string[]) => Promise.all(names.map((name) => fileRow(page, name, names.filter((other) => other !== name))));
    const before = await listArea();

    await close.click();

    await close.waitFor({ state: 'hidden' });
    expect(await hunkHeaders(page), 'the diff area goes').toEqual([]);
    await moveMouseAway(page);
    const selectedRows = (await rows(CHANGED_NAMES)).filter((found) => found?.row.background === accent);
    expect(selectedRows, 'no row is selected').toEqual([]);
    // The list takes the height the diff area gave up, with changes of the DOM the wait is on.
    const after = await untilRead(page, readListArea, (found, arg: { selector: string; before?: number }) => found.height > arg.before! + 50, { selector: PANEL, before: before.height });
    expect(after.height, `the list takes the height: ${before.height} then ${after.height}`).toBeGreaterThan(before.height + 50);
    expect(near(after.bottom, (await lookOf(rightBar(page))).bottom, 16), 'down to the bottom of the bar').toBe(true);

    // A file written meanwhile: listed, no diff.
    const late = join(A.path, 'late.txt');
    writeFileSync(late, 'late\n');
    try {
      expect(await waitForListed(page, ['late.txt'], ['late.txt'])).toEqual(['late.txt']);
      expect(await close.count(), 'still no diff').toBe(0);
      expect(await hunkHeaders(page)).toEqual([]);

      await selectChangedFile(page, 'late.txt');
      expect(await waitForDiffLine(page, 1, '+', 'late')).not.toBeNull();
      expect(await close.count()).toBe(1);

      // Closing and opening the bar selects the first file again.
      await setChangesOpen(page, false);
      await setChangesOpen(page, true, 'Diff');
      const first = await untilPanel(page, readFileRow, (found, arg: { name: string; others: string[]; accent?: string }) => found?.row.background === arg.accent, {
        name: 'a.txt',
        others: CHANGED_NAMES.filter((name) => name !== 'a.txt'),
        accent,
      });
      expect(first?.row.background, 'a.txt is selected again').toBe(accent);
      expect(await waitForHunkHeaders(page, 2)).toHaveLength(2);
    } finally {
      rmSync(late, { force: true });
    }
    expect(await waitForListed(page, ['late.txt'], [])).toEqual([]);
  });

  test('changes AC14 — a binary file shows "Binary file" and a diff over 1 MiB "Diff too large to display", with no error logged', async () => {
    const { page } = session;
    const mark = await errorMark(session);
    await openSessionById(page, A.id);
    await setChangesOpen(page, true);
    await waitForPanelText(page, (shown) => shown.includes('bin.dat'));

    await selectChangedFile(page, 'bin.dat');
    await waitForPanelText(page, (shown) => shown.includes('Binary file'));
    expect(await panelText(page)).toContain('Binary file');
    expect(await hunkHeaders(page)).toEqual([]);

    await selectChangedFile(page, 'big.txt');
    await waitForPanelText(page, (shown) => shown.includes('Diff too large to display'));
    expect(await panelText(page)).toContain('Diff too large to display');
    expect(await hunkHeaders(page)).toEqual([]);

    await expectNoNewErrors(session, mark);
  });

  test('changes AC12 — a file written in the worktree appears in the list within 5 s, a line appended to it shows in the diff within 5 s, and removing it takes it out of the list within 5 s', async () => {
    const { page } = session;
    await openSessionById(page, B.id);
    await setChangesOpen(page, true);
    await waitForPanelText(page, (shown) => shown.includes('No changes against main.'));
    const file = join(B.path, 'live.txt');

    // Each step has 5 s from the write.
    let within = startClock();
    writeFileSync(file, 'first\n');
    expect(await waitForListed(page, ['live.txt'], ['live.txt'])).toEqual(['live.txt']);
    within('the file was listed', 5_000);
    within = startClock();
    expect(await waitForDiffLine(page, 1, '+', 'first')).not.toBeNull();
    within('the diff showed the first line', 5_000);

    within = startClock();
    appendFileSync(file, 'second\n');
    expect(await waitForDiffLine(page, 2, '+', 'second')).toEqual({ added: true, removed: false });
    within('the diff showed the appended line', 5_000);

    within = startClock();
    rmSync(file);
    expect(await waitForListed(page, ['live.txt'], [])).toEqual([]);
    await waitForPanelText(page, (shown) => shown.includes('No changes against main.'));
    within('the file left the list', 5_000);
  });

  test('changes AC13 — opening the page of a session in workspace B lists B\'s changes, not A\'s', async () => {
    const { page } = session;
    writeFileSync(join(B.path, 'only-b.txt'), 'b\n');
    await openSessionById(page, A.id);
    await setChangesOpen(page, true);
    await waitForPanelText(page, (shown) => shown.includes('main.ts'));
    expect(await listedNames(page, ['a.txt', 'only-b.txt'])).toEqual(['a.txt']);

    await openSessionById(page, B.id);
    const names = await waitForListed(page, ['a.txt', 'big.txt', 'only-b.txt'], ['only-b.txt']);
    expect(names).toEqual(['only-b.txt']);
    expect(await panelText(page)).toContain('against main');
    rmSync(join(B.path, 'only-b.txt'));
  });

  test('right bar AC7 — the bar opened on a workspace with no base shows "No base branch to compare no-base with." in the Diff tab', async () => {
    const { page } = session;
    const bare = makeRepo('changes-no-base-ui');
    try {
      const path = join(bare.parent, 'wt-no-base-ui');
      gitIn(bare.root, 'worktree', 'add', '--quiet', '-b', 'no-base', path, 'main');
      // Detached in the main working tree and without origin: nothing to default to.
      gitIn(bare.root, 'checkout', '--quiet', '--detach');
      await addRepository(session, bare);
      await dispatchFocus(page);
      const row = page.getByTitle(path, { exact: true }).first();
      await row.waitFor();
      await row.click();
      await page.waitForURL((url) => url.pathname === '/workspace' && url.searchParams.get('path') === path);

      await setChangesOpen(page, true, 'Diff');
      await waitForPanelText(page, (text) => text.includes('No base branch to compare no-base with.'));
      expect(await panelText(page)).not.toContain('No changes against');

      await setChangesOpen(page, false);
      await goHome(page);
      await removeThroughMenu(page, bare.root);
      await waitForNoEntry(page, bare.root);
    } finally {
      rmSync(bare.parent, { recursive: true, force: true });
    }
  });

  test('changes AC15 — an unknown project or a path that is no linked worktree is refused by changes and diff, and watch sends no event for it', async () => {
    const { page } = session;
    await goHome(page);
    const elsewhere = join(repo.parent, 'not-a-worktree');
    mkdirSync(elsewhere);
    const mark = await errorMark(session);

    for (const method of ['changes', 'diff'] as const) {
      expect(await changesApi(page, method, '/no/such/project', '/no/such/project/ws')).toEqual({
        status: 'refused',
        message: '/no/such/project is not a project in Cockpit.',
      });
      expect(await changesApi(page, method, repo.root, elsewhere)).toEqual({
        status: 'refused',
        message: `${elsewhere} is not a workspace of ${repo.name}.`,
      });
      // The main working tree is the project, not a workspace.
      expect(await changesApi(page, method, repo.root, repo.root)).toEqual({
        status: 'refused',
        message: `${repo.root} is not a workspace of ${repo.name}.`,
      });
    }

    // The same watch on a real workspace delivers events: the refusals below are not a broken listener.
    await startWatching(page, repo.root, B.path);
    writeFileSync(join(B.path, 'watched.txt'), 'x\n');
    await waitForChangedEvent(page);
    expect(await changedEvents(page)).toBeGreaterThan(0);
    await stopWatching(page);
    rmSync(join(B.path, 'watched.txt'));

    for (const [project, label] of [['/no/such/project', 'unknown project'], [repo.root, 'not a worktree']] as const) {
      const watchers = await fsEventWatchersOf(session);
      await startWatching(page, project, elsewhere);
      // The watch is answered: a refused one holds no watcher in the main process, so nothing can send an event for
      // the file below (a refusal has no time to wait out: its cause, the watcher, is what is read).
      expect(await fsEventWatchersOf(session), `no watcher for ${label}`).toBe(watchers);
      writeFileSync(join(elsewhere, `${label.replace(' ', '-')}.txt`), 'x\n');
      expect(await changedEvents(page), `no event for ${label}`).toBe(0);
      await stopWatching(page);
    }

    await expectNoNewErrors(session, mark);
  });

  test('changes AC17, right bar AC15 — with the rail showing (the bar closed, left for a page without it, or reloaded) a file written starts no git command in the worktree; with the bar open, on either tab, it does and the changes are listed again', async () => {
    const { page } = session;
    await openSessionById(page, A.id);
    await setChangesOpen(page, true);
    await waitForPanelText(page, (shown) => shown.includes('main.ts'));

    // The bar open holds a watcher on the worktree; with the rail showing there is none, so a write starts nothing:
    // that is the cause of "no git command", and it is read where it is (the FSEvents handles of the main process).
    await watchUnwatches(session);
    const watchersOpen = await fsEventWatchersOf(session);
    const diffCount = async () => Number(/\d+/.exec(await barTab(page, 'Diff').innerText())?.[0] ?? 0);

    // Control: with the sidebar open, a write does start git commands in the worktree (the wrapper logs them).
    const runsBefore = gitRunsIn(fx, A.path).length;
    writeFileSync(join(A.path, 'probe.txt'), 'probe\n');
    await waitForListed(page, ['probe.txt'], ['probe.txt']);
    expect(gitRunsIn(fx, A.path).length).toBeGreaterThan(runsBefore);
    rmSync(join(A.path, 'probe.txt'));
    await waitForListed(page, ['probe.txt'], []);

    // The same with the other tab selected: the changes and the git status are read whichever tab shows, which
    // the number on the "Diff" tab follows.
    await selectBarTab(page, 'Pull request');
    const filesBefore = await diffCount();
    writeFileSync(join(A.path, 'probe-tab.txt'), 'probe\n');
    await barTab(page, 'Diff').filter({ hasText: new RegExp(`Diff\\s*${filesBefore + 1}$`) }).waitFor();
    await selectBarTab(page, 'Diff');
    expect(await waitForListed(page, ['probe-tab.txt'], ['probe-tab.txt'])).toEqual(['probe-tab.txt']);
    rmSync(join(A.path, 'probe-tab.txt'));
    await waitForListed(page, ['probe-tab.txt'], []);

    // Nothing but a watcher on the worktree starts git commands on a write, and `expectNoWatcher` reads that there is
    // none; a read of the git runs right after the write could not tell a run that has not started yet.
    const expectNoWatcher = async (where: string) => {
      const watchers = await fsEventWatchersOf(session);
      expect(watchers, `${where}: no watcher on the worktree`).toBeLessThan(watchersOpen);
      return watchers;
    };

    // (a) The sidebar is closed: the bar stops watching, which the main process hears.
    const unwatches = await unwatchesSeen(session);
    await setChangesOpen(page, false);
    await untilUnwatches(session, unwatches + 1);
    const watchersClosed = await expectNoWatcher('the bar closed');
    writeFileSync(join(A.path, 'after-close.txt'), 'x\n');
    await setChangesOpen(page, true);
    expect(await waitForListed(page, ['after-close.txt'], ['after-close.txt'])).toEqual(['after-close.txt']);

    // (b) The user is on a page without it: the bar goes, and stops watching.
    const unwatchesOpen = await unwatchesSeen(session);
    await goHome(page);
    await untilUnwatches(session, unwatchesOpen + 1);
    expect(await expectNoWatcher('Home')).toBe(watchersClosed);
    writeFileSync(join(A.path, 'after-home.txt'), 'x\n');
    await openSessionById(page, A.id);
    expect(await waitForBar(page, true), 'the bar is still open').toBe(true);
    expect(await waitForListed(page, ['after-home.txt'], ['after-home.txt'])).toEqual(['after-home.txt']);

    // (c) The page reloads, and starts with the rail.
    await page.reload();
    await page.getByText(versionLabel).waitFor();
    await showRightBar(page).waitFor();
    expect(await markChangesPanel(page)).toBe(false);
    expect(await expectNoWatcher('after a reload')).toBe(watchersClosed);
    writeFileSync(join(A.path, 'after-reload.txt'), 'x\n');
    await setChangesOpen(page, true);
    expect(await waitForListed(page, ['after-reload.txt'], ['after-reload.txt'])).toEqual(['after-reload.txt']);
  });

  test('logs no error and keeps running', async () => {
    await expectNoErrors(session);
  });
});
