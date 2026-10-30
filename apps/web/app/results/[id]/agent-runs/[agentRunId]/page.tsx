import {
  getAgentRunFile,
  getBenchmarkRunDetail,
  hasUnrevealedBlindReview,
  listAgentRunFiles,
} from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MockBadge, NotInitialized, PageHeader } from '@/components/common';
import { FileStatusBadges } from '@/components/output-files/file-status-badges';
import { FileView } from '@/components/output-files/file-view';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import {
  agentRunFilesHref,
  agentRunFilesNotice,
  agentRunLabel,
  agentRunStatusBadge,
  parsePathParam,
  selectFile,
} from '@/lib/agent-run-files';
import { loadUnlessBlindReview } from '@/lib/blind-review';
import { getDatabase } from '@/lib/db';
import { BlindReviewClosedPage } from '../../blind-review/closed-page';
import { isMockAgent } from '@/lib/mock-agent';
import { formatSize } from '@/lib/output-files';
import { baselineLabel, candidateLabel } from '@/lib/run-detail';
import { highlightLines, languageForPath } from '@/lib/syntax-highlight';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Agent run files' };

/**
 * The files one agent run added, changed or deleted (SPEC-123 FR-123-21, FR-123-22, D28 to
 * D34): a list on the left and the selected file, read only, on the right. Content is untrusted
 * agent output and is only ever rendered as text; one file is loaded per request.
 */
export default async function AgentRunFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; agentRunId: string }>;
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const handle = getDatabase();
  if (!handle) return <NotInitialized />;
  const { id, agentRunId } = await params;
  // Closed while the run's blind review is unrevealed, for any agent-run id or query, checked
  // before anything about the agent runs is read and again right before the render
  // (SPEC-123 FR-123-52a, D55).
  const query = await searchParams;
  const loaded = await loadUnlessBlindReview(
    () => hasUnrevealedBlindReview(handle.db, id),
    async () => {
      const detail = await getBenchmarkRunDetail(handle.db, id);
      // The agent run must belong to the benchmark run in the URL (FR-123-21).
      const agentRun = detail?.agentRuns.find((r) => r.id === agentRunId);
      if (!detail || !agentRun) notFound();

      const files = await listAgentRunFiles(handle.db, agentRun.id);
      const selection = selectFile(
        files.map((f) => f.path),
        parsePathParam(query.path),
      );
      if (selection.kind === 'not-found') notFound();
      const selected =
        selection.kind === 'file'
          ? await getAgentRunFile(handle.db, {
              benchmarkRunId: detail.run.id,
              agentRunId: agentRun.id,
              path: selection.path,
            })
          : null;
      if (selection.kind === 'file' && !selected) notFound();
      // Syntax tokens are computed on the server, off the request thread (SPEC-123 §6.7); a file
      // without kept content has nothing to colour.
      const highlight =
        selected?.content == null
          ? undefined
          : await highlightLines(selected.content, languageForPath(selected.path));

      const variant =
        agentRun.variant === 'baseline'
          ? baselineLabel(detail.baselineArtifactVersion)
          : candidateLabel(detail.artifactVersion);
      const status = agentRunStatusBadge(agentRun);
      const notice = agentRunFilesNotice(agentRun, files.length);
      return { detail, agentRun, files, selected, highlight, variant, status, notice };
    },
  );
  if (loaded.closed) return <BlindReviewClosedPage runId={id} title="Output files hidden" />;
  const { detail, agentRun, files, selected, highlight, variant, status, notice } = loaded.value;

  return (
    <>
      <p className="mb-2 text-body">
        <Link href={`/results/${encodeURIComponent(detail.run.id)}`} className="underline">
          Back to the run
        </Link>
      </p>
      <PageHeader
        title={agentRunLabel(variant, agentRun.repetition)}
        description={
          <>
            Case <span className="font-mono">{agentRun.caseId}</span> · run{' '}
            <span className="font-mono">{detail.run.id}</span>
          </>
        }
        actions={
          <>
            <Badge variant={status.variant}>{status.label}</Badge>
            {isMockAgent(detail.run.agentAdapterId) ? <MockBadge /> : null}
          </>
        }
      />

      {notice ? (
        <Card data-testid="agent-run-files-notice">
          <CardContent className="text-body">{notice}</CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-grid lg:flex-row lg:items-start">
          <Card className="min-w-0 lg:w-sidebar lg:shrink-0">
            <CardHeader>
              <CardTitle>Changed files ({files.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <nav aria-label="Changed files">
                <ul className="space-y-1">
                  {files.map((file) => {
                    const current = file.path === selected?.path;
                    return (
                      <li key={file.id}>
                        <Link
                          // The fragment brings the file into view where it is stacked under the
                          // list; on wide screens its target is hidden, so nothing scrolls.
                          href={`${agentRunFilesHref(detail.run.id, agentRun.id, file.path)}#file`}
                          aria-current={current ? 'page' : undefined}
                          className={cn(
                            'block border-l-2 py-1 pr-1 pl-2 text-body hover:bg-muted',
                            current ? 'border-primary-text font-medium' : 'border-transparent',
                          )}
                        >
                          <span className="block font-mono wrap-anywhere">{file.path}</span>
                          <span className="mt-1 block">
                            <FileStatusBadges file={file} />
                          </span>
                          {file.sizeBytes === null ? null : (
                            <span className="block text-ui text-muted-foreground">
                              {formatSize(file.sizeBytes)}
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            </CardContent>
          </Card>
          <Card className="relative min-w-0 lg:flex-1">
            {/* The #file target of the file links. It exists only where the file is stacked
                under the list (below lg): side by side, the hidden target makes the browser
                keep the scroll position, so the header stays in view (maintainer decision
                on PR 162, browser QA finding 1). */}
            <span id="file" aria-hidden className="absolute top-0 scroll-mt-4 lg:hidden" />
            <CardContent>
              {selected ? <FileView file={selected} highlight={highlight} /> : null}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
