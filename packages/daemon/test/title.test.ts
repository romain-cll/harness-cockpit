import { describe, expect, test } from 'vitest';
import { connectTo, registerCleanup, shellOptions, startDaemon, until, waitForOutput, type Connection } from './helpers';

// COCKPIT-66 (AC24): a session terminal whose program sets a title (OSC 0 or OSC 2) between the
// "agent started" and "agent exited" markers `cockpit setup` writes (private OSC 6973) makes the daemon
// push { type: 'title', sessionId, title } to its clients, once per change. Before the first marker, after
// the second, without markers, and on a `shell` or `commands` terminal, it sends none. Real node-pty,
// real sockets, plain Node.

registerCleanup();

// printf, not echo: the typed line carries the escapes as text, only the program's output holds the ESC.
const osc = (code: 0 | 2, title: string) => `printf '\\033]${code};%s\\007' '${title}'\n`;
// The marker is split in the typed line (`69%s`, `agent-%s`), so the shell's echo of it never holds
// `6973` or `agent-started` as text: only the program's output does.
const marker = (what: 'started' | 'exited') => `printf '\\033]69%s;agent-%s\\007' 73 ${what}\n`;

async function start() {
  const daemon = await startDaemon();
  const connection = await connectTo(daemon.files.socket);
  const titles: Array<{ sessionId: string; title: string }> = [];
  (connection.client as unknown as { onTitle(listener: (event: { sessionId: string; title: string }) => void): void }).onTitle((event) =>
    titles.push({ sessionId: event.sessionId, title: event.title }),
  );
  return { ...daemon, connection, client: connection.client, titles };
}

let counter = 0;
/**
 * Resolves once the terminal's headless copy holds a line written after everything sent before: the
 * stream is parsed in order, so every title event it holds was pushed (on the same socket, before the
 * answer to `attach`).
 */
async function settle(connection: Connection, id: unknown) {
  const n = ++counter;
  connection.client.write(id, `echo settled-$((${n}*1000))\n`);
  await until(async () => (await connection.client.attach(id)).screen.includes(`settled-${n * 1000}`), `the line settled-${n * 1000}`);
}

describe('title events (AC24)', () => {
  test('AC24 — only the titles between the "agent started" and "agent exited" markers give events: OSC 2 then OSC 0 give two, a repeat of the same title none; those before and after give none', async () => {
    const { client, connection, titles } = await start();
    const id = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });

    client.write(id, osc(2, 'Setup title') + marker('started') + osc(2, 'First title'));
    await until(() => titles.length === 1, 'the first title');
    client.write(id, osc(0, 'Second title'));
    await until(() => titles.length === 2, 'the second title');
    client.write(id, osc(0, 'Second title') + osc(2, 'Second title') + osc(0, 'Third title'));
    await until(() => titles.length === 3, 'the third title');
    client.write(id, marker('exited') + osc(0, 'Login shell title'));
    await settle(connection, id);

    expect(titles).toEqual([
      { sessionId: 'session-1', title: 'First title' },
      { sessionId: 'session-1', title: 'Second title' },
      { sessionId: 'session-1', title: 'Third title' },
    ]);
  });

  test('AC24 — a session terminal that never saw a marker sends no title event', async () => {
    const { client, connection, titles } = await start();
    const id = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });

    client.write(id, osc(0, 'Title without markers') + osc(2, 'Another one'));
    await settle(connection, id);

    expect(titles).toEqual([]);
  });

  test('AC24 — a title with non-ASCII characters arrives intact', async () => {
    const { client, titles } = await start();
    const id = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });

    // Typed as octal escapes in the format: a line with raw multibyte bytes is mangled by the shell's
    // readline in the C locale, and the escapes of a `%s` argument would not be interpreted.
    client.write(id, marker('started') + "printf '\\033]0;\\342\\234\\263 Fix the caf\\303\\251 loop\\007'\n");

    await until(() => titles.length === 1, 'the title');
    expect(titles[0]!.title).toBe('✳ Fix the café loop');
  });

  test('AC24 — each session terminal reports its own sessionId', async () => {
    const { client, titles } = await start();
    const one = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });
    const two = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-2' });

    client.write(two, marker('started') + osc(0, 'Title of two'));
    await until(() => titles.length === 1, 'the title of the second');
    client.write(one, marker('started') + osc(0, 'Title of one'));
    await until(() => titles.length === 2, 'the title of the first');

    expect(titles).toEqual([
      { sessionId: 'session-2', title: 'Title of two' },
      { sessionId: 'session-1', title: 'Title of one' },
    ]);
  });

  test('AC24 — shell and commands terminals send no title event, markers or not, while a session terminal started after them does', async () => {
    const { client, connection, titles } = await start();
    const shell = await client.spawn(shellOptions);
    const commands = await client.spawn({ ...shellOptions, kind: 'commands' });

    client.write(shell, marker('started') + osc(0, 'Shell title') + 'echo shell-done\n');
    client.write(commands, marker('started') + osc(2, 'Commands title') + 'echo commands-done\n');
    await waitForOutput(connection, shell, 'shell-done');
    await waitForOutput(connection, commands, 'commands-done');
    await settle(connection, shell);
    await settle(connection, commands);
    const session = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });
    client.write(session, marker('started') + osc(0, 'Session title'));
    await until(() => titles.length >= 1, 'the session title');

    expect(titles).toEqual([{ sessionId: 'session-1', title: 'Session title' }]);
  });

  test('AC24 — the markers never show: an attach snapshot holds the output around them and no trace of them', async () => {
    const { client, connection } = await start();
    const id = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });

    client.write(id, 'echo before-marks\n' + marker('started') + 'echo between-marks\n' + marker('exited') + 'echo after-marks\n');
    await settle(connection, id);

    const { screen } = await client.attach(id);
    expect(screen).toContain('before-marks');
    expect(screen).toContain('between-marks');
    expect(screen).toContain('after-marks');
    expect(screen).not.toContain('6973');
    expect(screen).not.toContain('agent-started');
    expect(screen).not.toContain('agent-exited');
  });
});
