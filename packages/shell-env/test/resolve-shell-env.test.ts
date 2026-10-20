import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
  warn.mockRestore();
  vi.mocked(userInfo).mockImplementation(real.userInfo);
  vi.mocked(os.homedir).mockImplementation(real.homedir);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
    const shell = fakeShell(
      [`echo $$ > "${pidFile}"`, 'sleep 60 &', `echo $! >> "${pidFile}"`, 'wait'].join('\n'),
    );

    const started = Date.now();
    const env = await resolveShellEnv({ shell, baseEnv, timeoutMs: 200 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(env).toEqual(baseEnv);
    expect(env).not.toBe(baseEnv);

    const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    // The kernel may need a moment to reap the killed processes.
    const deadline = Date.now() + 2000;
    while (pids.some(isAlive) && Date.now() < deadline) await sleep(25);
    expect(pids.map(isAlive)).toEqual([false, false]);
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
      // The startup leaves `sleep 30` running on purpose; the test cleans up.
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
      const shell = fakeShell(
        // `sleep` inherits the shell's stdout and is not redirected.
        ['sleep 30 &', `echo $! > "${pidFile}"`, `FROM_SHELL=yes /bin/sh -c "$2"`].join('\n'),
      );

      const started = Date.now();
      // Gives up waiting after 2.5 s, so a regression fails here instead of after 30 s.
      const env = await Promise.race([
        resolveShellEnv({ shell, baseEnv, timeoutMs: 5000 }),
        sleep(2500).then(() => undefined),
      ]);
      const elapsed = Date.now() - started;

      expect(env).toBeDefined();
      expect(elapsed).toBeLessThan(2000);
      expect(env!.FROM_SHELL).toBe('yes');
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
