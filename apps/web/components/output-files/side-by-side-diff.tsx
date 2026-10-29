import {
  diffLines,
  diffSummary,
  type DiffCell,
  type DiffVariant,
  type LineDiff,
} from '@/lib/line-diff';
import { displayLines, fileNotices, type OutputFile } from '@/lib/output-files';
import { CodeLines, type CodeLine } from './code-lines';
import { FileNotices } from './file-view';

export interface DiffSide {
  /** Short name used in the heading and in line labels: "Left", "Right", "A", "B". */
  name: string;
  /** Who produced this side, for example "Baseline (v2), repetition 1"; omit in blind review. */
  description?: string;
  /** The file on this side, or null when this agent run has no such path. */
  file: OutputFile | null;
}

type Side = 'left' | 'right';

function cellLine(cell: DiffCell | null, side: Side, variant: DiffVariant, name: string): CodeLine {
  if (cell === null) return { number: null, text: '', tone: 'filler' };
  if (cell.change === 'same') return { number: cell.line, text: cell.text };
  if (variant === 'neutral') {
    return {
      number: cell.line,
      text: cell.text,
      tone: 'only',
      marker: side === 'left' ? '<' : '>',
      markerLabel: `Only in ${name}`,
    };
  }
  return side === 'left'
    ? { number: cell.line, text: cell.text, tone: 'removed', marker: '-', markerLabel: 'Removed' }
    : { number: cell.line, text: cell.text, tone: 'added', marker: '+', markerLabel: 'Added' };
}

/**
 * The same path in two agent runs, side by side (SPEC-123 FR-123-30 to 32). Lines are aligned
 * by a bounded line diff; above the bound, or when one side has no text, both sides are shown
 * as they are. Changed lines carry a text marker and a screen-reader label, not only a colour.
 */
export function SideBySideDiff({
  path,
  left,
  right,
  variant = 'change',
}: {
  path: string;
  left: DiffSide;
  right: DiffSide;
  /** `neutral` for blind review: no removed/added direction and no red or green. */
  variant?: DiffVariant;
}) {
  const leftLines = left.file?.content == null ? null : displayLines(left.file.content);
  const rightLines = right.file?.content == null ? null : displayLines(right.file.content);
  const diff: LineDiff | null = leftLines && rightLines ? diffLines(leftLines, rightLines) : null;

  const column = (side: Side, info: DiffSide, lines: string[] | null) => {
    const notices = info.file ? fileNotices(info.file) : ['Not present in this agent run.'];
    const code: CodeLine[] =
      diff?.kind === 'aligned'
        ? diff.rows.map((row) => cellLine(row[side], side, variant, info.name))
        : (lines ?? []).map((text, index) => ({ number: index + 1, text }));
    return (
      <div className="min-w-0 space-y-stack">
        <h4 className="text-body font-medium wrap-anywhere">
          {info.description ? `${info.name}: ${info.description}` : info.name}
        </h4>
        <FileNotices notices={notices} />
        {code.length > 0 ? (
          <CodeLines
            label={`${info.name}: ${path}`}
            lines={code}
            markers={diff?.kind === 'aligned'}
          />
        ) : null}
      </div>
    );
  };

  return (
    // A container query: the columns stack whenever the space is narrow, not only on a phone.
    <div className="@container min-w-0 space-y-stack">
      <div className="space-y-1">
        <h3 className="font-mono text-body font-medium wrap-anywhere">{path}</h3>
        <p role="status" className="text-ui text-muted-foreground">
          {diffSummary(diff, { left: left.name, right: right.name }, variant)}
        </p>
      </div>
      <div className="grid gap-grid @3xl:grid-cols-2">
        {column('left', left, leftLines)}
        {column('right', right, rightLines)}
      </div>
    </div>
  );
}
