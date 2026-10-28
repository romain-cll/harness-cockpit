import { writeFileSync } from 'node:fs';
import { Terminal as Headless } from '@xterm/headless';
import { describe, expect, test } from 'vitest';
import { SCROLLBACK } from '../src/index';
import {
  BUILD,
  OTHER_BUILD,
  connectTo,
  exists,
  isAlive,
  registerCleanup,
  send,
  shellOptions,
  startDaemon,
  stripAnsi,
  until,
  waitForOutput,
} from './helpers';

// Real node-pty, real sockets in short temporary folders, plain Node.

registerCleanup();

async function start() {
  const daemon = await startDaemon();
  const connection = await connectTo(daemon.files.socket);
  return { ...daemon, connection, client: connection.client };
}

// Prints the pid of the terminal's shell, to check later whether the process is alive.
async function pidOf(connection: Awaited<ReturnType<typeof connectTo>>, id: unknown): Promise<number> {
  connection.client.write(id, 'echo pid-$$-end\n');
  await until(() => /pid-\d+-end/.test(connection.output(id)), `the pid of terminal ${String(id)}`);
  return Number(/pid-(\d+)-end/.exec(connection.output(id))![1]);
}

describe('hello and list (AC14)', () => {
  test('AC14 — hello answers { protocol: 1, build, pid } and list gives each running terminal with its id, kind, cwd, size, sessionId, workspace and last status', async () => {
    const { client, connection } = await start();
    expect(await client.hello(BUILD)).toEqual({ protocol: 1, build: BUILD, pid: process.pid });
    expect(await client.list()).toEqual([]);

    const shell = await client.spawn({ ...shellOptions, cwd: '/tmp' });
    const session = await client.spawn({
      ...shellOptions,
      kind: 'session',
      cols: 100,
      rows: 30,
      sessionId: 'session-1',
      workspace: '/work/space',
    });
    const listed = await client.list();

    expect(listed).toHaveLength(2);
    expect(listed.find((entry) => entry.id === shell)).toMatchObject({ kind: 'shell', cwd: '/tmp', cols: 80, rows: 24 });
    expect(listed.find((entry) => entry.id === shell)?.sessionId).toBeUndefined();
    expect(listed.find((entry) => entry.id === shell)?.workspace).toBeUndefined();
    expect(listed.find((entry) => entry.id === session)).toMatchObject({
      kind: 'session',
      cols: 100,
      rows: 30,
      sessionId: 'session-1',
      workspace: '/work/space',
    });
    expect(connection.statuses).toEqual([]);
  });

  test('AC14 — the terminal runs, its output reaches the client, write and resize reach the pty', async () => {
    const { client, connection } = await start();
    const id = await client.spawn(shellOptions);

    client.write(id, 'echo cockpit-$((6*7))\n');
    await waitForOutput(connection, id, 'cockpit-42');
    client.resize(id, 100, 30);
    client.write(id, 'stty size\n');
    await waitForOutput(connection, id, '30 100');
    expect((await client.list()).find((entry) => entry.id === id)).toMatchObject({ cols: 100, rows: 30 });
  });
});

describe('attach and sequence numbers (AC14, AC5)', () => {
  test('AC14, AC5 — attach answers the screen with the output so far, at the pty\'s size after a resize, and a later data event carries a higher sequence number', async () => {
    const { client, connection } = await start();
    const id = await client.spawn(shellOptions);
    client.write(id, 'echo marker-$((6*7))\n');
    await waitForOutput(connection, id, 'marker-42');
    client.resize(id, 100, 30);
    client.write(id, 'stty size\n');
    await waitForOutput(connection, id, '30 100');

    const attached = await client.attach(id);

    expect(attached.cols).toBe(100);
    expect(attached.rows).toBe(30);
    expect(stripAnsi(attached.screen)).toContain('marker-42');
    expect(stripAnsi(attached.screen)).toContain('30 100');
    expect(typeof attached.seq).toBe('number');
    const before = connection.data.length;
    client.write(id, 'echo after-$((1+1))\n');
    await until(() => connection.data.slice(before).some((chunk) => chunk.data.includes('after-2')), 'the later output');
    for (const chunk of connection.data.slice(before)) expect(chunk.seq).toBeGreaterThan(attached.seq);
  });

  test('AC5 — a resize sent to the pty resizes the headless terminal too: text placed at column 90 and row 28 stays there in the attached screen', async () => {
    const { client, connection } = await start();
    const id = await client.spawn(shellOptions);
    client.resize(id, 100, 30);
    // The cursor move only lands at row 28, column 90 on a 100 x 30 screen (an 80 x 24 one clamps it).
    client.write(id, "printf '\\033[28;90H%s' \"$((6*7))-edge\"\n");
    await waitForOutput(connection, id, '42-edge');

    const attached = await client.attach(id);

    const replay = new Headless({ cols: attached.cols, rows: attached.rows, allowProposedApi: true });
    await new Promise<void>((resolve) => replay.write(attached.screen, resolve));
    const buffer = replay.buffer.active;
    const lines = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '');
    const row = lines.findIndex((line) => line.includes('42-edge'));
    replay.dispose();
    expect(row - buffer.baseY, 'row of the text on the screen').toBe(27);
    expect(lines[row]!.indexOf('42-edge'), 'column of the text').toBe(89);
  });

  test('AC14 — a client attaching during a burst of output gets every line exactly once: the screen it receives plus the data events after its sequence number', async () => {
    const { client, connection, files } = await start();
    const id = await client.spawn(shellOptions);
    // 150 lines, a few milliseconds apart: the attach lands in the middle.
    client.write(id, 'i=0; while [ $i -lt 150 ]; do echo line-$i; i=$((i+1)); sleep 0.02; done; echo burst-$((1+1))-done\n');
    await waitForOutput(connection, id, 'line-10\r');

    const other = await connectTo(files.socket);
    const attached = await other.client.attach(id);
    await waitForOutput(other, id, 'burst-2-done');

    const later = other.data.filter((chunk) => chunk.id === id);
    expect(later.length, 'some output came after the attach').toBeGreaterThan(0);
    const seqs = later.map((chunk) => chunk.seq);
    expect(seqs.every((seq) => seq > attached.seq)).toBe(true);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);

    const text = stripAnsi(attached.screen) + later.map((chunk) => chunk.data).join('');
    const numbers = [...text.matchAll(/line-(\d+)/g)].map((match) => Number(match[1]));
    expect(numbers).toEqual(Array.from({ length: 150 }, (_, index) => index));
  });
});

describe('the headless terminal (AC5)', () => {
  test('AC5 — a terminal that printed more than SCROLLBACK lines serializes the last ones only, scrollback included', async () => {
    const { client, connection } = await start();
    const id = await client.spawn(shellOptions);
    client.write(id, "seq 1 1500 | sed 's/^/line-/'; echo printed-$((1+1))-done\n");
    await waitForOutput(connection, id, 'printed-2-done');

    const { screen, rows } = await client.attach(id);
    const lines = [...stripAnsi(screen).matchAll(/line-(\d+)/g)].map((match) => Number(match[1]));

    expect(lines.at(-1)).toBe(1500);
    expect(lines.length).toBeGreaterThanOrEqual(SCROLLBACK);
    expect(lines.length).toBeLessThanOrEqual(SCROLLBACK + rows);
    expect(lines[0]).toBeGreaterThan(1);
  });
});

describe('kill and exit (AC6)', () => {
  test('AC6 — kill ends the process and the daemon no longer lists the terminal; a shell that exits by itself leaves the list too', async () => {
    const { client, connection } = await start();
    const killed = await client.spawn(shellOptions);
    const exiting = await client.spawn(shellOptions);
    const killedPid = await pidOf(connection, killed);

    client.kill(killed);
    client.write(exiting, 'exit 3\n');

    await until(() => connection.exits.length === 2, 'both exits');
    expect(connection.exits.find((exit) => exit.id === exiting)?.exitCode).toBe(3);
    expect(await client.list()).toEqual([]);
    await until(() => !isAlive(killedPid), 'the killed shell to be gone');
  });
});

describe('commands bound to a connection (AC7)', () => {
  test('AC7 — closing the connection that spawned a commands terminal ends it; the shell and the session of the same connection keep running and are listed to another client', async () => {
    const { connection, files } = await start();
    const { client } = connection;
    const shell = await client.spawn(shellOptions);
    const session = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });
    const commands = await client.spawn({ ...shellOptions, kind: 'commands' });
    const pids = { shell: await pidOf(connection, shell), session: await pidOf(connection, session), commands: await pidOf(connection, commands) };

    client.close();

    const other = await connectTo(files.socket);
    await until(async () => (await other.client.list()).length === 2, 'the commands terminal to end');
    expect((await other.client.list()).map((entry) => entry.id).sort()).toEqual([shell, session].sort());
    await until(() => !isAlive(pids.commands), 'the commands process to be gone');
    expect(isAlive(pids.shell)).toBe(true);
    expect(isAlive(pids.session)).toBe(true);
    other.client.kill(shell);
    other.client.kill(session);
  });
});

describe('another build (AC8, AC9)', () => {
  test('AC8 — a hello of another build supersedes the daemon: it keeps its terminals, then exits when the last one ends, removing .sock, .token and .pid but not .log', async () => {
    const { client, connection, files } = await start();
    writeFileSync(files.log, 'daemon output\n');
    const id = await client.spawn(shellOptions);
    const pid = await pidOf(connection, id);

    const newer = await connectTo(files.socket, OTHER_BUILD);
    expect(await newer.client.hello(OTHER_BUILD)).toMatchObject({ build: BUILD });
    expect((await newer.client.list()).map((entry) => entry.id)).toEqual([id]);
    expect(isAlive(pid)).toBe(true);
    expect([files.socket, files.token, files.pid].every(exists)).toBe(true);

    await newer.client.attach(id);
    newer.client.write(id, 'echo from-newer-$((6*7))\n');
    await waitForOutput(newer, id, 'from-newer-42');
    client.kill(id);

    await until(() => ![files.socket, files.token, files.pid].some(exists), 'the superseded daemon to remove its files');
    expect(exists(files.log)).toBe(true);
  });

  test('AC8 — a daemon holding no terminal exits as soon as a client of another build connects', async () => {
    const { files } = await start();

    await connectTo(files.socket, OTHER_BUILD);

    await until(() => ![files.socket, files.token, files.pid].some(exists), 'the idle daemon to exit');
  });

  test('AC9 — a client of another build asking to spawn is refused with the build message and nothing is spawned', async () => {
    const { client, connection, files } = await start();
    const id = await client.spawn(shellOptions);
    const pid = await pidOf(connection, id);
    const newer = await connectTo(files.socket, OTHER_BUILD);

    await expect(newer.client.spawn(shellOptions)).rejects.toThrow('this background service belongs to another build of Cockpit');

    expect((await client.list()).map((entry) => entry.id)).toEqual([id]);
    expect(isAlive(pid)).toBe(true);
  });
});

describe('authentication (AC14)', () => {
  test.each([
    ['no Authorization header', undefined],
    ['a Basic scheme', 'Basic abc'],
    ['a wrong token', `Bearer ${'a'.repeat(64)}`],
  ])('AC14 — %s on the attach upgrade gets 401 with an empty body', async (_label, authorization) => {
    const { files } = await start();

    const answer = await send(files.socket, {
      method: 'GET',
      path: '/attach',
      authorization,
      headers: { connection: 'Upgrade', upgrade: 'cockpit-1' },
    });

    expect(answer).toEqual({ status: 401, text: '' });
  });
});
