import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Locator, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { baseSelect, closePopups, createButton, itemTexts, norm, projectSelect, promptBox, textOf, urlIn, useAgent, waitForBase, waitForNewSession } from './composer';
import { fifo, gonePipe, launchSpawned, type Session, untilRead, versionLabel } from './launch';
import { makeTestDir } from './run-root';
import {
  addProject,
  afterIpcAnswers,
  choose,
  chooseLocation,
  cloneButton,
  cloneDialog,
  countIpcCalls,
  createDialog,
  entryTitles,
  gitIn,
  ipcAnswered,
  ipcCalls,
  makePlainFolder,
  makeRepo,
  nameBox,
  openAddMenu,
  openDialogs,
  pickAddItem,
  pickerCalls,
  pickerOpenedAfter,
  projectsInState,
  readSidebarEntries,
  readSidebarLines,
  sidebarLines,
  stateSnapshot,
  stubPicker,
  submitCreate,
  tokenColor,
  urlBox,
  waitForEntry,
} from './support/projects';
import { closeOverlays, expectNoErrors, launchBuiltWith, makeSessionsFixture, type SessionsFixture, sessionsInState } from './support/sessions';
import { goHome } from './support/terminal';

// COCKPIT-72: the empty state, Open project, Clone from Git, Create new and Update path, in the built app. The
// folder picker is stubbed in the main process; the login shell is a fake one whose environment holds the git
// configuration under test (no identity, or one a test writes), so that the user's own git configuration never
// reaches the app.

const NO_IDENTITY = 'Git needs your name and email to commit. Set user.name and user.email, then try again.';
const BAD_NAME = 'A project name cannot be . or .. or contain /.';
const CARDS: Array<[string, string]> = [
  ['Open project', 'A repository on this Mac'],
  ['Clone from Git', 'From a GitHub or GitLab URL'],
  ['Create new', 'An empty git repository'],
];

// --- Dialogs ------------------------------------------------------------------------------------------------------

const cardOf = (page: Page, title: string) => page.locator('main').locator('button, a, [role="button"]').filter({ hasText: title });

// Everything a dialog shows: its text and the values of its fields (a Location may be a field or text).
const shownIn = (dialog: Locator) =>
  dialog.evaluate((element) => `${(element as HTMLElement).innerText}\n${[...element.querySelectorAll('input')].map((input) => input.value).join('\n')}`);

// Waits for `text` in the dialog and checks that it sits under `field` (and above `next`, the following field), and
// that the field has the border of the `destructive` token.
async function expectErrorUnder(page: Page, dialog: Locator, field: Locator, text: string | RegExp, next?: Locator) {
  const note = dialog.getByText(text).first();
  await note.waitFor();
  const [noteBox, fieldBox] = [await note.boundingBox(), await field.boundingBox()];
  expect(noteBox!.y, `"${text}" is under the field`).toBeGreaterThanOrEqual(fieldBox!.y + fieldBox!.height - 1);
  if (next) expect(noteBox!.y + noteBox!.height, `"${text}" is above the next field`).toBeLessThanOrEqual((await next.boundingBox())!.y + 1);
  expect(await field.evaluate((element) => getComputedStyle(element).borderTopColor), 'the field has a red border').toBe(await tokenColor(page, '--destructive'));
  return note;
}

const hereNow = (page: Page) => page.evaluate(() => location.pathname + location.search);

// --- The app with no project ----------------------------------------------------------------------------------------

describe('new project: built app', () => {
  let fx: SessionsFixture;
  let session: Session;
  let base: string;
  let gitconfig: string;
  // The shell text the fake ssh runs to tell the test it is running and to hold a pipe until it is gone.
  let sshReady: string;
  let sshHold: string;
  // The roots of the projects the tests have added, in order.
  const added: string[] = [];
  let source: ReturnType<typeof makeRepo>;
  const folders: string[] = [];

  const setIdentity = (on: boolean) => writeFileSync(gitconfig, on ? '[user]\n\tname = Tester\n\temail = tester@example.com\n' : '');
  const cloneLines = () => readFileSync(fx.gitLog, 'utf8').split('\n').filter((line) => / clone /.test(line));
  const expectProjects = async () => {
    expect(await entryTitles(session.page)).toEqual(added);
    expect(projectsInState(session.dataDir) ?? []).toEqual(added.map((path) => ({ path })));
  };
  const openClone = async () => {
    await pickAddItem(session.page, 'Clone from Git…');
    const dialog = cloneDialog(session.page);
    await dialog.waitFor();
    return dialog;
  };
  const openCreate = async () => {
    await pickAddItem(session.page, 'Create new…');
    const dialog = createDialog(session.page);
    await dialog.waitFor();
    return dialog;
  };

  beforeAll(async () => {
    fx = makeSessionsFixture([], { gitLog: true });
    base = realpathSync(makeTestDir('n-'));
    source = makeRepo('clone-source');
    gitconfig = join(base, 'gitconfig');
    sshReady = join(base, 'ssh-ready');
    sshHold = join(base, 'ssh-hold.sh');
    const ssh = join(base, 'ssh');
    // A server that never answers: it reports, holds a pipe the test watches, and reads git's stdin until git ends.
    writeFileSync(ssh, `#!/bin/sh\nread ready < '${sshReady}'\n. '${sshHold}'\necho ready > "$ready"\ncat > /dev/null\n`);
    chmodSync(ssh, 0o755);
    setIdentity(false);
    // The fake login shell sources `early` before it prints its environment: git sees no identity unless a test writes
    // one into `gitconfig`, and cannot guess one from the host name (`user.useConfigOnly`).
    writeFileSync(
      join(fx.root, 'early'),
      [
        `export GIT_CONFIG_GLOBAL='${gitconfig}' GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true`,
        'unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL EMAIL',
        `export GIT_SSH_COMMAND='${ssh}'`,
        '',
      ].join('\n'),
    );
    session = await launchBuiltWith(fx.env());
    await session.page.getByText(versionLabel).waitFor();
    // A click that opens the native picker by mistake never opens a real one.
    await stubPicker(session, null);
  });

  afterAll(async () => {
    try {
      if (session) await expectNoErrors(session);
    } finally {
      await session?.close();
      for (const folder of [fx?.root, base, source?.parent, ...folders]) if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await closePopups(session.page);
    await closeOverlays(session.page);
    // A test that failed with the sidebar hidden (AC4) must not take the ones after it down.
    const show = session.page.getByRole('button', { name: 'Show sidebar', exact: true });
    if ((await show.count()) > 0) {
      await show.click();
      await session.page.locator('aside').waitFor();
    }
  });

  test('AC1 — with no project "/" shows "No projects yet", its sentence and the cards Open project, Clone from Git and Create new with their lines, and no composer', async () => {
    const { page } = session;
    await page.getByText('No projects yet', { exact: true }).waitFor();

    expect(new URL(page.url()).pathname).toBe('/');
    expect(norm(await page.locator('main').innerText())).toContain('Add a git repository to run agents in its workspaces.');
    for (const [title, line] of CARDS) {
      const card = cardOf(page, title);
      expect(await card.count(), `the card ${title}`).toBe(1);
      expect(norm(await card.innerText())).toContain(line);
    }
    expect(await promptBox(page).count()).toBe(0);
  });

  test('AC3 — the Projects "+" menu lists "Open project…" (⌘O), "Clone from Git…" and "Create new…"; each item and each card opens the same picker or dialog', async () => {
    const { page } = session;
    const menu = await openAddMenu(page);
    const texts = await itemTexts(menu);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toMatch(/^Open project…/);
    expect(texts[0]).toContain('⌘O');
    expect(texts.slice(1)).toEqual(['Clone from Git…', 'Create new…']);
    await closePopups(page);

    const opens = {
      'Open project': async (from: () => Promise<void>) => {
        await stubPicker(session, null);
        const before = await pickerCalls(session);
        await from();
        await pickerOpenedAfter(session, before);
      },
      'Clone from Git': async (from: () => Promise<void>) => {
        await from();
        await cloneDialog(page).waitFor();
        await page.keyboard.press('Escape');
        await cloneDialog(page).waitFor({ state: 'hidden' });
      },
      'Create new': async (from: () => Promise<void>) => {
        await from();
        await createDialog(page).waitFor();
        await page.keyboard.press('Escape');
        await createDialog(page).waitFor({ state: 'hidden' });
      },
    };
    for (const [title] of CARDS) {
      await opens[title as keyof typeof opens](() => cardOf(page, title).click());
      await opens[title as keyof typeof opens](() => pickAddItem(page, `${title}…` as 'Open project…'));
    }
  });

  test('AC2 — the Sessions "+" opens the composer at /?project=none showing "No project", and a session starts from it', async () => {
    const { page } = session;
    await goHome(page);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await promptBox(page).waitFor();

    expect(new URL(page.url()).pathname).toBe('/');
    expect(new URL(page.url()).searchParams.get('project')).toBe('none');
    expect(await textOf(projectSelect(page))).toBe('No project');

    await useAgent(page, 'Terminal');
    await promptBox(page).fill('start');
    await createButton(page).click();
    const id = await waitForNewSession(page);
    expect(sessionsInState(session.dataDir).map((stored) => stored.id)).toContain(id);
  });

  test('AC4 — ⌘O opens the folder picker with the sidebar hidden and no dialog open, and no picker while the Clone dialog is open', async () => {
    const { page } = session;
    await goHome(page);
    await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    await page.locator('aside').waitFor({ state: 'detached' });
    try {
      await stubPicker(session, null);
      const before = await pickerCalls(session);

      await page.keyboard.press('Meta+o');
      await pickerOpenedAfter(session, before);
    } finally {
      await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
      await page.locator('aside').waitFor();
    }

    const dialog = await openClone();
    await countIpcCalls(session, ['projects:add']);
    const [adds, picked] = [await ipcCalls(session, 'projects:add'), await pickerCalls(session)];

    await page.keyboard.press('Meta+o');
    await afterIpcAnswers(page);

    expect(await pickerCalls(session)).toBe(picked);
    expect(await ipcCalls(session, 'projects:add')).toBe(adds);
    expect(await dialog.isVisible()).toBe(true);
  });

  test('AC8 — the Clone dialog opens with GitHub selected, empty fields and the location ~/projects, and Clone stays disabled until both fields are filled and the name is valid', async () => {
    const dialog = await openClone();

    expect(await dialog.getByRole('tab', { name: 'GitHub', exact: true }).getAttribute('aria-selected')).toBe('true');
    expect(await dialog.getByRole('tab', { name: 'GitLab', exact: true }).getAttribute('aria-selected')).toBe('false');
    expect(await urlBox(dialog).inputValue()).toBe('');
    expect(await nameBox(dialog).inputValue()).toBe('');
    expect(await shownIn(dialog)).toContain('~/projects');
    expect(await cloneButton(dialog).isDisabled(), 'both fields empty').toBe(true);

    await nameBox(dialog).fill('named');
    expect(await cloneButton(dialog).isDisabled(), 'no URL').toBe(true);
    await urlBox(dialog).fill('https://host/a/b');
    expect(await cloneButton(dialog).isDisabled(), 'both filled').toBe(false);
    await nameBox(dialog).fill('');
    expect(await cloneButton(dialog).isDisabled(), 'no name').toBe(true);
    await nameBox(dialog).fill('..');
    expect(await cloneButton(dialog).isDisabled(), 'invalid name').toBe(true);
  });

  test('AC9, AC20 — a hand-edited Project name stays when the URL changes; a name that is ".", ".." or holds "/" disables Clone and Create and shows the message', async () => {
    const dialog = await openClone();
    await urlBox(dialog).fill('https://host/a/n1');
    await nameBox(dialog).fill('mine');
    await urlBox(dialog).fill('https://host/a/n6');
    expect(await nameBox(dialog).inputValue(), 'an edited name stays').toBe('mine');

    for (const name of ['.', '..', 'a/b']) {
      await nameBox(dialog).fill(name);
      await dialog.getByText(BAD_NAME).first().waitFor();
      expect(await cloneButton(dialog).isDisabled(), `Clone with ${name}`).toBe(true);
    }
    await nameBox(dialog).fill('fine');
    await dialog.getByText(BAD_NAME).first().waitFor({ state: 'hidden' });
    expect(await cloneButton(dialog).isDisabled()).toBe(false);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });

    const create = await openCreate();
    for (const name of ['.', '..', 'a/b']) {
      await nameBox(create).fill(name);
      await create.getByText(BAD_NAME).first().waitFor();
      expect(await submitCreate(create).isDisabled(), `Create with ${name}`).toBe(true);
    }
    await nameBox(create).fill('fine');
    await create.getByText(BAD_NAME).first().waitFor({ state: 'hidden' });
    expect(await submitCreate(create).isDisabled()).toBe(false);
  });

  test('AC20 — the main process refuses an invalid or empty name for clone and create with AC20\'s text, runs no git and makes no folder', async () => {
    const { page } = session;
    const location = join(base, 'invalid-names');
    const clones = cloneLines().length;
    const before = stateSnapshot(session.dataDir);
    type Refusal = { status: string; message?: string };
    const answers: Refusal[] = [];
    const names: Array<[string, string]> = [
      ['.', BAD_NAME],
      ['..', BAD_NAME],
      ['a/b', BAD_NAME],
      ['', 'A project name is required.'],
    ];

    for (const [name] of names) {
      answers.push(
        await page.evaluate(
          ([location, name]) =>
            (window as unknown as { api: { projects: { clone(o: object): Promise<Refusal> } } }).api.projects.clone({ url: 'https://example.com/o/r', location, name }),
          [location, name] as const,
        ),
        await page.evaluate(
          ([location, name]) =>
            (window as unknown as { api: { projects: { create(o: object): Promise<Refusal> } } }).api.projects.create({ location, name }),
          [location, name] as const,
        ),
      );
    }

    expect(answers).toEqual(names.flatMap(([, message]) => [{ status: 'refused', message }, { status: 'refused', message }]));
    expect(cloneLines(), 'no git clone ran').toHaveLength(clones);
    expect(existsSync(location), 'no folder appeared').toBe(false);
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    await expectProjects();
  });

  test('AC10 — Choose… shows the picked folder as the location and in the hint, the home folder as ~; a cancelled picker changes nothing', async () => {
    const { page } = session;
    const dialog = await openClone();
    await nameBox(dialog).fill('proj');
    const inHome = join(homedir(), 'cockpit-not-created', 'repos');

    await chooseLocation(session, dialog, inHome, 'Clones into ~/cockpit-not-created/repos/proj');
    expect(await shownIn(dialog)).toContain('~/cockpit-not-created/repos');
    await chooseLocation(session, dialog, homedir(), 'Clones into ~/proj');
    const elsewhere = join(base, 'elsewhere');
    await chooseLocation(session, dialog, elsewhere, `Clones into ${elsewhere}/proj`);

    const shown = await shownIn(dialog);
    await stubPicker(session, null);
    const before = await pickerCalls(session);
    await choose(dialog).click();
    await pickerOpenedAfter(session, before);
    await afterIpcAnswers(page);
    expect(await shownIn(dialog)).toBe(shown);
  });

  test('AC17 — the GitHub and GitLab tabs change the URL placeholder and keep the typed URL, and a URL of another host clones under the GitLab tab', async () => {
    const { page } = session;
    const dialog = await openClone();
    expect(await urlBox(dialog).getAttribute('placeholder')).toBe('https://github.com/owner/repository');

    await urlBox(dialog).fill(source.root);
    await dialog.getByRole('tab', { name: 'GitLab', exact: true }).click();
    expect(await urlBox(dialog).getAttribute('placeholder')).toBe('https://gitlab.com/group/project');
    expect(await urlBox(dialog).inputValue()).toBe(source.root);
    expect(await dialog.getByRole('tab', { name: 'GitLab', exact: true }).getAttribute('aria-selected')).toBe('true');
    await dialog.getByRole('tab', { name: 'GitHub', exact: true }).click();
    expect(await urlBox(dialog).getAttribute('placeholder')).toBe('https://github.com/owner/repository');
    expect(await urlBox(dialog).inputValue()).toBe(source.root);

    // A local path is a host of no provider: it clones under the GitLab tab as under the other.
    await dialog.getByRole('tab', { name: 'GitLab', exact: true }).click();
    const location = join(base, 'gitlab');
    const target = join(location, 'under-gitlab');
    await nameBox(dialog).fill('under-gitlab');
    await chooseLocation(session, dialog, location, `Clones into ${location}/under-gitlab`);
    await cloneButton(dialog).click();
    await dialog.waitFor({ state: 'hidden' });

    await waitForEntry(page, target);
    added.push(target);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    await expectProjects();
  });

  test('AC21 — with no git identity Create keeps the dialog open with its fields and says "Git needs your name and email…" under Project name, adds no project and removes the folder it made, the parents staying', async () => {
    const { page } = session;
    setIdentity(false);
    const dialog = await openCreate();
    const location = join(base, 'c', 'd');
    await nameBox(dialog).fill('no-identity');
    await chooseLocation(session, dialog, location, `Creates ${location}/no-identity and runs git init`);
    const before = stateSnapshot(session.dataDir);

    await submitCreate(dialog).click();
    await expectErrorUnder(page, dialog, nameBox(dialog), NO_IDENTITY);

    expect(await dialog.isVisible()).toBe(true);
    expect(await nameBox(dialog).inputValue()).toBe('no-identity');
    expect(await submitCreate(dialog).isDisabled(), 'Create is enabled again').toBe(false);
    expect(existsSync(join(location, 'no-identity'))).toBe(false);
    expect(existsSync(location), 'the parents it made stay').toBe(true);
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    await expectProjects();
  });

  test('AC6, AC24 — Initialize git repository without an identity keeps the dialog with the same message, leaves no .git and the files; once an identity is set a second click makes one empty commit, lists and stores the project, closes the dialog and offers the branch as base', async () => {
    const { page } = session;
    setIdentity(false);
    const plain = makePlainFolder('to-initialize');
    writeFileSync(join(plain.root, 'notes.txt'), 'keep me\n');
    writeFileSync(join(plain.root, 'draft.md'), '# draft\n');
    const files = readdirSync(plain.root).sort();
    folders.push(plain.parent);
    {
      await addProject(session, plain.root);
      const dialog = openDialogs(page).filter({ hasText: 'This folder is not a git repository' });
      await dialog.waitFor();
      const initialize = dialog.getByRole('button', { name: 'Initialize git repository', exact: true });
      const before = stateSnapshot(session.dataDir);

      await initialize.click();
      await dialog.getByText(NO_IDENTITY).first().waitFor();

      expect(await dialog.isVisible()).toBe(true);
      expect(await initialize.isDisabled(), 'Initialize is enabled again').toBe(false);
      expect(existsSync(join(plain.root, '.git'))).toBe(false);
      expect(readdirSync(plain.root).sort()).toEqual(files);
      expect(readFileSync(join(plain.root, 'notes.txt'), 'utf8')).toBe('keep me\n');
      expect(stateSnapshot(session.dataDir)).toEqual(before);
      await expectProjects();

      setIdentity(true);
      await initialize.click();
      await dialog.waitFor({ state: 'hidden' });

      added.push(plain.root);
      await waitForEntry(page, plain.root);
      await expectProjects();
      expect(gitIn(plain.root, 'rev-list', '--count', 'HEAD')).toBe('1');
      expect(gitIn(plain.root, 'ls-tree', '-r', 'HEAD')).toBe('');
      expect(gitIn(plain.root, 'status', '--porcelain').split('\n').sort()).toEqual(['?? draft.md', '?? notes.txt']);
      expect(readFileSync(join(plain.root, 'draft.md'), 'utf8')).toBe('# draft\n');
      await page.goto(urlIn(page, `/?project=${encodeURIComponent(plain.root)}`));
      await promptBox(page).waitFor();
      await waitForBase(page, gitIn(plain.root, 'symbolic-ref', '--short', 'HEAD'));
      expect(await baseSelect(page).count()).toBe(1);
    }
  });

  test('AC18 — Create shows the hint, makes the folder (parents included) a repository with one empty commit, lists and stores the project, closes the dialog, leaves the page and offers the branch as base', async () => {
    const { page } = session;
    setIdentity(true);
    await goHome(page);
    const dialog = await openCreate();
    const location = join(base, 'e', 'f');
    const target = join(location, 'fresh');
    await nameBox(dialog).fill('fresh');
    await chooseLocation(session, dialog, location, `Creates ${location}/fresh and runs git init`);
    const here = await hereNow(page);

    await submitCreate(dialog).click();
    await dialog.waitFor({ state: 'hidden' });

    added.push(target);
    await waitForEntry(page, target);
    await expectProjects();
    expect(await hereNow(page), 'the page shown does not change').toBe(here);
    expect(gitIn(target, 'rev-parse', '--show-toplevel')).toBe(target);
    expect(gitIn(target, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(gitIn(target, 'ls-tree', '-r', 'HEAD')).toBe('');
    await page.goto(urlIn(page, `/?project=${encodeURIComponent(target)}`));
    await promptBox(page).waitFor();
    await waitForBase(page, gitIn(target, 'symbolic-ref', '--short', 'HEAD'));
  });

  test('AC19 — Create on a folder that exists says "<path> already exists." under Project name and leaves the folder untouched', async () => {
    const { page } = session;
    const dialog = await openCreate();
    const location = join(base, 'e', 'f');
    const target = join(location, 'fresh');
    const content = readdirSync(target).sort();
    await nameBox(dialog).fill('fresh');
    await chooseLocation(session, dialog, location, `Creates ${location}/fresh and runs git init`);

    await submitCreate(dialog).click();
    await expectErrorUnder(page, dialog, nameBox(dialog), `${target} already exists.`);

    expect(await dialog.isVisible()).toBe(true);
    expect(readdirSync(target).sort()).toEqual(content);
    expect(gitIn(target, 'rev-list', '--count', 'HEAD')).toBe('1');
    await expectProjects();
  });

  test('AC29 — Initialize after a failed save: once saving works a second click adds the project, the folder keeps its single empty commit and no message says git cannot use it', async () => {
    const { page } = session;
    setIdentity(true);
    const plain = makePlainFolder('saved-late');
    folders.push(plain.parent);
    const blocker = join(session.dataDir, 'state.json.tmp');
    mkdirSync(blocker);
    await addProject(session, plain.root);
    const dialog = openDialogs(page).filter({ hasText: 'This folder is not a git repository' });
    await dialog.waitFor();
    const initialize = dialog.getByRole('button', { name: 'Initialize git repository', exact: true });
    try {
      await initialize.click();
      await dialog.getByText('Cockpit could not save its data: ').first().waitFor();
      expect(await entryTitles(page)).toEqual(added);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }

    // A refusal ("already has a .git that git cannot use") would keep the dialog open: its closing is the check.
    await initialize.click();
    await dialog.waitFor({ state: 'hidden' });

    added.push(plain.root);
    await waitForEntry(page, plain.root);
    await expectProjects();
    expect(gitIn(plain.root, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  test('AC11 — Clone runs git clone with the login-shell environment into <location>/<name> (parents created), lists and stores the project, closes the dialog and leaves the page', async () => {
    const { page } = session;
    await goHome(page);
    const dialog = await openClone();
    const location = join(base, 'g', 'h');
    const target = join(location, 'cloned');
    await urlBox(dialog).fill(source.root);
    await nameBox(dialog).fill('cloned');
    await chooseLocation(session, dialog, location, `Clones into ${location}/cloned`);
    const here = await hereNow(page);
    const clones = cloneLines().length;

    await cloneButton(dialog).click();
    await dialog.waitFor({ state: 'hidden' });

    added.push(target);
    await waitForEntry(page, target);
    await expectProjects();
    expect(await hereNow(page), 'the page shown does not change').toBe(here);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('hello\n');
    // The wrapper only the fake login shell's PATH holds ran it, with `--` before the URL.
    const lines = cloneLines();
    expect(lines).toHaveLength(clones + 1);
    expect(lines.at(-1)!.endsWith(` clone -- ${source.root} ${target}`)).toBe(true);
  });

  test('AC13 — a location and name that are a project in Cockpit show "<name> is already in Cockpit." under Repository URL with a red border and Clone disabled, without running git; changing the URL, the name or the location clears it', async () => {
    const { page } = session;
    const dialog = await openClone();
    const location = join(base, 'g', 'h');
    const message = 'cloned is already in Cockpit.';
    const clones = cloneLines().length;
    await urlBox(dialog).fill('https://example.com/o/cloned');
    await chooseLocation(session, dialog, location, `Clones into ${location}/cloned`);

    const note = await expectErrorUnder(page, dialog, urlBox(dialog), message, nameBox(dialog));
    expect(await cloneButton(dialog).isDisabled()).toBe(true);
    expect(cloneLines()).toHaveLength(clones);

    // The URL: the name follows it.
    await urlBox(dialog).fill('https://example.com/o/other');
    await note.waitFor({ state: 'hidden' });
    expect(await cloneButton(dialog).isDisabled()).toBe(false);
    await urlBox(dialog).fill('https://example.com/o/cloned');
    await note.waitFor();
    // The name.
    await nameBox(dialog).fill('cloned-2');
    await note.waitFor({ state: 'hidden' });
    await nameBox(dialog).fill('cloned');
    await note.waitFor();
    // The location.
    await chooseLocation(session, dialog, join(base, 'g'), `Clones into ${join(base, 'g')}/cloned`);
    await note.waitFor({ state: 'hidden' });
    expect(cloneLines(), 'git never ran').toHaveLength(clones);
  });

  test('AC14 — a folder that exists and is no project is refused with "<path> already exists." under Repository URL, and left untouched', async () => {
    const { page } = session;
    const location = join(base, 'taken-in');
    const target = join(location, 'taken');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'marker.txt'), 'mine\n');
    const dialog = await openClone();
    await urlBox(dialog).fill(source.root);
    await nameBox(dialog).fill('taken');
    await chooseLocation(session, dialog, location, `Clones into ${location}/taken`);

    await cloneButton(dialog).click();
    await expectErrorUnder(page, dialog, urlBox(dialog), `${target} already exists.`, nameBox(dialog));

    expect(await dialog.isVisible()).toBe(true);
    expect(readdirSync(target)).toEqual(['marker.txt']);
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('mine\n');
    await expectProjects();
  });

  test('AC12 — a clone git refuses keeps the dialog and its fields, shows the failure under Repository URL with a red border, enables Clone again, adds no project and leaves no folder', async () => {
    const { page } = session;
    const dialog = await openClone();
    const location = join(base, 'refused-in');
    await urlBox(dialog).fill(join(base, 'no-such-repository'));
    await nameBox(dialog).fill('refused');
    await chooseLocation(session, dialog, location, `Clones into ${location}/refused`);
    const before = stateSnapshot(session.dataDir);

    await cloneButton(dialog).click();
    await expectErrorUnder(page, dialog, urlBox(dialog), /does not exist/, nameBox(dialog));

    expect(await dialog.isVisible()).toBe(true);
    expect(await urlBox(dialog).inputValue()).toBe(join(base, 'no-such-repository'));
    expect(await nameBox(dialog).inputValue()).toBe('refused');
    expect(await cloneButton(dialog).isDisabled(), 'Clone is enabled again').toBe(false);
    expect(existsSync(join(location, 'refused'))).toBe(false);
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    await expectProjects();
  });

  // The clone is held by a server that never answers (`ssh` above): the test knows it runs from a FIFO and that git
  // is gone from a second one.
  async function holdClone(name: string) {
    const dialog = await openClone();
    const location = join(base, `held-${name}`);
    const target = join(location, 'held');
    const up = fifo();
    const ended = gonePipe();
    writeFileSync(sshReady, `${up.path}\n`);
    writeFileSync(sshHold, `${ended.snippet}\n`);
    await urlBox(dialog).fill('ssh://git@example.invalid/a/held.git');
    expect(await nameBox(dialog).inputValue()).toBe('held');
    await chooseLocation(session, dialog, location, `Clones into ${location}/held`);
    await countIpcCalls(session, ['projects:clone']);
    const calls = await ipcCalls(session, 'projects:clone');
    const before = stateSnapshot(session.dataDir);

    await cloneButton(dialog).click();
    await up.line();

    expect(await dialog.getByRole('button', { name: 'Cloning…', exact: true }).isDisabled()).toBe(true);
    expect(await cloneButton(dialog).count()).toBe(0);
    expect(await urlBox(dialog).isDisabled()).toBe(true);
    expect(await nameBox(dialog).isDisabled()).toBe(true);
    expect(existsSync(target), 'git has made the folder it clones into').toBe(true);
    const settled = async () => {
      await ended.gone;
      await ipcAnswered(session, 'projects:clone', calls + 1);
      expect(existsSync(target), 'the partial folder is gone').toBe(false);
      expect(stateSnapshot(session.dataDir)).toEqual(before);
      await expectProjects();
    };
    return { dialog, settled };
  }

  test.each(['Cancel', 'Escape'] as const)('AC15 — a running clone shows "Cloning…" disabled with its fields disabled; %s ends git, removes the partial folder, adds no project and closes the dialog', async (how) => {
    const { page } = session;
    const { dialog, settled } = await holdClone(how);

    if (how === 'Cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    else await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });

    await settled();
  });

  test('AC15 — a click outside the dialog while cloning leaves it open and the clone running', async () => {
    const { page } = session;
    const { dialog, settled } = await holdClone('backdrop');
    const target = join(base, 'held-backdrop', 'held');

    // The corner of the window is on the backdrop, outside the dialog.
    await page.mouse.click(2, 2);
    await afterIpcAnswers(page);

    expect(await dialog.isVisible(), 'the dialog stays open').toBe(true);
    expect(await dialog.getByRole('button', { name: 'Cloning…', exact: true }).isDisabled()).toBe(true);
    expect(existsSync(target), 'git is still cloning').toBe(true);

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await settled();
  });

  test('AC16 — reloading the page during a clone ends git, removes the partial folder and adds no project', async () => {
    const { page } = session;
    const { settled } = await holdClone('reload');

    await page.reload();
    await page.getByText(versionLabel).waitFor();

    await settled();
  });
});

// --- Update path ----------------------------------------------------------------------------------------------------

describe('update path: built app', () => {
  let session: Session;
  let dataDir: string;
  let moved: ReturnType<typeof makeRepo>;
  let stays: ReturnType<typeof makeRepo>;
  let plain: ReturnType<typeof makePlainFolder>;
  let workspace: string;
  let newRoot: string;

  const updateButton = (page: Page) => page.locator('aside').getByRole('button', { name: 'Update path…', exact: true });
  const projectDialog = (page: Page, text: RegExp | string) => openDialogs(page).filter({ hasText: text });

  beforeAll(async () => {
    moved = makeRepo('moved-before');
    stays = makeRepo('stays-put');
    plain = makePlainFolder('not-a-repository');
    workspace = join(moved.parent, 'feature-ws');
    gitIn(moved.root, 'worktree', 'add', '--quiet', '-b', 'feature', workspace);
    // The repository moves while Cockpit is closed: its folder is gone, and its worktree still points at the old one.
    newRoot = join(moved.parent, 'moved-after');
    renameSync(moved.root, newRoot);
    dataDir = makeTestDir('d-');
    writeFileSync(
      join(dataDir, 'state.json'),
      JSON.stringify({
        version: 1,
        projects: [{ path: moved.root }, { path: stays.root }],
        sessions: [{ id: 'old-session', name: 'Claude Code 1', harness: 'claude-code', directory: workspace, createdAt: '2026-11-05T10:00:00.000Z', project: moved.root }],
      }),
    );
    session = await launchSpawned(createRequire(import.meta.url)('electron') as string, ['.'], true, dataDir);
    await session.page.getByText(versionLabel).waitFor();
    await stubPicker(session, null);
  });

  afterAll(async () => {
    try {
      if (session) await expectNoErrors(session);
    } finally {
      await session?.close();
      rmSync(dataDir, { recursive: true, force: true });
      for (const folder of [moved?.parent, stays?.parent, plain?.parent]) if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  afterEach(() => closeOverlays(session.page));

  test('AC23 — a folder outside a repository, or a repository already in Cockpit, opens a dialog with one OK button; the project stays missing and state.json is unchanged; a cancelled picker changes nothing', async () => {
    const { page } = session;
    await untilRead(page, readSidebarLines, (lines) => lines.includes('Folder not found'));
    await updateButton(page).waitFor();
    const before = stateSnapshot(session.dataDir);

    for (const [pick, text] of [
      [plain.root, /not (in )?a git repository/],
      [stays.root, `${stays.name} is already in Cockpit.`],
    ] as const) {
      await stubPicker(session, pick);
      const picks = await pickerCalls(session);
      await updateButton(page).click();
      await pickerOpenedAfter(session, picks);
      const dialog = projectDialog(page, text);
      await dialog.waitFor();

      expect(await dialog.getByRole('button', { name: 'OK', exact: true }).count()).toBe(1);
      expect(await dialog.getByRole('button', { name: 'Cancel' }).count()).toBe(0);
      expect(stateSnapshot(session.dataDir)).toEqual(before);
      expect(await entryTitles(page)).toContain(moved.root);
      expect(await sidebarLines(page)).toContain('Folder not found');
      await dialog.getByRole('button', { name: 'OK', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }

    await stubPicker(session, null);
    const picks = await pickerCalls(session);
    await updateButton(page).click();
    await pickerOpenedAfter(session, picks);
    await afterIpcAnswers(page);
    expect(await openDialogs(page).count()).toBe(0);
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    expect(await entryTitles(page)).toContain(moved.root);
  });

  test('AC22 — "Update path…" sits under "Remove from Cockpit"; picking the moved repository keeps the project\'s place with the new path and name in the list, state.json and its sessions, clears the warning, lists its workspaces and git works in them', async () => {
    const { page } = session;
    const remove = page.locator('aside').getByRole('button', { name: 'Remove from Cockpit', exact: true });
    const [removeBox, updateBox] = [await remove.boundingBox(), await updateButton(page).boundingBox()];
    expect(updateBox!.y, '"Update path…" is under "Remove from Cockpit"').toBeGreaterThanOrEqual(removeBox!.y + removeBox!.height - 1);

    await stubPicker(session, newRoot);
    const picks = await pickerCalls(session);
    await updateButton(page).click();
    await pickerOpenedAfter(session, picks);
    await waitForEntry(page, newRoot);
    await waitForEntry(page, workspace);

    const titles = await entryTitles(page);
    expect(titles).not.toContain(moved.root);
    expect(titles.indexOf(newRoot), 'the project keeps its place').toBeLessThan(titles.indexOf(stays.root));
    const entries = await page.evaluate(readSidebarEntries);
    expect(entries.find((entry) => entry.title === newRoot)!.text).toContain('moved-after');
    await untilRead(page, readSidebarLines, (lines) => !lines.includes('Folder not found'));
    expect(projectsInState(session.dataDir)).toEqual([{ path: newRoot }, { path: stays.root }]);
    expect(sessionsInState(session.dataDir).map(({ id, project, directory }) => ({ id, project, directory }))).toEqual([
      { id: 'old-session', project: newRoot, directory: workspace },
    ]);
    expect(gitIn(workspace, 'rev-parse', '--show-toplevel')).toBe(workspace);
    const removal = await page.evaluate(
      ([project, path]) =>
        (window as unknown as { api: { workspaces: { removal(project: string, path: string): Promise<{ status: string }> } } }).api.workspaces.removal(project!, path!),
      [newRoot, workspace] as const,
    );
    expect(removal.status, 'the app reads the workspace with git').toBe('read');
  });
});

// --- A .git git refuses to read -------------------------------------------------------------------------------------

describe('initialize over a .git git cannot use: built app', () => {
  let fx: SessionsFixture;
  let session: Session;
  let repo: ReturnType<typeof makeRepo>;

  beforeAll(async () => {
    fx = makeSessionsFixture([]);
    repo = makeRepo('foreign-owner');
    gitIn(repo.root, 'commit', '--allow-empty', '-m', 'second');
    // Through the fake login shell, git takes the folder's `.git` for another user's: it will not read it.
    writeFileSync(join(fx.root, 'early'), 'export GIT_TEST_ASSUME_DIFFERENT_OWNER=1\n');
    session = await launchBuiltWith(fx.env());
    await session.page.getByText(versionLabel).waitFor();
    await stubPicker(session, null);
  });

  afterAll(async () => {
    try {
      if (session) await expectNoErrors(session);
    } finally {
      await session?.close();
      if (fx) rmSync(fx.root, { recursive: true, force: true });
      if (repo) rmSync(repo.parent, { recursive: true, force: true });
    }
  });

  test('AC28 — Initialize leaves the folder as it was, history included, keeps the dialog open with "<path> already has a .git that git cannot use. Nothing was changed." and adds no project', async () => {
    const { page } = session;
    const head = gitIn(repo.root, 'rev-parse', 'HEAD');
    const entries = readdirSync(join(repo.root, '.git')).sort();
    const before = stateSnapshot(session.dataDir);

    await addProject(session, repo.root);
    const dialog = openDialogs(page).filter({ hasText: 'This folder is not a git repository' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Initialize git repository', exact: true }).click();
    await dialog.getByText(`${repo.root} already has a .git that git cannot use. Nothing was changed.`).first().waitFor();

    expect(await dialog.isVisible()).toBe(true);
    expect(await dialog.getByRole('button', { name: 'Initialize git repository', exact: true }).isDisabled(), 'Initialize is enabled again').toBe(false);
    expect(readdirSync(join(repo.root, '.git')).sort()).toEqual(entries);
    expect(gitIn(repo.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(gitIn(repo.root, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(stateSnapshot(session.dataDir)).toEqual(before);
    expect(await entryTitles(page)).toEqual([]);
  });
});

// --- A project whose folder was replaced by a file ------------------------------------------------------------------

describe('a project whose folder is now a file: built app', () => {
  let session: Session;
  let dataDir: string;
  let stays: ReturnType<typeof makeRepo>;
  let replaced: string;

  beforeAll(async () => {
    stays = makeRepo('stays-listed');
    dataDir = makeTestDir('d-');
    replaced = join(dataDir, 'was-a-project');
    writeFileSync(replaced, 'a file now\n');
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, projects: [{ path: replaced }, { path: stays.root }], sessions: [] }));
    session = await launchSpawned(createRequire(import.meta.url)('electron') as string, ['.'], true, dataDir);
    await session.page.getByText(versionLabel).waitFor();
    await stubPicker(session, null);
  });

  afterAll(async () => {
    try {
      if (session) await expectNoErrors(session);
    } finally {
      await session?.close();
      rmSync(dataDir, { recursive: true, force: true });
      if (stays) rmSync(stays.parent, { recursive: true, force: true });
    }
  });

  test('AC30 — the page renders and only that project shows "Folder not found" with "Remove from Cockpit" and "Update path…"', async () => {
    const { page } = session;
    await untilRead(page, readSidebarLines, (lines) => lines.includes('Folder not found'));

    expect(await entryTitles(page)).toEqual([replaced, stays.root]);
    expect((await sidebarLines(page)).filter((line) => line === 'Folder not found')).toHaveLength(1);
    expect(await page.locator('aside').getByRole('button', { name: 'Remove from Cockpit', exact: true }).count()).toBe(1);
    expect(await page.locator('aside').getByRole('button', { name: 'Update path…', exact: true }).count()).toBe(1);
    await page.reload();
    await page.getByText(versionLabel).waitFor();
    await untilRead(page, readSidebarLines, (lines) => lines.includes('Folder not found'));
    expect(await entryTitles(page)).toEqual([replaced, stays.root]);
  });
});
