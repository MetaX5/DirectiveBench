import {
  displayLines,
  fileNotices,
  formatSize,
  syntaxHighlightNotice,
  type OutputFile,
} from '@/lib/output-files';
import type { HighlightResult } from '@/lib/syntax-highlight';
import { CodeLines } from './code-lines';

/** Notices about one side of a file: why it is cut or missing, redactions, line endings. */
export function FileNotices({ notices }: { notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <div role="status" className="space-y-1 text-body">
      {notices.map((notice) => (
        <p key={notice}>{notice}</p>
      ))}
    </div>
  );
}

/**
 * One output file, read-only: its path and size, the notices of FR-123-21 and the kept text
 * with line numbers. Content is untrusted agent output and is only ever rendered as text.
 * `highlight` carries syntax tokens computed on the server (SPEC-123 §6.7); without it the
 * text is plain.
 */
export function FileView({ file, highlight }: { file: OutputFile; highlight?: HighlightResult }) {
  const lines = file.content === null ? [] : displayLines(file.content);
  const tokens = highlight?.kind === 'highlighted' ? highlight.lines : null;
  const highlightNote = syntaxHighlightNotice(highlight);
  return (
    <div className="min-w-0 space-y-stack">
      <div className="flex flex-wrap items-baseline gap-inline">
        <h3 className="min-w-0 font-mono text-body font-medium wrap-anywhere">{file.path}</h3>
        {file.sizeBytes === null ? null : (
          <span className="text-ui text-muted-foreground">{formatSize(file.sizeBytes)}</span>
        )}
      </div>
      <FileNotices notices={[...fileNotices(file), ...(highlightNote ? [highlightNote] : [])]} />
      {lines.length > 0 ? (
        <CodeLines
          label={`Content of ${file.path}`}
          lines={lines.map((text, index) => ({ number: index + 1, text, tokens: tokens?.[index] }))}
        />
      ) : null}
    </div>
  );
}
