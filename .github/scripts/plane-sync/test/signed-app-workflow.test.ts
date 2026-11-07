import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

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
