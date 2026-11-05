import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ElementHandle, type Page } from 'playwright-core';
import { expect } from 'vitest';
import { evaluateUntil, type Session, startClock, untilRead, untilScript } from '../launch';
import { afterIpcAnswers, dispatchFocus, gitIn, makeRepo, openDialogs, overlayCount, type TempRepo, untilFewerOverlays } from './projects';
import { type SessionsFixture, storedSessions } from './sessions';

// --- Changes sidebar (COCKPIT-34), the right bar since COCKPIT-67 --------------

export type Locator = ReturnType<Page['locator']>;
export type BarTab = 'Diff' | 'Pull request';

// The right column of a workspace page: the 40 px rail or the 320 px bar, the one element with role
// `complementary` named "Right bar" (a `div`: the left sidebar stays the page's only `<aside>`).
export const PANEL = '[role="complementary"][aria-label="Right bar"]';
export const rightBar = (page: Page) => page.getByRole('complementary', { name: 'Right bar', exact: true });
export const showRightBar = (page: Page) => page.getByRole('button', { name: 'Show right bar', exact: true });
export const hideRightBar = (page: Page) => page.getByRole('button', { name: 'Hide right bar', exact: true });
// The rail's two buttons (the bar has tabs instead).
export const railButton = (page: Page, name: BarTab) => rightBar(page).getByRole('button', { name, exact: true });
// A tab of the bar: its name may be followed by the number of files.
export const barTab = (page: Page, name: BarTab) => rightBar(page).getByRole('tab', { name: new RegExp(`^${name}`) });

// Whether the right column is the open bar (320 px) and not the rail (40 px).
// Self-contained: it also runs in `untilRead`.
export const readBarOpen = ({ selector }: { selector: string; open?: boolean }) => (document.querySelector(selector)?.getBoundingClientRect().width ?? 0) > 100;
export const markChangesPanel = (page: Page) => page.evaluate(readBarOpen, { selector: PANEL });

// Waits until the right column is the open bar (`open`) or the rail.
export const waitForBar = (page: Page, open: boolean) =>
  untilRead(page, readBarOpen, (shown, arg: { selector: string; open?: boolean }) => shown === arg.open, { selector: PANEL, open });

// `untilRead` on the open bar: `read(panel, arg)` runs in the page on the bar, and gives `closed` while the bar is
// not open. `uses` are the self-contained reads `read` calls, by the name it calls them.
export const untilPanel = <A, R>(
  page: Page,
  read: (panel: HTMLElement, arg: A) => R,
  done: (value: R, arg: A) => boolean,
  arg: A,
  { closed = null, uses = {} }: { closed?: unknown; uses?: Record<string, object> } = {},
): Promise<R> =>
  evaluateUntil<R>(page.mainFrame(), read, arg, (id) =>
    untilScript(
      read,
      done,
      arg,
      `((panel) => (panel && panel.getBoundingClientRect().width > 100 ? read(panel, arg) : ${JSON.stringify(closed)}))(document.querySelector(${JSON.stringify(PANEL)}))`,
      'document',
      id,
      uses,
    ),
  );

// Runs `read` in the page on the bar, `null` when it is not there.
export async function panelEval<T, A>(page: Page, read: (panel: HTMLElement, arg: A) => T, arg: A): Promise<T | null> {
  if (!(await markChangesPanel(page))) return null;
  return page
    .locator(PANEL)
    .evaluate(read as unknown as (panel: HTMLElement | SVGElement, arg: unknown) => T, arg)
    .catch(() => null);
}

// What is shown (a hidden tab panel's text is not part of `innerText`).
export const panelText = async (page: Page) => (await panelEval(page, (panel) => panel.innerText, null)) ?? '';

// Waits until the bar's text satisfies `matches(text, arg)` (it runs in the page; the text is '' while the bar is closed).
export const waitForPanelText = <A = undefined>(page: Page, matches: (text: string, arg: A) => boolean, arg?: A) =>
  untilPanel(page, (panel) => panel.innerText, matches, arg as A, { closed: '' });

// Geometry and style of an element: the facts the right bar's criteria state.
export const readStyle = (element: Element) => {
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return {
    left: box.left,
    right: box.right,
    top: box.top,
    bottom: box.bottom,
    width: box.width,
    height: box.height,
    color: style.color,
    background: style.backgroundColor,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    fontWeight: style.fontWeight,
    fontFamily: style.fontFamily,
    radius: style.borderTopLeftRadius,
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
    borderTop: style.borderTopWidth,
    borderRight: style.borderRightWidth,
    borderBottom: style.borderBottomWidth,
    borderLeft: style.borderLeftWidth,
    borderTopColor: style.borderTopColor,
    borderLeftColor: style.borderLeftColor,
    position: style.position,
  };
};
export const lookOf = (target: Locator) => target.evaluate(readStyle);

// The heaviest font weight of the element and of everything in it (hidden content included).
export const heaviestWeight = (target: Locator) =>
  target.evaluate((root) => Math.max(...[root, ...root.querySelectorAll('*')].map((element) => parseInt(getComputedStyle(element).fontWeight, 10))));

// The window-dragging region in force at a point of the page: `drag`, `no-drag` or `none`.
export const regionAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => {
      for (let element = document.elementFromPoint(x!, y!); element; element = element.parentElement) {
        const region = getComputedStyle(element).getPropertyValue('-webkit-app-region');
        if (region === 'drag' || region === 'no-drag') return region;
      }
      return 'none';
    },
    [x, y] as const,
  );
export const centreOf = (look: { left: number; right: number; top: number; bottom: number }) => [(look.left + look.right) / 2, (look.top + look.bottom) / 2] as const;

// The smallest element that holds every one of `targets`.
export async function commonAncestor(page: Page, ...targets: Locator[]) {
  const handles = await Promise.all(targets.map((target) => target.elementHandle()));
  return page.evaluateHandle((elements) => {
    let node: Element | null = elements[0]!;
    while (node && !elements.every((element) => node!.contains(element))) node = node.parentElement;
    return node!;
  }, handles as ElementHandle<SVGElement | HTMLElement>[]);
}
export const lookOfHandle = (handle: unknown) => (handle as Locator).evaluate(readStyle);

// The Lucide icon inside `target`: its class, size, stroke width and color.
export const iconIn = (target: Locator) =>
  target
    .locator('svg')
    .first()
    .evaluate((svg) => ({
      className: svg.getAttribute('class') ?? '',
      width: svg.getBoundingClientRect().width,
      height: svg.getBoundingClientRect().height,
      stroke: parseFloat(getComputedStyle(svg).strokeWidth),
      color: getComputedStyle(svg).color,
    }));

export const near = (actual: number, expected: number, tolerance = 1) => Math.abs(actual - expected) <= tolerance;

export const TRANSPARENT = 'rgba(0, 0, 0, 0)';

// Whether `target`'s fill is the token's color at 14 % opacity (the state pills): both are drawn over the
// same gray in a canvas and the pixels compared, whatever color syntax the computed value uses.
export const fillIsTokenAt14 = (target: Locator, token: string) =>
  target.evaluate((element, token) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const solid = getComputedStyle(probe).color;
    probe.remove();
    const fill = getComputedStyle(element).backgroundColor;
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const over = (draw: () => void) => {
      context.clearRect(0, 0, 1, 1);
      context.globalAlpha = 1;
      context.fillStyle = '#808080';
      context.fillRect(0, 0, 1, 1);
      draw();
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const actual = over(() => {
      context.fillStyle = fill;
      context.fillRect(0, 0, 1, 1);
    });
    const expected = over(() => {
      context.globalAlpha = 0.14;
      context.fillStyle = solid;
      context.fillRect(0, 0, 1, 1);
    });
    return fill !== 'rgba(0, 0, 0, 0)' && actual.every((value, index) => Math.abs(value - expected[index]!) <= 3);
  }, token);

// The sidebar's hunk headers (`@@ … @@`).
// Self-contained: it also runs in `untilPanel`.
export const readHunkHeaders = (panel: HTMLElement): string[] => {
  const pattern = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/;
  const text = (element: Element) => (element.textContent ?? '').trim();
  return [...panel.querySelectorAll('*')]
    .filter((element) => pattern.test(text(element)) && ![...element.children].some((child) => pattern.test(text(child))))
    .map(text);
};
export const hunkHeaders = async (page: Page) => (await panelEval(page, readHunkHeaders, null)) ?? [];
export const waitForHunkHeaders = (page: Page, count: number) =>
  untilPanel(page, readHunkHeaders, (found, count: number) => found.length === count, count, { closed: [] });

export interface LeafLook {
  color: string;
  fontSize: string;
  fontFamily: string;
}
export interface FileRow {
  /** The row's text, one entry per word, with "−" read as "-". */
  tokens: string[];
  /** The look of each piece of text of the row, by its text ("−" read as "-"). */
  leaves: Record<string, LeafLook>;
  /** The row: the height of its button, its largest radius, the first fill from the name up to the row. */
  row: { height: number; radius: number; background: string };
}

// The row of the file list that shows the file name `name`: its text pieces and their looks. The first
// match in document order is the list's (the diff area comes after it). `others` are the names of the
// other rows, which tell where the row ends.
// Self-contained: it also runs in `untilPanel`.
export const readFileRow = (panel: HTMLElement, { name, others }: { name: string; others: string[] }): FileRow | null => {
      const text = (element: Element) => (element.textContent ?? '').trim();
      const leaves = [...panel.querySelectorAll<HTMLElement>('*')].filter(
        (element) => element.children.length === 0 && text(element) !== '' && element.checkVisibility(),
      );
      const shows = (leaf: Element, wanted: string) => text(leaf) === wanted || text(leaf).startsWith(`${wanted} `);
      const nameLeaf = leaves.find((leaf) => shows(leaf, name));
      if (!nameLeaf) return null;
      let row: HTMLElement = nameLeaf;
      while (row.parentElement && row.parentElement !== panel) {
        const parent: HTMLElement = row.parentElement;
        if (others.some((other) => leaves.some((leaf) => parent.contains(leaf) && shows(leaf, other)))) break;
        row = parent;
      }
      const inRow = leaves.filter((leaf) => row.contains(leaf));
      const normalise = (value: string) => value.replace(/−/g, '-');
      const chain: HTMLElement[] = [];
      for (let node: HTMLElement | null = nameLeaf; node; node = node.parentElement) {
        chain.push(node);
        if (node === row) break;
      }
      const control = nameLeaf.closest<HTMLElement>('button, [role="button"], [role="option"], a') ?? row;
      const fill = chain.map((node) => getComputedStyle(node).backgroundColor).find((color) => color !== 'rgba(0, 0, 0, 0)');
      return {
        tokens: inRow.flatMap((leaf) => normalise(text(leaf)).split(/\s+/)),
        leaves: Object.fromEntries(
          inRow.map((leaf) => {
            const style = getComputedStyle(leaf);
            return [normalise(text(leaf)), { color: style.color, fontSize: style.fontSize, fontFamily: style.fontFamily }];
          }),
        ),
        row: {
          height: control.getBoundingClientRect().height,
          radius: Math.max(...chain.map((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius))),
          background: fill ?? 'rgba(0, 0, 0, 0)',
        },
      };
    };

export const fileRow = (page: Page, name: string, others: string[]) => panelEval(page, readFileRow, { name, others });

// The names of the files the list shows, with their status letters and counts, for a workspace
// whose files are `names`.
export const listedNames = async (page: Page, names: string[]) => {
  const rows = await Promise.all(names.map(async (name) => [name, await fileRow(page, name, names.filter((other) => other !== name))] as const));
  return rows.filter(([, row]) => row !== null).map(([name]) => name);
};

// Self-contained but for `readFileRow` (see `uses` below): the same names, read in the page.
export const readListedNames = (panel: HTMLElement, { names }: { names: string[]; expected?: string[] }): string[] =>
  names.filter((name) => readFileRow(panel, { name, others: names.filter((other) => other !== name) }) !== null);

// Waits until the list shows exactly `expected` among `names` (in the order of `names`), and gives them.
export const waitForListed = (page: Page, names: string[], expected: string[]) =>
  untilPanel(page, readListedNames, (found, arg: { names: string[]; expected?: string[] }) => JSON.stringify(found) === JSON.stringify(arg.expected), { names, expected }, { closed: [], uses: { readFileRow } });

export interface DiffLineFacts {
  /** Whether the line or one of its containers is painted with the `--diff-added` token (background or text). */
  added: boolean;
  /** The same for `--diff-removed`. */
  removed: boolean;
}

// One line of the diff: its text is the line number, the `+`, `-` or space prefix and the content
// (whitespace ignored, "−" read as "-"). `null` when no element shows it.
// Self-contained: it also runs in `untilPanel`.
export const readDiffLine = (panel: HTMLElement, expected: string): DiffLineFacts | null => {
      const normalise = (text: string) => text.replace(/\s+/g, '').replace(/−/g, '-');
      const token = (name: string, property: 'color' | 'backgroundColor') => {
        const probe = document.createElement('span');
        if (property === 'color') probe.style.color = `var(${name})`;
        else probe.style.backgroundColor = `var(${name})`;
        document.body.append(probe);
        const value = getComputedStyle(probe)[property];
        probe.remove();
        return value;
      };
      const matches = [...panel.querySelectorAll<HTMLElement>('*')].filter((element) => normalise(element.textContent ?? '') === expected);
      const line = matches.find((element) => !matches.some((other) => other !== element && element.contains(other)));
      if (!line) return null;
      const chain: HTMLElement[] = [];
      for (let node: HTMLElement | null = line; node && node !== panel.parentElement; node = node.parentElement) chain.push(node);
      // A token the page does not define would resolve to the inherited text color: it paints nothing.
      const painted = (name: string) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() !== '' &&
        chain.some((node) => {
          const style = getComputedStyle(node);
          return style.backgroundColor === token(name, 'backgroundColor') || style.color === token(name, 'color');
        });
      return { added: painted('--diff-added'), removed: painted('--diff-removed') };
    };

export const diffLineExpected = (number: number, prefix: '+' | '-' | ' ', content: string) => `${number}${prefix === ' ' ? '' : prefix}${content}`.replace(/\s+/g, '');

export const waitForDiffLine = (page: Page, number: number, prefix: '+' | '-' | ' ', content: string) =>
  untilPanel(page, readDiffLine, (facts) => facts !== null, diffLineExpected(number, prefix, content));

// The layout of one diff line (AC9): its height, the gutter holding the number (width, alignment, color),
// the gap between the gutter and the prefix, the line's fill (the first one from the line up to the bar)
// and the color of its text.
export const diffLineLook = (page: Page, number: number, prefix: '+' | '-', content: string) =>
  panelEval(
    page,
    (panel, { expected, content }) => {
      const normalise = (text: string) => text.replace(/\s+/g, '').replace(/−/g, '-');
      const matches = [...panel.querySelectorAll<HTMLElement>('*')].filter((element) => normalise(element.textContent ?? '') === expected);
      const line = matches.find((element) => !matches.some((other) => other !== element && element.contains(other)));
      if (!line) return null;
      const texts: Text[] = [];
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if ((node.textContent ?? '').trim() !== '') texts.push(node as Text);
      const rangeOf = (node: Text) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect();
      };
      const gutter = texts[0]!.parentElement!;
      const gutterBox = gutter.getBoundingClientRect();
      const contentNode = texts.find((node) => (node.textContent ?? '').includes(content)) ?? texts.at(-1)!;
      let fill = 'rgba(0, 0, 0, 0)';
      for (let node: HTMLElement | null = line; node && node !== panel; node = node.parentElement) {
        const background = getComputedStyle(node).backgroundColor;
        if (background !== 'rgba(0, 0, 0, 0)') {
          fill = background;
          break;
        }
      }
      const lineStyle = getComputedStyle(line);
      return {
        height: line.getBoundingClientRect().height,
        fontSize: lineStyle.fontSize,
        fontFamily: lineStyle.fontFamily,
        gutterWidth: gutterBox.width,
        gutterAlign: getComputedStyle(gutter).textAlign,
        gutterColor: getComputedStyle(gutter).color,
        gap: rangeOf(texts[1]!).left - gutterBox.right,
        fill,
        textColor: getComputedStyle(contentNode.parentElement!).color,
      };
    },
    { expected: `${number}${prefix}${content}`.replace(/\s+/g, ''), content },
  );

// The hunk header row whose text starts with `start` (AC9): its height, fill, text style and the offset of
// its text from its left edge.
export const hunkRowLook = (page: Page, start: string) =>
  panelEval(
    page,
    (panel, start) => {
      const text = (element: Element) => (element.textContent ?? '').trim();
      const leaf = [...panel.querySelectorAll<HTMLElement>('*')].find(
        (element) => text(element).startsWith(start) && ![...element.children].some((child) => text(child).startsWith(start)),
      );
      if (!leaf) return null;
      let row: HTMLElement = leaf;
      while (row.parentElement && row.parentElement !== panel && text(row.parentElement) === text(leaf)) row = row.parentElement;
      const style = getComputedStyle(leaf);
      const range = document.createRange();
      range.selectNodeContents(leaf.firstChild ?? leaf);
      let background = 'rgba(0, 0, 0, 0)';
      for (let node: HTMLElement | null = leaf; node; node = node.parentElement) {
        const fill = getComputedStyle(node).backgroundColor;
        if (fill !== 'rgba(0, 0, 0, 0)') {
          background = fill;
          break;
        }
        if (node === row) break;
      }
      return {
        height: row.getBoundingClientRect().height,
        background,
        color: style.color,
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        textOffset: range.getBoundingClientRect().left - row.getBoundingClientRect().left,
      };
    },
    start,
  );

// The width of the first terminal screen that is shown. Self-contained: it also runs in `untilRead`.
// The scrolling area that holds the file `a.txt` in the bar, as height and bottom. Self-contained: it also runs in `untilRead`.
export const readListArea = ({ selector }: { selector: string; before?: number }) => {
  const leaf = [...(document.querySelector(selector)?.querySelectorAll('*') ?? [])].find((element) => element.children.length === 0 && (element.textContent ?? '').trim() === 'a.txt');
  for (let node = leaf?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return { height: node.getBoundingClientRect().height, bottom: node.getBoundingClientRect().bottom };
  }
  return { height: 0, bottom: 0 };
};

export const readScreenWidth = (): number =>
  [...document.querySelectorAll('.xterm-screen')].map((element) => element.getBoundingClientRect().width).find((width) => width > 0) ?? 0;

// Selects a tab of the open bar.
export async function selectBarTab(page: Page, tab: BarTab) {
  const element = barTab(page, tab);
  await element.waitFor();
  if ((await element.getAttribute('aria-selected')) !== 'true') await element.click();
  await rightBar(page).getByRole('tab', { name: new RegExp(`^${tab}`), selected: true }).waitFor();
}

// The tab that is selected, without the number of files.
export const selectedTabName = (page: Page) =>
  rightBar(page)
    .getByRole('tab', { selected: true })
    .first()
    .innerText()
    .then((name) => name.replace(/\s*\d+\s*$/, '').trim())
    .catch(() => '');

// Opens (or closes) the right bar through its buttons, on `tab`, and waits for it.
export async function setChangesOpen(page: Page, open: boolean, tab: BarTab = 'Diff') {
  if (open) {
    if (!(await markChangesPanel(page))) {
      await showRightBar(page).waitFor();
      await showRightBar(page).click();
    }
    expect(await waitForBar(page, true), 'the right bar opens').toBe(true);
    await selectBarTab(page, tab);
  } else {
    if (await markChangesPanel(page)) await hideRightBar(page).click();
    await showRightBar(page).waitFor();
    expect(await waitForBar(page, false), 'the right bar closes').toBe(false);
  }
}

// Clicks the file `name` in the bar's list.
export async function selectChangedFile(page: Page, name: string) {
  expect(await markChangesPanel(page)).toBe(true);
  await page.locator(PANEL).getByText(name, { exact: true }).first().click();
}

// Opens a session's page through its link in the left sidebar.
export async function openSessionById(page: Page, id: string) {
  const stored = (await storedSessions(page)).find((each) => each.id === id);
  if (stored?.project) {
    // A session of a workspace is a tab of the workspace's page.
    await page.getByTitle(stored.directory, { exact: true }).first().click();
    await page.getByRole('tab', { name: stored.name, exact: true }).click();
    return;
  }
  await page.locator(`a[href="/sessions/${id}"]`).first().click();
  await page.waitForURL((url) => url.pathname === `/sessions/${id}`);
}

// A repository whose files give the sidebar something to show: `a.txt` (20 lines), `c.txt` (3), `d.txt` (10)
// besides `README.md` and `src/main.ts`.
export function makeChangesRepo(name: string): TempRepo {
  const repo = makeRepo(name);
  const numbered = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join('');
  writeFileSync(join(repo.root, 'a.txt'), numbered('line', 20));
  writeFileSync(join(repo.root, 'c.txt'), numbered('c', 3));
  writeFileSync(join(repo.root, 'd.txt'), numbered('d', 10));
  gitIn(repo.root, 'add', '.');
  gitIn(repo.root, 'commit', '-m', 'files for the changes sidebar');
  return repo;
}

// Every kind of change in a worktree of `makeChangesRepo`, uncommitted: `a.txt` edited in two places
// (two hunks), `src/main.ts` edited, `c.txt` deleted, `d.txt` renamed to `e.txt`, an untracked `new.txt`, a
// binary `bin.dat` and a `big.txt` whose diff is over 1 MiB. Listed by path: a.txt, big.txt, bin.dat, c.txt,
// e.txt, new.txt, src/main.ts.
export const CHANGED_NAMES = ['a.txt', 'big.txt', 'bin.dat', 'c.txt', 'e.txt', 'new.txt', 'main.ts'];
export function writeChanges(worktree: string) {
  const a = readFileSync(join(worktree, 'a.txt'), 'utf8').replace(/^line 2$/m, 'line two').replace(/^line 18$/m, 'line eighteen');
  writeFileSync(join(worktree, 'a.txt'), a);
  writeFileSync(join(worktree, 'src', 'main.ts'), 'export const answer = 42;\n');
  rmSync(join(worktree, 'c.txt'));
  renameSync(join(worktree, 'd.txt'), join(worktree, 'e.txt'));
  writeFileSync(join(worktree, 'new.txt'), 'alpha\nbeta\n');
  writeFileSync(join(worktree, 'bin.dat'), Buffer.from([0, 1, 2]));
  writeFileSync(join(worktree, 'big.txt'), `${'x'.repeat(79)}\n`.repeat(15_000));
}

export interface ChangesApi {
  workspaces: {
    changes(project: string, path: string): Promise<unknown>;
    diff(project: string, path: string, file: unknown): Promise<unknown>;
    watch(project: string, path: string, listener: () => void): (() => void) | Promise<() => void>;
  };
}
export type ChangesWindow = Window & { api: ChangesApi; __changedEvents?: number; __stopWatching?: () => void; __onChanged?: () => void };

export const changesApi = (page: Page, method: 'changes' | 'diff', project: string, path: string) =>
  page.evaluate(
    ([method, project, path]) => {
      const { workspaces } = (window as unknown as ChangesWindow).api;
      return method === 'changes'
        ? workspaces.changes(project!, path!)
        : workspaces.diff(project!, path!, { path: 'a.txt', status: 'modified', additions: 1, deletions: 1 });
    },
    [method, project, path] as const,
  );

// Starts `window.api.workspaces.watch` in the page and counts the `changed` events it delivers.
export const startWatching = (page: Page, project: string, path: string) =>
  page.evaluate(
    async ([project, path]) => {
      const w = window as unknown as ChangesWindow;
      w.__changedEvents = 0;
      w.__stopWatching = await w.api.workspaces.watch(project!, path!, () => {
        w.__changedEvents = (w.__changedEvents ?? 0) + 1;
        w.__onChanged?.();
      });
    },
    [project, path] as const,
  );
export const changedEvents = (page: Page) => page.evaluate(() => (window as unknown as ChangesWindow).__changedEvents ?? 0);
// Resolves once the watch started with `startWatching` has delivered an event.
export const waitForChangedEvent = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const w = window as unknown as ChangesWindow;
        if ((w.__changedEvents ?? 0) > 0) resolve();
        else w.__onChanged = resolve;
      }),
  );

// Counts, in the main process, the `workspaces:unwatch` messages the page sends when its bar stops watching: the
// app's own listener (added first) has closed the watcher when ours runs.
export const watchUnwatches = (session: Session) =>
  session.evaluateInMain(`(() => {
    if (globalThis.__unwatches) return;
    const state = (globalThis.__unwatches = { count: 0, waiting: [] });
    require('electron').ipcMain.on('workspaces:unwatch', () => {
      state.count++;
      for (const check of state.waiting.splice(0)) check();
    });
  })()`);
export const unwatchesSeen = (session: Session) => session.evaluateInMain<number>('globalThis.__unwatches.count');
export const untilUnwatches = (session: Session, count: number) =>
  session.evaluateInMain(`new Promise((resolve) => {
    const state = globalThis.__unwatches;
    const check = () => (state.count >= ${count} ? resolve(true) : state.waiting.push(check));
    check();
  })`);

// The FSEvents watchers the main process holds (what a watch of a worktree opens), read after the main process
// has answered everything the page sent before, an unwatch included: the page's later answers come after the
// close, and the handles are gone by then.
export async function fsEventWatchersOf(session: Session) {
  await afterIpcAnswers(session.page);
  return session.evaluateInMain<number>("process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length");
}
export const stopWatching = (page: Page) => page.evaluate(() => (window as unknown as ChangesWindow).__stopWatching?.());

// The git runs the wrapper logged that mention `folder` (as working directory or argument).
export const gitRunsIn = (fx: SessionsFixture, folder: string) =>
  readFileSync(fx.gitLog, 'utf8').split('\n').filter((line) => line.includes(folder));

// What the smoke paths check on a workspace page: a file the test writes in the worktree shows in the
// sidebar's list with its diff.
export async function expectChangesShowNewFile(page: Page, worktree: string) {
  await setChangesOpen(page, true);
  writeFileSync(join(worktree, 'smoke-changes.txt'), 'hello from the smoke path\n');
  expect(await waitForListed(page, ['smoke-changes.txt'], ['smoke-changes.txt'])).toEqual(['smoke-changes.txt']);
  expect(await waitForDiffLine(page, 1, '+', 'hello from the smoke path')).not.toBeNull();
}

// --- Ship a workspace: commit, push, pull request, cleanup (COCKPIT-38) --------
//
// The contract of the five new `window.api.workspaces` calls these tests use, beyond the spec's:
// `status(project, path)`, `commit(project, path, message)`, `push(project, path)`,
// `pullRequest(project, path)` and `createPullRequest(project, path, title, body)`, each resolving to
// `{ status: 'refused', message }` on a refusal.

// The git the app runs ignores the developer's configuration (a signing key, a global hook) and has an
// identity of its own, so a commit made through the sidebar works on any machine.
export const GIT_APP_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export const PR_URL = 'https://github.test/acme/app/pull/7';

export type PrChecks = 'none' | 'pending' | 'passing' | 'failing' | 'unknown';
// One check run per state, named after it ("CI / check-failing"), so a test tells the answer it set from the one before.
const run = (name: string, status: string, conclusion: string) => ({ __typename: 'CheckRun', name, workflowName: 'CI', status, conclusion });
export const ROLLUPS: Record<PrChecks, object[]> = {
  none: [],
  pending: [run('check-pending', 'IN_PROGRESS', '')],
  passing: [run('check-passing', 'COMPLETED', 'SUCCESS')],
  failing: [run('check-failing', 'COMPLETED', 'FAILURE')],
  unknown: [run('check-unknown', 'COMPLETED', 'STALE')],
};

export const PR_HEAD = '0123456789abcdef0123456789abcdef01234567';

// What `gh pr list --json …` prints for one pull request (COCKPIT-75: author, body, head, reviews and checks too).
export const prJson = ({
  state = 'OPEN',
  checks = 'none',
  title = 'Fix the bug',
  author = 'romain-cll',
  body = '',
  head = PR_HEAD,
  rollup,
  reviews = [],
  decision = '',
}: {
  state?: string;
  checks?: PrChecks;
  title?: string;
  author?: string;
  body?: string;
  head?: string;
  /** The checks themselves, instead of the one `checks` stands for. */
  rollup?: object[];
  /** `latestReviews`: a login and a GitHub review state each. */
  reviews?: Array<{ login: string; state: string }>;
  /** `reviewDecision` as gh prints it, '' when the repository requires no review. */
  decision?: string;
} = {}) =>
  JSON.stringify([
    {
      number: 7,
      title,
      url: PR_URL,
      state,
      statusCheckRollup: rollup ?? ROLLUPS[checks],
      author: { login: author },
      body,
      headRefOid: head,
      latestReviews: reviews.map(({ login, state }) => ({ author: { login }, state })),
      reviewDecision: decision,
    },
  ]);

export interface GhFixture {
  /** The folder whose files set how the stub `gh` answers. */
  control: string;
  /** The file the stub appends every run to. */
  log: string;
}

// A stub `gh` on the fake login shell's `PATH` (the real one would reach GitHub). Every run is logged
// (fields separated by US, runs by RS, so a multi-line argument survives): the working directory,
// GH_PROMPT_DISABLED, then the arguments. `pr list` prints `pr-list` (`[]` without it) after failing as
// `code` and `stderr` say; `pr create` fails with `create-stderr`, else copies `after-create` over
// `pr-list` and prints a URL. `pr merge` fails with `merge-stderr` (exit 1), else succeeds unless `code` is set (COCKPIT-75), then copies `after-merge`
// over `pr-list` and each `after-merge-state-<branch>` over `state-<branch>`. `api graphql` answers, for each
// `-f b<i>=<branch>` it is given, the state in `state-<branch>` (no pull request without the file).
export function addGhFixture(fx: SessionsFixture): GhFixture {
  const control = join(fx.root, 'gh-control');
  mkdirSync(control);
  const log = join(fx.root, 'gh.log');
  const stub = join(fx.bin, 'gh');
  writeFileSync(
    stub,
    `#!/bin/sh
printf '%s\\037' "$(pwd -P)" "$GH_PROMPT_DISABLED" "$@" >> '${log}'
printf '\\036' >> '${log}'
if [ "$1 $2" = "pr create" ]; then
  if [ -s '${control}/create-stderr' ]; then cat '${control}/create-stderr' >&2; exit 1; fi
  [ -e '${control}/after-create' ] && cp '${control}/after-create' '${control}/pr-list'
  echo '${PR_URL}'
  exit 0
fi
if [ "$1 $2" = "pr merge" ] && [ -s '${control}/merge-stderr' ]; then cat '${control}/merge-stderr' >&2; exit 1; fi
if [ "$1 $2" = "pr merge" ] && [ ! -e '${control}/code' ]; then
  [ -e '${control}/after-merge' ] && cp '${control}/after-merge' '${control}/pr-list'
  for f in '${control}'/after-merge-state-*; do
    [ -e "$f" ] && cp "$f" '${control}/state-'"\${f##*/after-merge-state-}"
  done
  exit 0
fi
[ -s '${control}/stderr' ] && cat '${control}/stderr' >&2
[ -e '${control}/code' ] && exit "$(cat '${control}/code')"
if [ "$1" = api ]; then
  out=''
  for a in "$@"; do
    case "$a" in
      b[0-9]*=*)
        key="\${a%%=*}"
        branch="\${a#*=}"
        nodes='[]'
        [ -s '${control}/state-'"$branch" ] && nodes="[{\\"state\\":\\"$(cat '${control}/state-'"$branch")\\"}]"
        out="$out\\"$key\\":{\\"nodes\\":$nodes},"
        ;;
    esac
  done
  printf '{"data":{"repository":{%s}}}' "\${out%,}"
  exit 0
fi
if [ -e '${control}/pr-list' ]; then cat '${control}/pr-list'; else echo '[]'; fi
`,
  );
  chmodSync(stub, 0o755);
  // macOS scans a new executable the first time it runs; the run is not counted.
  execFileSync(stub, ['--warmup']);
  writeFileSync(log, '');
  return { control, log };
}

export interface GhAnswers {
  /** What `pr list` prints. */
  list?: string;
  code?: number;
  stderr?: string;
  createStderr?: string;
  afterCreate?: string;
  /** Makes `pr merge` (and only it) exit 1 with this message. */
  mergeStderr?: string;
  /** The state of the newest pull request of each branch for `api graphql` (`OPEN`, `MERGED`, `CLOSED`); a branch not named has none. */
  states?: Record<string, string>;
  /** What `pr list` prints and the states `api graphql` answers once `pr merge` succeeded. */
  afterMerge?: { list?: string; states?: Record<string, string> };
}

// How the stub answers from now on: everything not given is back to the default (`[]`, exit 0, no pull request).
export function setGh(gh: GhFixture, { list, code, stderr, createStderr, afterCreate, mergeStderr, states = {}, afterMerge }: GhAnswers = {}) {
  for (const name of readdirSync(gh.control)) rmSync(join(gh.control, name), { force: true });
  const files: Record<string, string | undefined> = {
    'pr-list': list,
    code: code?.toString(),
    stderr,
    'create-stderr': createStderr,
    'after-create': afterCreate,
    'merge-stderr': mergeStderr,
    'after-merge': afterMerge?.list,
  };
  for (const [branch, state] of Object.entries(states)) files[`state-${branch}`] = state;
  for (const [branch, state] of Object.entries(afterMerge?.states ?? {})) files[`after-merge-state-${branch}`] = state;
  for (const [name, content] of Object.entries(files)) if (content !== undefined) writeFileSync(join(gh.control, name), content);
}

export interface GhRun {
  cwd: string;
  /** `GH_PROMPT_DISABLED` as the stub saw it. */
  prompt: string;
  args: string[];
}
export const ghRuns = (gh: GhFixture): GhRun[] =>
  readFileSync(gh.log, 'utf8')
    .split('\x1e')
    .filter(Boolean)
    .map((run) => {
      const [cwd, prompt, ...args] = run.split('\x1f').slice(0, -1);
      return { cwd: cwd!, prompt: prompt!, args };
    });

// The runs of the bar's own read, of the sidebar's (one `api graphql` for a whole project) and of merges.
export const prListRuns = (gh: GhFixture) => ghRuns(gh).filter((run) => run.args[0] === 'pr' && run.args[1] === 'list');
export const graphqlRuns = (gh: GhFixture) => ghRuns(gh).filter((run) => run.args[0] === 'api' && run.args[1] === 'graphql');
export const mergeRuns = (gh: GhFixture) => ghRuns(gh).filter((run) => run.args[0] === 'pr' && run.args[1] === 'merge');
// The branches an `api graphql` run was given, in order.
export const branchesOfRun = (run: GhRun) => run.args.filter((arg) => /^b\d+=/.test(arg)).map((arg) => arg.slice(arg.indexOf('=') + 1));

// `origin`: a bare repository next to `repo`, holding `main`. Returns its path.
export function addOrigin(repo: TempRepo): string {
  const origin = join(repo.parent, `${repo.name}-origin.git`);
  gitIn(repo.parent, 'init', '--quiet', '--bare', '-b', 'main', origin);
  gitIn(repo.root, 'remote', 'add', 'origin', origin);
  gitIn(repo.root, 'push', '--quiet', 'origin', 'main');
  gitIn(repo.root, 'fetch', '--quiet', 'origin');
  return origin;
}

// A branch's commit in a bare repository, '' when it has none.
export const remoteRef = (origin: string, branch: string) => {
  try {
    return gitIn(origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  } catch {
    return '';
  }
};

export const shipButton = (page: Page, name: string) => page.locator(PANEL).getByRole('button', { name, exact: true });
export const prLink = (page: Page) => page.locator(PANEL).getByRole('link', { name: 'Open on GitHub', exact: true });
export const commitField = (page: Page) => page.locator(PANEL).getByRole('textbox', { name: 'Commit message', exact: true });
export const prDialog = (page: Page) => page.getByRole('dialog', { name: 'Create pull request' });

// --- Merge, checks, reviews, description and the sidebar's icons (COCKPIT-75) ---

export type MergeMethod = 'squash' | 'merge' | 'rebase';
export const MERGE_LABELS: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
export const MERGE_FLAGS: Record<MergeMethod, string> = { squash: '--squash', merge: '--merge', rebase: '--rebase' };
export const mergeMethodButton = (page: Page) => shipButton(page, 'Merge method');
// The confirmation of a merge: a dialog (or alert dialog) that reads `title`.
export const mergeDialog = (page: Page, title: string) => openDialogs(page).filter({ hasText: title });
// The workspace's row in the left sidebar, by its folder (the link's title).
export const workspaceRow = (page: Page, path: string) => page.locator('aside').locator(`[title="${path}"]`).first();
// The named status icon of that row ("Pull request open", "Pull request merged", "Working"…).
export const rowIcon = (page: Page, path: string, name: string) => workspaceRow(page, path).getByRole('img', { name, exact: true });
// The `gh pr merge` arguments of a merge of #7 with `method`, as PR_HEAD read.
export const mergeArgs = (method: MergeMethod) => ['pr', 'merge', '7', MERGE_FLAGS[method], '--match-head-commit', PR_HEAD];

// Picks `method` in the "Merge method" menu of the bar.
export async function pickMergeMethod(page: Page, method: MergeMethod) {
  await mergeMethodButton(page).click();
  // The menu mounts after the click: count its overlay only once it is there.
  await page.locator('[role^="menuitem"]').first().waitFor();
  const open = await overlayCount(page);
  await page.locator('[role^="menuitem"]').filter({ hasText: MERGE_LABELS[method] }).first().click();
  await untilFewerOverlays(page, open);
  await shipButton(page, MERGE_LABELS[method]).waitFor();
}

// Waits until the sidebar's text (its whitespace folded) satisfies `matches(text, arg)`, which runs in the page,
// and checks it took less than 5 s from the call ("within 5 s").
export async function waitForShipText<A = undefined>(page: Page, matches: (text: string, arg: A) => boolean, arg?: A) {
  const within = startClock();
  const text = await untilPanel(page, (panel) => panel.innerText.replace(/\s+/g, ' '), matches, arg as A, { closed: '' });
  within('the sidebar showed the expected text', 5_000);
  return text;
}

// Waits until the sidebar lists exactly `names` among `names` (the files the test wrote or removed).
// The list is on the Diff tab: the tab selected before is selected again.
export async function expectListed(page: Page, names: string[], expected: string[]) {
  const tab = await selectedTabName(page);
  await selectBarTab(page, 'Diff');
  const listed = await waitForListed(page, names, expected);
  if (tab === 'Pull request') await selectBarTab(page, 'Pull request');
  expect(listed).toEqual(expected);
}

// Opens a session's page and its right bar on the "Pull request" tab.
export async function openShip(page: Page, sessionId: string) {
  await openSessionById(page, sessionId);
  await setChangesOpen(page, true, 'Pull request');
}

// Types `message` in the commit field and presses "Commit".
export async function commitThroughPanel(page: Page, message: string) {
  await commitField(page).fill(message);
  await shipButton(page, 'Commit').click();
}

// The smoke path of the dev server and the packaged app, on a workspace page whose Changes sidebar is
// open with an uncommitted file, in a repository with a local bare `origin`: a pull request the stub
// answers shows in the sidebar, then a commit and a push reach `origin`, then the pull request merges through its dialog.
export async function expectShipSmoke(page: Page, gh: GhFixture, worktree: string, origin: string, branch: string) {
  setGh(gh, {
    list: prJson({ checks: 'pending' }),
    states: { [branch]: 'OPEN' },
    afterMerge: { list: prJson({ state: 'MERGED', checks: 'passing' }), states: { [branch]: 'MERGED' } },
  });
  await setChangesOpen(page, true, 'Pull request');
  await dispatchFocus(page);
  await prLink(page).waitFor();
  await waitForShipText(page, (text) => text.includes('#7 · romain-cll'));

  await commitThroughPanel(page, 'Smoke commit');
  // The section shows the commit to push once the commit succeeded.
  await waitForShipText(page, (text) => /(^|\s)1 commit to push(\s|$)/.test(text));
  expect(gitIn(worktree, 'log', '-1', '--format=%B')).toBe('Smoke commit');
  expect(gitIn(worktree, 'status', '--porcelain')).toBe('');

  await shipButton(page, 'Push').click();
  const head = gitIn(worktree, 'rev-parse', 'HEAD');
  // The button goes once the push finished: `git push --set-upstream` has exited, so `origin` holds the commit and
  // the tracking ref and the upstream are written in the repository's `.git` too, and a caller removing the
  // repository never races it.
  await shipButton(page, 'Push').waitFor({ state: 'detached' });
  expect(remoteRef(origin, branch)).toBe(head);
  expect(gitIn(worktree, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`), 'the tracking ref').toBe(head);
  expect(gitIn(worktree, 'config', '--get', `branch.${branch}.remote`), 'the upstream remote').toBe('origin');
  expect(gitIn(worktree, 'config', '--get', `branch.${branch}.merge`), 'the upstream branch').toBe(`refs/heads/${branch}`);

  // COCKPIT-75: the merge goes through its confirmation dialog, reads the pull request again with no window focus
  // and turns the pill and the sidebar's icon to "Merged".
  await shipButton(page, 'Squash and merge').click();
  const dialog = mergeDialog(page, 'Squash and merge #7 into main?');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Squash and merge', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await waitForShipText(page, (text) => /\bMerged\b/.test(text));
  expect(await shipButton(page, 'Squash and merge').count(), 'no merge row once merged').toBe(0);
  await rowIcon(page, worktree, 'Pull request merged').waitFor();
  expect(mergeRuns(gh)).toEqual([{ cwd: worktree, prompt: '1', args: mergeArgs('squash') }]);
}
