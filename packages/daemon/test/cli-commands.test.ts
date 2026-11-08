import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { daemonFiles, readTerminals } from '../src/index';
import { BUILD, connectTo, makeHome, registerCleanup, shellOptions } from './helpers';
import {
  branchesOf,
  cockpit,
  endDaemonIn,
  git,
  jsonLine,
  launchOf,
  makeAgentFixture,
  makePlainFolder,
  makeRepo,
  newStateDir,
  nodeLaunchOf,
  runsOf,
  setProcessEnv,
  startProjectDaemon,
  startStateDaemon,
  stateFileIn,
  stateIn,
  untilSessionPrints,
  untilState,
  worktreesOf,
  writeLaunchFile,
} from './state-helpers';

// COCKPIT-37: the `cockpit project|ws|session` commands. `runCli` in this process against a real daemon (its state
// in a folder of its own), real git and a stub agent; `state-helpers.ts` lists what is assumed of the API.

registerCleanup();

const OPEN_COCKPIT = 'Open Cockpit once so the cockpit command can start its background service.';

describe('cockpit project add and list', () => {
  test('AC5 — add <folder> inside a repository prints the root as added (exit 0), a relative folder being resolved against the current directory, and state.json lists it; list prints the projects with their workspaces; a second add of the root is refused (exit 1)', async () => {
    const fixture = makeAgentFixture();
    const repo = makeRepo('added');
    mkdirSync(join(repo.root, 'src'));
    const { home, stateDir } = await startStateDaemon({ fixture });

    const added = await cockpit(['project', 'add', 'src'], { home, cwd: repo.root });
    expect(added.exits).toEqual([0]);
    expect(jsonLine(added.out)).toMatchObject({ status: 'added', project: { path: repo.root } });
    expect(stateIn(stateDir).projects).toEqual([{ path: repo.root }]);

    const listed = await cockpit(['project', 'list'], { home });
    expect(listed.exits).toEqual([0]);
    expect(jsonLine(listed.out)).toEqual([{ path: repo.root, name: 'added', workspaces: [] }]);

    const again = await cockpit(['project', 'add', repo.root], { home });
    expect(again.exits).toEqual([1]);
    expect(jsonLine(again.out)).toEqual({ status: 'refused', message: 'added is already in Cockpit.' });
    expect(stateIn(stateDir).projects).toEqual([{ path: repo.root }]);
  });

  test('AC5 — add <folder> on a folder that is in no repository prints not-a-repository (exit 1) and adds nothing', async () => {
    const fixture = makeAgentFixture();
    const folder = makePlainFolder();
    const { home, stateDir } = await startStateDaemon({ fixture });

    const result = await cockpit(['project', 'add', folder], { home });

    expect(result.exits).toEqual([1]);
    expect(jsonLine(result.out)).toEqual({ status: 'not-a-repository', folder });
    expect(stateIn(stateDir).projects ?? []).toEqual([]);
  });
});

describe('cockpit ws', () => {
  test('AC6 — list --project prints the workspaces of the project, and project list shows them under it', async () => {
    const { repo, run, create } = await startProjectDaemon();
    const one = await create('one');
    const two = await create('two');

    const listed = await run(['ws', 'list', '--project', repo.root]);
    expect(listed.exits).toEqual([0]);
    // The workspaces as an array, or under a `workspaces` key.
    const value = jsonLine(listed.out);
    const workspaces = (Array.isArray(value) ? value : value.workspaces) as Array<{ path: string; branch: string }>;
    expect(workspaces.map(({ path, branch }) => ({ path, branch })).sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      [one, two].map(({ path, branch }) => ({ path, branch })).sort((a, b) => a.path.localeCompare(b.path)),
    );

    const projects = jsonLine((await run(['project', 'list'])).out) as Array<{ path: string; workspaces: Array<{ path: string }> }>;
    expect(projects.map((project) => [project.path, project.workspaces.map(({ path }) => path).sort()])).toEqual([[repo.root, [one.path, two.path].sort()]]);
  });

  test('AC6 — delete --project --workspace runs the repository\'s teardown while the agent still runs, then ends every session and terminal of the workspace (GET /terminals lists none of it), removes a clean worktree (exit 0) and closes the open mark of its sessions in state.json', async () => {
    const { fixture, repo, stateDir, socket, run, create, startAgent } = await startProjectDaemon();
    // The teardown says whether the agent was still running when it ran.
    const config = join(repo.root, '.cockpit');
    mkdirSync(config);
    const teardown = `if kill -0 "$(cat '${fixture.pidFile}')" 2>/dev/null; then echo teardown >> '${fixture.runs}'; else echo teardown-after-the-agent >> '${fixture.runs}'; fi`;
    writeFileSync(join(config, 'config.json'), JSON.stringify({ setup: [], teardown: [teardown] }));
    const workspace = await create('clean');
    const other = await create('other');
    const id = await startAgent(workspace);
    expect(stateIn(stateDir).sessions).toEqual([expect.objectContaining({ id, open: true })]);
    // A shell in each workspace: the deleted one's goes, the other stays.
    const shells = await connectTo(socket);
    await shells.client.spawn({ ...shellOptions, cwd: workspace.path, workspace: workspace.path });
    await shells.client.spawn({ ...shellOptions, cwd: other.path, workspace: other.path });
    expect((await readTerminals(socket)).filter(({ workspace: each }) => each === workspace.path)).toHaveLength(2);

    let removed!: Awaited<ReturnType<typeof run>>;
    await untilState(stateDir, (state) => state.sessions?.[0]?.open === false, async () => {
      removed = await run(['ws', 'delete', '--project', repo.root, '--workspace', workspace.path]);
    });

    expect(removed.exits).toEqual([0]);
    expect(jsonLine(removed.out)).toEqual({ status: 'removed', branchKept: false });
    expect(runsOf(fixture)).toEqual(['agent', 'teardown']);
    expect(existsSync(workspace.path)).toBe(false);
    expect(worktreesOf(repo)).toEqual([other.path]);
    expect(stateIn(stateDir).sessions).toEqual([expect.objectContaining({ id, open: false })]);
    const left = await readTerminals(socket);
    expect(left.filter(({ workspace: each, sessionId }) => each === workspace.path || sessionId === id)).toEqual([]);
    expect(left.filter(({ workspace: each }) => each === other.path)).toHaveLength(1);
  });

  test('AC6 — a dirty worktree without --force prints dirty (exit 1) and stays; with --force it is removed', async () => {
    const { repo, run, create } = await startProjectDaemon();
    const workspace = await create('dirty');
    appendFileSync(join(workspace.path, 'README.md'), 'uncommitted\n');

    const refused = await run(['ws', 'delete', '--project', repo.root, '--workspace', workspace.path]);
    expect(refused.exits).toEqual([1]);
    expect(jsonLine(refused.out)).toEqual({ status: 'dirty' });
    expect(existsSync(workspace.path)).toBe(true);
    expect(worktreesOf(repo)).toEqual([workspace.path]);

    const forced = await run(['ws', 'delete', '--project', repo.root, '--workspace', workspace.path, '--force']);
    expect(forced.exits).toEqual([0]);
    expect(jsonLine(forced.out)).toMatchObject({ status: 'removed' });
    expect(existsSync(workspace.path)).toBe(false);
  });

  test('AC6 — a dirty worktree without --force runs no teardown and ends no session (it answers dirty before touching anything); with --force the teardown runs once and the delete succeeds', async () => {
    const { fixture, repo, socket, run, create, startAgent } = await startProjectDaemon();
    const config = join(repo.root, '.cockpit');
    mkdirSync(config);
    writeFileSync(join(config, 'config.json'), JSON.stringify({ setup: [], teardown: [`echo teardown >> '${fixture.runs}'`] }));
    const workspace = await create('dirty-teardown');
    const id = await startAgent(workspace);
    appendFileSync(join(workspace.path, 'README.md'), 'uncommitted\n');
    expect(runsOf(fixture)).toEqual(['agent']);

    const refused = await run(['ws', 'delete', '--project', repo.root, '--workspace', workspace.path]);
    expect(refused.exits).toEqual([1]);
    expect(jsonLine(refused.out)).toEqual({ status: 'dirty' });
    expect(runsOf(fixture)).toEqual(['agent']);
    expect(existsSync(workspace.path)).toBe(true);
    expect(worktreesOf(repo)).toEqual([workspace.path]);
    expect((await readTerminals(socket)).filter(({ sessionId }) => sessionId === id)).toHaveLength(1);

    const forced = await run(['ws', 'delete', '--project', repo.root, '--workspace', workspace.path, '--force']);
    expect(forced.exits).toEqual([0]);
    expect(jsonLine(forced.out)).toMatchObject({ status: 'removed' });
    expect(runsOf(fixture)).toEqual(['agent', 'teardown']);
    expect(existsSync(workspace.path)).toBe(false);
  });

  test('AC6 — --delete-branch deletes a merged branch and keeps an unmerged one (branchKept); --force-branch <name> deletes an unmerged one', async () => {
    const { repo, run, create } = await startProjectDaemon();
    const merged = await create('merged');
    const unmerged = await create('unmerged');
    const forced = await create('forced');
    for (const { path } of [unmerged, forced]) git(path, 'commit', '--quiet', '--allow-empty', '-m', 'work');
    const remove = (workspace: { path: string }, ...flags: string[]) => run(['ws', 'delete', '--project', repo.root, '--workspace', workspace.path, ...flags]);

    const first = await remove(merged, '--delete-branch');
    expect(first.exits).toEqual([0]);
    expect(jsonLine(first.out)).toEqual({ status: 'removed', branchKept: false });
    expect(branchesOf(repo)).not.toContain('merged');

    const second = await remove(unmerged, '--delete-branch');
    expect(second.exits).toEqual([0]);
    expect(jsonLine(second.out)).toEqual({ status: 'removed', branchKept: true });
    expect(existsSync(unmerged.path)).toBe(false);
    expect(branchesOf(repo)).toContain('unmerged');

    const third = await remove(forced, '--force-branch', 'forced');
    expect(third.exits).toEqual([0]);
    expect(jsonLine(third.out)).toEqual({ status: 'removed', branchKept: false });
    expect(branchesOf(repo)).not.toContain('forced');
  });
});

describe('cockpit session start', () => {
  test('AC4 — prints the started session, state.json holds it open in the workspace, and the stub agent ran there with the prompt as its argument', async () => {
    const { fixture, repo, stateDir, socket, run, create } = await startProjectDaemon();
    const workspace = await create('agent');

    const result = await run(['session', 'start', '--project', repo.root, '--workspace', workspace.path, '--harness', 'claude-code', '--prompt', 'hello']);

    expect(result.exits).toEqual([0]);
    const started = jsonLine(result.out);
    expect(started).toMatchObject({ status: 'started', session: { id: expect.any(String), name: expect.any(String) } });
    expect(stateIn(stateDir).sessions).toEqual([
      expect.objectContaining({ id: started.session.id, name: started.session.name, harness: 'claude-code', project: repo.root, directory: workspace.path, open: true }),
    ]);
    await untilSessionPrints(socket, started.session.id, 'agent-ready');
    const [directory, ...args] = fixture.ran();
    expect(directory).toBe(realpathSync(workspace.path));
    expect(args.at(-1)).toBe('hello');
  });

  test('AC4 — with --setup the repository\'s setup runs before the agent', async () => {
    const { fixture, repo, socket, run, create } = await startProjectDaemon();
    const config = join(repo.root, '.cockpit');
    mkdirSync(config);
    writeFileSync(join(config, 'config.json'), JSON.stringify({ setup: [`echo setup >> '${fixture.runs}'`], teardown: [] }));
    const workspace = await create('with-setup');

    const result = await run(['session', 'start', '--project', repo.root, '--workspace', workspace.path, '--harness', 'claude-code', '--prompt', 'hello', '--setup']);

    expect(result.exits).toEqual([0]);
    await untilSessionPrints(socket, jsonLine(result.out).session.id, 'agent-ready');
    expect(runsOf(fixture)).toEqual(['setup', 'agent']);
    expect(fixture.ran().at(-1)).toBe('hello');
  });
});

describe('cockpit usage and the daemon the CLI needs', () => {
  test.each([
    ['project with no subcommand', ['project']],
    ['project add with no folder', ['project', 'add']],
    ['project list with an extra argument', ['project', 'list', 'extra']],
    ['an unknown project subcommand', ['project', 'frobnicate']],
    ['ws with no subcommand', ['ws']],
    ['ws list with no --project', ['ws', 'list']],
    ['ws create with no --task', ['ws', 'create', '--project', '/p']],
    ['ws create with no --project', ['ws', 'create', '--task', 'fix']],
    ['ws delete with no --workspace', ['ws', 'delete', '--project', '/p']],
    ['ws delete with no --project', ['ws', 'delete', '--workspace', '/w']],
    ['session with no subcommand', ['session']],
    ['session start with no --harness', ['session', 'start', '--project', '/p', '--workspace', '/w']],
    ['session start with an unknown option', ['session', 'start', '--project', '/p', '--workspace', '/w', '--harness', 'claude-code', '--bogus']],
  ])('AC6 — %s: the usage on stderr, exit 2, and nothing started', async (_label, argv) => {
    const home = makeHome();

    const result = await cockpit(argv, { home });

    expect(result.exits).toEqual([2]);
    expect(result.err.startsWith('usage:')).toBe(true);
    for (const line of ['cockpit project', 'cockpit ws', 'cockpit session start']) expect(result.err).toContain(line);
    expect(result.out).toBe('');
    expect(readdirSync(home)).toEqual([]);
  });

  test('AC2 — with no launch file a command that needs the daemon exits 1 with "Open Cockpit once…" on stderr and starts nothing', async () => {
    const home = makeHome();

    const result = await cockpit(['project', 'list'], { home });

    expect(result.exits).toEqual([1]);
    expect(result.err.trimEnd()).toBe(OPEN_COCKPIT);
    expect(result.out).toBe('');
    expect(readdirSync(home)).toEqual([]);
  });

  test('AC13 — a state.json from a newer version: the daemon the CLI starts does not start, its log\'s last line names the file and the version, and the CLI exits 1 with that line on stderr', async () => {
    const fixture = makeAgentFixture();
    const home = makeHome();
    const stateDir = newStateDir();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFileIn(stateDir), JSON.stringify({ version: 99 }));
    const before = readFileSync(stateFileIn(stateDir));
    writeLaunchFile(home, launchOf(fixture, stateDir));

    const result = await cockpit(['project', 'list'], { home });

    expect(result.exits).toEqual([1]);
    const line = readFileSync(daemonFiles(home, 1, BUILD).log, 'utf8').split('\n').findLast((each) => each.trim() !== '')!;
    expect(line).toContain(stateFileIn(stateDir));
    expect(line).toContain('99');
    expect(result.err).toContain(line);
    expect(result.out).toBe('');
    expect(readdirSync(home).filter((name) => /\.(sock|token|pid)$/.test(name))).toEqual([]);
    expect(readFileSync(stateFileIn(stateDir)).equals(before)).toBe(true);
  });
});

describe('cockpit home and the environment of the daemon it starts', () => {
  test('AC16 — with COCKPIT_HOME unset the CLI uses the folder of COCKPIT_SOCKET as its home', async () => {
    const fixture = makeAgentFixture();
    const repo = makeRepo('socket-home');
    const { socket } = await startStateDaemon({ fixture, state: { version: 1, projects: [{ path: repo.root }] } });
    // A home of no Cockpit: the fallback on `~/.cockpit` would find nothing.
    const nowhere = realpathSync(makeHome());
    setProcessEnv({ HOME: nowhere });

    const result = await cockpit(['project', 'list'], { home: undefined, env: { COCKPIT_SOCKET: socket, HOME: nowhere } });

    expect(result.exits).toEqual([0]);
    expect(jsonLine(result.out)).toEqual([{ path: repo.root, name: 'socket-home', workspaces: [] }]);
  });

  test('AC16 — with neither COCKPIT_HOME nor COCKPIT_SOCKET the CLI uses ~/.cockpit', async () => {
    const fixture = makeAgentFixture();
    const repo = makeRepo('default-home');
    const userHome = realpathSync(makeHome());
    // A short build name: the socket path of a home one folder deeper stays under macOS's limit.
    await startStateDaemon({ fixture, state: { version: 1, projects: [{ path: repo.root }] }, home: join(userHome, '.cockpit'), build: 'c1' });
    setProcessEnv({ HOME: userHome });

    const result = await cockpit(['project', 'list'], { home: undefined, env: { HOME: userHome } });

    expect(result.exits).toEqual([0]);
    expect(jsonLine(result.out)).toEqual([{ path: repo.root, name: 'default-home', workspaces: [] }]);
  });

  test('AC15 — a daemon the CLI starts from a shell holding TMUX, VIRTUAL_ENV and Claude Code session variables hands none of them to its sessions, and gives them the login shell\'s variables', async () => {
    const fixture = makeAgentFixture();
    const repo = makeRepo('polluted');
    const home = realpathSync(makeHome());
    const stateDir = newStateDir();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFileIn(stateDir), JSON.stringify({ version: 1, projects: [{ path: repo.root }] }));
    // The CLI starts the daemon from the launch file the app wrote, and the daemon runs the sessions' terminals.
    writeLaunchFile(home, nodeLaunchOf(fixture, stateDir));
    endDaemonIn(home);
    const polluted = { TMUX: '/tmp/tmux-501/default,1234,0', VIRTUAL_ENV: '/somewhere/venv', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' };
    const shell = { SHELL: fixture.shell };
    // The daemon is a child of this process as much as of the CLI: both environments hold the variables.
    setProcessEnv({ ...polluted, ...shell });
    const run = (argv: string[]) => cockpit(argv, { home, env: { ...polluted, ...shell } });

    const created = await run(['ws', 'create', '--project', repo.root, '--task', 'polluted']);
    expect(created.exits).toEqual([0]);
    const started = await run(['session', 'start', '--project', repo.root, '--workspace', jsonLine(created.out).workspace.path, '--harness', 'claude-code', '--prompt', 'hello']);
    expect(started.exits).toEqual([0]);
    await untilSessionPrints(daemonFiles(home, 1, BUILD).socket, jsonLine(started.out).session.id, 'agent-ready');

    const environment = fixture.environment();
    for (const name of Object.keys(polluted)) expect(environment, name).not.toHaveProperty(name);
    expect(environment.LOGIN_SHELL_MARK).toBe('from-login-shell');
  });
});
