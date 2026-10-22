import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addProject,
  addSession,
  loadState,
  NewerStateError,
  ProjectExistsError,
  removeProject,
  saveState,
  sessionName,
  type Session,
} from '../src/index';

// Records the calls `saveState` and `loadState` make on the file system, in
// order, while still running them for real (AC10). `fds` maps an open
// descriptor to the path it was opened on.
const calls = vi.hoisted(() => ({ log: [] as string[], fds: new Map<number, string>(), failLink: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const pathOf = (fd: number) => calls.fds.get(fd) ?? `fd ${fd}`;
  return {
    ...actual,
    openSync: ((path: string, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
      calls.fds.set(fd, String(path));
      calls.log.push(`open ${String(path)}`);
      return fd;
    }) as typeof actual.openSync,
    writeSync: ((fd: number, ...rest: unknown[]) => {
      calls.log.push(`write ${pathOf(fd)}`);
      return (actual.writeSync as (...args: unknown[]) => number)(fd, ...rest);
    }) as typeof actual.writeSync,
    fsyncSync: ((fd: number) => {
      calls.log.push(`fsync ${pathOf(fd)}`);
      return actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
    renameSync: ((from: string, to: string) => {
      calls.log.push(`rename ${String(from)} -> ${String(to)}`);
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
    // Fails like a volume without hard links when a test asks for it (AC21).
    linkSync: ((existing: string, created: string) => {
      if (calls.failLink) throw Object.assign(new Error(`EPERM: operation not permitted, link '${existing}' -> '${created}'`), { code: 'EPERM' });
      return actual.linkSync(existing, created);
    }) as typeof actual.linkSync,
  };
});

let root: string;
let dir: string;
let file: string;

beforeEach(() => {
  calls.log.length = 0;
  calls.fds.clear();
  calls.failLink = false;
  root = mkdtempSync(join(tmpdir(), 'cockpit-state-test-'));
  dir = join(root, 'data');
  file = join(dir, 'state.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const seed = (content: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, content);
  // An old mtime, so an untouched file is told from a rewritten one even when
  // both writes fall in the same clock tick.
  const past = new Date('2020-01-01T00:00:00Z');
  utimesSync(file, past, past);
};

const backups = () => readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'));
const snapshot = () => ({ content: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs });

describe('AC1 — missing file', () => {
  test('AC1 — returns { version: 1 } and writes it when the folder has no state.json', () => {
    mkdirSync(dir, { recursive: true });

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  test('AC1 — creates a data folder that does not exist yet, parents included', () => {
    dir = join(root, 'a', 'b', 'data');
    file = join(dir, 'state.json');

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    expect(readdirSync(dir)).toEqual(['state.json']);
  });
});

describe('AC2 — read back', () => {
  test('AC2 — a second load returns the same state and leaves the file untouched', () => {
    const first = loadState(dir);
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(file, past, past);
    const before = snapshot();

    expect(loadState(dir)).toEqual(first);
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  test('AC2 — returns the content of a valid file, fields included, without rewriting it', () => {
    seed('{ "version": 1, "extra": ["kept"] }\n');
    const before = snapshot();

    expect(loadState(dir)).toEqual({ version: 1, extra: ['kept'], projects: [], sessions: [] });
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
  });
});

describe('AC3 — corrupted file', () => {
  test.each([
    ['not JSON', '{not json'],
    ['an empty file', ''],
    ['an array', '[]'],
    ['null', 'null'],
    ['an object without version', '{}'],
    ['a string version', '{"version":"1"}'],
    ['version 0', '{"version":0}'],
    ['a negative version', '{"version":-1}'],
    ['a fractional version', '{"version":1.5}'],
  ])('AC3 — %s is set aside with its original bytes and replaced', (_name, content) => {
    seed(content);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });

    const found = backups();
    expect(found).toHaveLength(1);
    expect(readFileSync(join(dir, found[0]!), 'utf8')).toBe(content);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toContain(found[0]!);
  });

  test('AC3 — the backup name carries a filesystem-safe timestamp', () => {
    seed('{not json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadState(dir);

    expect(backups()[0]).toMatch(/^state\.json\.corrupt-[0-9TZ-]+$/);
  });

  test('AC3 — a replaced file reads back as valid on the next load', () => {
    seed('{not json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadState(dir);
    const before = snapshot();

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });
    expect(snapshot()).toEqual(before);
    expect(backups()).toHaveLength(1);
  });
});

// The name `loadState` gives the backup for a clock set to `at`.
const backupNameAt = (at: Date) => `state.json.corrupt-${at.toISOString().replace(/[:.]/g, '-')}`;

describe('AC21 — backup when the hard link fails', () => {
  test.each(['{not json', '', '[]'])(
    'AC21 — %j is kept as a copy with its original bytes, a fresh state.json is written and the app starts',
    (content) => {
      seed(content);
      calls.failLink = true;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });

      const found = backups();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/^state\.json\.corrupt-[0-9TZ-]+$/);
      expect(readFileSync(join(dir, found[0]!), 'utf8')).toBe(content);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
      expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]!.join(' ')).toContain(found[0]!);
    },
  );

  test('AC21 — a replaced file reads back as valid on the next load', () => {
    seed('{not json');
    calls.failLink = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadState(dir);
    const before = snapshot();

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });
    expect(snapshot()).toEqual(before);
    expect(backups()).toHaveLength(1);
  });
});

describe('AC22 — backup name already taken', () => {
  const at = new Date('2026-10-21T10:20:30.456Z');

  test('AC22 — the backup goes to the first free -<n> from 2 and the existing backup is left byte for byte', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    const taken = join(dir, backupNameAt(at));
    seed('{not json');
    writeFileSync(taken, 'an older backup');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });

    expect(readFileSync(taken, 'utf8')).toBe('an older backup');
    expect(backups().sort()).toEqual([backupNameAt(at), `${backupNameAt(at)}-2`]);
    expect(readFileSync(join(dir, `${backupNameAt(at)}-2`), 'utf8')).toBe('{not json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    expect(warn.mock.calls[0]!.join(' ')).toContain(`${backupNameAt(at)}-2`);
  });

  test('AC22 — with -2 taken too, the backup goes to -3', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    seed('{not json');
    writeFileSync(join(dir, backupNameAt(at)), 'first');
    writeFileSync(join(dir, `${backupNameAt(at)}-2`), 'second');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });

    expect(readFileSync(join(dir, backupNameAt(at)), 'utf8')).toBe('first');
    expect(readFileSync(join(dir, `${backupNameAt(at)}-2`), 'utf8')).toBe('second');
    expect(readFileSync(join(dir, `${backupNameAt(at)}-3`), 'utf8')).toBe('{not json');
  });

  test('AC22 — the same holds when the hard link fails and the backup is a copy', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    seed('{not json');
    writeFileSync(join(dir, backupNameAt(at)), 'first');
    calls.failLink = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });

    expect(readFileSync(join(dir, backupNameAt(at)), 'utf8')).toBe('first');
    expect(readFileSync(join(dir, `${backupNameAt(at)}-2`), 'utf8')).toBe('{not json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
  });
});

describe('AC4 — file from a newer version', () => {
  test.each(['{"version":2}', '{"version":99,"projects":[]}'])(
    'AC4 — %s throws NewerStateError and leaves the file alone',
    (content) => {
      seed(content);
      const before = snapshot();
      const version = (JSON.parse(content) as { version: number }).version;

      let error: unknown;
      try {
        loadState(dir);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(NewerStateError);
      expect(error).toBeInstanceOf(Error);
      expect((error as NewerStateError).path).toBe(file);
      expect((error as NewerStateError).version).toBe(version);
      expect(snapshot()).toEqual(before);
      expect(readdirSync(dir)).toEqual(['state.json']);
    },
  );
});

describe('AC5 — atomic write', () => {
  test('AC5 — a leftover state.json.tmp next to a valid state.json is ignored', () => {
    seed('{ "version": 1, "extra": 1 }');
    writeFileSync(join(dir, 'state.json.tmp'), '{half written');
    const before = snapshot();

    expect(loadState(dir)).toEqual({ version: 1, extra: 1, projects: [], sessions: [] });
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
  });

  test('AC5 — a leftover state.json.tmp does not stop a first write, and none remains after it', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json.tmp'), '{half written');

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
  });

  test('AC5 — a write after a corrupted file leaves no state.json.tmp', () => {
    seed('[]');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadState(dir);

    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([...backups(), 'state.json'].sort());
  });
});

// What `loadState` throws, or undefined when it returns.
const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (caught) {
    return caught;
  }
  return undefined;
};

describe('AC8 — file that cannot be read', () => {
  test('AC8 — a folder named state.json throws EISDIR and nothing is renamed or created', () => {
    mkdirSync(file, { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const error = thrownBy(() => loadState(dir));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NewerStateError);
    expect((error as NodeJS.ErrnoException).code).toBe('EISDIR');
    expect(statSync(file).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual(['state.json']);
    expect(readdirSync(file)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  // A file without read permission cannot be told from a corrupted one by its
  // content, which is unreadable: it must not be set aside nor replaced.
  test.skipIf(process.getuid?.() === 0)('AC8 — a file without read permission throws EACCES and is left untouched', () => {
    seed('{"version":1,"extra":"kept"}');
    const before = snapshot();
    chmodSync(file, 0o000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const error = thrownBy(() => loadState(dir));

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NewerStateError);
      expect((error as NodeJS.ErrnoException).code).toBe('EACCES');
      expect(readdirSync(dir)).toEqual(['state.json']);
      expect(statSync(file).mode & 0o777).toBe(0o000);
      expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      // Restored so the folder can be removed and the content checked.
      chmodSync(file, 0o644);
    }
    expect(snapshot()).toEqual(before);
  });
});

describe('AC8, AC9 — projects field absent or valid', () => {
  test('AC8 — a version 1 file without projects reads as projects: [] and is not rewritten', () => {
    seed('{ "version": 1 }\n');
    const before = snapshot();

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  test('AC9 — a valid list is returned as written, in order, without rewriting the file', () => {
    seed('{ "version": 1, "projects": [{ "path": "/b" }, { "path": "/a" }] }\n');
    const before = snapshot();

    expect(loadState(dir)).toEqual({ version: 1, projects: [{ path: '/b' }, { path: '/a' }], sessions: [] });
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
  });

  test('AC9 — an empty list is valid', () => {
    seed('{ "version": 1, "projects": [] }\n');
    const before = snapshot();

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
  });
});

describe('AC9 — malformed projects', () => {
  test.each([
    ['a string', '"x"'],
    ['null', 'null'],
    ['an object', '{}'],
    ['a number', '3'],
    ['an array of numbers', '[1]'],
    ['an array holding null', '[null]'],
    ['an object without path', '[{}]'],
    ['a numeric path', '[{ "path": 3 }]'],
    ['a valid project followed by an invalid one', '[{ "path": "/a" }, { "path": null }]'],
  ])('AC9 — projects as %s is set aside with its original bytes and replaced', (_name, projects) => {
    const content = `{ "version": 1, "projects": ${projects} }\n`;
    seed(content);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });

    const found = backups();
    expect(found).toHaveLength(1);
    expect(readFileSync(join(dir, found[0]!), 'utf8')).toBe(content);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toContain(found[0]!);
  });
});

describe('AC10 — durable write', () => {
  const tmp = () => join(dir, 'state.json.tmp');

  // The calls that matter, in order; the open of the temporary file is left out.
  const durableSteps = () => calls.log.filter((entry) => entry !== `open ${tmp()}`);

  const expected = () => [
    `write ${tmp()}`,
    `fsync ${tmp()}`,
    `rename ${tmp()} -> ${file}`,
    `open ${dir}`,
    `fsync ${dir}`,
  ];

  test('AC10 — saveState writes the temp file, fsyncs it, renames it, then opens the folder and fsyncs it', () => {
    mkdirSync(dir, { recursive: true });
    calls.log.length = 0;

    saveState(dir, { version: 1, projects: [{ path: '/a' }], sessions: [] });

    expect(durableSteps()).toEqual(expected());
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, projects: [{ path: '/a' }], sessions: [] });
    expect(existsSync(tmp())).toBe(false);
  });

  test('AC10 — the first write of loadState goes through the same steps', () => {
    loadState(dir);

    expect(durableSteps()).toEqual(expected());
  });

  test('AC10 — the write that replaces a corrupted file goes through the same steps', () => {
    seed('[]');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    calls.log.length = 0;

    loadState(dir);

    expect(durableSteps()).toEqual(expected());
  });

  test('AC10 — a leftover state.json.tmp is overwritten, and none remains', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp(), '{half written, much longer than the state that replaces it'.repeat(20));

    saveState(dir, { version: 1, projects: [], sessions: [] });

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, projects: [], sessions: [] });
    expect(existsSync(tmp())).toBe(false);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  test('AC10 — what saveState wrote loads back as the same state, without a rewrite', () => {
    mkdirSync(dir, { recursive: true });
    const state = { version: 1, projects: [{ path: '/b' }, { path: '/a' }], sessions: [] };
    saveState(dir, state);
    const before = snapshot();

    expect(loadState(dir)).toEqual(state);
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
  });
});

describe('AC11 — addProject and removeProject', () => {
  test('AC11 — addProject appends the project and leaves the given state alone', () => {
    const state = { version: 1, projects: [{ path: '/a' }], sessions: [] };

    const next = addProject(state, '/b');

    expect(next).toEqual({ version: 1, projects: [{ path: '/a' }, { path: '/b' }], sessions: [] });
    expect(state).toEqual({ version: 1, projects: [{ path: '/a' }], sessions: [] });
  });

  test('AC11 — addProject keeps the other fields of the state', () => {
    const state = { version: 1, extra: 'kept', projects: [], sessions: [] };

    const next = addProject(state, '/a');

    expect(next).toEqual({ version: 1, extra: 'kept', projects: [{ path: '/a' }], sessions: [] });
  });

  test('AC11 — addProject throws ProjectExistsError for a path already in the state, and returns nothing', () => {
    const state = { version: 1, projects: [{ path: '/a' }, { path: '/b' }], sessions: [] };
    let result: unknown;

    const error = (() => {
      try {
        result = addProject(state, '/a');
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(ProjectExistsError);
    expect(error).toBeInstanceOf(Error);
    expect(result).toBeUndefined();
    expect(state).toEqual({ version: 1, projects: [{ path: '/a' }, { path: '/b' }], sessions: [] });
  });

  test('AC11 — removeProject removes the project and keeps the order of the others', () => {
    const state = { version: 1, projects: [{ path: '/a' }, { path: '/b' }, { path: '/c' }], sessions: [] };

    const next = removeProject(state, '/b');

    expect(next).toEqual({ version: 1, projects: [{ path: '/a' }, { path: '/c' }], sessions: [] });
    expect(state.projects).toHaveLength(3);
  });

  test('AC11 — removeProject with an unknown path returns a state with the same projects', () => {
    const state = { version: 1, projects: [{ path: '/a' }, { path: '/b' }], sessions: [] };

    const next = removeProject(state, '/unknown');

    expect(next.projects).toEqual([{ path: '/a' }, { path: '/b' }]);
    expect(next.version).toBe(1);
  });
});

// --- Sessions (COCKPIT-25) ---------------------------------------------------

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'id-1',
  name: 'Claude Code 1',
  harness: 'claude-code',
  directory: '/home/.cockpit/sessions/id-1',
  createdAt: '2026-10-21T10:00:00.000Z',
  ...overrides,
});

describe('sessions AC12 — field absent or valid', () => {
  test('AC12 — a version 1 file without sessions reads as sessions: [] and is not rewritten', () => {
    seed('{ "version": 1, "projects": [{ "path": "/a" }] }\n');
    const before = snapshot();

    expect(loadState(dir)).toEqual({ version: 1, projects: [{ path: '/a' }], sessions: [] });
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  test('AC12 — a valid list is returned as written, in order, without rewriting the file', () => {
    const stored = [session({ id: 'b', name: 'Codex 1', harness: 'codex' }), session({ id: 'a' })];
    seed(`${JSON.stringify({ version: 1, sessions: stored })}\n`);
    const before = snapshot();

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: stored });
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
  });

  test('AC12 — an empty list is valid', () => {
    seed('{ "version": 1, "sessions": [] }\n');
    const before = snapshot();

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
  });

  test('AC12 — saveState writes the sessions and they load back as the same state, without a rewrite', () => {
    mkdirSync(dir, { recursive: true });
    const state = { version: 1, projects: [], sessions: [session()] };
    saveState(dir, state);
    const before = snapshot();

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(state);
    expect(loadState(dir)).toEqual(state);
    expect(snapshot()).toEqual(before);
  });
});

describe('sessions AC12 — malformed sessions', () => {
  const valid = JSON.stringify(session());
  const without = (field: keyof Session) =>
    JSON.stringify(Object.fromEntries(Object.entries(session()).filter(([key]) => key !== field)));

  test.each([
    ['a string', '"x"'],
    ['null', 'null'],
    ['an object', '{}'],
    ['a number', '3'],
    ['an array of numbers', '[1]'],
    ['an array holding null', '[null]'],
    ['an empty object', '[{}]'],
    ['a session without id', `[${without('id')}]`],
    ['a session without name', `[${without('name')}]`],
    ['a session without harness', `[${without('harness')}]`],
    ['a session without directory', `[${without('directory')}]`],
    ['a session without createdAt', `[${without('createdAt')}]`],
    ['a numeric id', `[${JSON.stringify({ ...session(), id: 3 })}]`],
    ['a null name', `[${JSON.stringify({ ...session(), name: null })}]`],
    ['a numeric harness', `[${JSON.stringify({ ...session(), harness: 1 })}]`],
    ['an array directory', `[${JSON.stringify({ ...session(), directory: ['/a'] })}]`],
    ['a numeric createdAt', `[${JSON.stringify({ ...session(), createdAt: 1761040000000 })}]`],
    ['a valid session followed by an invalid one', `[${valid}, {"id":"x"}]`],
  ])('AC12 — sessions as %s is set aside with its original bytes and replaced', (_name, sessions) => {
    const content = `{ "version": 1, "sessions": ${sessions} }\n`;
    seed(content);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadState(dir)).toEqual({ version: 1, projects: [], sessions: [] });

    const found = backups();
    expect(found).toHaveLength(1);
    expect(readFileSync(join(dir, found[0]!), 'utf8')).toBe(content);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toContain(found[0]!);
  });
});

describe('sessions AC3, AC5 — addSession and sessionName', () => {
  test('AC3 — addSession appends the session, leaves the given state alone and keeps its other fields', () => {
    const first = session();
    const second = session({ id: 'id-2', name: 'Codex 1', harness: 'codex' });
    const state = { version: 1, extra: 'kept', projects: [{ path: '/a' }], sessions: [first] };

    const next = addSession(state, second);

    expect(next).toEqual({ version: 1, extra: 'kept', projects: [{ path: '/a' }], sessions: [first, second] });
    expect(state).toEqual({ version: 1, extra: 'kept', projects: [{ path: '/a' }], sessions: [first] });
    expect(next).not.toBe(state);
  });

  test('AC5 — sessionName is "<name> 1" for the first session of a harness', () => {
    const state = { version: 1, projects: [], sessions: [] };

    expect(sessionName(state, { id: 'claude-code', name: 'Claude Code' })).toBe('Claude Code 1');
  });

  test('AC5 — sessionName counts the sessions of that harness only', () => {
    const state = {
      version: 1,
      projects: [],
      sessions: [
        session({ id: '1', name: 'Claude Code 1' }),
        session({ id: '2', name: 'Codex 1', harness: 'codex' }),
        session({ id: '3', name: 'Claude Code 2' }),
      ],
    };

    expect(sessionName(state, { id: 'claude-code', name: 'Claude Code' })).toBe('Claude Code 3');
    expect(sessionName(state, { id: 'codex', name: 'Codex' })).toBe('Codex 2');
    expect(sessionName(state, { id: 'opencode', name: 'OpenCode' })).toBe('OpenCode 1');
  });

  test('AC5 — sessionName does not change the state', () => {
    const state = { version: 1, projects: [], sessions: [session()] };

    sessionName(state, { id: 'claude-code', name: 'Claude Code' });

    expect(state).toEqual({ version: 1, projects: [], sessions: [session()] });
  });
});
