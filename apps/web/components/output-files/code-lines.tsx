import type { HighlightedLine, SyntaxTokenKind } from '@/lib/syntax-highlight';
import { cn } from '@/lib/utils';

// The line-numbered, horizontally scrolling text block shared by FileView and SideBySideDiff
// (SPEC-123 A14). Not a design-system component of its own: use one of those two.

export type LineTone = 'removed' | 'added' | 'only' | 'filler';

export interface CodeLine {
  /** 1-based line number; null for a filler row that keeps the two sides of a diff aligned. */
  number: number | null;
  text: string;
  tone?: LineTone;
  /** Visible one-character marker, read by assistive technology as `markerLabel`. */
  marker?: string;
  markerLabel?: string;
  /** Syntax tokens of `text`, computed on the server (SPEC-123 §6.7); absent for plain text. */
  tokens?: HighlightedLine;
}

// Each token kind has its own design token (FR-123-73); a null kind keeps the code text colour.
const tokenClass: Record<SyntaxTokenKind, string> = {
  comment: 'text-syntax-token-comment',
  keyword: 'text-syntax-token-keyword',
  string: 'text-syntax-token-string',
  'string-expression': 'text-syntax-token-string-expression',
  constant: 'text-syntax-token-constant',
  function: 'text-syntax-token-function',
  parameter: 'text-syntax-token-parameter',
  punctuation: 'text-syntax-token-punctuation',
  link: 'text-syntax-token-link',
};

/** The text of one line: React text nodes only, never HTML (FR-123-72, SPEC-123 §12). */
function LineText({ line }: { line: CodeLine }) {
  // A no-break space keeps an empty line one line high.
  if (line.text === '') return '\u00a0';
  if (!line.tokens) return line.text;
  return line.tokens.map((token, index) => (
    <span key={index} className={token.token ? tokenClass[token.token] : undefined}>
      {token.text}
    </span>
  ));
}

const toneClass: Record<LineTone, string> = {
  removed: 'bg-destructive/10',
  added: 'bg-success/10',
  only: 'bg-info/10',
  filler: 'bg-muted',
};

const markerClass: Record<LineTone, string> = {
  removed: 'text-destructive-foreground',
  added: 'text-success-foreground',
  only: 'text-info-foreground',
  filler: '',
};

export function CodeLines({
  label,
  lines,
  markers,
}: {
  /** Accessible name of the scroll region, for example "Content of src/render.php". */
  label: string;
  lines: readonly CodeLine[];
  /** Reserve the marker column (diffs); a plain file view has none. */
  markers?: boolean;
}) {
  const digits = String(lines.reduce((max, line) => Math.max(max, line.number ?? 0), 0)).length;
  return (
    // A tab stop with a name, so keyboard users can scroll long lines (SPEC-122 P13).
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="overflow-x-auto rounded-none border bg-muted/40 outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
    >
      <pre className="w-max min-w-full py-2 font-mono text-ui leading-relaxed">
        {lines.map((line, index) => (
          <span
            key={index}
            data-tone={line.tone}
            className={cn('flex', line.tone ? toneClass[line.tone] : undefined)}
          >
            <span
              aria-hidden
              style={{ width: `${digits}ch` }}
              className="sticky left-0 box-content shrink-0 bg-muted px-2 text-right text-muted-foreground tabular-nums select-none"
            >
              {line.number ?? ''}
            </span>
            {markers ? (
              <span
                aria-hidden
                className={cn(
                  'w-4 shrink-0 text-center select-none',
                  line.tone ? markerClass[line.tone] : undefined,
                )}
              >
                {line.marker ?? ''}
              </span>
            ) : null}
            {line.markerLabel ? <span className="sr-only">{line.markerLabel}: </span> : null}
            <span
              data-highlighted={line.tokens ? '' : undefined}
              className={cn('pr-3 pl-2 whitespace-pre', line.tokens && 'text-syntax-foreground')}
            >
              <LineText line={line} />
            </span>
          </span>
        ))}
      </pre>
    </div>
  );
}
