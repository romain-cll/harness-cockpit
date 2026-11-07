import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { connectTo, registerCleanup, send, shellOptions, startDaemon, waitForOutput, type Connection } from './helpers';

// COCKPIT-50: Claude Code does not fire a hook on an Esc, but its terminal title goes from the busy glyph
// (`◐`/`◑`) to the idle one (`✳`). The daemon gets the harness's busy and idle title patterns as data in the
// spawn options (`agentTitles`, regular expression sources) and, for a session whose last report is `working`,
// records `finished` when an idle title follows a busy one, pushing `{ type: 'status', event: 'finished',
// fromTitle: true }`. A busy title undoes it; any report clears the mark. Real node-pty, real sockets, plain Node.

registerCleanup();

const BUSY = '^[◐◑] ';
const IDLE = '^✳ ';
// Typed as octal escapes in a printf format: the typed line never holds the glyph, only the program's output does.
const GLYPH = { busy: '\\342\\227\\220', busier: '\\342\\227\\221', idle: '\\342\\234\\263' };
const title = (glyph: keyof typeof GLYPH, text: string) => `printf '\\033]0;${GLYPH[glyph]} ${text}\\007'\n`;
const marker = (what: 'started' | 'exited') => `printf '\\033]69%s;agent-%s\\007' 73 ${what}\n`;

let counter = 0;
/**
 * Resolves once the terminal's headless copy holds a line written after everything sent before: every title
 * before it was parsed, and the status it caused was pushed (on the same socket, before the answer to `attach`).
 */
async function settle(connection: Connection, id: unknown) {
  const n = ++counter;
  connection.client.write(id, `echo settled-$((${n}*1000))\n`);
  await waitForOutput(connection, id, `settled-${n * 1000}`);
  await connection.client.attach(id);
}

async function start() {
  const daemon = await startDaemon();
  const connection = await connectTo(daemon.files.socket);
  const token = readFileSync(daemon.files.token, 'utf8');
  const spawnSession = (sessionId: string, agentTitles?: { busy: string; idle: string; marked: boolean }) =>
    connection.client.spawn({ ...shellOptions, kind: 'session', sessionId, ...(agentTitles && { agentTitles }) } as Parameters<typeof connection.client.spawn>[0]);
  const report = async (sessionId: string, event: 'working' | 'waiting' | 'finished') => {
    const answer = await send(daemon.files.socket, { authorization: `Bearer ${token}`, body: JSON.stringify({ sessionId, event }) });
    expect(answer.status).toBe(204);
  };
  /** Resolves once at least `count` statuses reached the client. */
  const seen = (count: number) => connection.when(() => connection.statuses.length >= count);
  const statusOf = async (sessionId: string) => (await connection.client.list()).find((entry) => entry.sessionId === sessionId)?.status;
  return { ...daemon, connection, client: connection.client, spawnSession, report, seen, statusOf, statuses: connection.statuses };
}

const unmarked = { busy: BUSY, idle: IDLE, marked: false };

describe('status from the turn title (COCKPIT-50)', () => {
  test.each(['busy', 'busier'] as const)('AC1 — working, then a %s title and an idle title: finished is recorded, pushed with fromTitle and given by list', async (glyph) => {
    const { client, spawnSession, report, seen, statuses, statusOf } = await start();
    const id = await spawnSession('s1', unmarked);
    await report('s1', 'working');
    await seen(1);

    client.write(id, title(glyph, 'Greeting') + title('idle', 'Greeting'));
    await seen(2);

    expect(statuses).toEqual([
      { sessionId: 's1', event: 'working' },
      { sessionId: 's1', event: 'finished', fromTitle: true },
    ]);
    expect(await statusOf('s1')).toBe('finished');
  });

  test('AC3 — a session that reported waiting keeps waiting on an idle title, and nothing is pushed', async () => {
    const { client, connection, spawnSession, report, seen, statuses, statusOf } = await start();
    const id = await spawnSession('s1', unmarked);
    await report('s1', 'working');
    await seen(1);
    client.write(id, title('busy', 'Ask'));
    await settle(connection, id);
    await report('s1', 'waiting');
    await seen(2);

    client.write(id, title('idle', 'Ask'));
    await settle(connection, id);

    expect(statuses).toEqual([
      { sessionId: 's1', event: 'working' },
      { sessionId: 's1', event: 'waiting' },
    ]);
    expect(await statusOf('s1')).toBe('waiting');
    // The feature is on for this terminal: the next turn is read.
    await report('s1', 'working');
    await seen(3);
    client.write(id, title('busy', 'Next') + title('idle', 'Next'));
    await seen(4);
    expect(statuses[3]).toEqual({ sessionId: 's1', event: 'finished', fromTitle: true });
  });

  test('AC4 — after a status from a title, a waiting report gives waiting; a finished report then makes the busy titles after it change nothing', async () => {
    const { client, connection, spawnSession, report, seen, statuses, statusOf } = await start();
    const id = await spawnSession('s1', unmarked);
    await report('s1', 'working');
    await seen(1);
    client.write(id, title('busy', 'Turn') + title('idle', 'Turn'));
    await seen(2);

    await report('s1', 'waiting');
    await seen(3);
    expect(await statusOf('s1')).toBe('waiting');
    await report('s1', 'finished');
    await seen(4);
    client.write(id, title('busy', 'Later') + title('busier', 'Later'));
    await settle(connection, id);

    expect(statuses).toEqual([
      { sessionId: 's1', event: 'working' },
      { sessionId: 's1', event: 'finished', fromTitle: true },
      { sessionId: 's1', event: 'waiting' },
      { sessionId: 's1', event: 'finished' },
    ]);
    expect(await statusOf('s1')).toBe('finished');
  });

  test('AC5 — a finished report while the title is still busy: the busy titles and the idle title that follow push nothing', async () => {
    const { client, connection, spawnSession, report, seen, statuses, statusOf } = await start();
    const id = await spawnSession('s1', unmarked);
    await report('s1', 'working');
    await seen(1);
    client.write(id, title('busy', 'Turn'));
    await settle(connection, id);
    await report('s1', 'finished');
    await seen(2);

    client.write(id, title('busier', 'Turn') + title('busy', 'Turn') + title('idle', 'Turn'));
    await settle(connection, id);

    expect(statuses).toEqual([
      { sessionId: 's1', event: 'working' },
      { sessionId: 's1', event: 'finished' },
    ]);
    expect(await statusOf('s1')).toBe('finished');
    // The feature is on for this terminal: the next turn is read.
    await report('s1', 'working');
    await seen(3);
    client.write(id, title('busy', 'Next') + title('idle', 'Next'));
    await seen(4);
    expect(statuses[3]).toEqual({ sessionId: 's1', event: 'finished', fromTitle: true });
  });

  test('AC6 — a busy title after a status from a title gives working again, and the idle title after it finished again', async () => {
    const { client, spawnSession, report, seen, statuses, statusOf } = await start();
    const id = await spawnSession('s1', unmarked);
    await report('s1', 'working');
    await seen(1);
    client.write(id, title('busy', 'Turn') + title('idle', 'Turn'));
    await seen(2);

    client.write(id, title('busier', 'Turn'));
    await seen(3);
    expect(statuses[2]).toMatchObject({ sessionId: 's1', event: 'working' });
    expect(await statusOf('s1')).toBe('working');

    client.write(id, title('idle', 'Done'));
    await seen(4);
    expect(statuses[3]).toEqual({ sessionId: 's1', event: 'finished', fromTitle: true });
    expect(await statusOf('s1')).toBe('finished');
  });

  test('AC7 — working with no busy title since the last idle one: an idle title that changes keeps working, before and after a turn', async () => {
    const { client, connection, spawnSession, report, seen, statuses, statusOf } = await start();
    const id = await spawnSession('s1', unmarked);
    await report('s1', 'working');
    await seen(1);

    client.write(id, title('idle', 'Claude Code') + title('idle', 'Greeting'));
    await settle(connection, id);
    expect(statuses).toEqual([{ sessionId: 's1', event: 'working' }]);
    expect(await statusOf('s1')).toBe('working');

    // A turn, then a new prompt: working again, the idle title of the turn was the last idle one.
    client.write(id, title('busy', 'Greeting') + title('idle', 'Greeting'));
    await seen(2);
    await report('s1', 'working');
    await seen(3);
    client.write(id, title('idle', 'Renamed'));
    await settle(connection, id);

    expect(statuses).toHaveLength(3);
    expect(await statusOf('s1')).toBe('working');
  });

  test('AC8 — with markers, the titles before agent-started and after agent-exited change nothing, the ones between do; without markers they do', async () => {
    const { client, connection, spawnSession, report, seen, statuses, statusOf } = await start();
    const marked = await spawnSession('s1', { busy: BUSY, idle: IDLE, marked: true });
    const direct = await spawnSession('s2', unmarked);
    await report('s1', 'working');
    await seen(1);
    await report('s2', 'working');
    await seen(2);

    client.write(marked, title('busy', 'Setup') + title('idle', 'Setup'));
    await settle(connection, marked);
    expect(statuses).toHaveLength(2);
    expect(await statusOf('s1')).toBe('working');

    client.write(marked, marker('started') + title('busy', 'Agent') + title('idle', 'Agent'));
    await seen(3);
    expect(statuses[2]).toEqual({ sessionId: 's1', event: 'finished', fromTitle: true });

    await report('s1', 'working');
    await seen(4);
    client.write(marked, marker('exited') + title('busy', 'Shell') + title('idle', 'Shell'));
    await settle(connection, marked);
    expect(statuses).toHaveLength(4);
    expect(await statusOf('s1')).toBe('working');

    client.write(direct, title('busy', 'Agent') + title('idle', 'Agent'));
    await seen(5);
    expect(statuses[4]).toEqual({ sessionId: 's2', event: 'finished', fromTitle: true });
  });

  test('AC9 — a session terminal spawned without agentTitles keeps its status on the same titles, while one with them changes', async () => {
    const { client, connection, spawnSession, report, seen, statuses, statusOf } = await start();
    const plain = await spawnSession('s1');
    const catalogued = await spawnSession('s2', unmarked);
    await report('s1', 'working');
    await seen(1);
    await report('s2', 'working');
    await seen(2);

    client.write(plain, title('busy', 'Turn') + title('idle', 'Turn'));
    await settle(connection, plain);
    expect(statuses).toHaveLength(2);
    expect(await statusOf('s1')).toBe('working');

    client.write(catalogued, title('busy', 'Turn') + title('idle', 'Turn'));
    await seen(3);
    expect(statuses[2]).toEqual({ sessionId: 's2', event: 'finished', fromTitle: true });
    expect(await statusOf('s1')).toBe('working');
  });
});
