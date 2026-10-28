import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { daemonFiles, ensureDaemon, runDaemon } from '../src/index';
import { BUILD, makeHome, onCleanup, registerCleanup, startDaemon, until } from './helpers';

// `ensureDaemon` with a fake `spawn`: the child is whatever the test makes of it (a daemon
// started in this process, or a process that dies). A real detached Electron is the app tests'.

registerCleanup();

function fakeSpawn(home: string, behave: (child: EventEmitter) => void) {
  const calls: number[] = [];
  const spawn = () => {
    calls.push(calls.length);
    const child = new EventEmitter();
    behave(child);
    return child;
  };
  return { spawn, calls, home };
}

// A fake child that is a daemon started in this process; `daemons` collects the handles.
const startsDaemon = (home: string, daemons: Array<{ close(): Promise<void> }> = []) => () => {
  void runDaemon({ home, build: BUILD }).then((daemon) => {
    daemons.push(daemon);
    onCleanup(() => daemon.close());
  });
};

describe('ensureDaemon', () => {
  test('AC1 — with no daemon of the build it spawns one and returns a connected client; a second call reuses it without spawning', async () => {
    const home = makeHome();
    const fake = fakeSpawn(home, startsDaemon(home));

    const client = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    onCleanup(() => client.close());

    expect(fake.calls).toHaveLength(1);
    expect(await client.hello(BUILD)).toMatchObject({ protocol: 1, build: BUILD });

    const again = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    onCleanup(() => again.close());
    expect(fake.calls).toHaveLength(1);
    expect((await again.hello(BUILD)).pid).toBe((await client.hello(BUILD)).pid);
  });

  test('AC1 — with a daemon of the build already running it connects without spawning', async () => {
    const { home } = await startDaemon();
    const fake = fakeSpawn(home, () => {});

    const client = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    onCleanup(() => client.close());

    expect(fake.calls).toHaveLength(0);
  });

  test('AC10 — a child that exits before the daemon listens rejects with the last line of the log', async () => {
    const home = makeHome();
    mkdirSync(home, { recursive: true });
    const { log } = daemonFiles(home, 1, BUILD);
    const reason = `Error: listen EADDRINUSE: address already in use ${home}/daemon-1-${BUILD}.sock`;
    const fake = fakeSpawn(home, (child) => {
      writeFileSync(log, `starting\n${reason}\n`);
      setTimeout(() => child.emit('exit', 1, null), 20);
    });

    const failure = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn }).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain(reason);
    expect(failure?.message).not.toContain('starting');
  });
});

describe('a daemon that dies (AC12)', () => {
  test('AC12 — the client reports the close when the daemon goes away, and the next ensureDaemon starts a new one', async () => {
    const home = makeHome();
    const daemons: Array<{ close(): Promise<void> }> = [];
    const fake = fakeSpawn(home, startsDaemon(home, daemons));
    const client = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    let closed = false;
    client.onClose(() => (closed = true));
    await until(() => daemons.length === 1, 'the daemon handle');

    await daemons[0]!.close();

    await until(() => closed, 'onClose');
    const next = await ensureDaemon({ home, build: BUILD, spawn: fake.spawn });
    onCleanup(() => next.close());
    expect(fake.calls).toHaveLength(2);
    expect(await next.hello(BUILD)).toMatchObject({ protocol: 1, build: BUILD });
  });
});
