import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
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

/** The lines of a job (comments dropped): from its `  <job>:` key to the next key at the same indent. */
function jobLines(text: string, job: string): string[] {
  const lines = code(text);
  const from = lines.findIndex((line) => new RegExp(`^ {2}${job}:\\s*$`).test(line));
  if (from < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (line.trim() !== '' && indentOf(line) <= 2) break;
    body.push(line);
  }
  return body;
}

/** The steps of one job of the workflow (the signing job by default), comments dropped: each is the lines from its `- ` item to the next one. */
function steps(text: string, job = 'signed-app'): string[][] {
  const lines = jobLines(text, job);
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
    expect(desktopScripts['package:signed']).toContain('electron-builder');
    expect(desktopScripts['package:signed']).not.toContain('--dir');
    expect(desktopScripts['package:signed']).toContain('--publish never');
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
    // The workflow default and the publish job's own (COCKPIT-23).
    expect(text.match(/^\s*permissions:/gm)).toHaveLength(2);
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

  test('AC5 — the release files are uploaded as Cockpit-<short sha> for 14 days, after the tests and the release files check (COCKPIT-23 AC2: paths, no file missing)', () => {
    const all = steps(signedApp);
    const verifyAt = indexOfStep(all, 'Verify release files');
    expect(verifyAt).toBeGreaterThan(indexOfStep(all, 'vitest run'));
    expect(indexOfStep(all, 'ditto -c -k')).toBe(-1);
    const uploadAt = all.findIndex((step) => step.join('\n').includes('actions/upload-artifact@v'));
    expect(uploadAt).toBeGreaterThan(verifyAt);
    const upload = all[uploadAt]?.join('\n') ?? '';
    expect(upload).toMatch(/^\s+name:\s*Cockpit-\$\{\{\s*\S/m);
    expect(upload).toMatch(/^\s+retention-days:\s*14\s*$/m);
    expect(upload).toMatch(/^\s+if-no-files-found:\s*error\s*$/m);
    for (const file of ['release/*.dmg', 'release/*.zip', 'release/*.blockmap', 'release/latest-mac.yml']) expect(upload, file).toContain(file);
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

// COCKPIT-23: DMG releases. The release files are built on every run; a dispatch with a `version` also
// checks the version and the tag first, and a secret-less `publish` job creates the pre-release (and the tag).

const stepNamed = (name: string, job = 'signed-app') => steps(signedApp, job).find((step) => step.join('\n').includes(`name: ${name}`)) ?? [];
const publishSteps = () => steps(signedApp, 'publish');
const publishText = () => jobLines(signedApp, 'publish').join('\n');

/** The text of a block opened by `<key>:` (the lines indented deeper than it). */
function blockOf(text: string, key: RegExp): string {
  const lines = code(text);
  const at = lines.findIndex((line) => key.test(line));
  if (at < 0) return '';
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && indentOf(line) <= indentOf(lines[at] ?? '')) break;
    body.push(line);
  }
  return body.join('\n');
}

describe('electron-builder.yml and package:signed — release files (COCKPIT-23)', () => {
  test('AC2 — the mac targets are dmg and zip, each for arm64 only; the GitHub publish config makes latest-mac.yml', () => {
    const items = blockOf(builder, /^ {2}target:\s*$/).split(/^\s*-\s+target:/m).slice(1);
    expect(items.map((item) => item.trim().split(/\s/)[0]).sort()).toEqual(['dmg', 'zip']);
    for (const item of items) {
      expect(item).toMatch(/arm64/);
      expect(item).not.toMatch(/x64|universal/);
    }
    const publish = blockOf(builder, /^publish:\s*$/);
    expect(publish).toMatch(/^\s+provider:\s*github\s*$/m);
    expect(publish).toMatch(/^\s+owner:\s*romain-cll\s*$/m);
    expect(publish).toMatch(/^\s+repo:\s*harness-cockpit\s*$/m);
  });
});

describe('signed-app.yml — release files check (COCKPIT-23)', () => {
  test('AC2 — "Verify release files" attaches the DMG read-only with -nobrowse, checks its app, detaches it, then checks the app of the zip extracted with ditto -x -k into $RUNNER_TEMP, and latest-mac.yml', () => {
    const step = stepNamed('Verify release files');
    expect(step.join('\n')).not.toMatch(/^\s+if:/m);
    const script = logicalLines(scriptOf(step));
    const text = script.join('\n');
    const attachAt = script.findIndex((line) => /\bhdiutil\s+attach\b/.test(line));
    const detachAt = script.findIndex((line) => /\bhdiutil\s+detach\b/.test(line));
    expect(attachAt).toBeGreaterThanOrEqual(0);
    expect(script[attachAt]).toMatch(/-readonly\b/);
    expect(script[attachAt]).toMatch(/-nobrowse\b/);
    expect(detachAt).toBeGreaterThan(attachAt);
    expect(text).toMatch(/\.dmg\b/);
    expect(script.find((line) => /\bditto\s+-x\s+-k\b/.test(line))).toContain('RUNNER_TEMP');
    expect(text).toMatch(/\.zip\b/);
    // The DMG's app and the zip's app: each passes codesign and spctl.
    expect(text.match(/codesign --verify --deep --strict/g)).toHaveLength(2);
    expect(text.match(/spctl --assess --type execute/g)).toHaveLength(2);
    expect(text).toContain('source=Notarized Developer ID');
    expect(text).toContain('xcrun stapler validate');
    // latest-mac.yml holds the package.json version and the zip's file name.
    expect(text).toContain('latest-mac.yml');
    expect(text).toMatch(/apps\/desktop\/package\.json/);
    expect(text).toMatch(/version:/);
  });
});

describe('signed-app.yml — dispatch input, triggers and permissions (COCKPIT-23)', () => {
  test('AC6 — triggers stay a push to main and workflow_dispatch (with an optional string `version`, empty by default): no tag, release or pull_request trigger', () => {
    const on = blockOf(signedApp, /^on:\s*$/);
    expect(on).toMatch(/^\s+push:\s*\n\s+branches:\s*(?:\[\s*main\s*\]|\n\s+-\s+main\s*$)/m);
    expect(on).not.toMatch(/\btags?:|^\s+release:|pull_request/m);
    expect([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]).sort()).toEqual(['push', 'workflow_dispatch']);
    const version = blockOf(on, /^\s+version:\s*$/);
    expect(version).toMatch(/^\s+type:\s*string\s*$/m);
    expect(version).toMatch(/^\s+required:\s*false\s*$/m);
    expect(version).toMatch(/^\s+default:\s*(?:''|"")\s*$/m);
  });

  test('AC6 — the version input reaches the scripts only through env: no ${{ inputs.… }} in any run line', () => {
    const everyStep = [...steps(signedApp), ...publishSteps()];
    expect(publishSteps().length).toBeGreaterThan(0);
    for (const step of everyStep) {
      const runLines = step.filter((line) => /^\s+(?:- )?run:/.test(line));
      const script = scriptOf(step);
      expect(`${runLines.join('\n')}\n${script}`).not.toMatch(/\$\{\{\s*(?:inputs|github\.event\.inputs)\./);
    }
    expect(envOf(stepNamed('Check release version'))).toContain('VERSION: ${{ inputs.version }}');
    expect(envOf(publishSteps().find((step) => step.join('\n').includes('gh release create')) ?? [])).toContain('VERSION: ${{ inputs.version }}');
  });

  test('AC6 — the signing job has no permissions of its own; contents: write is in the publish job alone, and the workflow default stays contents: read', () => {
    const text = code(signedApp).join('\n');
    expect(text).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
    expect(text.match(/contents:\s*write/g) ?? []).toHaveLength(1);
    expect(blockOf(publishText(), /^\s+permissions:\s*$/).trim()).toBe('contents: write');
    expect(jobLines(signedApp, 'signed-app').join('\n')).not.toMatch(/permissions:/);
  });

  test('AC5, AC6 — publish needs the signing job, runs only with a version, on ubuntu, has no environment and reads no secret; the signing job still holds the environment and the five secrets', () => {
    const job = publishText();
    expect(job).toMatch(/^\s+needs:\s*(?:signed-app|\[\s*signed-app\s*\])\s*$/m);
    expect(job).toMatch(/^\s+if:\s*(?:\$\{\{\s*)?inputs\.version\s*!=\s*''\s*(?:\}\})?\s*$/m);
    expect(job).toMatch(/^\s+runs-on:\s*ubuntu-latest\s*$/m);
    expect(job).toMatch(/^\s+timeout-minutes:\s*10\s*$/m);
    expect(job).not.toMatch(/environment:/);
    expect(job).not.toMatch(/secrets\./);
    expect(job).toMatch(/uses:\s*actions\/download-artifact@v\d+/);
    expect(code(signedApp).join('\n').match(/\$\{\{\s*secrets\./g)).toHaveLength(SECRETS.length);
    expect(jobLines(signedApp, 'signed-app').join('\n')).toMatch(/^\s+environment:\s*release\s*$/m);
  });
});

describe('Check release version step under bash -e with a stub git (COCKPIT-23)', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  test('the step runs right after checkout, only with a version, with VERSION from env', () => {
    const all = steps(signedApp);
    const checkoutAt = indexOfStep(all, 'actions/checkout');
    const stepAt = indexOfStep(all, 'Check release version');
    expect(stepAt).toBe(checkoutAt + 1);
    expect(stepAt).toBeLessThan(indexOfStep(all, 'package:signed'));
    expect(all[stepAt]?.join('\n')).toMatch(/^\s+if:\s*(?:\$\{\{\s*)?inputs\.version\s*!=\s*''\s*(?:\}\})?\s*$/m);
  });

  /** Runs the step's script in a folder holding apps/desktop/package.json at `0.0.0-alpha.0`; `git ls-remote` exits `lsRemoteStatus`. */
  function check(version: string, lsRemoteStatus: number) {
    const folder = mkdtempSync(join(tmpdir(), 'ck-'));
    folders.push(folder);
    mkdirSync(join(folder, 'apps', 'desktop'), { recursive: true });
    writeFileSync(join(folder, 'apps', 'desktop', 'package.json'), JSON.stringify({ name: '@cockpit/desktop', version: '0.0.0-alpha.0' }));
    const stubs = join(folder, 'stubs');
    mkdirSync(stubs);
    const log = join(folder, 'git.log');
    writeFileSync(
      join(stubs, 'git'),
      ['#!/bin/sh', 'echo "$*" >> "$GIT_LOG"', 'if [ "$1" = ls-remote ] && [ "$LS_REMOTE_STATUS" = 0 ]; then eval "last=\\${$#}"; printf "abc\\t%s\\n" "$last"; fi', '[ "$1" = ls-remote ] && exit "$LS_REMOTE_STATUS"', 'exit 0', ''].join('\n'),
    );
    chmodSync(join(stubs, 'git'), 0o755);
    const script = scriptOf(stepNamed('Check release version'));
    expect(script, 'the step has a run: | script').not.toBe('');
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: folder,
      encoding: 'utf8',
      env: { PATH: `${stubs}:${process.env.PATH ?? ''}`, VERSION: version, GIT_LOG: log, LS_REMOTE_STATUS: String(lsRemoteStatus) },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, git: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  }

  test('AC3 — a version that differs from package.json fails and prints both versions', () => {
    const run = check('0.0.0-alpha.7', 2);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('0.0.0-alpha.7');
    expect(run.output).toContain('0.0.0-alpha.0');
  });

  test('AC4 — a matching version whose tag exists on origin fails and prints the tag', () => {
    const run = check('0.0.0-alpha.0', 0);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('v0.0.0-alpha.0');
    expect(run.git).toMatch(/ls-remote .*--exit-code .*origin .*refs\/tags\/v0\.0\.0-alpha\.0/);
  });

  test('AC4 — a matching version whose tag is absent (ls-remote exit 2) goes on', () => {
    const run = check('0.0.0-alpha.0', 2);
    expect(run.git).toMatch(/ls-remote/);
    expect(run.status).toBe(0);
  });
});

describe('publish job script under bash -e with a stub gh (COCKPIT-23)', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  const FILES = ['Cockpit-0.0.0-alpha.0-arm64.dmg', 'Cockpit-0.0.0-alpha.0-arm64.dmg.blockmap', 'Cockpit-0.0.0-alpha.0-arm64-mac.zip', 'Cockpit-0.0.0-alpha.0-arm64-mac.zip.blockmap', 'latest-mac.yml'];
  const publishStep = () => publishSteps().find((step) => step.join('\n').includes('gh release create')) ?? [];

  /** Runs the script with the five downloaded files where the download step puts them; `gh release create` exits `createStatus`. */
  function publish(createStatus: number) {
    const folder = mkdtempSync(join(tmpdir(), 'ck-'));
    folders.push(folder);
    const runnerTemp = join(folder, 'tmp');
    mkdirSync(runnerTemp);
    const workspace = join(folder, 'ws');
    mkdirSync(workspace);
    const download = publishSteps().find((step) => step.join('\n').includes('actions/download-artifact')) ?? [];
    const path = (/^\s+path:\s*(.+?)\s*$/m.exec(download.join('\n'))?.[1] ?? '.')
      .replace(/^(["'])(.*)\1$/, '$2')
      .replace(/\$\{\{\s*runner\.temp\s*\}\}/g, runnerTemp)
      .replace(/\$\{\{\s*github\.workspace\s*\}\}/g, workspace);
    const into = join(workspace, path);
    mkdirSync(into, { recursive: true });
    for (const file of FILES) writeFileSync(join(into, file), 'x');
    const stubs = join(folder, 'stubs');
    mkdirSync(stubs);
    const log = join(folder, 'gh.log');
    writeFileSync(join(stubs, 'gh'), ['#!/bin/sh', 'echo "$*" >> "$GH_LOG"', '[ "$1 $2" = "release create" ] && exit "$CREATE_STATUS"', 'exit 0', ''].join('\n'));
    chmodSync(join(stubs, 'gh'), 0o755);
    const script = scriptOf(publishStep());
    expect(script, 'the publish job has a run: | script with gh release create').not.toBe('');
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: workspace,
      encoding: 'utf8',
      env: {
        PATH: `${stubs}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: runnerTemp,
        VERSION: '0.0.0-alpha.0',
        GITHUB_SHA: 'abc123def456',
        GITHUB_REPOSITORY: 'romain-cll/harness-cockpit',
        GH_TOKEN: 'token',
        GH_LOG: log,
        CREATE_STATUS: String(createStatus),
      },
    });
    return { status: result.status, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
  }

  test('AC5 — the publish step gets VERSION from env and GH_TOKEN from github.token', () => {
    const env = envOf(publishStep());
    expect(env).toContain('VERSION: ${{ inputs.version }}');
    expect(env).toContain('GH_TOKEN: ${{ github.token }}');
  });

  test('AC5 — gh release create makes a draft pre-release at the run commit with the five files, then gh release edit publishes it', () => {
    const run = publish(0);
    expect(run.status).toBe(0);
    const create = run.calls.find((call) => call.startsWith('release create')) ?? '';
    expect(create).toMatch(/^release create v0\.0\.0-alpha\.0\b/);
    expect(create).toMatch(/--target abc123def456\b/);
    for (const flag of ['--draft', '--prerelease', '--generate-notes']) expect(create.split(/\s+/), flag).toContain(flag);
    // The five files, each given once (a blockmap glob or a directory would also match, a path to each file is what the release needs).
    for (const file of FILES) expect(create.split(/\s+/).filter((arg) => arg.endsWith(`/${file}`) || arg === file), file).toHaveLength(1);
    const edit = run.calls.findIndex((call) => /^release edit v0\.0\.0-alpha\.0\b.*--draft=false/.test(call));
    expect(edit).toBeGreaterThan(run.calls.findIndex((call) => call.startsWith('release create')));
  });

  test('AC5 — gh release create fails: the script fails and gh release edit is not run', () => {
    const run = publish(1);
    expect(run.status).not.toBe(0);
    expect(run.calls.some((call) => call.startsWith('release create'))).toBe(true);
    expect(run.calls.some((call) => call.startsWith('release edit'))).toBe(false);
  });
});
