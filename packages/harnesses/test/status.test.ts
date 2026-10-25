import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { codexTrustHash, statusLaunch } from '../src/index';

// How each harness is told to report its status. The commands are fake here (`status <event>`),
// the real one is `statusCommand` of `@cockpit/control`; the package has no dependency on it.
//
// Interface the tests assume, from the spec's technical plan:
//   statusLaunch(harnessId, { command, pluginsDir, env }) -> Promise<{ args, env }>
//   `command(event)` is the shell line for `working` | `waiting` | `finished`;
//   `pluginsDir` is `$COCKPIT_HOME/plugins` (OpenCode's plugin goes in `<pluginsDir>/opencode-status/`);
//   `env` is the login shell's environment.
//   codexTrustHash(eventName, command, matcher?) -> 'sha256:<hex>'

vi.setConfig({ testTimeout: 30_000 });

type Event = 'working' | 'waiting' | 'finished';
const command = (event: Event) => `status ${event}`;

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-status-')));
  created.push(dir);
  return dir;
}

async function launch(id: 'claude-code' | 'codex' | 'opencode', env: NodeJS.ProcessEnv = {}) {
  const pluginsDir = await tempDir();
  const result = await statusLaunch(id, { command, pluginsDir, env });
  return { ...result, pluginsDir, folder: join(pluginsDir, 'opencode-status') };
}

describe('Claude Code (AC2)', () => {
  test('AC2 — --settings <inline JSON> whose hooks run the status command: working, waiting and finished events, each a synchronous command hook with timeout 5 and no matcher', async () => {
    const { args, pluginsDir } = await launch('claude-code');

    expect(args).toHaveLength(2);
    expect(args[0]).toBe('--settings');
    const settings = JSON.parse(args[1]!) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> };

    const expected: Record<string, Event> = {
      UserPromptSubmit: 'working',
      PostToolUse: 'working',
      PostToolUseFailure: 'working',
      ElicitationResult: 'working',
      PermissionRequest: 'waiting',
      Elicitation: 'waiting',
      Stop: 'finished',
      StopFailure: 'finished',
    };
    expect(Object.keys(settings.hooks).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, event] of Object.entries(expected)) {
      const groups = settings.hooks[name]!;
      expect(groups, name).toHaveLength(1);
      expect(groups[0]!.matcher, `${name} has no matcher`).toBeUndefined();
      expect(groups[0]!.hooks, name).toHaveLength(1);
      const hook = groups[0]!.hooks[0]!;
      expect(hook, name).toMatchObject({ type: 'command', command: command(event), timeout: 5 });
      expect(hook.async ?? false, `${name} is synchronous`).toBe(false);
    }
    // Nothing is written anywhere for Claude Code.
    expect(await readdir(pluginsDir)).toEqual([]);
  });
});

// --- Codex ---------------------------------------------------------------------------------

// A reader for the TOML subset Codex's `-c key=value` takes here: inline tables, arrays, basic and
// literal strings, booleans and integers. Enough to read the `hooks` value whatever its formatting.
function parseToml(text: string): unknown {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`TOML: ${what} at ${i} in ${text.slice(Math.max(0, i - 20), i + 20)}`);
  };
  const skip = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const basicString = (): string => {
    let out = '';
    i++;
    while (text[i] !== '"') {
      if (i >= text.length) fail('unterminated string');
      if (text[i] === '\\') {
        const next = text[i + 1]!;
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' };
        if (next in simple) {
          out += simple[next];
          i += 2;
        } else if (next === 'u') {
          out += String.fromCodePoint(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else if (next === 'U') {
          out += String.fromCodePoint(parseInt(text.slice(i + 2, i + 10), 16));
          i += 10;
        } else fail('bad escape');
      } else out += text[i++];
    }
    i++;
    return out;
  };
  const literalString = (): string => {
    const end = text.indexOf("'", i + 1);
    if (end < 0) fail('unterminated literal string');
    const out = text.slice(i + 1, end);
    i = end + 1;
    return out;
  };
  const key = (): string => {
    skip();
    if (text[i] === '"') return basicString();
    if (text[i] === "'") return literalString();
    const found = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
    if (!found) return fail('key expected');
    i += found[0].length;
    return found[0];
  };
  const value = (): unknown => {
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const table: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (text[i] === '}') break;
        const k = key();
        skip();
        if (text[i] !== '=') fail('= expected');
        i++;
        table[k] = value();
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== '}') fail(', or } expected');
      }
      i++;
      return table;
    }
    if (c === '[') {
      i++;
      const list: unknown[] = [];
      for (;;) {
        skip();
        if (text[i] === ']') break;
        list.push(value());
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail(', or ] expected');
      }
      i++;
      return list;
    }
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    const rest = text.slice(i);
    const word = /^(true|false|-?\d+)/.exec(rest);
    if (!word) return fail('value expected');
    i += word[0].length;
    return word[0] === 'true' ? true : word[0] === 'false' ? false : Number(word[0]);
  };
  const parsed = value();
  skip();
  if (i !== text.length) fail('trailing text');
  return parsed;
}

// The hash Codex computes for a hook: SHA-256 of the key-sorted JSON of its identity.
function expectedHash(eventName: string, hookCommand: string, matcher?: string): string {
  const identity: Record<string, unknown> = {
    event_name: eventName,
    hooks: [{ async: false, command: hookCommand, timeout: 3, type: 'command' }],
  };
  if (matcher !== undefined) identity.matcher = matcher;
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

describe('Codex (AC3)', () => {
  // The line `statusCommand('finished')` of `@cockpit/control` is, recorded in the technical plan.
  const finishedLine =
    '[ -n "$COCKPIT_SOCKET" ] && curl -s -m 2 --unix-socket "$COCKPIT_SOCKET" -H "Authorization: Bearer $(cat "${COCKPIT_SOCKET%/*}/control.token")" -d "{\\"sessionId\\":\\"$COCKPIT_SESSION_ID\\",\\"event\\":\\"finished\\"}" http://localhost/session-events >/dev/null 2>&1; exit 0';

  test('AC3 — codexTrustHash gives the hash the real Codex 0.163.0 accepted as trusted for the recorded fixture', () => {
    expect(codexTrustHash('stop', finishedLine)).toBe('sha256:3a518d3995508e104ce5ddba6cb72857920988e7daffc1e794c211c780c2cfe1');
  });

  test('AC3 — codexTrustHash puts the matcher in the hashed identity when there is one', () => {
    expect(codexTrustHash('pre_tool_use', command('waiting'), '^request_user_input$')).toBe(
      expectedHash('pre_tool_use', command('waiting'), '^request_user_input$'),
    );
    expect(codexTrustHash('pre_tool_use', command('waiting'), '^request_user_input$')).not.toBe(codexTrustHash('pre_tool_use', command('waiting')));
  });

  test('AC3 — --no-daemon -c hooks={…} with the working, waiting and finished events as synchronous command hooks with timeout 3, and the trusted hash of each', async () => {
    const { args, pluginsDir } = await launch('codex');

    expect(args).toHaveLength(3);
    expect(args[0]).toBe('--no-daemon');
    expect(args[1]).toBe('-c');
    expect(args[2]).toMatch(/^hooks=/);
    const hooks = parseToml(args[2]!.slice('hooks='.length)) as Record<string, unknown>;

    interface Group {
      matcher?: string;
      hooks: Array<Record<string, unknown>>;
    }
    const events: Array<{ name: string; snake: string; event: Event; matcher?: string }> = [
      { name: 'UserPromptSubmit', snake: 'user_prompt_submit', event: 'working' },
      { name: 'PostToolUse', snake: 'post_tool_use', event: 'working' },
      { name: 'PermissionRequest', snake: 'permission_request', event: 'waiting' },
      { name: 'PreToolUse', snake: 'pre_tool_use', event: 'waiting', matcher: '^request_user_input$' },
      { name: 'Stop', snake: 'stop', event: 'finished' },
      { name: 'Interrupt', snake: 'interrupt', event: 'finished' },
    ];
    expect(Object.keys(hooks).sort()).toEqual([...events.map((e) => e.name), 'state'].sort());

    const state: Record<string, unknown> = {};
    for (const { name, snake, event, matcher } of events) {
      const groups = hooks[name] as Group[];
      expect(groups, name).toHaveLength(1);
      expect(groups[0]!.matcher, `${name} matcher`).toBe(matcher);
      expect(groups[0]!.hooks, name).toHaveLength(1);
      const hook = groups[0]!.hooks[0]!;
      expect(hook, name).toMatchObject({ type: 'command', command: command(event), timeout: 3 });
      expect(hook.async ?? false, `${name} is synchronous`).toBe(false);
      state[`/<session-flags>/config.toml:${snake}:0:0`] = { trusted_hash: expectedHash(snake, command(event), matcher) };
    }
    expect(hooks.state).toEqual(state);
    // Nothing is written anywhere for Codex.
    expect(await readdir(pluginsDir)).toEqual([]);
  });
});

// --- OpenCode ------------------------------------------------------------------------------

describe('OpenCode (AC4)', () => {
  test('AC4 — writes the plugin to <pluginsDir>/opencode-status/server.js, passes --standalone, and sets OPENCODE_CONFIG_CONTENT to {"plugins":[<folder>]} when the environment has none', async () => {
    const { args, env, pluginsDir, folder } = await launch('opencode');

    expect(args).toEqual(['--standalone']);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ plugins: [folder] });
    const source = await readFile(join(folder, 'server.js'), 'utf8');
    expect(source).toMatch(/export default/);
    expect(source).toContain('cockpit.session-status');
    expect(await readdir(pluginsDir)).toEqual(['opencode-status']);
    // A plain file written whole: no temporary file is left next to it.
    expect(await readdir(folder)).toEqual(['server.js']);
  });

  test('AC4 — rewrites the plugin at every start', async () => {
    const { pluginsDir, folder } = await launch('opencode');
    const file = join(folder, 'server.js');
    const written = await readFile(file, 'utf8');
    await writeFile(file, '// stale');

    await statusLaunch('opencode', { command, pluginsDir, env: {} });

    expect(await readFile(file, 'utf8')).toBe(written);
    expect(await readdir(folder)).toEqual(['server.js']);
  });

  test("AC4 — appends the folder to the user's plugins array, leaves their other keys and the legacy plugin key as they are", async () => {
    const user = { model: 'x/y', plugins: ['/a/plugin'], plugin: ['legacy'] };
    const { args, env, folder } = await launch('opencode', { OPENCODE_CONFIG_CONTENT: JSON.stringify(user) });

    expect(args).toEqual(['--standalone']);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ model: 'x/y', plugins: ['/a/plugin', folder], plugin: ['legacy'] });
  });

  test('AC4 — creates the plugins array in a user object that has none', async () => {
    const { env, folder } = await launch('opencode', { OPENCODE_CONFIG_CONTENT: '{"theme":"dark"}' });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ theme: 'dark', plugins: [folder] });
  });

  test.each([
    ['not JSON', 'not json'],
    ['a JSON array', '[1,2]'],
    ['a JSON string', '"text"'],
    ['JSON null', 'null'],
    ['a plugins that is a string', '{"plugins":"x"}'],
    ['a plugins that is an object', '{"plugins":{"a":1}}'],
  ])('AC4 — %s: no flag, no plugin written and the user value passed unchanged', async (_label, value) => {
    const { args, env, pluginsDir } = await launch('opencode', { OPENCODE_CONFIG_CONTENT: value });

    expect(args).toEqual([]);
    expect(env.OPENCODE_CONFIG_CONTENT ?? value).toBe(value);
    expect(existsSync(join(pluginsDir, 'opencode-status'))).toBe(false);
  });
});

// --- OpenCode plugin behaviour ---------------------------------------------------------------

describe('OpenCode plugin (AC5)', () => {
  // Events as OpenCode 2.0.31 emits them: `{ type, data }`.
  const started = (sessionID: string) => ({ type: 'session.execution.started', data: { sessionID } });
  const succeeded = (sessionID: string) => ({ type: 'session.execution.succeeded', data: { sessionID } });
  const failed = (sessionID: string) => ({ type: 'session.execution.failed', data: { sessionID } });
  const interrupted = (sessionID: string) => ({ type: 'session.execution.interrupted', data: { sessionID } });
  const asked = (sessionID: string, id: string) => ({ type: 'permission.asked', data: { id, sessionID } });
  const replied = (sessionID: string, requestID: string) => ({ type: 'permission.replied', data: { sessionID, requestID, reply: 'once' } });
  const formCreated = (sessionID: string, id: string) => ({ type: 'form.created', data: { form: { id, sessionID } } });
  const formReplied = (sessionID: string, id: string) => ({ type: 'form.replied', data: { sessionID, id } });
  const formCancelled = (sessionID: string, id: string) => ({ type: 'form.cancelled', data: { sessionID, id } });

  const saved = { socket: process.env.COCKPIT_SOCKET, session: process.env.COCKPIT_SESSION_ID };
  afterEach(() => {
    for (const [name, value] of [
      ['COCKPIT_SOCKET', saved.socket],
      ['COCKPIT_SESSION_ID', saved.session],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  interface Plugin {
    id: string;
    setup(ctx: unknown): unknown;
  }

  // The plugin file `statusLaunch` writes in `<dir>/<name>`, whose commands append `<event>` to
  // `<dir>/log`; `working` is slow, so a plugin that ran commands side by side would log them out
  // of order.
  async function plugin(dir?: string, name = 'plugins') {
    dir ??= await tempDir();
    const log = join(dir, 'log');
    const slow = (event: Event) => (event === 'working' ? 'sleep 0.2; ' : '');
    const logging = (event: Event) => `${slow(event)}echo ${event} >> '${log}'`;
    const pluginsDir = join(dir, name);
    await statusLaunch('opencode', { command: logging, pluginsDir, env: {} });
    const module = (await import(/* @vite-ignore */ pathToFileURL(join(pluginsDir, 'opencode-status', 'server.js')).href)) as { default: Plugin };
    const lines = async () => (existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter(Boolean) : []);
    return { plugin: module.default, lines, dir };
  }

  // A context whose event stream yields `events`, then ends.
  const contextOf = (events: unknown[]) => ({
    event: {
      subscribe: () =>
        (async function* () {
          for (const event of events) yield event;
        })(),
    },
  });

  async function run(events: unknown[], { socket = '/unused.sock', session = 'cockpit-session' }: { socket?: string; session?: string } = {}) {
    process.env.COCKPIT_SOCKET = socket;
    process.env.COCKPIT_SESSION_ID = session;
    const { plugin: loaded, lines } = await plugin();
    expect(loaded.id).toBe('cockpit.session-status');
    await Promise.resolve(loaded.setup(contextOf(events)));
    return lines;
  }

  test('AC5 — runs the status command of each state the events lead to, in order and one at a time, only when the state changes', async () => {
    const lines = await run([
      started('s1'), // working (slow command)
      started('s1'), // no change
      asked('s1', 'p1'), // waiting
      asked('s1', 'p2'), // no change
      replied('s1', 'p1'), // p2 is still pending: no change
      replied('s1', 'p2'), // working (slow command)
      formCreated('s1', 'f1'), // waiting
      formReplied('s1', 'f1'), // working (slow command)
      formCreated('s1', 'f2'), // waiting
      formCancelled('s1', 'f2'), // working (slow command)
      succeeded('s1'), // finished
    ]);

    const expected = ['working', 'waiting', 'working', 'waiting', 'working', 'waiting', 'working', 'finished'];
    await vi.waitFor(async () => expect((await lines()).length).toBeGreaterThanOrEqual(expected.length), { timeout: 15_000, interval: 50 });
    expect(await lines()).toEqual(expected);
  });

  test('AC5 — an execution that ends drops its pending permissions, whichever way it ends: the next start is working, not waiting', async () => {
    for (const ending of [succeeded, failed, interrupted]) {
      const lines = await run([started('s1'), asked('s1', 'p1'), ending('s1'), started('s1')]);

      const expected = ['working', 'waiting', 'finished', 'working'];
      await vi.waitFor(async () => expect((await lines()).length).toBeGreaterThanOrEqual(expected.length), { timeout: 15_000, interval: 50 });
      expect(await lines(), ending.name).toEqual(expected);
    }
  });

  test('AC5 — the state covers every session of the server: it stays waiting while another session has a pending permission, and finishes when the last execution ends', async () => {
    const lines = await run([
      started('s1'), // working
      started('s2'), // no change
      asked('s1', 'p1'), // waiting
      succeeded('s2'), // s1 is still pending: no change
      replied('s1', 'p1'), // working (s1 still runs)
      failed('s1'), // finished
    ]);

    const expected = ['working', 'waiting', 'working', 'finished'];
    await vi.waitFor(async () => expect((await lines()).length).toBeGreaterThanOrEqual(expected.length), { timeout: 15_000, interval: 50 });
    expect(await lines()).toEqual(expected);
  });

  test.each([
    ['COCKPIT_SOCKET', 'COCKPIT_SESSION_ID'],
    ['COCKPIT_SESSION_ID', 'COCKPIT_SOCKET'],
  ])('AC5 — with %s unset it runs nothing', async (unset, kept) => {
    delete process.env[unset];
    process.env[kept] = 'value';
    const { plugin: silent, lines, dir } = await plugin();
    await Promise.resolve(silent.setup(contextOf([started('s1'), asked('s1', 'p1'), succeeded('s1')])));

    // A copy of the plugin loaded with both variables set reports its one event, which proves the
    // earlier events had every chance to run a command by then (the commands of one log line are fast).
    process.env.COCKPIT_SOCKET = '/unused.sock';
    process.env.COCKPIT_SESSION_ID = 'cockpit-session';
    const { plugin: probe } = await plugin(dir, 'probe');
    await Promise.resolve(probe.setup(contextOf([started('probe')])));

    await vi.waitFor(async () => expect((await lines()).length).toBeGreaterThanOrEqual(1), { timeout: 15_000, interval: 50 });
    expect(await lines()).toEqual(['working']);
  });
});
