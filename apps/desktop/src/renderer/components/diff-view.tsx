import type { FileDiff } from '../../shared/api';

export interface DiffLine {
  kind: 'context' | 'added' | 'removed';
  /** The new line number for a context or an added line, the old one for a removed line. */
  number: number;
  /** Without the `+`, `-` or space prefix. */
  text: string;
}

export interface Hunk {
  /** The whole `@@ … @@` line. */
  header: string;
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const KINDS = { ' ': 'context', '+': 'added', '-': 'removed' } as const;

/** Git's unified diff of one file as one block per hunk; what comes before the first `@@` is dropped. */
export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldNumber = Number(header[1]);
      newNumber = Number(header[2]);
      hunks.push({ header: line, lines: [] });
      continue;
    }
    const prefix = line[0];
    const hunk = hunks.at(-1);
    // `\ No newline at end of file` and the empty end of the patch are not lines.
    if (!hunk || prefix === undefined || !(prefix in KINDS)) continue;
    const kind = KINDS[prefix as keyof typeof KINDS];
    const text = line.slice(1);
    if (kind === 'removed') hunk.lines.push({ kind, number: oldNumber++, text });
    else {
      hunk.lines.push({ kind, number: newNumber++, text });
      if (kind === 'context') oldNumber++;
    }
  }
  return hunks;
}

const PREFIXES = { context: ' ', added: '+', removed: '−' } as const;

const LINE_CLASSES = { context: '', added: 'bg-diff-added', removed: 'bg-diff-removed' } as const;

/** The diff of one file: a block per hunk, or why there is none. */
export function DiffView({ diff }: { diff: FileDiff }) {
  if (diff.kind === 'binary') return <p className="p-3 text-xs text-muted-foreground">Binary file</p>;
  if (diff.kind === 'tooLarge') return <p className="p-3 text-xs text-muted-foreground">Diff too large to display</p>;
  return (
    <div className="w-max min-w-full font-mono text-xs">
      {parsePatch(diff.patch).map((hunk, index) => (
        <div key={index} className="border-b">
          <div className="px-3 py-1 text-muted-foreground">{hunk.header}</div>
          {hunk.lines.map((line, number) => (
            <div key={number} className={`flex whitespace-pre ${LINE_CLASSES[line.kind]}`}>
              <span className="w-10 shrink-0 pr-2 text-right text-muted-foreground select-none">{line.number}</span>
              <span className="w-4 shrink-0 select-none">{PREFIXES[line.kind]}</span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
