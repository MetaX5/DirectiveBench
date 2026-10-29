import { displayLines, fileNotices, formatSize, type OutputFile } from '@/lib/output-files';
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
 */
export function FileView({ file }: { file: OutputFile }) {
  const lines = file.content === null ? [] : displayLines(file.content);
  return (
    <div className="min-w-0 space-y-stack">
      <div className="flex flex-wrap items-baseline gap-inline">
        <h3 className="min-w-0 font-mono text-body font-medium wrap-anywhere">{file.path}</h3>
        {file.sizeBytes === null ? null : (
          <span className="text-ui text-muted-foreground">{formatSize(file.sizeBytes)}</span>
        )}
      </div>
      <FileNotices notices={fileNotices(file)} />
      {lines.length > 0 ? (
        <CodeLines
          label={`Content of ${file.path}`}
          lines={lines.map((text, index) => ({ number: index + 1, text }))}
        />
      ) : null}
    </div>
  );
}
