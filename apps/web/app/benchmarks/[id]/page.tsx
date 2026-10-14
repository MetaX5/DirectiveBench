import { validateDefinition } from '@directivebench/benchmark-engine/load';
import { getSuiteDetail, listBenchmarkRuns } from '@directivebench/database';
import { Play } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
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
  Button,
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
import { enqueueBenchmarkRunAction } from '@/lib/actions';
import { getDatabase } from '@/lib/db';
import { formatDate, formatDelta } from '@/lib/utils';

export const metadata: Metadata = { title: 'Benchmark' };

export default async function BenchmarkPage({ params }: { params: Promise<{ id: string }> }) {
  const handle = getDatabase();
  if (!handle) return <NotInitialized />;
  const { id } = await params;
  const detail = await getSuiteDetail(handle.db, id);
  if (!detail?.latestVersion) notFound();
  const version = detail.latestVersion;
  const parsed = validateDefinition(version.definition);
  const runs = await listBenchmarkRuns(handle.db, { suiteId: id, limit: 20 });
  const definition = parsed.success ? parsed.definition : null;
  const approved = Boolean(version.executionApprovedAt);

  return (
    <>
      <PageHeader
        title={detail.suite.name}
        description={detail.suite.description ?? undefined}
        actions={
          <>
            <Badge variant="outline">v{version.version}</Badge>
            {definition?.execution.agent === 'mock' ? <MockBadge /> : null}
            {definition?.execution.environment.kind === 'local-process' ? (
              <NotSandboxedBadge />
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Cases</CardTitle>
            <CardDescription>
              {definition
                ? `${definition.cases.length} case(s) · ${definition.execution.repetitions} repetition(s) per variant · timeout ${definition.execution.timeoutSeconds}s`
                : 'Stored definition failed validation'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {definition?.cases.map((c) => (
              <div key={c.id} className="rounded-md border p-3">
                <p className="text-sm font-medium">
                  {c.name} <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
                </p>
                <Pre className="mt-2 max-h-40">{c.prompt}</Pre>
                <Table className="mt-2">
                  <THead>
                    <TR>
                      <TH>Assertion</TH>
                      <TH>Type</TH>
                      <TH className="text-right">Weight</TH>
                      <TH>Required</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {c.assertions.map((a) => (
                      <TR key={a.id}>
                        <TD>
                          <span className="font-mono text-xs">{a.id}</span>
                          {a.description ? (
                            <p className="text-xs text-muted-foreground">{a.description}</p>
                          ) : null}
                        </TD>
                        <TD>
                          <Badge variant="outline">{a.type}</Badge>
                        </TD>
                        <TD className="text-right tabular-nums">{a.weight}</TD>
                        <TD>{a.required ? 'yes' : '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ))}
            {!parsed.success ? (
              <Pre>{parsed.issues.map((i) => `${i.path}: ${i.message}`).join('\n')}</Pre>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Run benchmark</CardTitle>
              <CardDescription>
                Enqueues a RED/GREEN run for the latest artifact version. The runner in the CLI
                process executes it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!approved ? (
                <p className="text-xs text-warning">
                  This suite version runs commands but is not approved for execution. Approval in
                  the UI is planned.
                </p>
              ) : null}
              {detail.assignedArtifacts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No artifacts are assigned to this suite.
                </p>
              ) : null}
              {detail.assignedArtifacts.map((artifact) => (
                <form
                  key={artifact.id}
                  action={enqueueBenchmarkRunAction}
                  className="flex items-center justify-between gap-2"
                >
                  <input type="hidden" name="suiteVersionId" value={version.id} />
                  <input type="hidden" name="artifactId" value={artifact.id} />
                  <Link href={`/artifacts/${artifact.id}`} className="truncate hover:underline">
                    {artifact.name}
                  </Link>
                  <Button size="sm" type="submit" disabled={!approved || !definition}>
                    <Play aria-hidden /> Run
                  </Button>
                </form>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs">
              <p>
                <span className="text-muted-foreground">Agent:</span>{' '}
                <span className="font-mono">{definition?.execution.agent}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Model:</span>{' '}
                {definition?.execution.model
                  ? `${definition.execution.model.provider}/${definition.execution.model.model}`
                  : 'adapter default'}
              </p>
              <p>
                <span className="text-muted-foreground">Environment:</span>{' '}
                {definition?.execution.environment.kind}
              </p>
              <p>
                <span className="text-muted-foreground">Pass threshold:</span>{' '}
                {definition?.scoring.passThreshold}
              </p>
              <p>
                <span className="text-muted-foreground">Min. delta:</span>{' '}
                {definition?.scoring.minDelta}
              </p>
              <p>
                <span className="text-muted-foreground">Execution approval:</span>{' '}
                {approved
                  ? `${version.executionApprovalSource} (${formatDate(version.executionApprovedAt)})`
                  : 'not approved'}
              </p>
              <p>
                <span className="text-muted-foreground">Content hash:</span>{' '}
                <span className="font-mono">{version.contentHash.slice(0, 16)}…</span>
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Runs</CardTitle>
          </CardHeader>
          <CardContent>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Run</TH>
                    <TH>Artifact</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Delta</TH>
                    <TH>Started</TH>
                  </TR>
                </THead>
                <TBody>
                  {runs.map(({ run, artifact }) => (
                    <TR key={run.id}>
                      <TD>
                        <Link className="font-mono text-xs underline" href={`/results/${run.id}`}>
                          {run.id}
                        </Link>
                      </TD>
                      <TD>
                        {artifact.name} v{artifact.version}
                      </TD>
                      <TD>
                        {run.status === 'running' ? (
                          'running…'
                        ) : (
                          <StatusBadge status={runDisplayStatus(run)} />
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {formatDelta((run.summary as { delta?: number } | null)?.delta)}
                      </TD>
                      <TD className="text-xs text-muted-foreground">{formatDate(run.startedAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Definition (as stored)</CardTitle>
          </CardHeader>
          <CardContent>
            <Pre>{JSON.stringify(version.definition, null, 2)}</Pre>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
