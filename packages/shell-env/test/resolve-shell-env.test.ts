import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, close, constants, mkdtempSync, open, read, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveShellEnv } from '../src/index';

// `userInfo` and `homedir` are spies that call the real ones, so AC9 and AC10
// can make them throw.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, default: os, userInfo: vi.fn(os.userInfo), homedir: vi.fn(os.homedir) };
});

// The real functions, to put the spies back after a test that made them throw.
const real = await vi.importActual<typeof import('node:os')>('node:os');

// Every test runs `resolveShellEnv` against a fake shell: a small `#!/bin/sh`
// script. Like a real shell it receives `-ilc` as `$1` and the command to run
// as `$2`.

let dir: string;
let counter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-env-test-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes an executable fake shell and returns its path. macOS scans a new
 * executable the first time it runs, which takes over 100 ms, so the shell is
 * run once here (it exits at once with `--warmup`): the timing of the tests
 * then reflects `resolveShellEnv`, not the scan.
 */
function fakeShell(body: string): string {
  const path = join(dir, `shell-${counter++}`);
  writeFileSync(path, `#!/bin/sh\n[ "$1" = --warmup ] && exit 0\n${body}\n`);
  chmodSync(path, 0o755);
  execFileSync(path, ['--warmup']);
  return path;
}

const baseEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: homedir(), BASE_ONLY: 'from-base' };

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
  vi.mocked(userInfo).mockImplementation(real.userInfo);
  vi.mocked(os.homedir).mockImplementation(real.homedir);
});

/** Resolves once the process has exited (macOS's `caffeinate -w <pid>` returns then; it may return before the process is reaped). */
function exited(pid: number): Promise<void> {
  return new Promise((resolve) => execFile('/usr/bin/caffeinate', ['-w', String(pid)], () => resolve()));
}

/** Whether a process has ended: no longer listed, or a zombie (killed, not reaped yet: `kill(pid, 0)` still sees it). */
function hasEnded(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    return state === '' || state.startsWith('Z');
  } catch {
    // `ps` exits 1 when no process matches.
    return true;
  }
}

/**
 * A pipe the test holds: `snippet` makes the running shell hold its write end on descriptor 9, which its
 * children inherit. `started` resolves with the first line a process writes to it, `gone` once no process
 * holds the write end any more (end of file). `hold` is a FIFO nobody writes to: a process reading it
 * lives until it is killed.
 */
function heldPipe(): { snippet: string; hold: string; started: Promise<void>; gone: Promise<void> } {
  const path = join(dir, `pipe-${counter++}`);
  const hold = join(dir, `hold-${counter++}`);
  execFileSync('mkfifo', [path]);
  execFileSync('mkfifo', [hold]);
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const gone = new Promise<void>((resolve, reject) => {
    // The open returns once the first writer has opened the FIFO, so no end of file comes before it. The
    // read blocks a thread of libuv's pool until a byte or the end of file: kqueue does not report a
    // FIFO's end of file on macOS, so a stream over the descriptor would never end.
    open(path, constants.O_RDONLY, (error, fd) => {
      if (error) return reject(error);
      const next = () =>
        read(fd, Buffer.alloc(16), 0, 16, null, (failure, bytes) => {
          if (failure) reject(failure);
          else if (bytes > 0) {
            markStarted();
            next();
          } else close(fd, () => resolve());
        });
      next();
    });
  });
  return { snippet: `exec 9> '${path}'`, hold, started, gone };
}

describe('resolveShellEnv', () => {
  test('AC4 — keeps multi-line and `=` values byte for byte and drops the text the shell prints', async () => {
    const shell = fakeShell(
      [
        'echo noise before',
        `FOO="$(printf 'a\\nb')" BAR='x=y' /bin/sh -c "$2"`,
        'echo noise after',
      ].join('\n'),
    );

    const env = await resolveShellEnv({ shell, baseEnv });

    expect(env.FOO).toBe('a\nb');
    expect(env.BAR).toBe('x=y');
    expect(env.BASE_ONLY).toBe('from-base');
    expect(env.PATH).toBe('/usr/bin:/bin');
    const everything = JSON.stringify(env);
    expect(everything).not.toContain('noise');
    expect(everything).not.toContain('__COCKPIT_SHELL_ENV__');
    expect(warn).not.toHaveBeenCalled();
  });

  test('AC5 — gives up on a shell that never exits, in time, and kills the shell and its child', async () => {
    const pidFile = join(dir, 'hanging-pids');
    const { snippet, hold, started, gone } = heldPipe();
    // The shell reports on the pipe once its first lines ran, so the product's clock is advanced only then:
    // under load a shell can take longer than the timeout to run its first line. Its background child
    // inherits the shell's stdout, so the shell's output stays open, and the pipe of the test (descriptor 9) too.
    const shell = fakeShell(
      [snippet, `echo $$ > "${pidFile}"`, `read _ < "${hold}" &`, `echo $! >> "${pidFile}"`, 'echo up >&9', 'wait'].join('\n'),
    );

    // Only the product's timer is the test's clock: files, pipes and processes stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const resolving = resolveShellEnv({ shell, baseEnv, timeoutMs: 200 });
    await started;

    const advancedAt = Date.now();
    vi.advanceTimersByTime(200);
    const env = await resolving;
    const elapsed = Date.now() - advancedAt;

    expect(elapsed).toBeLessThan(2000);
    expect(env).toEqual(baseEnv);
    expect(env).not.toBe(baseEnv);

    const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    // Every holder of the pipe, the shell and its child, is gone.
    await gone;
    // And so are the two processes: `caffeinate -w` returns at a process's exit (at once if it is gone).
    await Promise.all(pids.map(exited));
    expect(pids.map(hasEnded)).toEqual([true, true]);
  });

  test('AC6 — resolves to the base environment and warns once, with the spawn error, when the shell does not exist', async () => {
    const shell = join(dir, 'does-not-exist');

    const env = await resolveShellEnv({ shell, baseEnv });

    expect(env).toEqual(baseEnv);
    expect(env).not.toBe(baseEnv);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain(shell);
    expect(message).toContain('ENOENT');
  });

  test.each([
    ['exits with an error', 'exit 1', 1],
    ['exits without printing the environment', 'echo nothing useful; exit 0', 0],
    ['exits with another code without printing the environment', 'exit 7', 7],
  ])(
    'AC6 — resolves to the base environment and warns once, with the exit code, when the shell %s',
    async (_name, body, code) => {
      const shell = fakeShell(body);

      const env = await resolveShellEnv({ shell, baseEnv });

      expect(env).toEqual(baseEnv);
      expect(env).not.toBe(baseEnv);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain(shell);
      expect(message).toContain(`it printed no environment (exit code ${code})`);
    },
  );

  describe('AC7 — injected variables, removed keys and working directory', () => {
    const injected = {
      COCKPIT_RESOLVING_ENVIRONMENT: '1',
      DISABLE_AUTO_UPDATE: 'true',
      ZSH_TMUX_AUTOSTARTED: 'true',
      ZSH_TMUX_AUTOSTART: 'false',
    };

    function recordingShell(): { shell: string; read(file: string): string } {
      const out = join(dir, `record-${counter++}`);
      const shell = fakeShell(
        [
          `mkdir -p "${out}"`,
          `pwd > "${out}/pwd"`,
          `printf '%s\\n%s\\n%s\\n%s\\n' "$COCKPIT_RESOLVING_ENVIRONMENT" "$DISABLE_AUTO_UPDATE" "$ZSH_TMUX_AUTOSTARTED" "$ZSH_TMUX_AUTOSTART" > "${out}/vars"`,
          // Like a real shell, leave the bookkeeping variables in the environment.
          `SHLVL=3 OLDPWD=/somewhere _=/usr/bin/something /bin/sh -c "$2"`,
        ].join('\n'),
      );
      return { shell, read: (file) => readFileSync(join(out, file), 'utf8') };
    }

    test('the shell receives the four variables and starts in the home directory; the result has none of them', async () => {
      const { shell, read } = recordingShell();

      const env = await resolveShellEnv({ shell, baseEnv });

      expect(read('vars')).toBe('1\ntrue\ntrue\nfalse\n');
      expect(realpathSync(read('pwd').trim())).toBe(realpathSync(homedir()));
      for (const key of Object.keys(injected)) expect(env).not.toHaveProperty(key);
      for (const key of ['_', 'SHLVL', 'PWD', 'OLDPWD']) expect(env).not.toHaveProperty(key);
      expect(env.BASE_ONLY).toBe('from-base');
    });

    test('keeps the base value of an injected variable the base environment already had', async () => {
      const { shell, read } = recordingShell();
      const base = {
        ...baseEnv,
        COCKPIT_RESOLVING_ENVIRONMENT: 'base-1',
        DISABLE_AUTO_UPDATE: 'base-2',
        ZSH_TMUX_AUTOSTARTED: 'base-3',
        ZSH_TMUX_AUTOSTART: 'base-4',
      };

      const env = await resolveShellEnv({ shell, baseEnv: base });

      // The shell still sees the injected values.
      expect(read('vars')).toBe('1\ntrue\ntrue\nfalse\n');
      expect(env.COCKPIT_RESOLVING_ENVIRONMENT).toBe('base-1');
      expect(env.DISABLE_AUTO_UPDATE).toBe('base-2');
      expect(env.ZSH_TMUX_AUTOSTARTED).toBe('base-3');
      expect(env.ZSH_TMUX_AUTOSTART).toBe('base-4');
      for (const key of ['_', 'SHLVL', 'PWD', 'OLDPWD']) expect(env).not.toHaveProperty(key);
    });
  });

  describe('AC8 — a background process that holds stdout open', () => {
    const pidFiles: string[] = [];

    afterEach(() => {
      // The startup leaves its background process running on purpose; the test cleans up.
      for (const file of pidFiles.splice(0)) {
        try {
          process.kill(Number(readFileSync(file, 'utf8').trim()), 'SIGKILL');
        } catch {
          // Never started, or already gone.
        }
      }
    });

    test('resolves to the shell environment, in time, without a warning', async () => {
      const pidFile = join(dir, `background-pid-${counter++}`);
      pidFiles.push(pidFile);
      const hold = join(dir, `hold-${counter++}`);
      execFileSync('mkfifo', [hold]);
      const shell = fakeShell(
        // The background process inherits the shell's stdout and is not redirected; nobody writes to its FIFO.
        [`read _ < "${hold}" &`, `echo $! > "${pidFile}"`, `FROM_SHELL=yes /bin/sh -c "$2"`].join('\n'),
      );

      const started = Date.now();
      // A regression (waiting for the background process) ends at the 5 s timeout with the base environment.
      const env = await resolveShellEnv({ shell, baseEnv, timeoutMs: 5000 });
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(2000);
      expect(env.FROM_SHELL).toBe('yes');
      expect(env.BASE_ONLY).toBe('from-base');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('AC9 — no shell found and no passwd entry', () => {
    test('resolves to the base environment, warns once with the exact text, and neither throws nor rejects', async () => {
      vi.mocked(userInfo).mockImplementation(() => {
        throw new Error('ENOENT: no matching entry in passwd file');
      });
      const { SHELL: _shell, ...withoutShell } = baseEnv;
      let promise!: Promise<NodeJS.ProcessEnv>;
      expect(() => {
        promise = resolveShellEnv({ baseEnv: withoutShell });
      }).not.toThrow();

      const env = await promise;

      expect(env).toEqual(withoutShell);
      expect(env).not.toBe(withoutShell);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Could not find a login shell. Using the app's environment.");
      expect(String(warn.mock.calls[0]![0])).not.toContain('undefined');
    });
  });

  describe('AC10 — a shell is set but the home directory cannot be found', () => {
    test('resolves to the base environment, warns once naming the shell and the error, and neither throws nor rejects', async () => {
      const shell = fakeShell(`FROM_SHELL=yes /bin/sh -c "$2"`);
      vi.mocked(os.homedir).mockImplementation(() => {
        throw new Error('no HOME and no passwd entry');
      });
      const withShell = { ...baseEnv, SHELL: shell };
      let promise!: Promise<NodeJS.ProcessEnv>;
      expect(() => {
        promise = resolveShellEnv({ baseEnv: withShell });
      }).not.toThrow();

      const env = await promise;

      expect(env).toEqual(withShell);
      expect(env).not.toBe(withShell);
      expect(env).not.toHaveProperty('FROM_SHELL');
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain(shell);
      expect(message).toContain('no HOME and no passwd entry');
    });
  });
});
