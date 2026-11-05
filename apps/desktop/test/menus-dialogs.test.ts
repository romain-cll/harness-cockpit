import { existsSync, rmSync } from 'node:fs';
import { type ElementHandle, type Locator, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { type Session, untilIn, versionLabel } from './launch';
import { addRepository, makeRepo, openMenu, startProjectRemoval, type TempRepo, untilFewerOverlays } from './support/projects';
import { addOpenFixture, createPlainWorkspace, expectNoErrors, launchBuiltWith, makeSessionsFixture, openSubmenu, type OpenFixture, type SessionsFixture, topLevelItems, workspaceMenu } from './support/sessions';

// COCKPIT-68: the look of the project and workspace menus and of the confirmation dialogs, in both color schemes.
// Only a rendered page resolves the tokens and the Tailwind classes, so each check reads computed styles.

const SCHEMES = ['dark', 'light'] as const;

// What a token resolves to as a fill or as a text color, as `getComputedStyle` writes it.
const tokenColour = (page: Page, token: string, property: 'backgroundColor' | 'color' = 'backgroundColor') =>
  page.evaluate(
    ([token, property]) => {
      const probe = document.createElement('span');
      probe.style[property as 'color'] = `var(${token})`;
      document.body.append(probe);
      const colour = getComputedStyle(probe)[property as 'color'];
      probe.remove();
      return colour;
    },
    [token, property] as const,
  );

describe('built app', () => {
  let fx: SessionsFixture;
  let open: OpenFixture;
  let repo: TempRepo;
  let session: Session;
  let workspace = '';

  beforeAll(async () => {
    // A stub `open` and fake editor and terminal bundles: Visual Studio Code, Cursor, Terminal and Ghostty are detected.
    fx = makeSessionsFixture([]);
    open = addOpenFixture(fx);
    repo = makeRepo('menu-project');
    session = await launchBuiltWith(open.env());
    await session.page.getByText(versionLabel).waitFor();
    await addRepository(session, repo);
    workspace = await createPlainWorkspace(session, repo, 'menu-ws');
  });

  afterAll(async () => {
    try {
      await expectNoErrors(session);
    } finally {
      await session?.close();
      if (fx) rmSync(fx.root, { recursive: true, force: true });
      if (repo) rmSync(repo.parent, { recursive: true, force: true });
    }
    if (session) expect(existsSync(session.dataDir)).toBe(false);
  });

  // A failing test must not leave a menu or a dialog open for the tests after it, or the color scheme emulated.
  afterEach(async () => {
    const { page } = session;
    await page.emulateMedia({ colorScheme: null });
    const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
    for (let attempt = 0; attempt < 4; attempt++) {
      const shown = await overlays.count();
      if (shown === 0) break;
      await page.keyboard.press('Escape');
      await untilFewerOverlays(page, shown);
    }
  });

  const WORKSPACE_ITEMS = ['Open in Visual Studio Code', 'Open in Terminal', 'Open in editor', 'Open in terminal', 'Reveal in Finder', 'Delete workspace…'];

  // Opens the "…" menu of the workspace and waits until every item is there (the apps arrive after the menu opens).
  async function openWorkspaceMenu() {
    const { page } = session;
    await openMenu(page, workspace);
    const menu = workspaceMenu(page, workspace);
    for (const name of WORKSPACE_ITEMS) await menu.getByRole('menuitem', { name, exact: true }).waitFor();
    return menu;
  }

  // What a menu popup and its items look like. Sizes are layout sizes: the popup zooms in as it opens.
  const readMenu = (menu: Locator) =>
    menu.evaluate((popup) => {
      const style = getComputedStyle(popup);
      const items = [...popup.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
      const separators = [...popup.querySelectorAll('[role="separator"]')] as HTMLElement[];
      return {
        width: (popup as HTMLElement).offsetWidth,
        radius: style.borderTopLeftRadius,
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        background: style.backgroundColor,
        items: items.map((item) => {
          const look = getComputedStyle(item);
          const icon = item.querySelector('svg');
          const iconLook = icon ? getComputedStyle(icon) : null;
          return {
            text: (item.textContent ?? '').trim(),
            height: item.offsetHeight,
            top: item.offsetTop,
            fontSize: look.fontSize,
            fontWeight: look.fontWeight,
            radius: look.borderTopLeftRadius,
            color: look.color,
            icon: iconLook ? { width: iconLook.width, height: iconLook.height, stroke: parseFloat(iconLook.strokeWidth) } : null,
          };
        }),
        separators: separators.map((separator) => ({ top: separator.offsetTop, height: separator.offsetHeight })),
      };
    });

  test('COCKPIT-68 AC1 — a workspace\'s "…" menu is 200 px wide, radius 10, padding 4, filled with --menu; its items are 28 px high, 12 px, weight 400, radius 8, with a 14 px icon of stroke 1.25, in order, ending after a separator with "Delete workspace…" in the destructive color; a highlighted item is filled with --hover, in both schemes', async () => {
    const { page } = session;
    const menu = await openWorkspaceMenu();
    expect(await topLevelItems(menu)).toEqual(WORKSPACE_ITEMS);

    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      const fill = await tokenColour(page, '--menu');
      expect(fill, `--menu is a fill, ${scheme}`).not.toBe('rgba(0, 0, 0, 0)');
      const look = await readMenu(menu);

      expect(look.width, `popup width, ${scheme}`).toBe(200);
      expect(look.radius, `popup radius, ${scheme}`).toBe('10px');
      expect(look.padding, `popup padding, ${scheme}`).toEqual(['4px', '4px', '4px', '4px']);
      expect(look.background, `popup fill, ${scheme}`).toBe(fill);
      expect(look.items.map((item) => item.text)).toEqual(WORKSPACE_ITEMS);
      for (const item of look.items) {
        expect(item.height, `${item.text} height, ${scheme}`).toBe(28);
        expect(item.fontSize, `${item.text} font size, ${scheme}`).toBe('12px');
        expect(item.fontWeight, `${item.text} weight, ${scheme}`).toBe('400');
        expect(item.radius, `${item.text} radius, ${scheme}`).toBe('8px');
        expect(item.icon, `${item.text} icon, ${scheme}`).toEqual({ width: '14px', height: '14px', stroke: 1.25 });
      }

      // One separator, between "Reveal in Finder" and "Delete workspace…", which is painted destructive.
      expect(look.separators, `separators, ${scheme}`).toHaveLength(1);
      const reveal = look.items.find((item) => item.text === 'Reveal in Finder')!;
      const remove = look.items.find((item) => item.text === 'Delete workspace…')!;
      expect(look.separators[0]!.top, 'after "Reveal in Finder"').toBeGreaterThanOrEqual(reveal.top + reveal.height);
      expect(look.separators[0]!.top + look.separators[0]!.height, 'before "Delete workspace…"').toBeLessThanOrEqual(remove.top);
      expect(remove.color, `Delete workspace… color, ${scheme}`).toBe(await tokenColour(page, '--destructive', 'color'));

      // The item under the pointer is highlighted with --hover.
      const hover = await tokenColour(page, '--hover');
      await menu.getByRole('menuitem', { name: 'Reveal in Finder', exact: true }).hover();
      const highlighted = (await menu.getByRole('menuitem', { name: 'Reveal in Finder', exact: true }).elementHandle()) as ElementHandle<HTMLElement>;
      await untilIn(highlighted, (element, expected: string) => getComputedStyle(element).backgroundColor === expected, (matches) => matches, hover);
    }
  });

  // The items of a submenu: each app's name (the last text of its item), whether it carries a check mark, and its letter badges
  // (an element of its own whose text is the first letter of the app's name).
  const readApps = (items: Locator) =>
    items.evaluateAll((elements) =>
      elements.map((item) => {
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
        let name = '';
        for (let node = walker.nextNode(); node; node = walker.nextNode()) name = (node.textContent ?? '').trim() || name;
        const badges = [...item.querySelectorAll('*')].filter(
          (element) => element.children.length === 0 && (element.textContent ?? '').trim().toLowerCase() === name.charAt(0).toLowerCase() && (element.textContent ?? '').trim() !== name,
        );
        return { name, check: item.querySelectorAll('svg.lucide-check').length, badges: badges.length };
      }),
    );

  test('COCKPIT-68 AC2 — in the "Open in editor" and "Open in terminal" submenus the app shown first carries a check mark and every app a letter badge', async () => {
    await openWorkspaceMenu();

    for (const [trigger, apps] of [
      ['Open in editor', ['Visual Studio Code', 'Cursor']],
      ['Open in terminal', ['Terminal', 'Ghostty']],
    ] as const) {
      const rows = await readApps(await openSubmenu(session.page, trigger));
      expect(rows.map((row) => row.name), trigger).toEqual(apps);
      expect(
        rows.map((row) => row.check),
        `${trigger}: the check mark is on the first app only`,
      ).toEqual([1, 0]);
      expect(
        rows.map((row) => row.badges),
        `${trigger}: one letter badge per app`,
      ).toEqual([1, 1]);
    }
  });

  test('COCKPIT-68 AC3 — a project\'s "…" menu holds "New workspace" (Plus) and, after a separator, "Remove project…" (FolderMinus, destructive color), and no "Files stay on disk" line', async () => {
    const { page } = session;
    await openMenu(page, repo.root);
    const menu = page.getByRole('menu', { name: `Actions for ${repo.name}`, exact: true });

    expect(await topLevelItems(menu)).toEqual(['New workspace', 'Remove project…']);
    expect(await menu.innerText()).not.toContain('Files stay on disk');
    const look = await menu.evaluate((popup) => {
      const items = [...popup.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
      const separators = [...popup.querySelectorAll('[role="separator"]')] as HTMLElement[];
      return {
        icons: items.map((item) => item.querySelector('svg')?.getAttribute('class') ?? ''),
        colors: items.map((item) => getComputedStyle(item).color),
        tops: items.map((item) => ({ top: item.offsetTop, bottom: item.offsetTop + item.offsetHeight })),
        separators: separators.map((separator) => separator.offsetTop),
      };
    });
    expect(look.icons[0]).toMatch(/lucide-plus(\s|$)/);
    expect(look.icons[1]).toMatch(/lucide-folder-minus(\s|$)/);
    expect(look.colors[1]).toBe(await tokenColour(page, '--destructive', 'color'));
    expect(look.colors[0]).not.toBe(look.colors[1]);
    expect(look.separators).toHaveLength(1);
    expect(look.separators[0]!).toBeGreaterThanOrEqual(look.tops[0]!.bottom);
    expect(look.separators[0]!).toBeLessThanOrEqual(look.tops[1]!.top);
  });

  test('COCKPIT-68 AC18 — a confirmation dialog is 420 px wide, radius 12, padding 16, filled with --dialog over a --scrim with no blur; its title is 13 px weight 500, its body 12 px on 18 px, its buttons 28 px high with radius 8, and the destructive one is filled with --destructive under white text, in both schemes', async () => {
    const { page } = session;
    const dialog = await startProjectRemoval(page, repo.root);

    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      const expected = {
        dialog: await tokenColour(page, '--dialog'),
        scrim: await tokenColour(page, '--scrim'),
        destructive: await tokenColour(page, '--destructive'),
      };
      expect(expected.dialog, `--dialog is a fill, ${scheme}`).not.toBe('rgba(0, 0, 0, 0)');
      expect(expected.scrim, `--scrim is a fill, ${scheme}`).not.toBe('rgba(0, 0, 0, 0)');

      const look = await dialog.evaluate((popup, name) => {
        const style = getComputedStyle(popup);
        const own = (predicate: (element: HTMLElement) => boolean) => [...popup.querySelectorAll('*')].filter((element) => predicate(element as HTMLElement))[0] as HTMLElement;
        const title = own((element) => (element.textContent ?? '').trim() === `Remove ${name}?` && element.children.length === 0);
        const body = own((element) => (element.textContent ?? '').trim().startsWith('This removes the project from Cockpit.') && element.children.length === 0);
        const button = (label: string) => own((element) => element.tagName === 'BUTTON' && (element.textContent ?? '').trim() === label);
        const buttonLook = (element: HTMLElement) => {
          const look = getComputedStyle(element);
          return { height: element.offsetHeight, radius: look.borderTopLeftRadius, background: look.backgroundColor, color: look.color };
        };
        // What covers the page outside the dialog: the scrim.
        const covering = document.elementFromPoint(2, 2) as HTMLElement | null;
        const coveringLook = covering ? getComputedStyle(covering) : null;
        return {
          width: (popup as HTMLElement).offsetWidth,
          radius: style.borderTopLeftRadius,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
          background: style.backgroundColor,
          title: title ? { fontSize: getComputedStyle(title).fontSize, fontWeight: getComputedStyle(title).fontWeight } : null,
          body: body ? { fontSize: getComputedStyle(body).fontSize, lineHeight: getComputedStyle(body).lineHeight } : null,
          cancel: button('Cancel') ? buttonLook(button('Cancel')) : null,
          remove: button('Remove') ? buttonLook(button('Remove')) : null,
          scrim:
            covering && coveringLook && !popup.contains(covering)
              ? { background: coveringLook.backgroundColor, blur: coveringLook.backdropFilter, webkitBlur: coveringLook.getPropertyValue('-webkit-backdrop-filter') }
              : null,
        };
      }, repo.name);

      expect(look.width, `width, ${scheme}`).toBe(420);
      expect(look.radius, `radius, ${scheme}`).toBe('12px');
      expect(look.padding, `padding, ${scheme}`).toEqual(['16px', '16px', '16px', '16px']);
      expect(look.background, `fill, ${scheme}`).toBe(expected.dialog);
      expect(look.title, `title, ${scheme}`).toEqual({ fontSize: '13px', fontWeight: '500' });
      expect(look.body, `body, ${scheme}`).toEqual({ fontSize: '12px', lineHeight: '18px' });
      expect(look.cancel?.height, `Cancel height, ${scheme}`).toBe(28);
      expect(look.cancel?.radius, `Cancel radius, ${scheme}`).toBe('8px');
      expect(look.remove?.height, `Remove height, ${scheme}`).toBe(28);
      expect(look.remove?.radius, `Remove radius, ${scheme}`).toBe('8px');
      expect(look.remove?.background, `Remove fill, ${scheme}`).toBe(expected.destructive);
      expect(look.remove?.color, `Remove text, ${scheme}`).toBe('rgb(255, 255, 255)');
      expect(look.scrim, `a scrim covers the page, ${scheme}`).not.toBeNull();
      expect(look.scrim!.background, `scrim fill, ${scheme}`).toBe(expected.scrim);
      expect([look.scrim!.blur, look.scrim!.webkitBlur].filter((blur) => blur && blur !== 'none'), `no blur, ${scheme}`).toEqual([]);
    }
  });
});
