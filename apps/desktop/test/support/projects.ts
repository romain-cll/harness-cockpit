import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type ElementHandle, type Page } from 'playwright-core';
import { expect } from 'vitest';
import { basePopup, baseSelect, searchBranches } from '../composer';
import { fifo, gonePipe, heldProcess, MAIN_PROCESS_ERROR, type Session, untilIn, untilRead } from '../launch';
import { makeTestDir } from '../run-root';
import { allConsoleErrorsOf, allPageErrorsOf, escapeRegExp, type Pane, type PtyWindow } from './terminal';

// --- Projects helpers --------------------------------------------------------

// A git that ignores the user's configuration, for the repositories the tests
// create.
export const gitTestEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitTestEnv, encoding: 'utf8' }).trim();

export interface TempRepo {
  /** The temporary folder that holds the repository, to remove afterwards. */
  parent: string;
  /** The repository root, as git reports it (macOS `/var` is `/private/var`). */
  root: string;
  /** The name the sidebar shows: the root's basename. */
  name: string;
}

// `<tmp>/<name>` with one commit (`README.md`, `src/main.ts`).
export function makeRepo(name: string): TempRepo {
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'hello\n');
  writeFileSync(join(root, 'src', 'main.ts'), 'export {};\n');
  gitIn(root, 'init', '-b', 'main');
  gitIn(root, 'add', '.');
  gitIn(root, 'commit', '-m', 'initial');
  expect(gitIn(root, 'rev-parse', '--show-toplevel')).toBe(root);
  return { parent, root, name };
}

// A folder that is not inside any git repository.
export function makePlainFolder(name: string): TempRepo {
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  mkdirSync(root);
  return { parent, root, name };
}

// What a removal from Cockpit must leave alone.
export const snapshotRepo = (repo: TempRepo) => ({
  head: gitIn(repo.root, 'rev-parse', 'HEAD'),
  status: gitIn(repo.root, 'status', '--porcelain'),
  readme: readFileSync(join(repo.root, 'README.md'), 'utf8'),
  source: readFileSync(join(repo.root, 'src', 'main.ts'), 'utf8'),
  hasGit: existsSync(join(repo.root, '.git')),
});

export const projectsInState = (dataDir: string): unknown =>
  (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { projects?: unknown }).projects;

export const stateSnapshot = (dataDir: string) => {
  const file = join(dataDir, 'state.json');
  return { content: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs };
};

// Replaces `dialog.showOpenDialog` in the main process with a function that
// answers the folder `pick` (or a cancellation for `null`) and counts its calls.
export const stubPicker = (session: Session, pick: string | null) =>
  session.evaluateInMain(`(() => {
    const { dialog } = require('electron');
    const picker = (globalThis.__pickerCalls ??= { count: 0 });
    const answer = ${JSON.stringify(pick === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [pick] })};
    const stub = async () => {
      picker.count++;
      picker.opened?.(picker.count);
      return answer;
    };
    dialog.showOpenDialog = stub;
    if (dialog.showOpenDialog !== stub) throw new Error('dialog.showOpenDialog cannot be replaced');
    return picker.count;
  })()`);

export const pickerCalls = (session: Session) => session.evaluateInMain<number>('globalThis.__pickerCalls?.count ?? 0');

// Resolves, in the main process, once the picker has been called more than `before` times: at once if it
// already was, else when the stub is called.
export const pickerOpenedAfter = (session: Session, before: number) =>
  session.evaluateInMain<number>(`new Promise((resolve) => {
    const picker = (globalThis.__pickerCalls ??= { count: 0 });
    if (picker.count > ${before}) resolve(picker.count);
    else picker.opened = resolve;
  })`);

// Opens the Projects "+" ("Add project") menu and gives it: "Open project…" (⌘O), "Clone from Git…", "Create new…".
export async function openAddMenu(page: Page) {
  const trigger = page.getByRole('button', { name: 'Add project', exact: true });
  const id = await trigger.getAttribute('id');
  await trigger.click();
  const menu = page.locator(`[role="menu"][aria-labelledby="${id}"]`);
  await menu.waitFor();
  return menu;
}

// Picks an item of the Projects "+" menu.
export async function pickAddItem(page: Page, item: 'Open project…' | 'Clone from Git…' | 'Create new…') {
  const menu = await openAddMenu(page);
  await menu.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click();
}

// Picks "Open project…" in the Projects "+" menu with the picker answering `pick`, and waits until the
// app has opened the picker. What the app does with the answer is the caller's to wait for.
export async function addProject(session: Session, pick: string | null) {
  await stubPicker(session, pick);
  const before = await pickerCalls(session);
  await pickAddItem(session.page, 'Open project…');
  const after = await pickerOpenedAfter(session, before);
  expect(after, 'picking "Open project…" opens the folder picker').toBeGreaterThan(before);
}

// --- Clone and Create dialogs (COCKPIT-72)

export const cloneDialog = (page: Page) => openDialogs(page).filter({ has: page.getByRole('textbox', { name: 'Repository URL' }) });
export const createDialog = (page: Page) =>
  openDialogs(page)
    .filter({ has: page.getByRole('textbox', { name: 'Project name' }) })
    .filter({ hasNot: page.getByRole('textbox', { name: 'Repository URL' }) });
export const urlBox = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('textbox', { name: 'Repository URL' });
export const nameBox = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('textbox', { name: 'Project name' });
export const cloneButton = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('button', { name: 'Clone', exact: true });
export const submitCreate = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('button', { name: 'Create', exact: true });
export const choose = (dialog: ReturnType<Page['locator']>) => dialog.getByRole('button', { name: 'Choose…', exact: true });

// Picks the dialog's location through "Choose…" (the stubbed picker answers `folder`) and waits for its hint, which
// shows the choice once the name is filled.
export async function chooseLocation(session: Session, dialog: ReturnType<Page['locator']>, folder: string, hint: string) {
  await stubPicker(session, folder);
  const before = await pickerCalls(session);
  await choose(dialog).click();
  await pickerOpenedAfter(session, before);
  await dialog.getByText(hint).first().waitFor();
}

export interface SidebarEntry {
  title: string;
  text: string;
}

// The rows of the Projects section (a project, a workspace): the elements that carry a `title` there,
// the outermost one when the title is repeated on nested elements. The status dots of the sessions
// (`role="img"` with a `title`) and the Sessions section's own entries are not rows. Self-contained: it also
// runs in `untilRead`.
export const readSidebarEntries = (): SidebarEntry[] => {
  const section = [...document.querySelectorAll('aside section')].find((candidate) => candidate.querySelector('h2')?.textContent === 'Projects');
  const titled = [...(section?.querySelectorAll('div[title], a[title]') ?? [])] as HTMLElement[];
  return titled
    .filter((element) => !titled.some((other) => other !== element && other.contains(element) && other.title === element.title))
    .map((element) => ({ title: element.title, text: (element.textContent ?? '').trim() }));
};

export const sidebarEntries = (page: Page): Promise<SidebarEntry[]> => page.evaluate(readSidebarEntries);

export const entryTitles = async (page: Page) => (await sidebarEntries(page)).map((entry) => entry.title);

// Waits until the sidebar lists a row titled `title` (a project root or a workspace path).
export const waitForEntry = (page: Page, title: string) =>
  untilRead(page, readSidebarEntries, (entries, title: string) => entries.some((entry) => entry.title === title), title);

// Waits until the sidebar lists no row titled `title`.
export const waitForNoEntry = (page: Page, title: string) =>
  untilRead(page, readSidebarEntries, (entries, title: string) => !entries.some((entry) => entry.title === title), title);

// Waits for exactly these rows.
export async function waitForEntries(page: Page, expected: string[]): Promise<string[]> {
  const entries = await untilRead(
    page,
    readSidebarEntries,
    (found, expected: string[]) => JSON.stringify(found.map((entry) => entry.title)) === JSON.stringify(expected),
    expected,
  );
  return entries.map((entry) => entry.title);
}

// The text lines of the sidebar. Self-contained: it also runs in `untilRead`.
export const readSidebarLines = (): string[] =>
  ((document.querySelector('aside') as HTMLElement | null)?.innerText ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

export const sidebarLines = (page: Page) => page.evaluate(readSidebarLines);

export const REFUSAL = /is already in Cockpit\.$|is not in a git repository\.$/;
export const refusalsShown = async (page: Page) => (await sidebarLines(page)).filter((line) => REFUSAL.test(line));

export const waitForLine = (page: Page, line: string) =>
  untilRead(page, readSidebarLines, (lines, line: string) => lines.includes(line), line);

// Whether the deepest element that shows `text` (or carries `title`) sits
// below the "Projects" header in the sidebar.
export const isBelowProjectsHeader = (page: Page, target: { text: string } | { title: string }) =>
  page.evaluate((target) => {
    const all = [...document.querySelectorAll('aside *')] as HTMLElement[];
    const deepest = (matches: (element: HTMLElement) => boolean) =>
      all.filter(matches).filter((element) => !all.some((other) => other !== element && element.contains(other) && matches(other)))[0];
    const header = deepest((element) => (element.textContent ?? '').trim() === 'Projects');
    const found =
      'title' in target
        ? deepest((element) => element.getAttribute('title') === target.title)
        : deepest((element) => (element.textContent ?? '').trim() === target.text);
    if (!header || !found) return false;
    return found.getBoundingClientRect().top >= header.getBoundingClientRect().bottom - 1;
  }, target);

// The "…" menu trigger of the sidebar entry titled `title` (a project root or a
// workspace path): the nearest ancestor of the entry that holds a menu trigger
// of its own, not counting the triggers of entries nested in it (a project
// holds its workspaces).
export async function menuTriggerOf(page: Page, title: string) {
  const handle = await page.evaluateHandle((title) => {
    const entry = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === title);
    for (let node: Element | null = entry ?? null; node && node.tagName !== 'ASIDE'; node = node.parentElement) {
      const here: Element = node;
      const triggers = [...here.querySelectorAll('button[aria-haspopup="menu"][aria-label^="Actions for"]')].filter((button) => {
        const titled = button.closest('[title]');
        return !titled || titled === here || !here.contains(titled) || titled.getAttribute('title') === title;
      });
      if (triggers.length === 1) return triggers[0]!;
      if (triggers.length > 1) return null;
    }
    return null;
  }, title);
  const trigger = handle.asElement();
  if (!trigger) throw new Error(`no single "…" menu trigger for the sidebar entry titled ${title}`);
  return trigger;
}

// Opens the "…" menu of the sidebar entry titled `title` and waits for its items.
export async function openMenu(page: Page, title: string) {
  await page.getByTitle(title, { exact: true }).first().hover();
  const trigger = await menuTriggerOf(page, title);
  await trigger.click();
  await page.getByRole('menuitem').first().waitFor();
}

// --- Remove project dialog (COCKPIT-68)

export const removeProjectDialog = (page: Page, name: string) => openDialogs(page).filter({ hasText: `Remove ${name}?` });

// Opens the "…" menu of the project entry titled `root`, picks "Remove project…" and waits for its dialog.
export async function startProjectRemoval(page: Page, root: string) {
  await openMenu(page, root);
  await page.getByRole('menuitem', { name: 'Remove project…', exact: true }).click();
  const dialog = removeProjectDialog(page, basename(root));
  await dialog.waitFor();
  return dialog;
}

// Removes the project entry titled `root` through its "…" menu and confirms in the dialog.
export async function removeThroughMenu(page: Page, root: string) {
  const dialog = await startProjectRemoval(page, root);
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

// --- Workspaces helpers ------------------------------------------------------

export const sha8 = (root: string) => createHash('sha256').update(root).digest('hex').slice(0, 8);

// Where the app must create the worktree of `branch` for `repo`:
// `$COCKPIT_HOME/worktrees/<repo basename>-<8 hex>/<branch>`, compared by real
// path (macOS `/var` is `/private/var`; the data folder exists, the rest does not yet).
export const worktreePath = (session: Session, repo: TempRepo, branch: string) =>
  join(realpathSync(session.dataDir), 'h', 'worktrees', `${repo.name}-${sha8(repo.root)}`, branch);

// A repository with `origin` (a clone of `upstream`, which has `develop`,
// `feature/x` and `release/1.0` besides `main`), a local commit on `main` that
// `origin/main` lacks, and the local branches `local-topic` and `topic/nested`.
export interface TempClone extends TempRepo {
  upstream: TempRepo;
}
export function makeClone(name: string): TempClone {
  const upstream = makeRepo(`${name}-upstream`);
  for (const branch of ['develop', 'feature/x', 'release/1.0']) gitIn(upstream.root, 'branch', branch);
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  gitIn(parent, 'clone', '--quiet', upstream.root, root);
  gitIn(root, 'commit', '--allow-empty', '-m', 'local only');
  gitIn(root, 'branch', 'local-topic');
  gitIn(root, 'branch', 'topic/nested');
  expect(gitIn(root, 'rev-parse', '--show-toplevel')).toBe(root);
  return { parent, root, name, upstream };
}

// A repository whose only content is an empty commit.
export function makeLightRepo(name: string): TempRepo {
  const parent = realpathSync(makeTestDir('p-'));
  const root = join(parent, name);
  mkdirSync(root);
  gitIn(root, 'init', '--quiet', '-b', 'main');
  gitIn(root, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
  return { parent, root, name };
}

// The linked worktrees of `repo`, in `git worktree list` order.
export function linkedWorktrees(repo: TempRepo): { path: string; branch: string | null }[] {
  const records = gitIn(repo.root, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean);
  return records.slice(1).map((record) => {
    const lines = record.split('\n');
    return {
      path: lines.find((line) => line.startsWith('worktree '))!.slice('worktree '.length),
      branch: lines.find((line) => line.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? null,
    };
  });
}

export const localBranches = (repo: TempRepo) =>
  gitIn(repo.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

// What a cancelled or refused action must leave alone.
export const gitState = (repo: TempRepo) => ({
  worktrees: gitIn(repo.root, 'worktree', 'list', '--porcelain'),
  branches: localBranches(repo),
  refs: gitIn(repo.root, 'for-each-ref', '--format=%(refname) %(objectname)'),
});

// Adds a repository through the stubbed picker and waits until it is listed.
export async function addRepository(session: Session, repo: TempRepo) {
  await addProject(session, repo.root);
  await waitForEntry(session.page, repo.root);
  expect(await entryTitles(session.page)).toContain(repo.root);
}

// Resolves once the main process has answered everything the page sent before (the replies of one channel come
// in order, and a handler that finished has replied before a later `list` is handled) and the page has rendered
// it: the closing event of a "nothing happened" check after an action whose answer shows nothing.
export const afterRender = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

export const afterIpcAnswers = (page: Page) =>
  page.evaluate(async () => {
    // Two frames first: what the page's last change made it send (an effect's cleanup runs after the paint) is sent
    // before the call below, and so is handled before it.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // `pty:list` is answered from memory: it runs no git or gh.
    await (window as unknown as PtyWindow).api.pty.list();
  });

// The invoke handlers of the main process, by channel, for a script run there. `_invokeHandlers` is a private API
// of Electron's `ipcMain` (a `Map`), the only way to call a handler as another sender or to wrap one: the same
// one `daemon.test.ts` and `workspace-panes.test.ts` use, so an Electron update that renames it breaks all three,
// and this constant is the place of this file to change.
export const INVOKE_HANDLERS = "require('electron').ipcMain._invokeHandlers";

// Counts, in the main process, the calls of the invoke handlers of `channels` (from the first call of this on):
// the lowest level that tells whether an action reached the main process, for a "nothing happened" check.
// The renderer's IPC messages reach the main process in order, so a later answer (`afterIpcAnswers`, or
// `pty:list` when the channel counted is `projects:list`) closes the window in which a call would have come,
// and `ipcAnswered` is the answer of the handler itself.
export const countIpcCalls = (session: Session, channels: string[]) =>
  session.evaluateInMain(`(() => {
    const handlers = ${INVOKE_HANDLERS};
    const calls = (globalThis.__ipcCalls ??= {});
    const watchers = (globalThis.__ipcWatchers ??= []);
    for (const channel of ${JSON.stringify(channels)}) {
      if (calls[channel] !== undefined) continue;
      calls[channel] = [];
      const original = handlers.get(channel);
      handlers.set(channel, (event, ...args) => {
        const call = { args, done: Promise.resolve() };
        calls[channel].push(call);
        try {
          const result = original(event, ...args);
          call.done = Promise.resolve(result).then(() => {}, () => {});
          return result;
        } finally {
          for (const watcher of [...watchers]) watcher();
        }
      });
    }
  })()`);
// The arguments of each call counted so far.
export const ipcCallArgs = (session: Session, channel: string) =>
  session.evaluateInMain<unknown[][]>(`globalThis.__ipcCalls[${JSON.stringify(channel)}].map((call) => call.args)`);
export const ipcCalls = async (session: Session, channel: string) => (await ipcCallArgs(session, channel)).length;
// Resolves, in the main process, once `channel` has been called `count` times in all and every call so far has
// answered (or rejected): the closing event of an action whose handler does the work (git, `open`, a spawn,
// `saveState`) before it answers.
export const ipcAnswered = (session: Session, channel: string, count: number) =>
  session.evaluateInMain(`new Promise((resolve) => {
    const calls = globalThis.__ipcCalls[${JSON.stringify(channel)}];
    const watchers = globalThis.__ipcWatchers;
    const check = () => {
      const at = watchers.indexOf(check);
      if (calls.length < ${count} || at < 0) return;
      watchers.splice(at, 1);
      Promise.all(calls.map((call) => call.done)).then(() => resolve(true));
    };
    watchers.push(check);
    check();
  })`);

// Runs `action` (a click on a menu item) and resolves once the handler of `channel` it called has answered.
export async function untilAnswered(session: Session, channel: string, action: () => Promise<unknown>) {
  await countIpcCalls(session, [channel]);
  const before = await ipcCalls(session, channel);
  await action();
  await ipcAnswered(session, channel, before + 1);
}

// Asks the main process to look again, as it does when the window gains focus.
export const dispatchFocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

export const openDialogs = (page: Page) => page.locator('[role="dialog"], [role="alertdialog"]');

// Dialogs, menus and select popups: what an Escape closes.
export const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
export const overlayCount = (page: Page) => page.locator(OVERLAYS).count();

// Waits until fewer than `open` overlays are in the page: the Escape that closed one has taken effect.
export const untilFewerOverlays = (page: Page, open: number) =>
  untilRead(page, () => document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]').length, (count, open: number) => count < open, open);

// Escape until no dialog is left (a Select popup takes one Escape of its own).
export async function dismissDialogs(page: Page) {
  for (let attempt = 0; attempt < 4 && (await openDialogs(page).count()) > 0; attempt++) {
    const open = await overlayCount(page);
    await page.keyboard.press('Escape');
    await untilFewerOverlays(page, open);
  }
  expect(await openDialogs(page).count()).toBe(0);
}

export const linesOf = async (locator: ReturnType<Page['locator']>) =>
  (await locator.innerText()).split('\n').map((line) => line.trim()).filter(Boolean);

// Waits until the dialog shows a line matching `pattern` that is not one of `except`, and returns those lines.
export async function waitForDialogLine(dialog: ReturnType<Page['locator']>, pattern: RegExp, except: string[] = []) {
  return untilIn(
    (await dialog.elementHandle()) as ElementHandle<HTMLElement>,
    (element, { source, flags, except }: { source: string; flags: string; except: string[] }): string[] =>
      element.innerText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && new RegExp(source, flags).test(line) && !except.includes(line)),
    (found) => found.length > 0,
    { source: pattern.source, flags: pattern.flags, except },
  );
}

// Marks where the console and the main process output stood, so a test can check that
// what it did logged no error (the shared session may hold earlier ones).
export const errorMark = async (session: Session) => ({
  errors: (await allConsoleErrorsOf(session.page)).length,
  output: session.output().length,
});
export const expectNoNewErrors = async (session: Session, mark: { errors: number; output: number }) => {
  expect(await allConsoleErrorsOf(session.page)).toHaveLength(mark.errors);
  expect(await allPageErrorsOf(session.page)).toEqual([]);
  const written = session.output().slice(mark.output);
  expect(written).not.toMatch(MAIN_PROCESS_ERROR);
  expect(written).not.toContain('Error occurred in handler');
};

// --- New workspace composer (COCKPIT-66; the helpers are in ./composer)

// The groups of the base popup ("Local", "Remote") with their branches, read from its lines.
export function baseGroups(lines: string[]) {
  const groups: Record<string, string[]> = {};
  let current: string | undefined;
  for (const line of lines) {
    if (line === 'Local' || line === 'Remote') groups[(current = line)] = [];
    else if (current) groups[current]!.push(line);
  }
  return groups;
}

// Opens the base select, reads its options per group, closes it.
export async function readBaseOptions(page: Page) {
  await baseSelect(page).click();
  await searchBranches(page).waitFor();
  const popup = (await basePopup(page))!;
  await page.keyboard.press('Escape');
  await searchBranches(page).waitFor({ state: 'detached' });
  return baseGroups(popup.lines);
}

// --- Delete workspace dialog

export const deleteDialog = (page: Page, text: string) => openDialogs(page).filter({ hasText: text });

export async function startDeletion(page: Page, path: string) {
  await openMenu(page, path);
  await page.getByRole('menuitem', { name: 'Delete workspace…' }).click();
}

// The dialog's button labelled `label`, found by its text: it may hold a spinner, which would change its name.
export const deleteButton = (dialog: ReturnType<Page['locator']>, label: 'Delete' | 'Delete anyway' = 'Delete') =>
  dialog.locator('button').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) });

// The "Also delete the local branch <branch>" checkbox.
export const branchBox = (dialog: ReturnType<Page['locator']>, branch?: string) =>
  dialog.getByRole('checkbox', { name: `Also delete the local branch${branch === undefined ? '' : ` ${branch}`}` });

// Waits until the dialog's Delete button is enabled: the read it makes at opening (`workspaces:removal`) is answered and shown.
// The wait is on the page, not on the IPC call: a dialog that never reads is a failed assertion, not a hang.
export async function untilDeleteReady(dialog: ReturnType<Page['locator']>) {
  await untilIn(
    (await dialog.elementHandle()) as ElementHandle<HTMLElement>,
    (element): boolean =>
      [...element.querySelectorAll('button')].some(
        (button) => /^\s*Delete\s*$/.test(button.textContent ?? '') && !button.disabled && button.getAttribute('aria-disabled') !== 'true',
      ),
    (ready) => ready,
  );
}

// Opens the Delete dialog of the workspace `name` at `path` and waits until it has read what the workspace holds.
export async function openDeleteDialog(page: Page, path: string, name: string) {
  await startDeletion(page, path);
  const dialog = deleteDialog(page, `Delete ${name}?`);
  await dialog.waitFor();
  await untilDeleteReady(dialog);
  return dialog;
}

// The options of the calls of `workspaces:remove` counted so far (`countIpcCalls`), the third argument of each.
export const removeOptions = async (session: Session) =>
  (await ipcCallArgs(session, 'workspaces:remove')).map((args) => (args[2] ?? {}) as { force?: boolean; deleteBranch?: boolean; forceBranch?: string });

// The color the `muted-foreground` token resolves to, for "muted" lines.
export const mutedColor = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--muted-foreground)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });

// The color a token (`--destructive`, `--status-working`…) resolves to, as `getComputedStyle` writes it.
export const tokenColor = (page: Page, token: string) =>
  page.evaluate((token) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

// What a project whose folder is gone shows (COCKPIT-65 AC11): a `triangle-alert` icon after its name and
// the colours of the icon, of the "Folder not found" line and of the path.
export const missingFolderBlock = (page: Page, path: string, name: string) =>
  page.evaluate(
    ({ path, name }) => {
      const entry = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === path);
      const item = entry?.closest('li');
      const deepest = (text: string) => {
        const all = [...(item?.querySelectorAll('*') ?? [])] as HTMLElement[];
        const matches = all.filter((element) => (element.textContent ?? '').trim() === text);
        return matches.find((element) => !matches.some((other) => other !== element && element.contains(other)));
      };
      const nameElement = deepest(name);
      const icon = item?.querySelector('svg.lucide-triangle-alert');
      const line = deepest('Folder not found');
      const pathElement = deepest(path);
      return {
        icon: !!icon && !!nameElement && icon.getBoundingClientRect().left >= nameElement.getBoundingClientRect().right - 1,
        iconColor: icon ? getComputedStyle(icon).color : null,
        lineColor: line ? getComputedStyle(line).color : null,
        pathColor: pathElement ? getComputedStyle(pathElement).color : null,
      };
    },
    { path, name },
  );

// What `window.api.projects.git()` answers (COCKPIT-65).
export const projectsGit = (page: Page) =>
  page.evaluate(() => (window as unknown as { api: { projects: { git(): Promise<string> } } }).api.projects.git());

// The git alert of the sidebar (COCKPIT-65 AC10), or null when it is not shown: whether it holds a
// `triangle-alert` icon, where it sits against the Terminal link and the Projects header, and its icon's RGB.
// Self-contained: it also runs in `untilRead`.
export const readGitAlert = () => {
    const all = [...document.querySelectorAll('aside *')] as HTMLElement[];
    const deepest = (text: string) => {
      const matches = all.filter((element) => (element.textContent ?? '').trim() === text);
      return matches.find((element) => !matches.some((other) => other !== element && element.contains(other)));
    };
    const title = deepest('Git is not installed');
    const detail = deepest('Projects and workspaces need git 2.36 or later. Install it, then restart Cockpit.');
    if (!title || !detail) return null;
    let box: HTMLElement | null = title;
    while (box && box.tagName !== 'ASIDE' && !(box.contains(detail) && box.querySelector('svg.lucide-triangle-alert'))) box = box.parentElement;
    const terminal = [...document.querySelectorAll('aside a')].find((link) => (link.textContent ?? '').trim() === 'New workspace');
    const projects = [...document.querySelectorAll('aside button')].find((button) => (button.textContent ?? '').trim() === 'Projects');
    const icon = box && box.tagName !== 'ASIDE' ? box.querySelector('svg.lucide-triangle-alert') : null;
    if (!box || !icon || !terminal || !projects) return { icon: false, top: 0, bottom: 0, terminalBottom: 0, projectsTop: 0, iconRgb: [0, 0, 0] };
    const context = document.createElement('canvas').getContext('2d')!;
    context.fillStyle = '#000000';
    context.fillStyle = getComputedStyle(icon).color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    const rect = box.getBoundingClientRect();
    return {
      icon: true,
      top: rect.top,
      bottom: rect.bottom,
      terminalBottom: terminal.getBoundingClientRect().bottom,
      projectsTop: projects.getBoundingClientRect().top,
      iconRgb: [r!, g!, b!],
    };
};
export const gitAlertOf = (page: Page) => page.evaluate(readGitAlert);

// --- Workspace scripts helpers (COCKPIT-32) -----------------------------------

// The repository's `.cockpit/config.json` (a string is written as is, to test an invalid one).
export function writeConfig(repo: TempRepo, config: unknown) {
  mkdirSync(join(repo.root, '.cockpit'), { recursive: true });
  writeFileSync(join(repo.root, '.cockpit', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

// Scripts the configured commands call, kept in the main working tree so a command stays short (the
// terminal echoes it as one row). `$COCKPIT_ROOT_PATH` is set by the app. `waitfor.sh <marker>` runs the
// shell text the test wrote to `<root>/<marker>.sh` (`holdWaiter`: it reports its pid and blocks until the
// test releases it); `record.sh <file>` appends the environment of its run.
// Its trap makes a Ctrl+C always end it by SIGINT, whatever it is blocked in.
export function writeScripts(repo: TempRepo, extra: Record<string, string> = {}) {
  const scripts: Record<string, string> = {
    'waitfor.sh': "trap 'trap - INT; kill -INT $$' INT\n" + '. "$COCKPIT_ROOT_PATH/$1.sh"\n',
    'record.sh':
      'echo "root=$COCKPIT_ROOT_PATH ws=$COCKPIT_WORKSPACE_PATH name=$COCKPIT_WORKSPACE_NAME term=$TERM pwd=$(pwd -P) path=$PATH" >> "$COCKPIT_ROOT_PATH/$1"\n',
    ...extra,
  };
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(repo.root, name), body);
}

// What `record.sh` wrote, one record per run.
export function readRecords(repo: TempRepo, file: string) {
  const path = join(repo.root, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const found = /^root=(.*) ws=(.*) name=(.*) term=(.*) pwd=(.*) path=(.*)$/.exec(line);
      if (!found) throw new Error(`unexpected record: ${line}`);
      const [, root, ws, name, term, pwd, path] = found;
      return { root, ws, name, term, pwd, path };
    });
}

// The pids whose command line matches `pattern` (an extended regular expression).
export function pidsMatching(pattern: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).sort();
  } catch {
    // `pgrep` exits with 1 when nothing matches.
    return [];
  }
}

// The `waitfor.sh <marker>` processes of `repo`: only the script itself has the expanded path in its
// command line (the shells that run the command hold `$COCKPIT_ROOT_PATH` unexpanded).
export const waiters = (repo: TempRepo, marker: string) => pidsMatching(`${escapeRegExp(repo.root)}/waitfor\\.sh ${escapeRegExp(marker)}$`);

// The `waitfor.sh <marker>` the test holds: when the script runs it reports its pid (`pid()`), holds the write
// end of a pipe from which `gone` is known (`watchGone`, at most 3 pending at once: it ties up a thread of
// libuv's pool until the script has run) and blocks until `release()`.
export function holdWaiter(repo: TempRepo, marker: string, { watchGone = false } = {}) {
  const up = fifo();
  const held = heldProcess();
  const ended = watchGone ? gonePipe() : undefined;
  writeFileSync(join(repo.root, `${marker}.sh`), `${ended?.snippet ?? ''}\necho $$ > '${up.path}'\n${held.snippet}\n`);
  return { pid: async () => Number(await up.line()), gone: ended?.gone, release: held.release, close: up.close };
}

// COCKPIT-57: the label a workspace's own row shows while its setup runs (`Setting up`, muted) or
// after it failed (`Setup failed`, destructive); null when the row shows none. The sessions listed
// under the row are not read. `rightGap` is the distance from the label to the row's right edge.
export const readSetupLabel = ({ workspacePath }: { workspacePath: string; text?: string | null }) => {
    const row = [...document.querySelectorAll('aside [title]')].find((element) => element.getAttribute('title') === workspacePath);
    const item = row?.closest('li');
    if (!row || !item) return null;
    const leaves = [...item.querySelectorAll('*')].filter(
      (element) => element.children.length === 0 && !element.closest('a[href*="/sessions/"]') && /^(Setting up|Setup failed)$/.test((element.textContent ?? '').trim()),
    );
    const leaf = leaves[0];
    if (!leaf) return null;
    const box = leaf.getBoundingClientRect();
    return {
      text: (leaf.textContent ?? '').trim(),
      color: getComputedStyle(leaf).color,
      rightGap: item.getBoundingClientRect().right - box.right,
      isRightOfTheName: box.left > row.getBoundingClientRect().left + 20,
    };
  };

export const setupLabel = (page: Page, workspacePath: string) => page.evaluate(readSetupLabel, { workspacePath });

export const waitForSetupLabel = (page: Page, workspacePath: string, text: string | null) =>
  untilRead(page, readSetupLabel, (found, arg: { workspacePath: string; text?: string | null }) => (found?.text ?? null) === arg.text, { workspacePath, text });

// Every `Setup` link of the sidebar: COCKPIT-57 removed the links and the /setup page.
export const setupLinkCount = (page: Page) => page.locator('aside a[href*="/setup"]').count();

// The color the `destructive` token resolves to, for "Setup failed".
export const destructiveColor = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--destructive)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });

// Everything every pty of the page writes from now on, in one string (the page's own listener, so a
// terminal that is gone by the time the test reads it, the dialog's, is read too). Raw: see `plain`.
export const collectPtyData = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __allPtyData?: string; api: { pty: { onData(listener: (id: number, data: string) => void): () => void } } };
    const listening = w.__allPtyData !== undefined;
    w.__allPtyData = '';
    if (listening) return;
    w.api.pty.onData((_id, data) => {
      w.__allPtyData += data;
    });
  });

// eslint-disable-next-line no-control-regex
export const plain = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '').replaceAll('\r', '');
export const collectedPtyData = async (page: Page) => plain(await page.evaluate(() => (window as unknown as { __allPtyData?: string }).__allPtyData ?? ''));

// What `window.api.workspaces.teardown` answers.
export const teardownApi = (page: Page, project: string, path: string) =>
  page.evaluate(
    ([project, path]) =>
      (
        window as unknown as {
          api: {
            workspaces: {
              teardown(project: string, path: string, size: { cols: number; rows: number }): Promise<{ status: string; message?: string }>;
            };
          };
        }
      ).api.workspaces.teardown(project, path, { cols: 80, rows: 24 }),
    [project, path] as const,
  );

// The terminal a dialog shows (the teardown's).
export async function dialogTerminal(page: Page): Promise<Pane> {
  return (await openDialogs(page).locator('.xterm').first().elementHandle()) as Pane;
}
