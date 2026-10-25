import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SESSION_EVENTS, startControlServer, statusCommand, type SessionEvent } from '../src/index';

// The shell line a harness hook runs to report a session's status. It is run the way the
// harnesses run it, by `/bin/sh -c`, against a real control server in a short temporary
// folder (macOS limits a socket path to 103 bytes).

const folders: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function makeFolder() {
  const folder = mkdtempSync(join(tmpdir(), 'ck-'));
  folders.push(folder);
  return folder;
}

async function start(known: string[]) {
  const received: SessionEvent[] = [];
  const dir = makeFolder();
  const server = await startControlServer({
    dir,
    onSessionEvent: (event) => {
      received.push(event);
      return known.includes(event.sessionId);
    },
  });
  closers.push(() => server.close());
  return { server, received };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runStatus(event: (typeof SESSION_EVENTS)[number], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', statusCommand(event)], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException & { code?: number }).code as number | undefined) : 0;
      resolve({ code: code ?? null, stdout, stderr });
    });
  });
}

describe('statusCommand', () => {
  test.each(SESSION_EVENTS)('AC1 — run by /bin/sh -c with the socket and the session id, the endpoint receives { sessionId, event: %s }, and the command exits 0 with no output', async (event) => {
    const { server, received } = await start(['session-1']);

    const run = await runStatus(event, { COCKPIT_SOCKET: server.socketPath, COCKPIT_SESSION_ID: 'session-1' });

    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(received).toEqual([{ sessionId: 'session-1', event }]);
  });

  test('AC1 — with COCKPIT_SOCKET unset it sends nothing, exits 0 and prints nothing', async () => {
    const { received } = await start(['session-1']);

    const run = await runStatus('working', { COCKPIT_SESSION_ID: 'session-1' });

    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(received).toEqual([]);
  });

  test('AC1 — with no listener on the socket (the app has quit, its token file stays) it exits 0 and prints nothing', async () => {
    const { server } = await start(['session-1']);
    await server.close();

    const run = await runStatus('waiting', { COCKPIT_SOCKET: server.socketPath, COCKPIT_SESSION_ID: 'session-1' });

    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  test('AC1 — with an unknown session id the endpoint answers 404 and the command still exits 0 and prints nothing', async () => {
    const { server, received } = await start(['session-1']);

    const run = await runStatus('finished', { COCKPIT_SOCKET: server.socketPath, COCKPIT_SESSION_ID: 'nobody' });

    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(received).toEqual([{ sessionId: 'nobody', event: 'finished' }]);
  });
});
