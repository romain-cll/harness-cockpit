import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

// COCKPIT-17: the Developer ID signed and notarized app. Like ci-workflow.test.ts this reads the workflow,
// the entitlements and the packaging config as text (no YAML parser in the repository). What a runner and
// Apple's notary service do is proved by the `signed-app` job itself, not here.

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const read = (...path: string[]) => {
  const file = join(repoRoot, ...path);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

const signedApp = read('.github', 'workflows', 'signed-app.yml');
const ci = read('.github', 'workflows', 'ci.yml');
const builder = read('apps', 'desktop', 'electron-builder.yml');
const desktopScripts = (JSON.parse(read('apps', 'desktop', 'package.json')) as { scripts: Record<string, string> }).scripts;
const mainPlist = read('apps', 'desktop', 'build', 'entitlements.mac.plist');
const inheritPlist = read('apps', 'desktop', 'build', 'entitlements.mac.inherit.plist');

const SECRETS = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

const indentOf = (line: string) => line.length - line.trimStart().length;
const code = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('#'));

/** The steps of the workflow's job, comments dropped: each is the lines from its `- ` item to the next one. */
function steps(text: string): string[][] {
  const lines = code(text);
  const at = lines.findIndex((line) => /^\s+steps:\s*$/.test(line));
  if (at < 0) return [];
  const rest = lines.slice(at + 1);
  const itemIndent = indentOf(rest.find((line) => line.trim().startsWith('- ')) ?? '');
  const found: string[][] = [];
  for (const line of rest) {
    if (line.trim() !== '' && indentOf(line) < itemIndent) break;
    if (indentOf(line) === itemIndent && line.trim().startsWith('- ')) found.push([]);
    found.at(-1)?.push(line);
  }
  return found;
}

/** The entitlement keys of a plist, comments dropped. */
const keysOf = (plist: string) => [...plist.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort();

const indexOfStep = (all: string[][], needle: string) => all.findIndex((step) => step.join('\n').includes(needle));

describe('entitlements and packaging', () => {
  test('AC2 — the main app holds the four entitlements, the helpers allow-jit only, electron-builder names both and sets NSAppleEventsUsageDescription', () => {
    expect(keysOf(mainPlist)).toEqual(
      [
        'com.apple.security.cs.allow-jit',
        'com.apple.security.device.audio-input',
        'com.apple.security.device.camera',
        'com.apple.security.automation.apple-events',
      ].sort(),
    );
    expect(keysOf(inheritPlist)).toEqual(['com.apple.security.cs.allow-jit']);
    expect(builder).toMatch(/^\s+entitlements:\s*['"]?build\/entitlements\.mac\.plist['"]?\s*$/m);
    expect(builder).toMatch(/^\s+entitlementsInherit:\s*['"]?build\/entitlements\.mac\.inherit\.plist['"]?\s*$/m);
    expect(builder).toMatch(/^\s+NSAppleEventsUsageDescription:\s*\S/m);
    for (const text of [mainPlist, inheritPlist, builder]) {
      expect(code(text).join('\n')).not.toMatch(/disable-library-validation|allow-unsigned-executable-memory/);
    }
  });

  test('AC6 — the test builds stay ad-hoc and non-hardened; only package:signed signs with the identity and the hardened runtime; ci.yml knows no signing', () => {
    expect(builder).toMatch(/^\s+identity:\s*'-'\s*$/m);
    expect(builder).toMatch(/^\s+hardenedRuntime:\s*false\s*$/m);
    expect(desktopScripts.package).toBe('bun run --filter @cockpit/cli build && electron-vite build && electron-builder --dir');
    expect(desktopScripts['package:signed']).toContain('electron-builder --dir');
    expect(desktopScripts['package:signed']).toContain('CAILLE ROMAIN (64PK7M265S)');
    expect(desktopScripts['package:signed']).toContain('-c.mac.hardenedRuntime=true');
    expect(ci).not.toMatch(/signed-app|package:signed|CSC_|APPLE_API|notariz/i);
  });
});

describe('signed-app.yml', () => {
  test('AC4 — only push to main and manual runs, contents: read, environment release, checkout without persisted credentials', () => {
    const lines = code(signedApp);
    const text = lines.join('\n');
    expect(text).toMatch(/^on:\s*$/m);
    expect(text).toMatch(/^\s+push:\s*\n\s+branches:\s*(?:\[\s*main\s*\]|\n\s+-\s+main\s*$)/m);
    expect(text).toMatch(/^\s+workflow_dispatch:/m);
    expect(text).not.toMatch(/pull_request/);
    expect(text).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
    expect(text.match(/^\s*permissions:/gm)).toHaveLength(1);
    expect(text).toMatch(/^\s+environment:\s*release\s*$/m);
    expect(text).toMatch(/^\s+runs-on:\s*macos/m);
    const checkout = steps(signedApp).find((step) => step.join('\n').includes('actions/checkout'));
    expect(checkout?.join('\n')).toMatch(/persist-credentials:\s*false/);
  });

  test('AC4 — the five secrets are read only in the env of the one signing step, never in a run line, the job or workflow env, or ci.yml', () => {
    const text = code(signedApp).join('\n');
    expect(text.match(/\$\{\{\s*secrets\./g) ?? []).toHaveLength(SECRETS.length);
    const holders = steps(signedApp).filter((step) => step.join('\n').includes('secrets.'));
    expect(holders).toHaveLength(1);
    const signing = holders[0] ?? [];
    const envAt = signing.findIndex((line) => /^\s+env:\s*$/.test(line));
    expect(envAt).toBeGreaterThanOrEqual(0);
    const envBlock: string[] = [];
    for (const line of signing.slice(envAt + 1)) {
      if (line.trim() !== '' && indentOf(line) <= indentOf(signing[envAt] ?? '')) break;
      envBlock.push(line.trim());
    }
    for (const name of SECRETS) expect(envBlock, name).toContain(`${name}: \${{ secrets.${name} }}`);
    const beforeRun = signing.slice(0, signing.findIndex((line) => /^\s+run:/.test(line)));
    expect(beforeRun.join('\n')).not.toMatch(/secrets\./);
    expect(signing.join('\n')).toContain('package:signed');
    expect(ci).not.toMatch(/secrets\.(?:CSC_|APPLE_)/);
  });

  test('AC1 — the signing step writes the API key file, then verify runs codesign, spctl (Notarized Developer ID) and stapler on release/mac-arm64/Cockpit.app', () => {
    const all = steps(signedApp);
    const signing = all.find((step) => step.join('\n').includes('package:signed'))?.join('\n') ?? '';
    expect(signing).toMatch(/AuthKey\.p8/);
    expect(signing).toMatch(/export APPLE_API_KEY=/);

    const verifyAt = indexOfStep(all, 'xcrun stapler validate');
    expect(verifyAt).toBeGreaterThan(indexOfStep(all, 'package:signed'));
    const verify = all[verifyAt]?.join('\n') ?? '';
    expect(verify).toContain('release/mac-arm64/Cockpit.app');
    expect(verify).toContain('codesign --verify --deep --strict');
    expect(verify).toContain('spctl --assess --type execute -vv');
    expect(verify).toContain('source=Notarized Developer ID');
    expect(verify).toContain('xcrun stapler validate');
    expect(verify).toMatch(/codesign -d --entitlements - .*Contents\/MacOS\/Cockpit/);
    expect(verify).toMatch(/codesign -d --entitlements - .*Contents\/Resources\/bin\/cockpit/);
  });

  test('AC3 — packaged.test.ts and launchd.test.ts run on the signed app, after the verify step', () => {
    const all = steps(signedApp);
    const testAt = indexOfStep(all, 'vitest run test/packaged.test.ts test/launchd.test.ts');
    expect(testAt).toBeGreaterThan(indexOfStep(all, 'xcrun stapler validate'));
    expect(all[testAt]?.join('\n')).toContain('apps/desktop');
  });

  test('AC5 — the app is zipped by ditto -c -k --keepParent and uploaded as Cockpit-<short sha> for 14 days, after the tests', () => {
    const all = steps(signedApp);
    expect(indexOfStep(all, 'ditto -c -k --keepParent')).toBeGreaterThan(indexOfStep(all, 'vitest run'));
    const upload = all.find((step) => step.join('\n').includes('actions/upload-artifact@v'))?.join('\n') ?? '';
    expect(upload).toMatch(/^\s+name:\s*Cockpit-\S+/m);
    expect(upload).toMatch(/^\s+retention-days:\s*14\s*$/m);
    expect(all.indexOf(all.find((step) => step.join('\n').includes('actions/upload-artifact@v')) ?? [])).toBeGreaterThan(
      indexOfStep(all, 'ditto -c -k --keepParent'),
    );
  });
});

// COCKPIT-98: the signing step logs every codesign call (DEBUG) and what codesign waits on (`log stream`).

/** The `env:` entries of a step, trimmed. */
function envOf(step: string[]): string[] {
  const envAt = step.findIndex((line) => /^\s+env:\s*$/.test(line));
  if (envAt < 0) return [];
  const entries: string[] = [];
  for (const line of step.slice(envAt + 1)) {
    if (line.trim() !== '' && indentOf(line) <= indentOf(step[envAt] ?? '')) break;
    entries.push(line.trim());
  }
  return entries;
}

/** The script of a step's `run: |` block (lines indented deeper than `run:`), dedented, comments dropped. */
function scriptOf(step: string[]): string {
  const runAt = step.findIndex((line) => /^\s+(?:- )?run:\s*\|/.test(line));
  if (runAt < 0) return '';
  const runIndent = indentOf(step[runAt] ?? '');
  const body: string[] = [];
  for (const line of step.slice(runAt + 1)) {
    if (line.trim() !== '' && indentOf(line) <= runIndent) break;
    body.push(line);
  }
  const first = body.find((line) => line.trim() !== '');
  const dedent = indentOf(first ?? '');
  return body.map((line) => line.slice(Math.min(dedent, indentOf(line)))).join('\n');
}

const signingStep = () => steps(signedApp).find((step) => step.join('\n').includes('package:signed')) ?? [];
const signingScript = () => scriptOf(signingStep());

/** The script's logical lines: a trailing backslash joins the next line. */
const logicalLines = (script: string) => script.replace(/\\\n\s*/g, ' ').split('\n');

describe('signed-app.yml — codesign and keychain logs (COCKPIT-98)', () => {
  test('AC1 — the signing step sets DEBUG to electron-builder,electron-osx-sign* in its env', () => {
    const debug = envOf(signingStep()).find((entry) => entry.startsWith('DEBUG:'));
    expect(debug?.replace(/^DEBUG:\s*/, '').replace(/^(["'])(.*)\1$/, '$2')).toBe('electron-builder,electron-osx-sign*');
  });

  test('AC2 — the script starts `log stream --style compact --level info` on codesign, SecurityAgent and securityd in the background, before package:signed', () => {
    const lines = logicalLines(signingScript());
    const streamAt = lines.findIndex((line) => /\blog\s+stream\b/.test(line));
    const bunAt = lines.findIndex((line) => line.includes('bun run --cwd apps/desktop package:signed'));
    expect(streamAt).toBeGreaterThanOrEqual(0);
    expect(bunAt).toBeGreaterThan(streamAt);
    const stream = lines[streamAt] ?? '';
    expect(stream).toMatch(/--style\s+compact\b/);
    expect(stream).toMatch(/--level\s+info\b/);
    expect(stream.trim()).toMatch(/&$/);
    // The step's own output: no redirection to a file.
    expect(stream.replace(/\d?>&\d/g, '')).not.toMatch(/>/);
    const predicate = stream.split('--predicate')[1] ?? '';
    const names = [...predicate.matchAll(/["']([A-Za-z]+)["']/g)].map((match) => match[1]).sort();
    expect(names).toEqual(['SecurityAgent', 'codesign', 'securityd']);
  });

  test('AC2 — an EXIT trap set before package:signed kills the background log stream and waits for it', () => {
    const lines = logicalLines(signingScript());
    const trapAt = lines.findIndex((line) => /^\s*trap\b/.test(line));
    const bunAt = lines.findIndex((line) => line.includes('bun run --cwd apps/desktop package:signed'));
    expect(trapAt).toBeGreaterThanOrEqual(0);
    expect(bunAt).toBeGreaterThan(trapAt);
    const trap = lines[trapAt] ?? '';
    expect(trap).toMatch(/\bkill\b/);
    expect(trap).toMatch(/\bwait\b/);
    expect(trap).toMatch(/\bEXIT\s*$/);
  });
});

describe('signing step script under bash -e with stubs (COCKPIT-98)', () => {
  const running: ChildProcess[] = [];
  const folders: string[] = [];

  afterEach(() => {
    // A failing run may leave stubs holding the output: end their whole group.
    for (const child of running.splice(0)) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  /**
   * Runs the step's script with a `log` that blocks until killed while holding the script's stdout, and a
   * `bun` exiting with `status`. The `bun` stub fails (97) if the script started no background process, and
   * otherwise waits for the `log` stub to be running, so the trap never races its start-up.
   */
  async function run(status: number): Promise<{ code: number | null; stdout: string }> {
    const folder = mkdtempSync(join(tmpdir(), 'ck-'));
    folders.push(folder);
    const stubs = join(folder, 'stubs');
    mkdirSync(stubs);
    const ready = join(folder, 'ready');
    execFileSync('mkfifo', [ready]);
    const stub = (name: string, body: string) => {
      writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(stubs, name), 0o755);
    };
    stub('log', 'printf started > "$READY"\nexec tail -f /dev/null');
    stub(
      'bun',
      [
        'others=$(pgrep -P "$PPID" | grep -vx "$$")',
        '[ -n "$others" ] || exit 97',
        'cat "$READY" > /dev/null',
        'exit "$BUN_STATUS"',
      ].join('\n'),
    );
    const child = spawn('bash', ['-e', '-c', signingScript()], {
      cwd: folder,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${stubs}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: folder,
        APPLE_API_KEY_P8: 'not-a-key',
        READY: ready,
        BUN_STATUS: String(status),
      },
    });
    running.push(child);
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.resume();
    // `close` fires once every process holding the script's stdout is gone.
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    return { code, stdout };
  }

  test('AC3 — bun exits 0: the script exits 0 and no process is left holding its stdout', async () => {
    expect((await run(0)).code).toBe(0);
  });

  test('AC3 — bun exits 1: the script exits 1 and no process is left holding its stdout', async () => {
    expect((await run(1)).code).toBe(1);
  });
});
