import { describe, expect, test } from 'vitest';
import { connectTo, registerCleanup, shellOptions, startDaemon, until, waitForOutput } from './helpers';

// COCKPIT-66 (AC24): a session terminal whose program sets a title (OSC 0 or OSC 2) makes the
// daemon push { type: 'title', sessionId, title } to its clients, once per change. A `shell` or
// `commands` terminal sends none. Real node-pty, real sockets, plain Node.

registerCleanup();

// printf, not echo: the typed line carries the escapes as text, only the program's output holds the ESC.
const osc = (code: 0 | 2, title: string) => `printf '\\033]${code};%s\\007' '${title}'\n`;

async function start() {
  const daemon = await startDaemon();
  const connection = await connectTo(daemon.files.socket);
  const titles: Array<{ sessionId: string; title: string }> = [];
  (connection.client as unknown as { onTitle(listener: (event: { sessionId: string; title: string }) => void): void }).onTitle((event) =>
    titles.push({ sessionId: event.sessionId, title: event.title }),
  );
  return { ...daemon, connection, client: connection.client, titles };
}

describe('title events (AC24)', () => {
  test('AC24 — a session terminal that sets a title with OSC 2 then OSC 0 gives two events, and a repeat of the same title gives none', async () => {
    const { client, connection, titles } = await start();
    const id = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });

    client.write(id, osc(2, 'First title'));
    await until(() => titles.length === 1, 'the first title');
    client.write(id, osc(0, 'Second title'));
    await until(() => titles.length === 2, 'the second title');
    client.write(id, osc(0, 'Second title'));
    client.write(id, osc(2, 'Second title'));
    client.write(id, osc(0, 'Third title'));
    await until(() => titles.length === 3, 'the third title');
    client.write(id, 'echo end-marker\n');
    await waitForOutput(connection, id, 'end-marker');

    expect(titles).toEqual([
      { sessionId: 'session-1', title: 'First title' },
      { sessionId: 'session-1', title: 'Second title' },
      { sessionId: 'session-1', title: 'Third title' },
    ]);
  });

  test('AC24 — a title with non-ASCII characters arrives intact', async () => {
    const { client, titles } = await start();
    const id = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });

    // Typed as octal escapes in the format: a line with raw multibyte bytes is mangled by the shell's
    // readline in the C locale, and the escapes of a `%s` argument would not be interpreted.
    client.write(id, "printf '\\033]0;\\342\\234\\263 Fix the caf\\303\\251 loop\\007'\n");

    await until(() => titles.length === 1, 'the title');
    expect(titles[0]!.title).toBe('✳ Fix the café loop');
  });

  test('AC24 — each session terminal reports its own sessionId', async () => {
    const { client, titles } = await start();
    const one = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });
    const two = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-2' });

    client.write(two, osc(0, 'Title of two'));
    await until(() => titles.length === 1, 'the title of the second');
    client.write(one, osc(0, 'Title of one'));
    await until(() => titles.length === 2, 'the title of the first');

    expect(titles).toEqual([
      { sessionId: 'session-2', title: 'Title of two' },
      { sessionId: 'session-1', title: 'Title of one' },
    ]);
  });

  test('AC24 — shell and commands terminals send no title event, while a session terminal started after them does', async () => {
    const { client, connection, titles } = await start();
    const shell = await client.spawn(shellOptions);
    const commands = await client.spawn({ ...shellOptions, kind: 'commands' });

    client.write(shell, osc(0, 'Shell title') + 'echo shell-done\n');
    client.write(commands, osc(2, 'Commands title') + 'echo commands-done\n');
    await waitForOutput(connection, shell, 'shell-done');
    await waitForOutput(connection, commands, 'commands-done');
    const session = await client.spawn({ ...shellOptions, kind: 'session', sessionId: 'session-1' });
    client.write(session, osc(0, 'Session title'));
    await until(() => titles.length >= 1, 'the session title');

    expect(titles).toEqual([{ sessionId: 'session-1', title: 'Session title' }]);
  });
});
