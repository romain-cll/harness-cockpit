import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { connectDaemon, daemonFiles, runDaemon } from '../src/index';
import { BUILD, exists, leaveStaleSocket, makeHome, onCleanup, registerCleanup, send, startDaemon } from './helpers';

registerCleanup();

describe('files (AC1)', () => {
  test('AC1 — the daemon listens on daemon-1-<build>.sock (0600), writes a 64 lowercase hex token (0600) and its pid, and a new start writes a different token', async () => {
    const { files, daemon, home } = await startDaemon();

    expect(statSync(files.socket).isSocket()).toBe(true);
    expect(statSync(files.socket).mode & 0o777).toBe(0o600);
    const token = readFileSync(files.token, 'utf8');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(files.token).mode & 0o777).toBe(0o600);
    expect(readFileSync(files.pid, 'utf8').trim()).toBe(String(process.pid));

    await daemon.close();
    const second = await startDaemon({ home });
    expect(readFileSync(second.files.token, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(second.files.token, 'utf8')).not.toBe(token);
  });

  test('AC1 — a stale socket (a killed daemon left it) is replaced and the new daemon answers', async () => {
    const home = makeHome();
    const files = daemonFiles(home, 1, BUILD);
    await leaveStaleSocket(files.socket);
    writeFileSync(files.token, 'old-token', { mode: 0o600 });
    writeFileSync(files.pid, '999999');

    await startDaemon({ home });
    const client = await connectDaemon(files.socket);
    onCleanup(() => client.close());

    expect(await client.hello(BUILD)).toMatchObject({ protocol: 1, build: BUILD });
    expect(readFileSync(files.token, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('start failures (AC10 reason)', () => {
  test('AC10 — COCKPIT_HOME a regular file: the start rejects with a message naming the path', async () => {
    const home = join(makeHome(), 'h');
    writeFileSync(home, 'a file, not a folder');

    await expect(runDaemon({ home, build: BUILD })).rejects.toThrow(home);

    expect(readFileSync(home, 'utf8')).toBe('a file, not a folder');
  });

  test('AC10 — the socket path is a folder: the start rejects with a message naming it and leaves it as it was', async () => {
    const home = makeHome();
    const { socket, token } = daemonFiles(home, 1, BUILD);
    mkdirSync(socket);
    writeFileSync(join(socket, 'inside'), 'kept');

    await expect(runDaemon({ home, build: BUILD })).rejects.toThrow(socket);

    expect(statSync(socket).isDirectory()).toBe(true);
    expect(readFileSync(join(socket, 'inside'), 'utf8')).toBe('kept');
    expect(exists(token)).toBe(false);
  });

  test('AC10 — a socket another daemon of the same build holds: the start rejects and the socket and token stay as they were', async () => {
    const { files, home } = await startDaemon();
    const before = { ino: statSync(files.socket).ino, token: readFileSync(files.token, 'utf8') };

    await expect(runDaemon({ home, build: BUILD })).rejects.toThrow(files.socket);

    expect(statSync(files.socket).ino).toBe(before.ino);
    expect(readFileSync(files.token, 'utf8')).toBe(before.token);
    await new Promise<void>((resolve, reject) => {
      const probe = connect(files.socket, () => {
        probe.destroy();
        resolve();
      });
      probe.on('error', reject);
    });
  });
});

describe('two daemons of one build started together (AC19)', () => {
  test.each([1, 2, 3])('AC19 — round %i: exactly one listens, the .token and .pid on disk are its, and the other rejects with "another daemon holds <path>" without touching the files', async () => {
    const home = makeHome();
    const files = daemonFiles(home, 1, BUILD);

    const settled = await Promise.allSettled([runDaemon({ home, build: BUILD }), runDaemon({ home, build: BUILD })]);

    const winners = settled.filter((outcome) => outcome.status === 'fulfilled');
    const losers = settled.filter((outcome) => outcome.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    onCleanup(() => winners[0]!.value.close());
    expect(String(losers[0]!.reason.message)).toContain(`another daemon holds ${files.socket}`);

    // The files are still there after the loser gave up, and the token on disk is the winner's.
    expect(statSync(files.socket).isSocket()).toBe(true);
    const token = readFileSync(files.token, 'utf8');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(files.pid, 'utf8').trim()).toBe(String(process.pid));
    const answer = await send(files.socket, { authorization: `Bearer ${token}`, body: JSON.stringify({ sessionId: 'nobody', event: 'working' }) });
    expect(answer.status, 'a request with the token on disk is not refused').toBe(404);
    const client = await connectDaemon(files.socket);
    onCleanup(() => client.close());
    expect(await client.hello(BUILD)).toMatchObject({ protocol: 1, build: BUILD });
  });
});
