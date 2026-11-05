import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { projectColour } from '../src/renderer/components/project-colour';
import { type Session, versionLabel } from './launch';
import {
  afterIpcAnswers,
  addRepository,
  countIpcCalls,
  dispatchFocus,
  gitIn,
  INVOKE_HANDLERS,
  ipcAnswered,
  ipcCalls,
  makeRepo,
  mutedColor,
  openDialogs,
  sidebarLines,
  type TempRepo,
  tokenColor,
  untilAnswered,
  untilFewerOverlays,
  worktreePath,
} from './support/projects';
import {
  addGhFixture,
  addOrigin,
  branchesOfRun,
  type GhAnswers,
  type GhFixture,
  GIT_APP_ENV,
  type GhRun,
  graphqlRuns,
  heaviestWeight,
  iconIn,
  lookOf,
  makeChangesRepo,
  MERGE_LABELS,
  type MergeMethod,
  mergeArgs,
  mergeDialog,
  mergeMethodButton,
  mergeRuns,
  openShip,
  PANEL,
  panelEval,
  panelText,
  pickMergeMethod,
  PR_HEAD,
  PR_URL,
  prJson,
  prDialog,
  prLink,
  rightBar,
  rowIcon,
  selectBarTab,
  selectedTabName,
  setChangesOpen,
  setGh,
  shipButton,
  waitForShipText,
  workspaceRow,
} from './support/right-bar';
import { createWorkspaceWithAgent, expectNoErrors, launchBuiltWith, makeSessionsFixture, reportStatus, type SessionsFixture } from './support/sessions';

// COCKPIT-75: the right bar's Pull request tab (merge, checks, reviews, description) and the pull request
// icons of the sidebar. One launch with the stub `gh` of the fixture; the project `main` has a local bare
// `origin` and five workspaces, `local` has none, `bare` has no workspace.

const STATES_CHANNEL = 'workspaces:pull-request-states';
const MERGE_CHANNEL = 'workspaces:merge-pull-request';

interface Workspace {
  /** The name and the branch: the prompt's slug. */
  name: string;
  id: string;
  path: string;
}

/** What `readRow` finds in the bar, from the label of a check or the login of a reviewer. */
interface RowFacts {
  text: string;
  top: number;
  iconClass: string;
  iconColor: string;
  iconStroke: number;
  iconSize: number;
  name: { whiteSpace: string; textOverflow: string; overflow: string; truncated: boolean; title: string | null; height: number };
  avatar: { size: [number, number]; radius: string; background: string; color: string; weight: number; letter: string } | null;
}

// The row of a check (its name element carries the full name as `title`) or of a reviewer (the element that
// shows the login): the smallest element around it that also holds an icon. Self-contained: it runs in the page.
const readRow = (panel: HTMLElement, { label, byTitle }: { label: string; byTitle: boolean }): RowFacts | null => {
  const leaf = byTitle
    ? [...panel.querySelectorAll<HTMLElement>('[title]')].find((element) => element.getAttribute('title') === label)
    : [...panel.querySelectorAll<HTMLElement>('*')].find((element) => element.children.length === 0 && (element.textContent ?? '').trim() === label);
  if (!leaf) return null;
  let row: HTMLElement = leaf;
  while (row !== panel && row.parentElement && !row.querySelector('svg')) row = row.parentElement;
  const svg = row.querySelector('svg')!;
  const icon = getComputedStyle(svg);
  const style = getComputedStyle(leaf);
  const letter = [...row.querySelectorAll<HTMLElement>('*')].find((element) => element.children.length === 0 && (element.textContent ?? '').trim().toLowerCase() === label[0]!.toLowerCase() && element !== leaf);
  const circle = letter && [letter, letter.parentElement!].find((element) => Math.round(element.getBoundingClientRect().width) === 18);
  return {
    text: row.innerText.replace(/\s+/g, ' ').trim(),
    top: row.getBoundingClientRect().top,
    iconClass: svg.getAttribute('class') ?? '',
    iconColor: icon.color,
    iconStroke: parseFloat(icon.strokeWidth),
    iconSize: svg.getBoundingClientRect().width,
    name: {
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      overflow: style.overflowX,
      truncated: leaf.scrollWidth > leaf.clientWidth,
      title: leaf.getAttribute('title'),
      height: leaf.getBoundingClientRect().height,
    },
    avatar:
      letter && circle && !byTitle
        ? {
            size: [circle.getBoundingClientRect().width, circle.getBoundingClientRect().height],
            radius: getComputedStyle(circle).borderTopLeftRadius,
            background: getComputedStyle(circle).backgroundColor,
            color: getComputedStyle(letter).color,
            weight: parseInt(getComputedStyle(letter).fontWeight, 10),
            letter: (letter.textContent ?? '').trim(),
          }
        : null,
  };
};

// The summary of a section's header ("5 checks · 1 failing", "Changes requested"): the text next to the title.
const readHeader = (panel: HTMLElement, { title }: { title: string }) => {
  const leaves = [...panel.querySelectorAll<HTMLElement>('*')].filter((element) => element.children.length === 0 && (element.textContent ?? '').trim() !== '');
  const heading = leaves.find((element) => (element.textContent ?? '').trim() === title);
  if (!heading) return null;
  for (let node = heading.parentElement; node && node !== panel; node = node.parentElement) {
    const summary = leaves.find((element) => element !== heading && node.contains(element));
    if (summary) return { top: heading.getBoundingClientRect().top, summary: (summary.textContent ?? '').trim(), color: getComputedStyle(summary).color };
  }
  return null;
};

// The height of the box that cuts the leaf showing `text` (the nearest ancestor that clips, the tab panel excepted),
// and whether the leaf sticks out of it. Self-contained.
const readClip = (panel: HTMLElement, { text }: { text: string }) => {
  const leaf = [...panel.querySelectorAll<HTMLElement>('*')].find((element) => element.children.length === 0 && (element.textContent ?? '').includes(text));
  if (!leaf) return { found: false as const };
  for (let node = leaf.parentElement; node && node !== panel; node = node.parentElement) {
    if (node.getAttribute('role') === 'tabpanel') break;
    if (getComputedStyle(node).overflowY !== 'visible') {
      return { found: true as const, height: node.getBoundingClientRect().height, cut: leaf.getBoundingClientRect().bottom > node.getBoundingClientRect().bottom + 1 };
    }
  }
  return { found: true as const, height: null, cut: false };
};

// What the Description section holds, read in the page.
const readDescription = (bar: HTMLElement) => {
  // The tab panel that shows (the other one stays in the page, hidden).
  const panel = [...bar.querySelectorAll<HTMLElement>('[role="tabpanel"]')].find((each) => !each.hasAttribute('hidden') && each.checkVisibility()) ?? bar;
  const texts = (selector: string) => [...panel.querySelectorAll(selector)].map((element) => (element.textContent ?? '').trim());
  const link = [...panel.querySelectorAll('a')].find((anchor) => (anchor.textContent ?? '').includes('docs link'));
  return {
    headings: texts('h1, h2, h3, h4, h5, h6, [role="heading"]').filter((text) => !['Description', 'Commit & push', 'Checks', 'Reviews'].includes(text)),
    items: texts('li'),
    emphasis: texts('em, i'),
    code: texts('code'),
    link: link ? { href: link.getAttribute('href'), text: (link.textContent ?? '').trim() } : null,
    images: panel.querySelectorAll('img').length,
    rawHtml: panel.querySelectorAll('#raw-html, script').length,
    pwned: (window as unknown as { __pwned?: boolean }).__pwned === true,
    text: panel.innerText.replace(/\s+/g, ' '),
  };
};

describe('right bar pull request tab: built app', () => {
  let fx: SessionsFixture;
  let gh: GhFixture;
  let session: Session;
  let main: TempRepo;
  let origin: string;
  let local: TempRepo;
  let bare: TempRepo;
  // Merge, merge row and diff row; merge flow; details; no pull request; a workspace of `main` whose branch is not
  // listed by anything else; a workspace of the repository with no remote.
  const M: Workspace = { name: 'pr-meta', id: '', path: '' };
  const G: Workspace = { name: 'pr-merge', id: '', path: '' };
  const D: Workspace = { name: 'pr-details', id: '', path: '' };
  const E: Workspace = { name: 'pr-empty', id: '', path: '' };
  const N: Workspace = { name: 'pr-local', id: '', path: '' };

  beforeAll(async () => {
    fx = makeSessionsFixture(['claude'], { gitLog: true });
    gh = addGhFixture(fx);
    session = await launchBuiltWith({ ...fx.env(), ...GIT_APP_ENV });
    await session.page.getByText(versionLabel).waitFor();
    await countIpcCalls(session, [STATES_CHANNEL, MERGE_CHANNEL, 'workspaces:pull-request']);

    main = makeChangesRepo('pr-tab');
    origin = addOrigin(main);
    local = makeChangesRepo('pr-no-remote');
    bare = makeRepo('pr-bare');
    for (const repo of [main, local, bare]) await addRepository(session, repo);
    for (const [repo, workspace] of [[main, M], [main, G], [main, D], [main, E], [local, N]] as const) {
      workspace.id = await createWorkspaceWithAgent(session.page, repo, { agent: 'Claude Code', prompt: workspace.name }, 'Claude Code 1');
      workspace.path = worktreePath(session, repo, workspace.name);
    }
    setGh(gh);
  });

  afterAll(async () => {
    try {
      await expectNoErrors(session);
    } finally {
      await session?.close();
      if (fx) rmSync(fx.root, { recursive: true, force: true });
      for (const repo of [main, local, bare]) if (repo) rmSync(repo.parent, { recursive: true, force: true });
    }
  });

  // A failing test must not leave a menu or a dialog that blocks the tests after it.
  afterEach(async () => {
    const { page } = session;
    const overlays = page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
    for (let attempt = 0; attempt < 4; attempt++) {
      const shown = await overlays.count();
      if (shown === 0 || (await page.evaluate(() => !!document.activeElement?.closest('.xterm')))) break;
      await page.keyboard.press('Escape');
      await untilFewerOverlays(page, shown);
    }
  });

  const waitForText = <A = undefined>(matches: (text: string, arg: A) => boolean, arg?: A) => waitForShipText(session.page, matches, arg);

  // Answers the stub gives from now on, the workspace's page on the Pull request tab, and a read of it.
  async function show(workspace: Workspace, answers: GhAnswers = {}) {
    setGh(gh, answers);
    await openShip(session.page, workspace.id);
    await dispatchFocus(session.page);
  }

  // Resolves once every read of the sidebar the page asked for has been answered by the main process.
  async function settle() {
    await afterIpcAnswers(session.page);
    await ipcAnswered(session, STATES_CHANNEL, await ipcCalls(session, STATES_CHANNEL));
  }

  const sortedBranches = (run: GhRun) => branchesOfRun(run).sort();
  const openAnswers = (workspace: Workspace): GhAnswers => ({
    list: prJson(),
    states: { [workspace.name]: 'OPEN' },
    afterMerge: { list: prJson({ state: 'MERGED', checks: 'passing' }), states: { [workspace.name]: 'MERGED' } },
  });

  test('AC1, AC2 — the meta row reads the state pill, "#7 · romain-cll" and the link, without the former checks text; an open pull request has a merge row, a merged or closed one or none has none, and a merged one offers "Delete workspace…"', async () => {
    const { page } = session;
    await show(M, { list: prJson() });
    await prLink(page).waitFor();
    const text = await waitForText((shown) => shown.includes('#7 · romain-cll'));
    expect(text).not.toContain('Checks pending');
    expect(text).not.toContain('#7 · Checks');
    expect(await prLink(page).getAttribute('href')).toBe(PR_URL);
    expect(await page.locator(PANEL).getByText('Open', { exact: true }).count(), 'the state pill').toBe(1);
    expect(await shipButton(page, 'Squash and merge').count()).toBe(1);
    expect(await mergeMethodButton(page).count()).toBe(1);
    expect(await shipButton(page, 'Delete workspace…').count()).toBe(0);
    // No check, review or description: none of their sections.
    for (const section of ['Checks', 'Reviews', 'Description']) expect(text, section).not.toMatch(new RegExp(`\\b${section}\\b`));

    for (const [state, pill] of [['MERGED', 'Merged'], ['CLOSED', 'Closed']] as const) {
      setGh(gh, { list: prJson({ state }) });
      await dispatchFocus(page);
      await waitForText((shown, wanted) => new RegExp(`\\b${wanted}\\b`).test(shown), pill);
      expect(await shipButton(page, 'Squash and merge').count(), `${pill}: no merge button`).toBe(0);
      expect(await mergeMethodButton(page).count(), `${pill}: no merge method button`).toBe(0);
      expect(await shipButton(page, 'Delete workspace…').count(), `${pill}: "Delete workspace…"`).toBe(state === 'MERGED' ? 1 : 0);
    }

    setGh(gh);
    await dispatchFocus(page);
    await shipButton(page, 'Create pull request').waitFor();
    expect(await shipButton(page, 'Squash and merge').count(), 'none: no merge button').toBe(0);
    expect(await mergeMethodButton(page).count(), 'none: no merge method button').toBe(0);
  });

  test('AC3 — "Merge method" offers three methods, the picked one is checked and labels the button, and nothing merges', async () => {
    const { page } = session;
    await show(M, { list: prJson() });
    await shipButton(page, 'Squash and merge').waitFor();
    const items = page.locator('[role^="menuitem"]');
    const checkedOf = async () =>
      Object.fromEntries(
        await Promise.all(
          (Object.values(MERGE_LABELS) as string[]).map(async (label) => [label, await items.filter({ hasText: label }).first().getAttribute('aria-checked')] as const),
        ),
      );

    await mergeMethodButton(page).click();
    expect((await items.allInnerTexts()).map((label) => label.trim()).sort()).toEqual(Object.values(MERGE_LABELS).sort());
    expect(await checkedOf()).toEqual({ 'Squash and merge': 'true', 'Create a merge commit': 'false', 'Rebase and merge': 'false' });
    await page.keyboard.press('Escape');
    await untilFewerOverlays(page, 1);

    await pickMergeMethod(page, 'merge');
    expect(await shipButton(page, 'Squash and merge').count()).toBe(0);
    await mergeMethodButton(page).click();
    expect(await checkedOf()).toEqual({ 'Squash and merge': 'false', 'Create a merge commit': 'true', 'Rebase and merge': 'false' });
    await page.keyboard.press('Escape');
    await untilFewerOverlays(page, 1);

    await pickMergeMethod(page, 'rebase');
    await mergeMethodButton(page).click();
    expect(await checkedOf()).toEqual({ 'Squash and merge': 'false', 'Create a merge commit': 'false', 'Rebase and merge': 'true' });
    await page.keyboard.press('Escape');
    await untilFewerOverlays(page, 1);

    expect(await openDialogs(page).count(), 'picking a method opens no dialog').toBe(0);
    expect(mergeRuns(gh), 'nothing merged').toEqual([]);
  });

  test('AC4, AC5, AC6 — the merge button asks "Squash and merge #7 into main?" and runs nothing until confirmed; unpushed commits are counted; confirming runs gh pr merge with the head read for each method, reads the pull request again with no focus, and turns the pill, the merge row and the sidebar icon', async () => {
    const { page } = session;
    await show(G, openAnswers(G));
    const merge = shipButton(page, 'Squash and merge');
    await merge.waitFor();

    // AC4, AC5 — nothing to push: no line about it. Cancel closes the dialog and runs nothing.
    await merge.click();
    let dialog = mergeDialog(page, 'Squash and merge #7 into main?');
    await dialog.waitFor();
    expect((await dialog.getByRole('button').allInnerTexts()).map((label) => label.trim()).sort()).toEqual(['Cancel', 'Squash and merge']);
    expect(await dialog.innerText()).not.toContain('not pushed');
    expect(mergeRuns(gh), 'the dialog ran nothing').toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    expect(mergeRuns(gh), 'Cancel ran nothing').toEqual([]);

    // AC5 — one local commit, then two.
    gitIn(G.path, 'commit', '--allow-empty', '-m', 'local one');
    await waitForText((shown) => /(^|\s)1 commit to push(\s|$)/.test(shown));
    await merge.click();
    dialog = mergeDialog(page, 'Squash and merge #7 into main?');
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain('1 local commit is not pushed and will not be merged.');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    gitIn(G.path, 'commit', '--allow-empty', '-m', 'local two');
    await waitForText((shown) => /(^|\s)2 commits to push(\s|$)/.test(shown));
    await merge.click();
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain('2 local commits are not pushed and will not be merged.');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    expect(mergeRuns(gh)).toEqual([]);

    // AC6 — confirming merges with the head the bar read, with no window focus afterwards.
    await merge.click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Squash and merge', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await waitForText((shown) => /\bMerged\b/.test(shown));
    expect(await shipButton(page, 'Squash and merge').count(), 'the merge row goes').toBe(0);
    expect(await mergeMethodButton(page).count()).toBe(0);
    expect(await shipButton(page, 'Delete workspace…').count()).toBe(1);
    await rowIcon(page, G.path, 'Pull request merged').waitFor();
    expect(mergeRuns(gh)).toEqual([{ cwd: G.path, prompt: '1', args: mergeArgs('squash') }]);
    expect(PR_HEAD).not.toBe(gitIn(G.path, 'rev-parse', 'HEAD'));

    for (const method of ['merge', 'rebase'] as const) {
      setGh(gh, openAnswers(G));
      await dispatchFocus(page);
      await mergeMethodButton(page).waitFor();
      await pickMergeMethod(page, method);
      await shipButton(page, MERGE_LABELS[method]).click();
      const methodDialog = mergeDialog(page, `${MERGE_LABELS[method]} #7 into main?`);
      await methodDialog.waitFor();
      await methodDialog.getByRole('button', { name: MERGE_LABELS[method], exact: true }).click();
      await methodDialog.waitFor({ state: 'hidden' });
      await waitForText((shown) => /\bMerged\b/.test(shown));
      expect(mergeRuns(gh).at(-1), method).toEqual({ cwd: G.path, prompt: '1', args: mergeArgs(method) });
    }
    expect(mergeRuns(gh)).toHaveLength(3);
  });

  test('AC7 — a merge gh refuses closes the dialog, shows "Could not merge the pull request: <message>" under the merge row, leaves the pull request open and the button usable, and a later attempt clears the message', async () => {
    const { page } = session;
    const refusal = 'X Pull request #7 is not mergeable: the head branch has moved';
    await show(G, { ...openAnswers(G), mergeStderr: `${refusal}\n` });
    const merge = shipButton(page, 'Squash and merge');
    await merge.waitFor();
    const before = mergeRuns(gh).length;

    await merge.click();
    const dialog = mergeDialog(page, 'Squash and merge #7 into main?');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Squash and merge', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const text = await waitForText((shown, wanted) => shown.includes(wanted), `Could not merge the pull request: ${refusal}`);
    expect(mergeRuns(gh)).toHaveLength(before + 1);
    expect(text).not.toMatch(/\bMerged\b/);
    expect(await page.locator(PANEL).getByText('Open', { exact: true }).count(), 'the pull request stays open').toBe(1);
    expect(await merge.isEnabled()).toBe(true);
    const message = await lookOf(page.locator(PANEL).getByText(/^Could not merge the pull request:/));
    expect(message.top, 'the message is under the merge row').toBeGreaterThanOrEqual((await lookOf(merge)).bottom - 1);

    setGh(gh, openAnswers(G));
    await merge.click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Squash and merge', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const merged = await waitForText((shown) => /\bMerged\b/.test(shown));
    expect(merged).not.toContain('Could not merge');
    expect(mergeRuns(gh)).toHaveLength(before + 2);
  });

  test('AC8 — a row reads the files changed and the Diff tab\'s totals (a zero is not shown) with "View diff", which selects the Diff tab; with no change there is no row, and no pull request is needed', async () => {
    const { page } = session;
    const leftovers = ['new.txt'];
    try {
      await show(E);
      await shipButton(page, 'Create pull request').waitFor();
      const none = await panelText(page);
      expect(none).not.toMatch(/files? changed/);
      expect(none).not.toContain('View diff');

      const a = readFileSync(join(E.path, 'a.txt'), 'utf8');
      writeFileSync(join(E.path, 'a.txt'), a.replace(/^line 2$/m, 'line two'));
      const one = await waitForText((shown) => /\b1 file changed\s*\+1\s*−1\s*View diff/.test(shown));
      expect(one).not.toContain('1 files');

      writeFileSync(join(E.path, 'new.txt'), 'alpha\nbeta\n');
      await waitForText((shown) => /\b2 files changed\s*\+3\s*−1\s*View diff/.test(shown));
      // The Diff tab shows the same totals.
      await selectBarTab(page, 'Diff');
      const diffTab = (await panelText(page)).replace(/\s+/g, ' ');
      expect([/\+(\d+)/.exec(diffTab)?.[1], /−(\d+)/.exec(diffTab)?.[1]], 'the totals of the Diff tab').toEqual(['3', '1']);
      await selectBarTab(page, 'Pull request');

      // Only additions: no "−0".
      writeFileSync(join(E.path, 'a.txt'), a);
      const additions = await waitForText((shown) => /\b1 file changed\s*\+2\s*View diff/.test(shown));
      expect(additions).not.toContain('−0');

      await page.locator(PANEL).getByText('View diff').first().click();
      await rightBar(page).getByRole('tab', { name: /^Diff/, selected: true }).waitFor();
      expect(await selectedTabName(page)).toBe('Diff');
    } finally {
      for (const name of leftovers) rmSync(join(E.path, name), { force: true });
      writeFileSync(join(E.path, 'a.txt'), Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join(''));
      setGh(gh);
    }
  });

  test('AC9, AC10, AC11, AC12, AC13 — the checks come failing first with their icons, names, truncation, times and a header summary; the reviews come with avatars, icons and the overall state; the sections follow the diff row and "Commit & push" in order', async () => {
    const { page } = session;
    const longName = `integration-${'y'.repeat(80)}`;
    const check = (name: string, over: object) => ({ __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', ...over });
    const running = new Date(Date.now() - 125_000).toISOString();
    const rollup = [
      check('lint', { startedAt: '2026-11-05T10:00:00Z', completedAt: '2026-11-05T10:00:12Z' }),
      check(longName, { conclusion: 'FAILURE', startedAt: '2026-11-05T10:00:00Z', completedAt: '2026-11-05T10:06:41Z' }),
      check('build', { status: 'IN_PROGRESS', conclusion: '', startedAt: running, completedAt: '0001-01-01T00:00:00Z' }),
      check('odd', { conclusion: 'STALE' }),
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
    ];
    const reviews = [
      { login: 'alice', state: 'CHANGES_REQUESTED' },
      { login: 'bob', state: 'APPROVED' },
      { login: 'carol', state: 'COMMENTED' },
      { login: 'dave', state: 'DISMISSED' },
      { login: 'erin', state: 'PENDING' },
      { login: 'frank', state: 'SOMETHING_NEW' },
    ];
    writeFileSync(join(D.path, 'extra.txt'), 'x\n');
    try {
      await show(D, { list: prJson({ rollup, reviews, decision: 'CHANGES_REQUESTED', body: 'Short description.' }) });
      await waitForText((shown) => shown.includes('5 checks · 1 failing'));
      const bar = page.locator(PANEL);

      // Order of the tab: title block, merge row, diff row, "Commit & push", Checks, Reviews, Description.
      const tops = [
        (await lookOf(bar.getByText('#7 · romain-cll'))).top,
        (await lookOf(bar.getByText('Fix the bug', { exact: true }))).top,
        (await lookOf(shipButton(page, 'Squash and merge'))).top,
        (await lookOf(bar.getByText('View diff').first())).top,
        (await lookOf(bar.getByText('Commit & push', { exact: true }))).top,
        (await lookOf(bar.getByText('Checks', { exact: true }))).top,
        (await lookOf(bar.getByText('Reviews', { exact: true }))).top,
        (await lookOf(bar.getByText('Description', { exact: true }))).top,
      ];
      expect(tops, 'the order of the blocks').toEqual([...tops].sort((x, y) => x - y));
      expect(new Set(tops).size).toBe(tops.length);

      // AC11, AC13 — headers.
      const checksHeader = await panelEval(page, readHeader, { title: 'Checks' });
      expect(checksHeader?.summary).toBe('5 checks · 1 failing');
      expect(checksHeader?.color, 'the summary is muted').toBe(await mutedColor(page));
      const reviewsHeader = await panelEval(page, readHeader, { title: 'Reviews' });
      expect(reviewsHeader?.summary).toBe('Changes requested');
      expect(reviewsHeader?.color).toBe(await tokenColor(page, '--diff-removed-foreground'));

      // AC9, AC10 — each check, in order.
      const names = [`CI / ${longName}`, 'CI / odd', 'CI / build', 'CI / lint', 'ci/legacy'];
      const rows = await Promise.all(names.map((label) => panelEval(page, readRow, { label, byTitle: true })));
      expect(rows.every((row) => row !== null), 'every check is listed, its full name as title').toBe(true);
      const found = rows as RowFacts[];
      expect(found.map((row) => row.top), 'failing, unknown, pending, passing, gh\'s order within a group').toEqual([...found.map((row) => row.top)].sort((x, y) => x - y));
      const expectedIcons = [
        [/lucide-circle-x(\s|$)/, '--status-exited'],
        [/lucide-circle-(help|question-mark)(\s|$)/, '--muted-foreground'],
        [/lucide-circle-dashed(\s|$)/, '--status-working'],
        [/lucide-circle-check(\s|$)/, '--status-ready'],
        [/lucide-circle-check(\s|$)/, '--status-ready'],
      ] as const;
      for (const [index, row] of found.entries()) {
        const [icon, token] = expectedIcons[index]!;
        expect(row.iconClass, names[index]).toMatch(icon);
        expect(row.iconColor, `${names[index]}: ${token}`).toBe(await tokenColor(page, token));
        expect([row.iconSize, row.iconStroke], `${names[index]}: 14 px, stroke 1.25`).toEqual([14, 1.25]);
        expect(row.name.title).toBe(names[index]);
      }
      const rightTexts = found.map((row, index) => row.text.replace(names[index]!, '').trim());
      expect(rightTexts[0]).toBe('6m 41s');
      expect(rightTexts[1], 'unknown: nothing').toBe('');
      expect(rightTexts[2]).toBe('Running · 2m');
      expect(rightTexts[3]).toBe('12s');
      expect(rightTexts[4], 'a status context without times: nothing').toBe('');
      expect(found[0]!.name, 'a long name is cut on one line').toMatchObject({ whiteSpace: 'nowrap', textOverflow: 'ellipsis', truncated: true });
      expect(found[0]!.name.overflow).not.toBe('visible');
      expect(found[0]!.name.height).toBeLessThan(20);

      // AC12 — reviewers: avatar, login, state; a PENDING review is not listed.
      const reviewers = [
        ['alice', 'Changes requested', /lucide-file-diff(\s|$)/, '--status-exited'],
        ['bob', 'Approved', /lucide-circle-check(\s|$)/, '--status-ready'],
        ['carol', 'Commented', /lucide-message-square(\s|$)/, '--muted-foreground'],
        ['dave', 'Dismissed', /lucide-message-square(\s|$)/, '--muted-foreground'],
        ['frank', 'Unknown', /./, '--muted-foreground'],
      ] as const;
      const reviewerRows: RowFacts[] = [];
      for (const [login, state, icon, token] of reviewers) {
        const row = (await panelEval(page, readRow, { label: login, byTitle: false }))!;
        expect(row, login).not.toBeNull();
        reviewerRows.push(row);
        expect(row.text, login).toMatch(new RegExp(`^\\S+ ${login} ${state}$`));
        expect(row.iconClass, login).toMatch(icon);
        expect(row.iconColor, `${login}: ${token}`).toBe(await tokenColor(page, token));
        expect([row.iconSize, row.iconStroke]).toEqual([14, 1.25]);
        expect(row.avatar, `${login}: avatar`).not.toBeNull();
        expect(row.avatar!.size, `${login}: 18 px`).toEqual([18, 18]);
        expect(row.avatar!.letter.toLowerCase()).toBe(login[0]);
        expect(parseFloat(row.avatar!.radius) >= 9 || row.avatar!.radius === '50%', `${login}: round`).toBe(true);
        expect(row.avatar!.background, `${login}: projectColour`).toBe(await tokenColor(page, `--${projectColour(login).replace('bg-', '')}`));
        expect(row.avatar!.color).toBe(await tokenColor(page, '--project-foreground'));
        expect(row.avatar!.weight, 'no weight above 400, the letter included').toBeLessThanOrEqual(400);
      }
      expect(reviewerRows.map((row) => row.top), 'gh\'s order').toEqual([...reviewerRows.map((row) => row.top)].sort((x, y) => x - y));
      expect(await panelEval(page, readRow, { label: 'erin', byTitle: false }), 'a PENDING review is not listed').toBeNull();
      expect(reviewerRows[4]!.iconClass, 'an unknown state is never approved').not.toMatch(/circle-check/);
      expect(await heaviestWeight(rightBar(page)), 'no font weight above 400 in the bar').toBeLessThanOrEqual(400);

      // AC13 — the other decisions.
      for (const [decision, list, summary, token] of [
        ['APPROVED', [{ login: 'bob', state: 'APPROVED' }], 'Approved', '--status-ready'],
        ['REVIEW_REQUIRED', [], 'Review required', '--muted-foreground'],
      ] as const) {
        setGh(gh, { list: prJson({ rollup, reviews: [...list], decision, body: 'Short description.' }) });
        await dispatchFocus(page);
        await untilHeader(summary);
        const header = await panelEval(page, readHeader, { title: 'Reviews' });
        expect(header?.summary).toBe(summary);
        expect(header?.color, `${decision}: ${token}`).toBe(await tokenColor(page, token));
      }
    } finally {
      rmSync(join(D.path, 'extra.txt'), { force: true });
      setGh(gh);
    }

    // The header of Reviews showing `summary`: the text next to the title changed with the new answer.
    async function untilHeader(summary: string) {
      await waitForText((shown, wanted) => shown.includes(`Reviews ${wanted}`), summary);
    }
  });

  test('AC14 — the description renders headings, lists, emphasis, inline code and links, shows raw HTML as nothing executable and an image as its alt text, and a link opens in the system browser', async () => {
    const { page } = session;
    await session.evaluateInMain(`(() => {
      const { shell } = require('electron');
      const opened = (globalThis.__openedExternally = []);
      const stub = async (url) => {
        opened.push(url);
        globalThis.__onOpenedExternally?.();
      };
      shell.openExternal = stub;
      if (shell.openExternal !== stub) throw new Error('shell.openExternal cannot be replaced');
    })()`);
    const body = [
      '# Release notes',
      '',
      '## What changed',
      '',
      '- first item',
      '- second item',
      '',
      'Some *emphasis*, **strong**, `inline code` and a [docs link](https://example.com/docs).',
      '',
      '<b id="raw-html">raw bold</b> <script>window.__pwned = true</script>',
      '',
      '![alt text here](https://evil.example/pixel.png)',
    ].join('\n');
    await show(D, { list: prJson({ body }) });
    await waitForText((shown) => shown.includes('Release notes'));

    const rendered = (await panelEval(page, readDescription, null))!;
    expect(rendered.headings).toEqual(['Release notes', 'What changed']);
    expect(rendered.items).toEqual(['first item', 'second item']);
    expect(rendered.emphasis).toEqual(['emphasis']);
    expect(rendered.code).toEqual(['inline code']);
    expect(rendered.link).toEqual({ href: 'https://example.com/docs', text: 'docs link' });
    expect(rendered.rawHtml, 'raw HTML is not rendered as HTML').toBe(0);
    expect(rendered.pwned).toBe(false);
    expect(rendered.images, 'an image loads nothing').toBe(0);
    expect(rendered.text).toContain('alt text here');
    await expectNoErrors(session);

    const url = page.url();
    await page.locator(PANEL).getByRole('link', { name: 'docs link', exact: true }).click();
    const opened = await session.evaluateInMain<string[]>(`new Promise((resolve) => {
      const done = () => resolve(globalThis.__openedExternally.slice());
      if (globalThis.__openedExternally.length > 0) done();
      else globalThis.__onOpenedExternally = done;
    })`);
    expect(opened).toEqual(['https://example.com/docs']);
    expect(page.url(), 'the window stays on its page').toBe(url);
    await expectNoErrors(session);
  });

  const heightOf = (clip: { found: boolean; height?: number | null } | null) => (clip?.found ? (clip.height ?? null) : undefined);

  test('AC15 — a body taller than 96 px is cut with "Show more", which shows it whole with "Show less" and stays so when the pull request is read again; a shorter body has neither', async () => {
    const { page } = session;
    const paragraphs = (last: string) => [...Array.from({ length: 8 }, (_, index) => `Paragraph ${index + 1}`), last].join('\n\n');
    await show(D, { list: prJson({ body: paragraphs('LAST-PARAGRAPH') }) });
    const more = shipButton(page, 'Show more');
    await more.waitFor();
    const folded = await panelEval(page, readClip, { text: 'LAST-PARAGRAPH' });
    expect(Math.round(heightOf(folded) ?? 0), 'folded to 96 px').toBe(96);
    expect(folded).toMatchObject({ found: true, cut: true });

    await more.click();
    await shipButton(page, 'Show less').waitFor();
    expect(await shipButton(page, 'Show more').count()).toBe(0);
    const unfolded = await panelEval(page, readClip, { text: 'LAST-PARAGRAPH' });
    expect(unfolded).toMatchObject({ found: true, cut: false });
    expect(heightOf(unfolded) === null || heightOf(unfolded)! > 96).toBe(true);

    // A re-read with a changed body keeps it unfolded.
    setGh(gh, { list: prJson({ body: paragraphs('LAST-PARAGRAPH-EDITED') }) });
    await untilAnswered(session, 'workspaces:pull-request', () => dispatchFocus(page));
    await waitForText((shown) => shown.includes('LAST-PARAGRAPH-EDITED'));
    expect(await shipButton(page, 'Show less').count(), 'still unfolded after the re-read').toBe(1);
    expect(await shipButton(page, 'Show more').count()).toBe(0);

    setGh(gh, { list: prJson({ body: 'Just one short line.' }) });
    await dispatchFocus(page);
    await waitForText((shown) => shown.includes('Just one short line.'));
    expect(await shipButton(page, 'Show more').count()).toBe(0);
    expect(await shipButton(page, 'Show less').count()).toBe(0);
  });

  test('AC16 — a workspace row with no session status shows the icon of its branch\'s newest pull request (open, merged, or the muted dashed circle), and a session status shows instead', async () => {
    const { page } = session;
    await setChangesOpen(page, false);
    setGh(gh, { states: { [M.name]: 'OPEN', [G.name]: 'MERGED', [D.name]: 'CLOSED', [E.name]: 'OPEN' } });
    await dispatchFocus(page);
    await rowIcon(page, M.path, 'Pull request open').waitFor();
    await rowIcon(page, G.path, 'Pull request merged').waitFor();
    await rowIcon(page, E.path, 'Pull request open').waitFor();

    const muted = await mutedColor(page);
    const open = await iconIn(rowIcon(page, M.path, 'Pull request open'));
    expect(open.className).toMatch(/lucide-git-pull-request(\s|$)/);
    expect(open.color).toBe(await tokenColor(page, '--status-ready'));
    const merged = await iconIn(rowIcon(page, G.path, 'Pull request merged'));
    expect(merged.className).toMatch(/lucide-git-merge(\s|$)/);
    expect(merged.color).toBe(await tokenColor(page, '--status-merged'));
    for (const [path, label] of [[D.path, 'closed'], [N.path, 'none']] as const) {
      const row = workspaceRow(page, path);
      expect(await row.getByRole('img').count(), `${label}: no named icon`).toBe(0);
      const dashed = await iconIn(row);
      expect(dashed.className, label).toMatch(/lucide-circle-dashed(\s|$)/);
      expect(dashed.color, label).toBe(muted);
    }
    for (const workspace of [M, G]) {
      expect(await lookOf(workspaceRow(page, workspace.path).locator('span.truncate').first()).then((look) => look.color), `${workspace.name}: the name stays muted`).toBe(muted);
    }

    // A session status wins over the pull request.
    await reportStatus(session, E.id, 'working');
    await rowIcon(page, E.path, 'Working').waitFor();
    expect(await rowIcon(page, E.path, 'Pull request open').count()).toBe(0);
    setGh(gh);
  });

  test('AC17, AC18 — one gh api graphql run reads the whole project when it shows, on each focus, when its branches change and after a pull request is created in the app; never because a file changed; a collapsed project, a collapsed Projects section, a hidden sidebar, a project with no workspace and a repository with no remote cost no run', async () => {
    const { page } = session;
    const states = { [M.name]: 'OPEN', [G.name]: 'MERGED', [D.name]: 'CLOSED' };
    const projectBranches = [D.name, E.name, G.name, M.name].sort();
    setGh(gh, { states });
    await setChangesOpen(page, false);
    await settle();

    // When it shows: a reload.
    const start = graphqlRuns(gh).length;
    await page.reload();
    await page.getByText(versionLabel).waitFor();
    await rowIcon(page, M.path, 'Pull request open').waitFor();
    await settle();
    let runs = graphqlRuns(gh).slice(start);
    expect(runs, 'one run for the project, whatever the number of workspaces').toHaveLength(1);
    expect(sortedBranches(runs[0]!)).toEqual(projectBranches);
    // No run for the repository with no remote, nor for the one with no workspace.
    expect(runs.flatMap((run) => branchesOfRun(run))).not.toContain(N.name);

    // Each window focus.
    await untilAnswered(session, STATES_CHANNEL, () => dispatchFocus(page));
    await settle();
    runs = graphqlRuns(gh).slice(start);
    expect(runs).toHaveLength(2);
    expect(sortedBranches(runs[1]!)).toEqual(projectBranches);

    // A file changed in a worktree, the bar watching it: no run.
    await openShip(page, M.id);
    await selectBarTab(page, 'Diff');
    writeFileSync(join(M.path, 'watched.txt'), 'x\n');
    try {
      await waitForShipTextOnDiff('watched.txt');
      await settle();
      expect(graphqlRuns(gh).slice(start), 'a file change reads no state').toHaveLength(2);
    } finally {
      rmSync(join(M.path, 'watched.txt'), { force: true });
    }
    await setChangesOpen(page, false);

    // AC18 — a collapsed project: no run on a focus; showing it again reads.
    const afterFocuses = graphqlRuns(gh).length;
    await page.getByRole('button', { name: `Collapse ${main.name}`, exact: true }).click();
    await dispatchFocus(page);
    await settle();
    expect(graphqlRuns(gh), 'a collapsed project').toHaveLength(afterFocuses);
    await untilAnswered(session, STATES_CHANNEL, () => page.getByRole('button', { name: `Expand ${main.name}`, exact: true }).click());
    await settle();
    expect(graphqlRuns(gh), 'expanding it reads it once').toHaveLength(afterFocuses + 1);

    // A collapsed Projects section.
    const afterExpand = graphqlRuns(gh).length;
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await dispatchFocus(page);
    await settle();
    expect(graphqlRuns(gh), 'a collapsed Projects section').toHaveLength(afterExpand);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await settle();

    // A hidden sidebar.
    const afterSection = graphqlRuns(gh).length;
    await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    await dispatchFocus(page);
    await settle();
    expect(graphqlRuns(gh), 'a hidden sidebar').toHaveLength(afterSection);
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).first().click();
    await settle();

    // The set of branches changes: a new workspace is one more run, carrying its branch.
    setGh(gh, { states: { ...states, 'pr-extra': 'OPEN' } });
    await settle();
    const beforeCreation = graphqlRuns(gh).length;
    const extra: Workspace = { name: 'pr-extra', id: '', path: '' };
    extra.id = await createWorkspaceWithAgent(page, main, { agent: 'Claude Code', prompt: extra.name }, 'Claude Code 1');
    extra.path = worktreePath(session, main, extra.name);
    await rowIcon(page, extra.path, 'Pull request open').waitFor();
    await settle();
    const created = graphqlRuns(gh).slice(beforeCreation);
    expect(created, 'one read when the set of branches changes').toHaveLength(1);
    expect(sortedBranches(created[0]!)).toEqual([...projectBranches, extra.name].sort());

    // A pull request created in the app: one more read.
    setGh(gh, { states: { ...states, 'pr-extra': 'OPEN' }, afterCreate: prJson({ title: 'Extra', checks: 'none' }) });
    gitIn(extra.path, 'commit', '--allow-empty', '-m', 'extra work');
    gitIn(extra.path, 'push', '--quiet', '--set-upstream', 'origin', extra.name);
    await openShip(page, extra.id);
    await dispatchFocus(page);
    const create = shipButton(page, 'Create pull request');
    await create.and(page.locator('button:enabled')).waitFor();
    await settle();
    const beforePullRequest = graphqlRuns(gh).length;
    await create.click();
    const dialog = prDialog(page);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await prLink(page).waitFor();
    await settle();
    expect(graphqlRuns(gh), 'a pull request created in the app reads the states once').toHaveLength(beforePullRequest + 1);
    // AC18 — never a run for the repository with no remote nor for the one with no workspace.
    expect(graphqlRuns(gh).flatMap((run) => branchesOfRun(run))).not.toContain(N.name);
    expect(graphqlRuns(gh).filter((run) => run.cwd.startsWith(bare.parent) || run.cwd.startsWith(local.parent) || run.cwd.includes(`/${local.name}-`))).toEqual([]);
    setGh(gh);

    // The wait for the Diff tab to list the file the test wrote, then nothing else.
    async function waitForShipTextOnDiff(name: string) {
      await page.locator(PANEL).getByText(name, { exact: true }).first().waitFor();
    }
  });

  test('AC19 — gh missing, logged out or failing leaves the rows as they were and shows or logs no error', async () => {
    const { page } = session;
    await setChangesOpen(page, false);
    setGh(gh, { states: { [M.name]: 'OPEN', [G.name]: 'MERGED' } });
    await dispatchFocus(page);
    await rowIcon(page, M.path, 'Pull request open').waitFor();
    await rowIcon(page, G.path, 'Pull request merged').waitFor();
    const lines = await sidebarLines(page);

    const expectRowsKept = async (label: string) => {
      await dispatchFocus(page);
      await settle();
      expect(await rowIcon(page, M.path, 'Pull request open').count(), `${label}: open`).toBe(1);
      expect(await rowIcon(page, G.path, 'Pull request merged').count(), `${label}: merged`).toBe(1);
      expect(await sidebarLines(page), `${label}: nothing new in the sidebar`).toEqual(lines);
      expect(session.output(), `${label}: nothing logged`).not.toMatch(/boom|authentication required|Error occurred in handler/);
    };

    setGh(gh, { code: 1, stderr: 'boom\n', states: { [M.name]: 'MERGED' } });
    await expectRowsKept('failing');
    setGh(gh, { code: 4, stderr: 'authentication required\n', states: { [M.name]: 'MERGED' } });
    await expectRowsKept('logged out');
    const stub = join(fx.bin, 'gh');
    renameSync(stub, `${stub}.away`);
    try {
      setGh(gh, { states: { [M.name]: 'MERGED' } });
      await expectRowsKept('missing');
    } finally {
      renameSync(`${stub}.away`, stub);
    }

    // gh answers again: the rows follow it.
    setGh(gh, { states: { [M.name]: 'MERGED', [G.name]: 'OPEN' } });
    await dispatchFocus(page);
    await rowIcon(page, M.path, 'Pull request merged').waitFor();
    await rowIcon(page, G.path, 'Pull request open').waitFor();
    await expectNoErrors(session);
    setGh(gh);
  });

  test('AC20 — the merge call refuses another origin, an unknown project, a path that is no linked worktree, a detached HEAD and a method outside the three, running no gh; the states call refuses an unknown project and another origin', async () => {
    const { page } = session;
    await setChangesOpen(page, false);
    setGh(gh);
    const linked = join(main.parent, 'wt-api');
    const detached = join(main.parent, 'wt-api-detached');
    const elsewhere = join(main.parent, 'not-a-worktree');
    gitIn(main.root, 'worktree', 'add', '--quiet', '-b', 'pr-api', linked, 'main');
    gitIn(main.root, 'worktree', 'add', '--quiet', '--detach', detached, 'main');
    mkdirSync(elsewhere);

    const api = (method: string, args: unknown[]) =>
      page.evaluate(
        ([method, args]) =>
          (window as unknown as { api: { workspaces: Record<string, (...args: unknown[]) => Promise<unknown>> } }).api.workspaces[method as string]!(...(args as unknown[])),
        [method, args] as const,
      );
    await settle();
    const mergesBefore = mergeRuns(gh).length;
    const graphqlBefore = graphqlRuns(gh).length;

    const refusals = [
      ['an unknown project', ['/no/such/project', linked, 7, 'squash', PR_HEAD]],
      ['a path that is no worktree', [main.root, elsewhere, 7, 'squash', PR_HEAD]],
      ['the main working tree', [main.root, main.root, 7, 'squash', PR_HEAD]],
      ['a detached HEAD', [main.root, detached, 7, 'squash', PR_HEAD]],
      ['a method outside the three', [main.root, linked, 7, 'fast-forward', PR_HEAD]],
      ['another method outside the three', [main.root, linked, 7, '--admin', PR_HEAD]],
    ] as const;
    for (const [label, args] of refusals) {
      expect(await api('mergePullRequest', [...args]), label).toMatchObject({ status: 'refused', message: expect.any(String) });
    }
    expect(await api('pullRequestStates', ['/no/such/project']), 'states: unknown project').toMatchObject({ status: 'refused', message: expect.any(String) });
    expect(mergeRuns(gh), 'no gh pr merge ran').toHaveLength(mergesBefore);
    expect(graphqlRuns(gh), 'no gh api graphql ran').toHaveLength(graphqlBefore);

    // From another origin the handlers reject.
    const origins = await session.evaluateInMain<Record<string, string>>(`(async () => {
      const handlers = ${INVOKE_HANDLERS};
      const calls = {
        '${MERGE_CHANNEL}': [${JSON.stringify(main.root)}, ${JSON.stringify(linked)}, 7, 'squash', ${JSON.stringify(PR_HEAD)}],
        '${STATES_CHANNEL}': [${JSON.stringify(main.root)}],
      };
      const results = {};
      for (const [channel, args] of Object.entries(calls)) {
        const handler = handlers.get(channel);
        if (!handler) { results[channel] = 'no handler'; continue; }
        try {
          await handler({ senderFrame: { url: 'https://example.com/' }, sender: null }, ...args);
          results[channel] = 'resolved';
        } catch {
          results[channel] = 'rejected';
        }
      }
      return results;
    })()`);
    expect(origins).toEqual({ [MERGE_CHANNEL]: 'rejected', [STATES_CHANNEL]: 'rejected' });
    expect(mergeRuns(gh)).toHaveLength(mergesBefore);
    expect(graphqlRuns(gh)).toHaveLength(graphqlBefore);
  });
});
