import {
  getAgentRunFile,
  getBenchmarkRunDetail,
  listAgentRunFiles,
} from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MockBadge, NotInitialized, PageHeader } from '@/components/common';
import { FileStatusBadges } from '@/components/output-files/file-status-badges';
import { SideBySideDiff } from '@/components/output-files/side-by-side-diff';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/primitives';
import { agentRunFilesNotice, agentRunLabel } from '@/lib/agent-run-files';
import {
  compareHref,
  comparePaths,
  compareRunOptionLabel,
  compareSideNotice,
  missingPathNotice,
  onlyInSide,
  pairBadge,
  parseCompareQuery,
  selectComparePath,
  selectCompareRuns,
} from '@/lib/compare-files';
import { getDatabase } from '@/lib/db';
import { isMockAgent } from '@/lib/mock-agent';
import { baselineLabel, candidateLabel } from '@/lib/run-detail';
import { highlightTexts, languageForPath } from '@/lib/syntax-highlight';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Compare output files' };

/**
 * The same file of two agent runs of one case, side by side (SPEC-123 FR-123-30 to FR-123-32,
 * D36 to D45). Both agent runs come from the benchmark run in the URL; the path list is the
 * union of their changed files, and at most two files are loaded. Content is untrusted agent
 * output and is only ever rendered as text.
 */
export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const handle = getDatabase();
  if (!handle) return <NotInitialized />;
  const { id } = await params;
  const detail = await getBenchmarkRunDetail(handle.db, id);
  if (!detail) notFound();
  const query = parseCompareQuery(await searchParams);
  const selection = selectCompareRuns(detail.agentRuns, query);
  if (selection.kind === 'not-found') notFound();

  const runId = detail.run.id;
  const variantLabel = (variant: 'baseline' | 'candidate') =>
    variant === 'baseline'
      ? baselineLabel(detail.baselineArtifactVersion)
      : candidateLabel(detail.artifactVersion);

  const header = (
    <>
      <p className="mb-2 text-body">
        <Link href={`/results/${encodeURIComponent(runId)}`} className="underline">
          Back to the run
        </Link>
      </p>
      <PageHeader
        title="Compare output files"
        description={
          <>
            {selection.kind === 'runs' ? (
              <>
                Case <span className="font-mono">{selection.caseId}</span> ·{' '}
              </>
            ) : null}
            run <span className="font-mono">{runId}</span>
          </>
        }
        actions={isMockAgent(detail.run.agentAdapterId) ? <MockBadge /> : null}
      />
    </>
  );
  if (selection.kind === 'none') {
    return (
      <>
        {header}
        <Card>
          <CardContent className="text-body">No agent runs recorded.</CardContent>
        </Card>
      </>
    );
  }

  const { caseId, caseRuns, left, right } = selection;
  const [leftFiles, rightFiles] = await Promise.all([
    listAgentRunFiles(handle.db, left.id),
    listAgentRunFiles(handle.db, right.id),
  ]);
  const union = comparePaths(leftFiles, rightFiles);
  const chosen = selectComparePath(
    union.map((entry) => entry.path),
    query.path,
  );
  const entry = union.find((e) => e.path === chosen.path);
  const load = (agentRunId: string, has: boolean) =>
    has && chosen.path !== null
      ? getAgentRunFile(handle.db, { benchmarkRunId: runId, agentRunId, path: chosen.path })
      : Promise.resolve(null);
  const [leftFile, rightFile] = await Promise.all([
    load(left.id, Boolean(entry?.left)),
    load(right.id, Boolean(entry?.right)),
  ]);

  // Both sides are highlighted as one job with one deadline, in the language of the compared
  // path, so the colouring never differs by side (SPEC-123 FR-123-76, FR-123-78). A side
  // without kept content has nothing to colour.
  const language = chosen.path === null ? null : languageForPath(chosen.path);
  const sides = [leftFile, rightFile];
  const tokenized = await highlightTexts(
    sides.flatMap((file) => (file?.content == null ? [] : [{ text: file.content, language }])),
  );
  const [leftHighlight, rightHighlight] = sides.map((file) =>
    file?.content == null ? undefined : tokenized.shift(),
  );

  const kept = { left: left.outputFilesKept, right: right.outputFilesKept };
  // A side whose agent run kept no files says why, not "Not present" (QA finding 1).
  const absentNotice = (run: typeof left, count: number) =>
    agentRunFilesNotice(run, count) ?? undefined;
  const leftLabel = agentRunLabel(variantLabel(left.variant), left.repetition);
  const rightLabel = agentRunLabel(variantLabel(right.variant), right.repetition);
  const notices = [
    compareSideNotice('Left', left, leftFiles.length),
    compareSideNotice('Right', right, rightFiles.length),
    union.length > 0 && chosen.missing !== null ? missingPathNotice(chosen.missing) : null,
  ].filter((notice) => notice !== null);

  const runSelect = (name: 'left' | 'right', label: string, value: string) => (
    <label className="flex min-w-0 max-w-full flex-col gap-1 text-ui text-muted-foreground">
      {label}
      <NativeSelect name={name} defaultValue={value} className="w-full max-w-full">
        {caseRuns.map((run) => (
          <NativeSelectOption key={run.id} value={run.id}>
            {compareRunOptionLabel(variantLabel(run.variant), run)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  );

  return (
    <>
      {header}
      <Card className="mb-4">
        <CardContent>
          {/* A plain GET form (D37): no client JavaScript; case and path travel along. */}
          <form
            action={`/results/${encodeURIComponent(runId)}/compare`}
            aria-label="Agent runs to compare"
            className="flex flex-wrap items-end gap-inline"
          >
            <input type="hidden" name="case" value={caseId} />
            {chosen.path !== null ? <input type="hidden" name="path" value={chosen.path} /> : null}
            {runSelect('left', 'Left', left.id)}
            {runSelect('right', 'Right', right.id)}
            <Button type="submit" variant="outline">
              Compare
            </Button>
          </form>
        </CardContent>
      </Card>

      {notices.length > 0 ? (
        <div role="status" className="mb-4 space-y-1 text-body">
          {notices.map((notice) => (
            <p key={notice} className="wrap-anywhere">
              {notice}
            </p>
          ))}
        </div>
      ) : null}

      {union.length === 0 ? (
        <Card data-testid="compare-empty">
          <CardContent className="text-body">
            Neither agent run has a changed file to compare.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Changed paths ({union.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <nav aria-label="Changed paths">
                <ul className="space-y-1">
                  {union.map((item) => {
                    const current = item.path === chosen.path;
                    const pair = item.left && item.right ? pairBadge(item.left, item.right) : null;
                    return (
                      <li key={item.path}>
                        <Link
                          // The diff sits under the list at every width (D42), so the fragment
                          // brings it into view (D44).
                          href={`${compareHref(runId, { caseId, left: left.id, right: right.id, path: item.path })}#diff`}
                          aria-current={current ? 'page' : undefined}
                          className={cn(
                            'block border-l-2 py-1 pr-1 pl-2 text-body hover:bg-muted',
                            current ? 'border-primary-text font-medium' : 'border-transparent',
                          )}
                        >
                          <span className="block font-mono wrap-anywhere">{item.path}</span>
                          <span className="mt-1 block">
                            {pair ? (
                              <Badge variant={pair.variant}>{pair.label}</Badge>
                            ) : (
                              <FileStatusBadges
                                // One side only: "Only left" / "Only right" when the other run
                                // kept its files, then this side's badges (D43, QA finding 1).
                                file={(item.left ?? item.right)!}
                                onlyIn={onlyInSide(item, kept) ?? undefined}
                              />
                            )}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            </CardContent>
          </Card>
          <Card className="relative min-w-0">
            <span id="diff" aria-hidden className="absolute top-0 scroll-mt-4" />
            <CardContent>
              {chosen.path !== null ? (
                <SideBySideDiff
                  path={chosen.path}
                  left={{
                    name: 'Left',
                    description: leftLabel,
                    file: leftFile,
                    highlight: leftHighlight,
                    absentNotice: absentNotice(left, leftFiles.length),
                  }}
                  right={{
                    name: 'Right',
                    description: rightLabel,
                    file: rightFile,
                    highlight: rightHighlight,
                    absentNotice: absentNotice(right, rightFiles.length),
                  }}
                />
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
