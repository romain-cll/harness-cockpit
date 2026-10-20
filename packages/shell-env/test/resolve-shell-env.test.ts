import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveShellEnv } from '../src/index';

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

  test('AC6 — resolves to the base environment and warns once when the shell does not exist', async () => {
    const shell = join(dir, 'does-not-exist');

    const env = await resolveShellEnv({ shell, baseEnv });

    expect(env).toEqual(baseEnv);
    expect(env).not.toBe(baseEnv);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(shell);
  });

  test.each([
    ['exits with an error', 'exit 1'],
    ['exits without printing the environment', 'echo nothing useful; exit 0'],
  ])('AC6 — resolves to the base environment and warns once when the shell %s', async (_name, body) => {
    const shell = fakeShell(body);

    const env = await resolveShellEnv({ shell, baseEnv });

    expect(env).toEqual(baseEnv);
    expect(env).not.toBe(baseEnv);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(shell);
  });

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
});
