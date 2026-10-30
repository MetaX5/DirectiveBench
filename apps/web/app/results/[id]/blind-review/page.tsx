import {
  getBenchmarkRunDetail,
  getBlindPairFiles,
  getBlindReviewForReviewer,
  getBlindReviewResult,
  type BlindPairFileSummary,
  type BlindReviewResult,
} from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { MockBadge, NotInitialized, PageHeader } from '@/components/common';
import { FileStatusBadges } from '@/components/output-files/file-status-badges';
import { SideBySideDiff } from '@/components/output-files/side-by-side-diff';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Pre,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@/components/ui/primitives';
import { agentRunFilesHref, agentRunLabel } from '@/lib/agent-run-files';
import {
  BLIND_VERDICT_LABELS,
  blindReviewHref,
  blindReviewSummaryText,
  casePrompt,
  decidedText,
  nextOpenPair,
  pairListLabel,
  parseBlindReviewQuery,
  preferredText,
  selectBlindPair,
} from '@/lib/blind-review';
import { comparePaths, onlyInSide, pairBadge } from '@/lib/compare-files';
import { getDatabase } from '@/lib/db';
import { isMockAgent } from '@/lib/mock-agent';
import { baselineLabel, candidateLabel } from '@/lib/run-detail';
import { highlightTexts, languageForPath } from '@/lib/syntax-highlight';
import { cn, formatDate } from '@/lib/utils';
import { RevealPanel, VerdictPanel } from './blind-review-forms';

export const metadata: Metadata = { title: 'Blind review' };

const AGENT_FILE_NONE = 'The agent did not change any file.';

/**
 * The blind review of a run (SPEC-123 §6.5, D46 to D57): one pair at a time, sides A and B side
 * by side with a neutral diff, a verdict per pair and one reveal. Before the reveal the page
 * reads pairs only through the reviewer functions, which return no variant, agent-run id,
 * repetition or status (FR-123-52), and renders nothing else about the agent runs. Content is
 * untrusted agent output and is only ever rendered as text.
 */
export default async function BlindReviewPage({
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
  const runId = detail.run.id;
  const mock = isMockAgent(detail.run.agentAdapterId);
  const query = parseBlindReviewQuery(await searchParams);
  const view = await getBlindReviewForReviewer(handle.db, runId);

  const back = (
    <p className="mb-2 text-body">
      <Link href={`/results/${encodeURIComponent(runId)}`} className="underline">
        Back to the run
      </Link>
    </p>
  );
  if (!view) {
    // D56: starting stays on the run page, one deliberate place.
    return (
      <>
        {back}
        <PageHeader
          title="Blind review"
          description={
            <>
              run <span className="font-mono">{runId}</span>
            </>
          }
          actions={mock ? <MockBadge /> : null}
        />
        <Card>
          <CardContent className="text-body">
            This run has no blind review. Start one from the run page.
          </CardContent>
        </Card>
      </>
    );
  }

  const revealed = view.review.revealedAt !== null;
  if (query.pair === 'invalid') notFound();
  const pair = selectBlindPair(view.pairs, query.pair, revealed);
  // A review always has at least one pair (FR-123-50), so only a foreign position is missing.
  if (!pair) notFound();
  // The URL always names its pair: otherwise recording a verdict would re-render the page at the
  // next open pair and lose the result line (D52: no auto-advance).
  if (query.pair === null) redirect(blindReviewHref(runId, { pair: pair.position }));

  const sideFiles = (side: 'a' | 'b', path: string | null) =>
    getBlindPairFiles(handle.db, { benchmarkRunId: runId, position: pair.position, side, path });
  let [a, b] = await Promise.all([sideFiles('a', query.path), sideFiles('b', query.path)]);
  if (!a || !b) notFound();
  const union = comparePaths<BlindPairFileSummary>(a.files, b.files);
  if (query.path !== null && !union.some((entry) => entry.path === query.path)) notFound();
  const path = query.path ?? union[0]?.path ?? null;
  if (query.path === null && path !== null) {
    [a, b] = await Promise.all([sideFiles('a', path), sideFiles('b', path)]);
    if (!a || !b) notFound();
  }

  // Both sides are coloured as one job, in the language of the path, so the colouring never
  // differs by side (FR-123-76).
  const language = path === null ? null : languageForPath(path);
  const contents = [a.file, b.file];
  const tokenized = await highlightTexts(
    contents.flatMap((file) => (file?.content == null ? [] : [{ text: file.content, language }])),
  );
  const [aHighlight, bHighlight] = contents.map((file) =>
    file?.content == null ? undefined : tokenized.shift(),
  );

  const result = revealed ? await getBlindReviewResult(handle.db, runId) : null;
  const revealedPair = result?.pairs.find((p) => p.position === pair.position) ?? null;
  const variantLabel = (variant: 'baseline' | 'candidate') =>
    variant === 'baseline'
      ? baselineLabel(detail.baselineArtifactVersion)
      : candidateLabel(detail.artifactVersion);
  const sideLabel = (side: BlindReviewResult['pairs'][number]['a']) =>
    agentRunLabel(variantLabel(side.variant), side.repetition);

  const total = view.pairs.length;
  const previous = view.pairs.find((p) => p.position === pair.position - 1);
  const following = view.pairs.find((p) => p.position === pair.position + 1);
  const next = nextOpenPair(view.pairs, pair.position);
  const prompt = casePrompt(detail.suiteVersion.definition, pair.caseId);
  // Both agent runs of a pair kept their files (A8), so a path on one side only is "Only A/B".
  const kept = { left: true, right: true };

  const pairLinks = (
    <p className="flex flex-wrap gap-inline text-body empty:hidden">
      {previous ? (
        <Link
          className="text-primary-text underline"
          href={blindReviewHref(runId, { pair: previous.position })}
        >
          Previous pair
        </Link>
      ) : null}
      {following ? (
        <Link
          className="text-primary-text underline"
          href={blindReviewHref(runId, { pair: following.position })}
        >
          Next pair
        </Link>
      ) : null}
    </p>
  );

  return (
    <>
      {back}
      <PageHeader
        title="Blind review"
        description={
          <>
            Pair {pair.position} of {total} · Case <span className="font-mono">{pair.caseId}</span>{' '}
            · run <span className="font-mono">{runId}</span>
          </>
        }
        actions={mock ? <MockBadge /> : null}
      />
      <p role="status" className="mb-4 text-body" data-testid="pairs-decided">
        {decidedText(view.pairs)}
      </p>

      <div className="space-y-4">
        {result ? (
          <Card data-testid="blind-review-result">
            <CardHeader>
              <CardTitle>Result</CardTitle>
            </CardHeader>
            <CardContent className="space-y-stack">
              <p className="text-body" data-testid="blind-review-summary">
                {blindReviewSummaryText(result.summary)}
              </p>
              <p className="text-ui text-muted-foreground">
                Revealed {formatDate(result.revealedAt)}.
              </p>
              <Table aria-label="Blind review result">
                <THead>
                  <TR>
                    <TH>Pair</TH>
                    <TH>Case</TH>
                    <TH>A</TH>
                    <TH>B</TH>
                    <TH>Verdict</TH>
                    <TH>Preferred</TH>
                    <TH>Note</TH>
                  </TR>
                </THead>
                <TBody>
                  {result.pairs.map((row) => (
                    <TR key={row.position}>
                      <TD className="tabular-nums">
                        <Link
                          className="text-primary-text underline"
                          href={blindReviewHref(runId, { pair: row.position })}
                        >
                          Pair {row.position}
                        </Link>
                      </TD>
                      <TD className="font-mono wrap-anywhere">{row.caseId}</TD>
                      <TD>{sideLabel(row.a)}</TD>
                      <TD>{sideLabel(row.b)}</TD>
                      <TD>
                        {row.verdict === null ? 'No verdict' : BLIND_VERDICT_LABELS[row.verdict]}
                      </TD>
                      <TD>{preferredText(row.verdict, row.a, row.b)}</TD>
                      <TD className="whitespace-pre-wrap wrap-anywhere">{row.note ?? ''}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Task</CardTitle>
          </CardHeader>
          <CardContent className="space-y-stack">
            {prompt === null ? (
              <p className="text-body">The prompt of this case could not be read.</p>
            ) : (
              <Pre className="max-h-40 whitespace-pre-wrap">{prompt}</Pre>
            )}
            {revealed ? null : (
              <p className="text-ui text-muted-foreground">
                Variants, scores and statuses are hidden until you reveal them. The per-variant
                results on the run page stay visible, and content written by the agent may still
                hint at the variant.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pairs ({total})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-stack">
            {pairLinks}
            <nav aria-label="Pairs">
              <ul className="space-y-1">
                {view.pairs.map((item) => {
                  const current = item.position === pair.position;
                  return (
                    <li key={item.id}>
                      <Link
                        href={blindReviewHref(runId, { pair: item.position })}
                        aria-current={current ? 'page' : undefined}
                        className={cn(
                          'block border-l-2 py-1 pr-1 pl-2 text-body wrap-anywhere hover:bg-muted',
                          current ? 'border-primary-text font-medium' : 'border-transparent',
                        )}
                      >
                        {pairListLabel(item)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </CardContent>
        </Card>

        {union.length === 0 ? (
          <Card data-testid="blind-pair-empty">
            <CardContent className="text-body">
              Neither side has a changed file to compare.
            </CardContent>
          </Card>
        ) : (
          <>
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Changed paths ({union.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <nav aria-label="Changed paths">
                  <ul className="space-y-1">
                    {union.map((item) => {
                      const current = item.path === path;
                      const both =
                        item.left && item.right ? pairBadge(item.left, item.right) : null;
                      const only = onlyInSide(item, kept);
                      return (
                        <li key={item.path}>
                          <Link
                            href={`${blindReviewHref(runId, { pair: pair.position, path: item.path })}#diff`}
                            aria-current={current ? 'page' : undefined}
                            className={cn(
                              'block border-l-2 py-1 pr-1 pl-2 text-body hover:bg-muted',
                              current ? 'border-primary-text font-medium' : 'border-transparent',
                            )}
                          >
                            <span className="block font-mono wrap-anywhere">{item.path}</span>
                            <span className="mt-1 block">
                              {both ? (
                                <Badge variant={both.variant}>{both.label}</Badge>
                              ) : (
                                <FileStatusBadges
                                  file={(item.left ?? item.right)!}
                                  onlyIn={
                                    only === 'left' ? 'A' : only === 'right' ? 'B' : undefined
                                  }
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
              <CardContent className="space-y-stack">
                {path !== null ? (
                  <SideBySideDiff
                    path={path}
                    variant="neutral"
                    left={{
                      name: 'A',
                      // D13: no description before the reveal, it would name the variant.
                      ...(revealedPair ? { description: sideLabel(revealedPair.a) } : {}),
                      file: a.file,
                      highlight: aHighlight,
                      ...(a.files.length === 0 ? { absentNotice: AGENT_FILE_NONE } : {}),
                    }}
                    right={{
                      name: 'B',
                      ...(revealedPair ? { description: sideLabel(revealedPair.b) } : {}),
                      file: b.file,
                      highlight: bHighlight,
                      ...(b.files.length === 0 ? { absentNotice: AGENT_FILE_NONE } : {}),
                    }}
                  />
                ) : null}
                {revealedPair ? (
                  <ul className="space-y-1 text-body" data-testid="revealed-sides">
                    {(['a', 'b'] as const).map((side) => (
                      <li key={side}>
                        <Link
                          className="text-primary-text underline"
                          href={agentRunFilesHref(runId, revealedPair[side].agentRunId)}
                        >
                          View files of {side.toUpperCase()}: {sideLabel(revealedPair[side])}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          </>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Your verdict for pair {pair.position}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-stack">
            <VerdictPanel
              key={pair.id}
              benchmarkRunId={runId}
              pairId={pair.id}
              position={pair.position}
              recorded={
                pair.verdict === null
                  ? null
                  : { label: BLIND_VERDICT_LABELS[pair.verdict], note: pair.note }
              }
              closed={revealed}
              next={next ? { href: blindReviewHref(runId, { pair: next.position }) } : null}
            />
            {pairLinks}
          </CardContent>
        </Card>

        <RevealPanel
          benchmarkRunId={runId}
          reviewId={view.review.id}
          revealed={revealed}
          undecided={view.pairs.filter((p) => p.verdict === null).length}
          total={total}
        />
      </div>
    </>
  );
}
