import type { Aggregate, ScoringSummary } from '@directivebench/benchmark-engine/scoring';
import { getBenchmarkRunDetail } from '@directivebench/database';
import type { Metadata } from 'next';
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
import { cn, formatDate, formatDelta, formatDuration, formatScore } from '@/lib/utils';

export const metadata: Metadata = { title: 'Benchmark run' };

function ScoreBar({ value, tone }: { value: number | null; tone: 'red' | 'green' }) {
  const pct = value === null ? 0 : Math.round(value * 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-muted" aria-hidden>
      <div
        className={cn('h-full', tone === 'red' ? 'bg-destructive/70' : 'bg-success/80')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function VariantCard({
  label,
  tone,
  data,
  testId,
}: {
  label: string;
  tone: 'red' | 'green';
  data: Aggregate | undefined;
  testId: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xl font-semibold tabular-nums" data-testid={testId}>
          {formatScore(data?.meanScore)}
        </p>
        <ScoreBar value={data?.meanScore ?? null} tone={tone} />
        <dl className="grid grid-cols-2 gap-1 text-xs">
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
  const { run, suite, suiteVersion, artifact, artifactVersion, agentRuns } = detail;
  const summary = run.summary as
    (ScoringSummary & { environment?: Record<string, unknown> }) | null;
  const status = runDisplayStatus(run);

  return (
    <>
      <AutoRefresh active={run.status === 'running'} />
      <PageHeader
        title={`${artifact.name} v${artifactVersion.version} × ${suite.name} v${suiteVersion.version}`}
        description={
          <>
            Run <span className="font-mono">{run.id}</span> · started {formatDate(run.startedAt)}
          </>
        }
        actions={
          <>
            {run.status === 'completed' || run.status === 'error' ? (
              <StatusBadge status={status} />
            ) : (
              <Badge variant="info">{run.status}</Badge>
            )}
            {run.agentAdapterId === 'mock' ? <MockBadge /> : null}
            <NotSandboxedBadge />
          </>
        }
      />

      {run.error ? (
        <Card className="mb-4 border-destructive/40">
          <CardContent className="text-sm text-destructive">{run.error}</CardContent>
        </Card>
      ) : null}

      {summary ? (
        <div className="grid gap-4 md:grid-cols-3">
          <VariantCard
            label="Baseline (RED) — without artifact"
            tone="red"
            data={summary.baseline}
            testId="baseline-score"
          />
          <VariantCard
            label="Candidate (GREEN) — with artifact"
            tone="green"
            data={summary.candidate}
            testId="candidate-score"
          />
          <Card>
            <CardHeader>
              <CardTitle>Comparison</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-2xl font-semibold tabular-nums" data-testid="score-delta">
                {formatDelta(summary.delta)}
              </p>
              <dl className="grid grid-cols-2 gap-1 text-xs">
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
              <p className="text-xs text-muted-foreground">{summary.confidence.reason}</p>
              {summary.reasons?.length ? (
                <ul className="list-inside list-disc text-xs" data-testid="verdict-reasons">
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
          <CardContent className="text-sm text-muted-foreground">
            {run.status === 'running'
              ? 'Run in progress — results appear as agent runs complete.'
              : 'No summary was recorded for this run.'}
          </CardContent>
        </Card>
      )}

      {run.warnings.length > 0 ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Warnings and uncontrolled differences</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc text-sm text-muted-foreground">
              {run.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Agent runs</CardTitle>
          <CardDescription>
            Each run used a fresh workspace from the same fixture snapshot. Assertions are evaluated
            against the resulting files.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {agentRuns.map((agentRun) => (
            <details key={agentRun.id} className="rounded-md border" data-testid="agent-run">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <Badge variant={agentRun.variant === 'baseline' ? 'destructive' : 'success'}>
                  {agentRun.variant === 'baseline' ? 'RED baseline' : 'GREEN candidate'}
                </Badge>
                <span className="font-mono text-xs">
                  {agentRun.caseId} · rep {agentRun.repetition}
                </span>
                <span className="tabular-nums">{formatScore(agentRun.score)}</span>
                <Badge
                  variant={
                    agentRun.passed
                      ? 'success'
                      : agentRun.passed === false
                        ? 'destructive'
                        : 'muted'
                  }
                >
                  {agentRun.executionStatus === 'completed'
                    ? agentRun.passed
                      ? 'passed'
                      : 'failed'
                    : agentRun.executionStatus}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatDuration(agentRun.durationMs)}
                </span>
              </summary>
              <div className="space-y-3 border-t p-3">
                {agentRun.error ? (
                  <p className="text-sm text-destructive">{agentRun.error}</p>
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
                        <TD className="font-mono text-xs">
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
                            {a.passed ? 'pass' : 'fail'}
                          </Badge>
                        </TD>
                        <TD className="text-right tabular-nums">{a.weight}</TD>
                        <TD className="text-xs text-muted-foreground">{a.message}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <p className="text-xs text-muted-foreground">
                  Changed files:{' '}
                  {agentRun.changedFiles.length
                    ? agentRun.changedFiles.map((f) => `${f.path} (${f.change})`).join(', ')
                    : 'none'}{' '}
                  · fixture{' '}
                  <span className="font-mono">{agentRun.fixtureVersionId.slice(0, 12)}…</span>
                </p>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Execution trace
                  </summary>
                  <Pre className="mt-2">{JSON.stringify(agentRun.trace, null, 2)}</Pre>
                </details>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Assertion details (command output)
                  </summary>
                  <Pre className="mt-2">
                    {JSON.stringify(
                      agentRun.assertions.map((a) => ({ id: a.assertionId, details: a.details })),
                      null,
                      2,
                    )}
                  </Pre>
                </details>
              </div>
            </details>
          ))}
          {agentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agent runs recorded.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Environment and versions</CardTitle>
          <CardDescription>Every result references exact, immutable versions.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-1 text-xs md:grid-cols-2">
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
