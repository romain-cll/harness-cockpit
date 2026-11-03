export type Category = 'pauses' | 'timeouts' | 'polls' | 'deadlines';

export const CATEGORIES: Category[] = ['pauses', 'timeouts', 'polls', 'deadlines'];

const PATTERNS: Record<Category, RegExp[]> = {
  pauses: [/\bsleep\(/g, /setTimeout\(/g, /waitForTimeout\(/g, /Atomics\.wait\(/g, /\bsleep [0-9.]+/g],
  timeouts: [/\btimeout:/g],
  polls: [/\bpoll\(/g],
  deadlines: [/Date\.now\(\) \+/g],
};

/** Occurrences per category in one file's text; lines whose trimmed text starts with `//` or `*` are skipped. */
export function countCategories(source: string): Record<Category, number> {
  const counts: Record<Category, number> = { pauses: 0, timeouts: 0, polls: 0, deadlines: 0 };
  for (const line of source.split('\n')) {
    const text = line.trim();
    if (text.startsWith('//') || text.startsWith('*')) continue;
    for (const category of CATEGORIES) {
      // The definition of `poll` is not a call of it.
      if (category === 'polls' && line.includes('function poll')) continue;
      for (const pattern of PATTERNS[category]) counts[category] += (line.match(pattern) ?? []).length;
    }
  }
  return counts;
}
