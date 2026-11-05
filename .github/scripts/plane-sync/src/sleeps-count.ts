export type Category = 'pauses' | 'timeouts' | 'polls' | 'deadlines';

export const CATEGORIES: Category[] = ['pauses', 'timeouts', 'polls', 'deadlines'];

const PATTERNS: Record<Category, RegExp[]> = {
  pauses: [/\bsleep\(/g, /setTimeout\(/g, /waitForTimeout\(/g, /Atomics\.wait\(/g, /\bsleep [0-9.]+/g],
  timeouts: [/\btimeout:/g],
  polls: [/\bpoll\(/g, /\bvi\.waitFor\(/g, /\bwaitForFunction\(/g, /\bsetInterval\(/g],
  deadlines: [/Date\.now\(\) \+/g],
};

export interface AllowedLine {
  line: string;
  reason: string;
}

// A re-check loop whose source cannot notify, justified on its own line.
const LEGITIMATE = /\/\/ legitimate poll: (\S.*)$/;

/**
 * Occurrences per category in one file's text, and its allowed lines. Lines whose trimmed text starts
 * with `//` or `*` are skipped; a line ending with `// legitimate poll: <reason>` counts nothing and is
 * returned with its reason.
 */
export function countCategories(source: string): { counts: Record<Category, number>; allowed: AllowedLine[] } {
  const counts: Record<Category, number> = { pauses: 0, timeouts: 0, polls: 0, deadlines: 0 };
  const allowed: AllowedLine[] = [];
  for (const line of source.split('\n')) {
    const text = line.trim();
    if (text.startsWith('//') || text.startsWith('*')) continue;
    const reason = LEGITIMATE.exec(text)?.[1]?.trim();
    if (reason) {
      allowed.push({ line: text, reason });
      continue;
    }
    for (const category of CATEGORIES) {
      // The definition of `poll` is not a call of it.
      if (category === 'polls' && line.includes('function poll')) continue;
      for (const pattern of PATTERNS[category]) counts[category] += (line.match(pattern) ?? []).length;
    }
  }
  return { counts, allowed };
}
