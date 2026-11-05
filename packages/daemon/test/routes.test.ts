import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { describe, expect, test } from 'vitest';
import { daemonFiles, runDaemonEntry } from '../src/index';
import { BUILD, type Connection, connectTo, exists, makeHome, OTHER_BUILD, registerCleanup, send, shellOptions, startDaemon } from './helpers';

// COCKPIT-69 AC15: two routes of the daemon's HTTP side that a later app uses to list and end a daemon
// it cannot talk to (another protocol). They are frozen across protocols: `GET /terminals` answers a JSON
// array, one entry per shell or session the daemon runs (the fields of `list`, plus `command`, the program
// the terminal was spawned with, in creation order, no `commands` terminal); `POST /shutdown` answers 202.

registerCleanup();

const tokenOf = (files: { token: string }) => readFileSync(files.token, 'utf8');
const get = (socket: string, authorization?: string) => send(socket, { method: 'GET', path: '/terminals', authorization });
const shutdown = (socket: string, authorization?: string) => send(socket, { method: 'POST', path: '/shutdown', authorization });

async function pidOf(connection: Connection, id: unknown): Promise<number> {
  connection.client.write(id, 'echo pid-$$-end\n');
  await connection.when(() => /pid-\d+-end/.test(connection.output(id)));
  return Number(/pid-(\d+)-end/.exec(connection.output(id))![1]);
}

// Resolves once the process is gone (a zombie counts), on the exit itself: `caffeinate -w` (macOS) waits for any
// process to exit and returns at once for one already gone.
async function processEnded(pid: number): Promise<void> {
  const [code] = await once(spawn('/usr/bin/caffeinate', ['-w', String(pid)], { stdio: 'ignore' }), 'exit');
  expect(code, `caffeinate -w ${pid}`).toBe(0);
}

describe('GET /terminals', () => {
  test('AC15 — with the token it answers 200 and the shells and sessions the daemon runs, in creation order, each with its program; a commands terminal is not listed', async () => {
    const { files } = await startDaemon();
    const { client } = await connectTo(files.socket);
    const shell = await client.spawn({ ...shellOptions, kind: 'shell', workspace: '/work/tree' });
    const session = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1', workspace: '/work/tree' });
    await client.spawn({ ...shellOptions, kind: 'commands' });
    expect((await send(files.socket, { authorization: `Bearer ${tokenOf(files)}`, body: JSON.stringify({ sessionId: 'session-1', event: 'working' }) })).status).toBe(204);

    const answer = await get(files.socket, `Bearer ${tokenOf(files)}`);

    expect(answer.status).toBe(200);
    const listed = JSON.parse(answer.text) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ id: shell, kind: 'shell', cwd: shellOptions.cwd, workspace: '/work/tree', command: '/bin/sh' });
    expect(listed[1]).toMatchObject({ id: session, kind: 'session', sessionId: 'session-1', workspace: '/work/tree', status: 'working', command: '/bin/sh' });

    // Without the token, or with a wrong one: 401 and an empty body.
    expect(await get(files.socket)).toEqual({ status: 401, text: '' });
    expect(await get(files.socket, `Bearer ${'0'.repeat(64)}`)).toEqual({ status: 401, text: '' });
  });

  test('AC15 — a daemon in any state answers: one that another build superseded still lists the terminals it keeps, and an empty one lists none', async () => {
    const { files } = await startDaemon();
    const owner = await connectTo(files.socket);
    const shell = await owner.client.spawn(shellOptions);
    // A client of another build says hello: the daemon is superseded, it keeps its terminals.
    await connectTo(files.socket, OTHER_BUILD);

    const answer = await get(files.socket, `Bearer ${tokenOf(files)}`);

    expect(answer.status).toBe(200);
    expect((JSON.parse(answer.text) as Array<{ id: number }>).map((entry) => entry.id)).toEqual([shell]);

    owner.client.kill(shell);
    await owner.when(() => owner.exits.some((exit) => exit.id === shell));
    expect(JSON.parse((await get(files.socket, `Bearer ${tokenOf(files)}`)).text)).toEqual([]);
  });
});

describe('POST /shutdown', () => {
  test('AC15 — with the token it answers 202, then ends every terminal, removes .sock, .token and .pid, and the daemon exits', async () => {
    const home = makeHome();
    const files = daemonFiles(home, 1, BUILD);
    const exits: number[] = [];
    let exited!: () => void;
    const exitedOnce = new Promise<void>((resolve) => (exited = resolve));
    await runDaemonEntry(['/usr/bin/electron', '/app/daemon.js', '--cockpit-daemon', BUILD], { COCKPIT_HOME: home }, {
      stderr: { write: () => {} },
      exit: (code) => void (exits.push(code), exited()),
      ready: () => {},
    });
    const connection = await connectTo(files.socket);
    const shell = await connection.client.spawn(shellOptions);
    const session = await connection.client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });
    const commands = await connection.client.spawn({ ...shellOptions, kind: 'commands' });
    const pids = [await pidOf(connection, shell), await pidOf(connection, session), await pidOf(connection, commands)];

    // Without the token, or with a wrong one: 401, and the daemon keeps running with its terminals.
    expect(await shutdown(files.socket)).toEqual({ status: 401, text: '' });
    expect(await shutdown(files.socket, `Bearer ${'0'.repeat(64)}`)).toEqual({ status: 401, text: '' });
    expect(await connection.client.list()).toHaveLength(3);

    const answer = await shutdown(files.socket, `Bearer ${tokenOf(files)}`);

    expect(answer.status).toBe(202);
    await exitedOnce;
    expect(exits).toEqual([0]);
    expect([exists(files.socket), exists(files.token), exists(files.pid)]).toEqual([false, false, false]);
    for (const pid of pids) await processEnded(pid);
  });
});
