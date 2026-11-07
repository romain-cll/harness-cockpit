import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { connectTo, OTHER_BUILD, registerCleanup, shellOptions } from './helpers';
import { cockpit, makeAgentFixture, makeRepo, startProjectDaemon, startStateDaemon, stateFileIn, stateIn, untilState } from './state-helpers';

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
