import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadState, NewerStateError } from '../src/index';

let root: string;
let dir: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-state-test-'));
  dir = join(root, 'data');
  file = join(dir, 'state.json');
});

afterEach(() => {
  vi.restoreAllMocks();
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

    expect(loadState(dir)).toEqual({ version: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 });
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  test('AC1 — creates a data folder that does not exist yet, parents included', () => {
    dir = join(root, 'a', 'b', 'data');
    file = join(dir, 'state.json');

    expect(loadState(dir)).toEqual({ version: 1 });
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

    expect(loadState(dir)).toEqual({ version: 1, extra: ['kept'] });
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

    expect(loadState(dir)).toEqual({ version: 1 });

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

    expect(loadState(dir)).toEqual({ version: 1 });
    expect(snapshot()).toEqual(before);
    expect(backups()).toHaveLength(1);
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

    expect(loadState(dir)).toEqual({ version: 1, extra: 1 });
    expect(snapshot()).toEqual(before);
    expect(backups()).toEqual([]);
  });

  test('AC5 — a leftover state.json.tmp does not stop a first write, and none remains after it', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json.tmp'), '{half written');

    expect(loadState(dir)).toEqual({ version: 1 });
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
