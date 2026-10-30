import type { Aggregate, ScoringSummary } from '@directivebench/benchmark-engine/scoring';
import {
  countAgentRunFiles,
  getBenchmarkRunDetail,
  getBlindReviewEligibility,
  getBlindReviewForReviewer,
  getBlindReviewResult,
  hasUnrevealedBlindReview,
  type AgentRunFileCounts,
  type BenchmarkRunDetail,
  type BlindReviewEligibility,
  type BlindReviewForReviewer,
  type BlindReviewResult,
} from '@directivebench/database';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import {
  MockBadge,
  NotInitialized,
  NotSandboxedBadge,
  PageHeader,
  StatusBadge,
  runDisplayStatus,
} from '@/components/common';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
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
import { getDatabase } from '@/lib/db';
import {
  agentRunFilesHref,
  agentRunLabel,
  agentRunStatusBadge,
  outputFilesRow,
  wholeRunPredatesCapture,
} from '@/lib/agent-run-files';
import {
  BLIND_REVIEW_CLOSED_NOTICE,
  blindReviewHref,
  blindReviewSummaryText,
  decidedText,
  eligiblePairsText,
  excludedPairsText,
  loadUnlessBlindReview,
  startUnavailableText,
} from '@/lib/blind-review';
import { compareHref } from '@/lib/compare-files';
import { isMockAgent } from '@/lib/mock-agent';
import {
  agentProfileOf,
  agentRunMetadata,
  assertionDetailLines,
  assertionErrorOf,
  baselineLabel,
  candidateLabel,
  invocationText,
  NOT_REPORTED,
  otherReportedModels,
  runWarnings,
  traceCounts,
  usageText,
  type AgentProfile,
} from '@/lib/run-detail';
import { cn, formatDate, formatDelta, formatDuration, formatScore } from '@/lib/utils';

import { StartBlindReviewForm } from './blind-review/blind-review-forms';

export const metadata: Metadata = { title: 'Benchmark run' };

function ScoreBar({ value, tone }: { value: number | null; tone: 'red' | 'green' }) {
  const pct = value === null ? 0 : Math.round(value * 100);
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-surface bg-scorebar-track"
      data-slot="score-bar"
      aria-hidden
    >
      <div
        className={cn(
          'h-full',
          tone === 'red' ? 'bg-scorebar-red-phase' : 'bg-scorebar-green-phase',
        )}
        data-slot="score-bar-fill"
        data-tone={tone}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function VariantCard({
  label,
  subtitle,
  tone,
  data,
  invocation,
  testId,
}: {
  label: string;
  subtitle: string;
  tone: 'red' | 'green';
  data: Aggregate | undefined;
  invocation: string | null;
  testId: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle data-testid={`${testId}-label`}>{label}</CardTitle>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-stack">
        <p className="text-metric tabular-nums" data-testid={testId}>
          {formatScore(data?.meanScore)}
        </p>
        <ScoreBar value={data?.meanScore ?? null} tone={tone} />
        <dl className="grid grid-cols-2 gap-1 text-ui">
          <dt className="text-muted-foreground">Pass rate</dt>
          <dd className="tabular-nums">{formatScore(data?.passRate)}</dd>
          <dt className="text-muted-foreground">Valid runs</dt>
          <dd className="tabular-nums">
            {data?.validRuns} / {data?.totalRuns}
          </dd>
          <dt className="text-muted-foreground">Error rate</dt>
          <dd className="tabular-nums">{formatScore(data?.errorRate)}</dd>
          <dt className="text-muted-foreground">Mean duration</dt>
          <dd className="tabular-nums">{formatDuration(data?.meanDurationMs)}</dd>
        </dl>
        {invocation ? (
          <p className="text-ui" data-testid={`${testId}-invocation`}>
            {invocation}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AssertionDetails({ lines }: { lines: { label: string; value: string }[] }) {
  if (lines.length === 0) return null;
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2" data-testid="assertion-details">
      {lines.map((line) => (
        <div key={line.label} className="contents">
          <dt>{line.label}</dt>
          <dd className="break-all font-mono text-foreground">{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AgentProfileCard({
  mock,
  profile,
  requestedModel,
  otherModels,
}: {
  mock: boolean;
  profile: AgentProfile | null;
  requestedModel: string;
  otherModels: string[];
}) {
  if (mock) {
    return (
      <Card className="mt-4" data-testid="agent-profile">
        <CardHeader>
          <CardTitle>Agent profile</CardTitle>
        </CardHeader>
        <CardContent className="text-body text-muted-foreground">
          The deterministic mock agent reports no agent profile: no auth mode, isolation or model.
        </CardContent>
      </Card>
    );
  }
  const value = (text: string | undefined) => text ?? NOT_REPORTED;
  return (
    <Card className="mt-4" data-testid="agent-profile">
      <CardHeader>
        <CardTitle>Agent profile</CardTitle>
        <CardDescription>
          The conditions every agent run of this benchmark ran under.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-1 text-ui md:grid-cols-2">
          <dt className="text-muted-foreground">Auth mode</dt>
          <dd data-testid="profile-auth-mode">{value(profile?.authMode)}</dd>
          <dt className="text-muted-foreground">Isolation profile</dt>
          <dd data-testid="profile-isolation">{value(profile?.isolationProfile)}</dd>
          <dt className="text-muted-foreground">Permission profile</dt>
          <dd data-testid="profile-permission">{value(profile?.permissionProfile)}</dd>
          <dt className="text-muted-foreground">Model requested</dt>
          <dd className="font-mono">{requestedModel}</dd>
          <dt className="text-muted-foreground">Execution model</dt>
          <dd className="font-mono" data-testid="profile-execution-model">
            {value(profile?.executionModel)}
          </dd>
          <dt className="text-muted-foreground">Other reported models</dt>
          <dd className="font-mono" data-testid="profile-other-models">
            {otherModels.length ? otherModels.join(', ') : 'none'}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * The "Output files" card (SPEC-123 FR-123-20, D21 to D27): one table per case with each agent
 * run's file counts and a link to its files. Counts come from SQL; no file content is loaded.
 */
function OutputFilesCard({
  runId,
  running,
  agentRuns,
  counts,
  variantLabel,
}: {
  runId: string;
  running: boolean;
  agentRuns: BenchmarkRunDetail['agentRuns'];
  counts: AgentRunFileCounts[];
  variantLabel: (variant: 'baseline' | 'candidate') => string;
}) {
  const countsByRun = new Map(counts.map((c) => [c.agentRunId, c]));
  const cases = new Map<string, BenchmarkRunDetail['agentRuns']>();
  for (const agentRun of agentRuns) {
    cases.set(agentRun.caseId, [...(cases.get(agentRun.caseId) ?? []), agentRun]);
  }
  return (
    <Card className="mt-4" data-testid="output-files">
      <CardHeader>
        <CardTitle>Output files</CardTitle>
        <CardDescription>
          Files each agent run added, changed or deleted. Up to 1 MB per file and 10 MB per agent
          run are kept, with secrets redacted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-stack">
        {running ? (
          <p className="text-body text-muted-foreground">
            Files of finished agent runs appear here while the run continues.
          </p>
        ) : null}
        {agentRuns.length === 0 ? (
          <p className="text-body text-muted-foreground">No agent runs recorded.</p>
        ) : wholeRunPredatesCapture(agentRuns) ? (
          <p className="text-body text-muted-foreground">
            Output files were not kept for this run.
          </p>
        ) : (
          [...cases].map(([caseId, runs]) => (
            <section key={caseId} className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-inline gap-y-1">
                <h3 className="min-w-0 text-body font-medium wrap-anywhere">
                  Case <span className="font-mono">{caseId}</span>
                </h3>
                {/* SPEC-123 D36: the compare page picks its default agent runs itself. */}
                <Link
                  className="text-body text-primary-text underline"
                  href={compareHref(runId, { caseId })}
                  aria-label={`Compare agent runs of case ${caseId}`}
                >
                  Compare agent runs
                </Link>
              </div>
              <Table aria-label={`Output files of case ${caseId}`}>
                <THead>
                  <TR>
                    <TH>Agent run</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Changed files</TH>
                    <TH className="text-right">Kept</TH>
                    <TH>Not complete</TH>
                    <TH>
                      <span className="sr-only">Files</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {runs.map((agentRun) => {
                    const label = agentRunLabel(
                      variantLabel(agentRun.variant),
                      agentRun.repetition,
                    );
                    const row = outputFilesRow(agentRun, countsByRun.get(agentRun.id));
                    const status = agentRunStatusBadge(agentRun);
                    return (
                      <TR key={agentRun.id} data-testid="output-files-row">
                        <TD>{label}</TD>
                        <TD>
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </TD>
                        <TD className="text-right tabular-nums">{row.changedFiles}</TD>
                        <TD className="text-right tabular-nums">{row.kept}</TD>
                        <TD>{row.notComplete}</TD>
                        <TD>
                          <Link
                            className="text-primary-text underline"
                            href={agentRunFilesHref(runId, agentRun.id)}
                            aria-label={`View files of ${label}, case ${caseId}`}
                          >
                            View files
                          </Link>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </section>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The "Blind review" card (SPEC-123 D46, D47): start, progress or the revealed summary
 * ("Human blind review"), next to the verdict and never inside it; it changes no score.
 */
function BlindReviewCard({
  runId,
  status,
  mock,
  review,
  result,
  eligibility,
}: {
  runId: string;
  status: BenchmarkRunDetail['run']['status'];
  mock: boolean;
  review: BlindReviewForReviewer | null;
  result: BlindReviewResult | null;
  eligibility: BlindReviewEligibility | null;
}) {
  const href = blindReviewHref(runId);
  let body: ReactNode;
  if (result) {
    body = (
      <>
        <p className="text-ui font-medium text-muted-foreground">Human blind review</p>
        <p className="text-body" data-testid="blind-review-summary">
          {blindReviewSummaryText(result.summary)}
        </p>
        <p className="text-ui text-muted-foreground">Revealed {formatDate(result.revealedAt)}.</p>
        <Link className="text-body text-primary-text underline" href={href}>
          View the review
        </Link>
      </>
    );
  } else if (review) {
    body = (
      <>
        <p className="text-body" data-testid="blind-review-progress">
          {decidedText(review.pairs)}
        </p>
        <Link className="text-body text-primary-text underline" href={href}>
          Continue the blind review
        </Link>
      </>
    );
  } else {
    // Without a review the page always reads the eligibility.
    const counts = eligibility!;
    const unavailable = startUnavailableText(status, counts);
    body = (
      <>
        <p className="text-body">
          Judge the outputs of baseline and candidate as unlabelled pairs A and B, then reveal which
          was which. While the review is open, labelled output files and agent runs are hidden.
        </p>
        {unavailable ? (
          <p className="text-body" data-testid="blind-review-unavailable">
            {unavailable}
          </p>
        ) : (
          <p className="text-body">{eligiblePairsText(counts.eligible)}</p>
        )}
        {status === 'completed' && excludedPairsText(counts).length > 0 ? (
          <ul className="list-inside list-disc text-ui text-muted-foreground">
            {excludedPairsText(counts).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {unavailable ? null : <StartBlindReviewForm benchmarkRunId={runId} />}
      </>
    );
  }
  return (
    <Card className="mt-4" data-testid="blind-review">
      <CardHeader>
        <CardTitle>Blind review</CardTitle>
      </CardHeader>
      <CardContent className="space-y-stack">
        {mock ? (
          <p>
            <MockBadge />
          </p>
        ) : null}
        {body}
      </CardContent>
    </Card>
  );
}

/** A labelled view while a blind review is unrevealed (FR-123-52a, D55): title and notice only. */
function ClosedCard({ title, runId, testId }: { title: string; runId: string; testId: string }) {
  return (
    <Card className="mt-4" data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-stack text-body">
        <p>{BLIND_REVIEW_CLOSED_NOTICE}</p>
        <Link className="text-primary-text underline" href={blindReviewHref(runId)}>
          Continue the blind review
        </Link>
      </CardContent>
    </Card>
  );
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const handle = getDatabase();
  if (!handle) return <NotInitialized />;
  const { id } = await params;
  const detail = await getBenchmarkRunDetail(handle.db, id);
  if (!detail) notFound();
  const {
    run,
    suite,
    suiteVersion,
    artifact,
    artifactVersion,
    baselineArtifactVersion,
    agentRuns,
  } = detail;
  const summary = run.summary as
    (ScoringSummary & { environment?: Record<string, unknown> }) | null;
  const status = runDisplayStatus(run);
  const mock = isMockAgent(run.agentAdapterId);
  const profile = agentProfileOf(run.summary);
  const baselineName = baselineLabel(baselineArtifactVersion);
  const candidateName = candidateLabel(artifactVersion);
  const warnings = runWarnings(run.warnings, profile);
  const review = await getBlindReviewForReviewer(handle.db, id);
  const blindResult = review?.review.revealedAt ? await getBlindReviewResult(handle.db, id) : null;
  const eligibility = review ? null : await getBlindReviewEligibility(handle.db, id);
  // Decided right before rendering, as the last read (FR-123-52a): while a review is unrevealed
  // no per-agent-run row reaches a component, so neither the HTML nor the RSC payload carries
  // one, also when the review starts while this page loads.
  const labelled = await loadUnlessBlindReview(
    () => hasUnrevealedBlindReview(handle.db, id),
    () => countAgentRunFiles(handle.db, id),
  );
  const closed = labelled.closed;
  const fileCounts = labelled.closed ? [] : labelled.value;

  return (
    <>
      <AutoRefresh active={run.status === 'running'} />
      <PageHeader
        title={`${artifact.name} v${artifactVersion.version} × ${suite.name} v${suiteVersion.version}`}
        description={
          <>
            <span data-testid="run-variants">
              {baselineName} vs {candidateName}
            </span>{' '}
            · run <span className="font-mono">{run.id}</span> · started {formatDate(run.startedAt)}
          </>
        }
        actions={
          <>
            {run.status === 'completed' || run.status === 'error' ? (
              <StatusBadge status={status} />
            ) : (
              <Badge variant="info">{run.status}</Badge>
            )}
            {mock ? <MockBadge /> : null}
            <NotSandboxedBadge />
          </>
        }
      />

      {run.error ? (
        <Card className="mb-4 border-destructive/40">
          <CardContent className="text-body text-destructive-foreground">{run.error}</CardContent>
        </Card>
      ) : null}

      {summary ? (
        <div className="grid gap-grid md:grid-cols-3">
          <VariantCard
            label={baselineName}
            subtitle={
              baselineArtifactVersion
                ? `RED — artifact v${baselineArtifactVersion.version} installed`
                : 'RED — without the artifact'
            }
            tone="red"
            data={summary.baseline}
            invocation={invocationText(run.summary, 'baseline')}
            testId="baseline-score"
          />
          <VariantCard
            label={candidateName}
            subtitle={`GREEN — artifact v${artifactVersion.version} installed`}
            tone="green"
            data={summary.candidate}
            invocation={invocationText(run.summary, 'candidate')}
            testId="candidate-score"
          />
          <Card>
            <CardHeader>
              <CardTitle>Comparison</CardTitle>
            </CardHeader>
            <CardContent className="space-y-stack text-body">
              <p className="text-metric tabular-nums" data-testid="score-delta">
                {formatDelta(summary.delta)}
              </p>
              <dl className="grid grid-cols-2 gap-1 text-ui">
                <dt className="text-muted-foreground">Verdict</dt>
                <dd data-testid="verdict">{summary.verdict}</dd>
                <dt className="text-muted-foreground">Candidate outcome</dt>
                <dd>{summary.candidateOutcome ?? '—'}</dd>
                <dt className="text-muted-foreground">Pass-rate delta</dt>
                <dd className="tabular-nums">{formatDelta(summary.passRateDelta)}</dd>
                <dt className="text-muted-foreground">Repetitions</dt>
                <dd>{summary.repetitions}</dd>
                <dt className="text-muted-foreground">Confidence</dt>
                <dd title={summary.confidence.reason}>{summary.confidence.level}</dd>
              </dl>
              {mock ? null : (
                <Badge variant="warning" data-testid="real-agent-badge">
                  Real agent — results vary between runs
                </Badge>
              )}
              <p className="text-ui text-muted-foreground">{summary.confidence.reason}</p>
              {summary.reasons?.length ? (
                <ul className="list-inside list-disc text-ui" data-testid="verdict-reasons">
                  {summary.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
              {summary.conclusive === false ? (
                <Badge variant="warning">Not conclusive — single nondeterministic repetition</Badge>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardContent className="text-body text-muted-foreground">
            {run.status === 'running'
              ? 'Run in progress — results appear as agent runs complete.'
              : 'No summary was recorded for this run.'}
          </CardContent>
        </Card>
      )}

      <BlindReviewCard
        runId={run.id}
        status={run.status}
        mock={mock}
        review={review}
        result={blindResult}
        eligibility={eligibility}
      />

      <AgentProfileCard
        mock={mock}
        profile={profile}
        requestedModel={run.model ? `${run.model.provider}/${run.model.model}` : 'agent default'}
        otherModels={otherReportedModels(
          agentRuns.map((r) => r.trace),
          profile,
        )}
      />

      {warnings.length > 0 ? (
        <Card className="mt-4" data-testid="run-warnings">
          <CardHeader>
            <CardTitle>Warnings and uncontrolled differences</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc space-y-1 text-body text-muted-foreground">
              {warnings.map((w) => (
                <li key={w.text} data-code={w.code ?? ''}>
                  <span className={w.code ? 'font-mono text-ui' : undefined}>{w.text}</span>
                  {w.explanation ? (
                    <span className="text-foreground"> — {w.explanation}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {closed ? (
        <>
          <ClosedCard title="Output files" runId={run.id} testId="output-files-closed" />
          <ClosedCard title="Agent runs" runId={run.id} testId="agent-runs-closed" />
        </>
      ) : (
        <>
          <OutputFilesCard
            runId={run.id}
            running={run.status === 'running'}
            agentRuns={agentRuns}
            counts={fileCounts}
            variantLabel={(variant) => (variant === 'baseline' ? baselineName : candidateName)}
          />

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Agent runs</CardTitle>
              <CardDescription>
                Each run used a fresh workspace from the same fixture snapshot. Assertions are
                evaluated against the resulting files.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {agentRuns.map((agentRun) => {
                const activation = agentRunMetadata(agentRun.trace)?.skillActivation;
                const usage = usageText(agentRun.usage, profile);
                const counts = traceCounts(agentRun.trace);
                return (
                  <details
                    key={agentRun.id}
                    className="rounded-surface border"
                    data-testid="agent-run"
                  >
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-body">
                      <Badge variant={agentRun.variant === 'baseline' ? 'destructive' : 'success'}>
                        {agentRun.variant === 'baseline' ? baselineName : candidateName}
                      </Badge>
                      <span className="font-mono text-ui">
                        {agentRun.caseId} · rep {agentRun.repetition}
                      </span>
                      <span className="tabular-nums">{formatScore(agentRun.score)}</span>
                      <Badge variant={agentRunStatusBadge(agentRun).variant}>
                        {agentRunStatusBadge(agentRun).label}
                      </Badge>
                      {activation ? (
                        <Badge
                          variant={activation.invoked ? 'outline' : 'muted'}
                          data-testid="skill-invoked"
                        >
                          {activation.invoked
                            ? `Skill invoked (${activation.invocations})`
                            : activation.loaded
                              ? 'Skill not invoked'
                              : 'Skill not loaded'}
                        </Badge>
                      ) : null}
                      <span className="ml-auto text-ui text-muted-foreground">
                        {formatDuration(agentRun.durationMs)}
                      </span>
                    </summary>
                    <div className="space-y-3 border-t p-3">
                      {agentRun.error ? (
                        <p className="text-body text-destructive-foreground">{agentRun.error}</p>
                      ) : null}
                      <Table>
                        <THead>
                          <TR>
                            <TH>Assertion</TH>
                            <TH>Type</TH>
                            <TH>Result</TH>
                            <TH className="text-right">Weight</TH>
                            <TH>Message</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {agentRun.assertions.map((a) => (
                            <TR key={a.id}>
                              <TD className="font-mono text-ui">
                                {a.assertionId}
                                {a.required ? ' *' : ''}
                              </TD>
                              <TD>
                                <Badge variant="outline">{a.type}</Badge>
                                {a.deterministic ? null : (
                                  <Badge variant="warning" className="ml-1">
                                    nondeterministic
                                  </Badge>
                                )}
                              </TD>
                              <TD>
                                <Badge variant={a.passed ? 'success' : 'destructive'}>
                                  {a.passed
                                    ? 'pass'
                                    : assertionErrorOf(a.details)
                                      ? 'error'
                                      : 'fail'}
                                </Badge>
                              </TD>
                              <TD className="text-right tabular-nums">{a.weight}</TD>
                              <TD className="text-ui text-muted-foreground">
                                <p>{a.message}</p>
                                <AssertionDetails lines={assertionDetailLines(a.type, a.details)} />
                              </TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                      <p className="text-ui text-muted-foreground">
                        Changed files:{' '}
                        {agentRun.changedFiles.length
                          ? agentRun.changedFiles.map((f) => `${f.path} (${f.change})`).join(', ')
                          : 'none'}{' '}
                        · fixture{' '}
                        <span className="font-mono">{agentRun.fixtureVersionId.slice(0, 12)}…</span>
                      </p>
                      <p className="text-ui text-muted-foreground" data-testid="agent-run-usage">
                        Tokens: {usage.tokens} · Cost: {usage.cost}
                        {mock
                          ? null
                          : !agentRunMetadata(agentRun.trace)
                            ? ' · Tool calls, permission denials, retries: not reported'
                            : ` · Tool calls: ${counts.toolCalls} · Permission denials: ${counts.permissionDenials} · Retries: ${counts.retries}`}
                      </p>
                      <details>
                        <summary className="cursor-pointer text-ui text-muted-foreground">
                          Execution trace
                        </summary>
                        <Pre className="mt-2">{JSON.stringify(agentRun.trace, null, 2)}</Pre>
                      </details>
                      <details>
                        <summary className="cursor-pointer text-ui text-muted-foreground">
                          Assertion details (raw)
                        </summary>
                        <Pre className="mt-2">
                          {JSON.stringify(
                            agentRun.assertions.map((a) => ({
                              id: a.assertionId,
                              details: a.details,
                            })),
                            null,
                            2,
                          )}
                        </Pre>
                      </details>
                    </div>
                  </details>
                );
              })}
              {agentRuns.length === 0 ? (
                <p className="text-body text-muted-foreground">No agent runs recorded.</p>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Environment and versions</CardTitle>
          <CardDescription>Every result references exact, immutable versions.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-1 text-ui md:grid-cols-2">
            <dt className="text-muted-foreground">Artifact version</dt>
            <dd>
              <Link className="underline" href={`/artifacts/${artifact.id}`}>
                {artifact.name} v{artifactVersion.version}
              </Link>{' '}
              <span className="font-mono">{artifactVersion.contentHash.slice(0, 12)}…</span>
            </dd>
            <dt className="text-muted-foreground">Suite version</dt>
            <dd>
              <Link className="underline" href={`/benchmarks/${suite.id}`}>
                {suite.name} v{suiteVersion.version}
              </Link>{' '}
              <span className="font-mono">{suiteVersion.contentHash.slice(0, 12)}…</span>
            </dd>
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="font-mono">
              {run.agentAdapterId} {run.agentVersion}
            </dd>
            <dt className="text-muted-foreground">Model</dt>
            <dd>{run.model ? `${run.model.provider}/${run.model.model}` : 'n/a'}</dd>
            <dt className="text-muted-foreground">Comparability key</dt>
            <dd className="font-mono">{run.comparabilityKey?.slice(0, 16) ?? '—'}</dd>
            <dt className="text-muted-foreground">Finished</dt>
            <dd>{formatDate(run.finishedAt)}</dd>
          </dl>
          {summary?.environment ? (
            <Pre className="mt-3">{JSON.stringify(summary.environment, null, 2)}</Pre>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
