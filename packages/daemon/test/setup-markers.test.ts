import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runSetup, type SetupIo, type SetupReport } from '../src/setup';
import { fifo, registerCleanup } from './helpers';

registerCleanup();

// COCKPIT-66 (AC23, AC24): `cockpit setup` writes the private OSC 6973 markers around the agent, in the
// stream and in order, and its reports never hold the run back. `runSetup` with a fake io: the setup
// commands, the stub agent and the stub login shell append to one log file, and so does the io's stdout,
// so the order of the markers against what the processes print is the order of the log. A temporary
// repository with one linked worktree.

const STARTED = '\u001b]6973;agent-started\u0007';
const EXITED = '\u001b]6973;agent-exited\u0007';

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv }, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let worktree: string;
let agent: string;
let shell: string;
let failingAgent: string;
let log: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ck-')));
  repo = join(root, 'repo');
  worktree = join(root, 'wt');
  mkdirSync(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'first');
  git(repo, 'worktree', 'add', '--quiet', '-b', 'feat-markers', worktree, 'main');

  agent = join(root, 'agent');
  shell = join(root, 'login-shell');
  failingAgent = join(root, 'agent-exits-3');
  writeFileSync(agent, '#!/bin/sh\necho agent-ran >> "$LOG"\n');
  writeFileSync(failingAgent, '#!/bin/sh\necho agent-ran >> "$LOG"\nexit 3\n');
  writeFileSync(shell, '#!/bin/sh\necho shell-ran >> "$LOG"\n[ -z "$DONE" ] || echo done > "$DONE"\n');
  for (const stub of [agent, shell, failingAgent]) chmodSync(stub, 0o755);
  // macOS scans a new executable the first time it runs.
  const warm = join(root, 'warm.log');
  for (const stub of [agent, shell]) execFileSync(stub, [], { env: { LOG: warm } });
  spawnSync(failingAgent, [], { env: { LOG: warm } });
  log = join(root, 'run.log');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function writeConfig(setup: string[]) {
  rmSync(join(repo, '.cockpit'), { recursive: true, force: true });
  mkdirSync(join(repo, '.cockpit'));
  writeFileSync(join(repo, '.cockpit', 'config.json'), JSON.stringify({ setup }));
}

/** The log as a list of events: the two markers, and what the commands, the agent and the shell printed. */
function events(): string[] {
  return readFileSync(log, 'utf8')
    .replaceAll(STARTED, '\n<started>\n')
    .replaceAll(EXITED, '\n<exited>\n')
    .split('\n')
    .filter((line) => /^(<started>|<exited>|setup-ran|agent-ran|shell-ran)$/.test(line));
}

function makeIo(report: (report: SetupReport) => Promise<void> = async () => {}): SetupIo {
  writeFileSync(log, '');
  return { cwd: worktree, stdout: { write: (text: string) => void appendFileSync(log, text) }, report };
}

const env = () => ({ PATH: '/usr/bin:/bin', SHELL: shell, LOG: log });

describe('cockpit setup: agent markers', () => {
  test('AC24 — the start marker comes after the setup commands and before the agent, the exit marker right after the agent and before the login shell', async () => {
    writeConfig(['echo setup-ran >> "$LOG"']);
    const io = makeIo();

    const code = await runSetup({ shell: true, agent: [agent] }, io, env());

    expect(code).toBe(0);
    expect(events()).toEqual(['setup-ran', '<started>', 'agent-ran', '<exited>', 'shell-ran']);
  });

  test('AC23 — without setup commands the start marker is written at once, right before the agent, and the exit marker follows an agent that failed too', async () => {
    writeConfig([]);
    const reports: SetupReport[] = [];
    const io = makeIo(async (report) => void reports.push(report));

    const code = await runSetup({ shell: false, agent: [failingAgent] }, io, env());

    expect(code).toBe(3);
    expect(events()).toEqual(['<started>', 'agent-ran', '<exited>']);
    expect(reports).toEqual([{ event: 'exited', exitCode: 3 }]);
  });

  test('AC24 — no marker without --then, and none when a failed setup keeps the agent from starting', async () => {
    writeConfig(['echo setup-ran >> "$LOG"']);
    const withoutAgent = makeIo();
    await runSetup({ shell: true, agent: [] }, withoutAgent, env());
    expect(events()).toEqual(['setup-ran', 'shell-ran']);

    writeConfig(['echo setup-ran >> "$LOG"', 'exit 4']);
    const failing = makeIo();
    await runSetup({ shell: true, agent: [agent] }, failing, env());
    expect(events()).toEqual(['setup-ran', 'shell-ran']);
  });

  test('AC23 — a report the daemon never answers delays neither the setup commands, the agent, the markers nor the shell', async () => {
    writeConfig(['echo setup-ran >> "$LOG"']);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const io = makeIo(() => gate);
    // The login shell, the last step of the run, writes to it once it has logged.
    const shellRan = fifo();

    const running = runSetup({ shell: true, agent: [agent] }, io, { ...env(), DONE: shellRan.path });
    try {
      await shellRan.line();
      expect(events()).toEqual(['setup-ran', '<started>', 'agent-ran', '<exited>', 'shell-ran']);
    } finally {
      release();
      await running;
    }
  });
});
