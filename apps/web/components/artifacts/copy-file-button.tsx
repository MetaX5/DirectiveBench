'use client';

import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { copyFileStatusMessage, copyText, type CopyResult } from '@/lib/artifact-versions';

// Copies a stored file's content (issue #52, SPEC-101 §11). The text comes from the server as a
// string, not from the DOM, so CR characters the raw view cannot show are copied too. The result
// is a role="status" line in words (design system: no toast).
export function CopyFileButton({ content, path }: { content: string; path: string }) {
  const [result, setResult] = useState<CopyResult | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-inline-tight">
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-label={`Copy the content of ${path}`}
        onClick={async () => setResult(await copyText(navigator.clipboard, content))}
      >
        <Copy aria-hidden data-icon="inline-start" />
        Copy
      </Button>
      <span
        role="status"
        data-testid="copy-file-status"
        className={
          result === 'failed'
            ? 'text-caption text-destructive-foreground'
            : 'text-caption text-muted-foreground'
        }
      >
        {result === null ? '' : copyFileStatusMessage(result)}
      </span>
    </span>
  );
}
