import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// COCKPIT-82: pins what can be asserted mechanically about the public README and LICENSE
// (structure, links, cited scripts, license). What the README says is reviewed against the
// code, as for AGENTS.md.

const root = resolve(import.meta.dirname, '..', '..', '..', '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const readme = () => read('README.md');

// The README without its fenced code blocks (a `## ` or a link inside a fence is not markup).
const outsideFences = (text: string) => {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line;
    })
    .join('\n');
};

const section = (text: string, title: string) => {
  const lines = outsideFences(text).split('\n');
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start === -1) return '';
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
};

// Relative targets of inline links, images and reference definitions, fragments and queries removed.
const relativeTargets = (text: string) => {
  const body = outsideFences(text).replace(/`[^`\n]*`/g, '');
  const targets = [
    ...[...body.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]!),
    ...[...body.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm)].map((m) => m[1]!),
  ];
  return targets
    .filter((t) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t))
    .map((t) => t.split('#')[0]!.split('?')[0]!)
    .filter((t) => t !== '');
};

const workspaceDirs = () => {
  const globs: string[] = JSON.parse(read('package.json')).workspaces;
  return globs.flatMap((glob) =>
    glob.endsWith('/*')
      ? readdirSync(join(root, glob.slice(0, -2)), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => `${glob.slice(0, -2)}/${d.name}`)
      : [glob],
  );
};

const scriptsOf = (dir: string): Record<string, string> => {
  const file = join(root, dir, 'package.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).scripts ?? {}) : {};
};

describe('README.md', () => {
  test('AC1 — starts with "# Cockpit" and a one-line pitch', () => {
    const lines = readme()
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines[0]).toBe('# Cockpit');
    expect(lines[1]).toBeDefined();
    expect(lines[1]).not.toMatch(/^#/);
  });

  test('AC1 — its ## sections are, in order, Status … License', () => {
    const headings = outsideFences(readme())
      .split('\n')
      .filter((line) => line.startsWith('## '));
    expect(headings).toEqual(
      [
        'Status',
        'What it does',
        'Supported agents',
        'How it works',
        'Getting started',
        'Development',
        'Contributing',
        'Roadmap',
        'License',
      ].map((title) => `## ${title}`),
    );
  });

  test('AC2 — every relative link and image target exists in the repository', () => {
    const missing = relativeTargets(readme()).filter((target) => !existsSync(resolve(root, target)));
    expect(missing).toEqual([]);
  });

  test('AC3 — every cited bun run script exists in the root or the named workspace package.json', () => {
    const dirs = workspaceDirs();
    const byName = new Map(
      dirs.map((dir) => [JSON.parse(read(`${dir}/package.json`)).name as string, dir] as const),
    );
    const cited = [...readme().matchAll(/bun run (?:--filter[= ]+(\S+) +)?([A-Za-z0-9:_|-]+)/g)];
    expect(cited.length).toBeGreaterThan(0);

    const unknown: string[] = [];
    for (const [, filter, names] of cited) {
      const dir = filter === undefined ? '.' : byName.get(filter);
      if (dir === undefined) {
        unknown.push(`unknown package ${filter}`);
        continue;
      }
      const scripts = scriptsOf(dir);
      for (const name of names!.split('|')) {
        if (!(name in scripts)) unknown.push(`${filter ?? 'root'}: ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test('AC4 — the License section names MIT and links LICENSE', () => {
    const license = section(readme(), 'License');
    expect(license).toMatch(/\bMIT\b/);
    const links = relativeTargets(license).map((target) => resolve(root, target));
    expect(links).toContain(join(root, 'LICENSE'));
  });
});

describe('LICENSE', () => {
  test('AC4 — is the MIT License with the 2026 romain-cll copyright line', () => {
    const text = read('LICENSE');
    expect(text.startsWith('MIT License')).toBe(true);
    expect(text.split('\n')).toContain('Copyright (c) 2026 romain-cll');
    expect(text).toContain('Permission is hereby granted, free of charge');
  });

  test('AC4 — the root package.json declares "license": "MIT"', () => {
    expect(JSON.parse(read('package.json')).license).toBe('MIT');
  });
});
