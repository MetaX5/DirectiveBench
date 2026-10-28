import { listBenchmarkRuns } from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  EmptyState,
  MockBadge,
  NotInitialized,
  PageHeader,
  StatusBadge,
  runDisplayStatus,
} from '@/components/common';
import { Card, CardContent, TBody, TD, TH, THead, TR, Table } from '@/components/ui/primitives';
import { getDatabase } from '@/lib/db';
import { isMockAgent } from '@/lib/mock-agent';
import { formatDate, formatDelta, formatScore } from '@/lib/utils';

export const metadata: Metadata = { title: 'Results' };

interface SummaryShape {
  baseline?: { meanScore: number | null; passRate: number | null };
  candidate?: { meanScore: number | null; passRate: number | null };
  delta?: number | null;
  confidence?: { level: string };
}

export default async function ResultsPage() {
  const handle = getDatabase();
  if (!handle)
    return (
      <>
        <PageHeader title="Results" />
        <NotInitialized />
      </>
    );
  const runs = await listBenchmarkRuns(handle.db, { limit: 100 });
  return (
    <>
      <PageHeader
        title="Results"
        description="Benchmark runs. Results are only compared within the same comparability key; there is no global ranking across suites."
      />
      {runs.length === 0 ? (
        <EmptyState title="No results yet" />
      ) : (
        <Card>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Artifact</TH>
                  <TH>Benchmark</TH>
                  <TH>Agent</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Baseline</TH>
                  <TH className="text-right">Candidate</TH>
                  <TH className="text-right">Delta</TH>
                  <TH>Confidence</TH>
                  <TH>Started</TH>
                </TR>
              </THead>
              <TBody>
                {runs.map(({ run, suite, artifact }) => {
                  const s = run.summary as SummaryShape | null;
                  return (
                    <TR key={run.id}>
                      <TD>
                        <Link className="font-medium hover:underline" href={`/results/${run.id}`}>
                          {artifact.name}
                        </Link>{' '}
                        <span className="text-ui text-muted-foreground">v{artifact.version}</span>
                      </TD>
                      <TD className="text-muted-foreground">
                        {suite.name} <span className="text-ui">v{suite.version}</span>
                      </TD>
                      <TD>
                        {isMockAgent(run.agentAdapterId) ? (
                          <MockBadge />
                        ) : (
                          <span className="font-mono text-ui">{run.agentAdapterId}</span>
                        )}
                      </TD>
                      <TD>
                        {run.status === 'running' ? (
                          'running…'
                        ) : run.status === 'cancelled' || run.status === 'interrupted' ? (
                          <span className="text-ui">{run.status}</span>
                        ) : (
                          <StatusBadge status={runDisplayStatus(run)} />
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {formatScore(s?.baseline?.meanScore)}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {formatScore(s?.candidate?.meanScore)}
                      </TD>
                      <TD className="text-right tabular-nums">{formatDelta(s?.delta)}</TD>
                      <TD className="text-ui">{s?.confidence?.level ?? '—'}</TD>
                      <TD className="text-ui text-muted-foreground">{formatDate(run.startedAt)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
