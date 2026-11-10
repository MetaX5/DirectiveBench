'use client';

import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { copyStatusMessage, copyText, type CopyResult } from '@/lib/artifact-versions';

// Copies a version's full content hash (SPEC-103 §11, issue 65). The result is a role="status"
// line in words (design system: no toast); when the browser refuses the clipboard, the line
// shows the full hash so it can still be selected and copied by hand.
export function CopyHashButton({ hash, version }: { hash: string; version: number }) {
  const [result, setResult] = useState<CopyResult | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-inline-tight">
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-label={`Copy the full hash of v${version}`}
        onClick={async () => setResult(await copyText(navigator.clipboard, hash))}
      >
        <Copy aria-hidden data-icon="inline-start" />
        Copy
      </Button>
      <span
        role="status"
        className={
          result === 'failed'
            ? 'break-all text-caption text-destructive-foreground'
            : 'text-caption text-muted-foreground'
        }
      >
        {result === null ? '' : copyStatusMessage(result, hash)}
      </span>
    </span>
  );
}
