import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { runDaemon } from '../src/index';
import { BUILD, connectTo, OTHER_BUILD, onCleanup, registerCleanup, shellOptions } from './helpers';
import { cockpit, endDaemonIn, jsonLine, makeAgentFixture, makeRepo, nodeLaunchOf, startProjectDaemon, startStateDaemon, stateFileIn, stateIn, untilState, writeLaunchFile } from './state-helpers';

// COCKPIT-37: the daemon owns `state.json`: what it refuses, what it stores with no app connected. Real
// sockets, git and a stub agent; `state-helpers.ts` lists what is assumed of the API.

registerCleanup();

describe('a daemon of another build', () => {
  test('AC9 — a client that said hello with another build and then sends a state write is refused, and nothing is written to state.json', async () => {
    const fixture = makeAgentFixture();
    const repo = makeRepo();
    const { socket, stateDir } = await startStateDaemon({ fixture, state: { version: 1 } });
    // The daemon keeps running once superseded only while it holds a terminal.
    const owner = await connectTo(socket);
    await owner.client.spawn(shellOptions);
    const other = await connectTo(socket, OTHER_BUILD);
    const before = readFileSync(stateFileIn(stateDir));

    await expect(other.client.call('project-add', { folder: repo.root })).rejects.toThrow('this background service belongs to another build of Cockpit');

    expect(readFileSync(stateFileIn(stateDir)).equals(before)).toBe(true);
    expect(stateIn(stateDir).projects ?? []).toEqual([]);
  });
});

describe('a session of the daemon with no app connected', () => {
  test('AC11 — an agent that exits on its own (exit code 0) leaves its session with open false in state.json', async () => {
    const { stateDir, socket, startAgent, create } = await startProjectDaemon();
    const id = await startAgent(await create('exits'));
    const connection = await connectTo(socket);
    const terminal = (await connection.client.list()).find((entry) => entry.sessionId === id)!;
    expect(stateIn(stateDir).sessions).toEqual([expect.objectContaining({ id, open: true })]);

    await untilState(stateDir, (state) => state.sessions?.[0]?.open === false, async () => connection.client.write(terminal.id, 'quit\n'));

    expect(stateIn(stateDir).sessions).toEqual([expect.objectContaining({ id, open: false })]);
  });

  test('AC11 — an agent a client killed leaves its mark as it is', async () => {
    const { stateDir, socket, startAgent, create } = await startProjectDaemon();
    const id = await startAgent(await create('killed'));
    const connection = await connectTo(socket);
    const terminal = (await connection.client.list()).find((entry) => entry.sessionId === id)!;
    await connection.client.attach(terminal.id);

    connection.client.kill(terminal.id);
    await connection.when(() => connection.exits.length === 1);
    // The daemon has handled the exit once it answers a request sent after it.
    await connection.client.list();

    expect(stateIn(stateDir).sessions).toEqual([expect.objectContaining({ id, open: true })]);
  });

  test('AC12 — a conversation id the session reports is stored in state.json by the daemon', async () => {
    const { home, stateDir, socket, startAgent, create } = await startProjectDaemon();
    const id = await startAgent(await create('reports'));
    expect(stateIn(stateDir).sessions?.[0]?.harnessSessionId).toBeUndefined();

    await untilState(stateDir, (state) => state.sessions?.[0]?.harnessSessionId === 'conversation-1', () =>
      cockpit(['session-id', 'claude-code'], {
        home,
        env: { COCKPIT_SOCKET: socket, COCKPIT_SESSION_ID: id },
        stdin: JSON.stringify({ session_id: 'conversation-1', hook_event_name: 'UserPromptSubmit' }),
      }),
    );

    expect(stateIn(stateDir).sessions).toEqual([expect.objectContaining({ id, harnessSessionId: 'conversation-1' })]);
  });
});

describe('a superseded daemon', () => {
  test('AC14 — a session that exits on its own writes nothing: what the newer build\'s daemon wrote in state.json since stays, and the mark is left for the app\'s relay', async () => {
    const { fixture, repo, home, stateDir, socket, daemon, create, startAgent } = await startProjectDaemon();
    const id = await startAgent(await create('superseded'));
    // A client of another build supersedes the daemon; it keeps the session.
    await connectTo(socket, OTHER_BUILD);
    // The newer build's daemon on the same state.json writes: a second project.
    const second = makeRepo('second');
    const newer = await runDaemon({ home, build: OTHER_BUILD, stateDir, cli: fixture.cli });
    onCleanup(() => newer.close());
    const client = await connectTo(newer.socketPath, OTHER_BUILD);
    await client.client.call('project-add', { folder: second.root });
    expect(stateIn(stateDir).projects?.map(({ path }) => path).sort()).toEqual([repo.root, second.root].sort());

    // The session's agent ends by itself; the superseded daemon closes once its last terminal is gone.
    const connection = await connectTo(socket);
    const terminal = (await connection.client.list()).find((entry) => entry.sessionId === id)!;
    connection.client.write(terminal.id, 'quit\n');
    await daemon.closed;

    const state = stateIn(stateDir);
    expect(state.projects?.map(({ path }) => path).sort()).toEqual([repo.root, second.root].sort());
    expect(state.sessions).toEqual([expect.objectContaining({ id, open: true })]);
  });

  test('AC14 — with no app, a daemon of an older build with a running session, then a CLI command starting the new build\'s daemon and writing: no client says hello to the old one, yet when its session exits on its own state.json keeps the new daemon\'s writes', async () => {
    const { fixture, repo, home, stateDir, socket, daemon, run, create, startAgent } = await startProjectDaemon(OTHER_BUILD);
    const id = await startAgent(await create('older'));
    // The next launch: the launch file names the new build, which the CLI starts on its first command.
    writeLaunchFile(home, nodeLaunchOf(fixture, stateDir, BUILD));
    endDaemonIn(home, BUILD);
    const second = makeRepo('second');

    const added = await run(['project', 'add', second.root]);

    expect(added.exits).toEqual([0]);
    expect(jsonLine(added.out).status).toBe('added');
    expect(stateIn(stateDir).projects?.map(({ path }) => path).sort()).toEqual([repo.root, second.root].sort());

    // The old session's agent ends by itself (this client is of the old daemon's own build: it supersedes nothing).
    // Superseded, its daemon closes once the terminal is gone and writes nothing; not superseded, it writes its stale
    // copy, which is the change waited for.
    const connection = await connectTo(socket, OTHER_BUILD);
    const terminal = (await connection.client.list()).find((entry) => entry.sessionId === id)!;
    const written = untilState(stateDir, (state) => state.sessions?.[0]?.open === false || state.projects?.length === 1);
    connection.client.write(terminal.id, 'quit\n');
    await Promise.race([daemon.closed, written]);

    const state = stateIn(stateDir);
    expect(state.projects?.map(({ path }) => path).sort()).toEqual([repo.root, second.root].sort());
    expect(state.sessions).toEqual([expect.objectContaining({ id, open: true })]);
  });
});
