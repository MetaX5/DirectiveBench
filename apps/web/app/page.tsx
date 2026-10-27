import { getDashboardStats } from '@directivebench/database';
import Link from 'next/link';
import {
  EmptyState,
  MockBadge,
  NotInitialized,
  PageHeader,
  StatusBadge,
  runDisplayStatus,
} from '@/components/common';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@/components/ui/primitives';
import { getDatabase } from '@/lib/db';
import { isMockAgent } from '@/lib/mock-agent';
import { formatDate, formatDelta, formatScore } from '@/lib/utils';

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className="mt-1 text-metric tabular-nums"
          data-testid={`stat-${label.toLowerCase().replaceAll(/[^a-z]+/g, '-')}`}
        >
          {value}
        </p>
        {hint ? <p className="mt-1 text-caption text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

export default async function DashboardPage() {
  const handle = getDatabase();
  if (!handle) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <NotInitialized />
      </>
    );
  }
  const stats = await getDashboardStats(handle.db);
  const succeeded = (stats.runsByVerdict.improved ?? 0) + (stats.runsByVerdict.unchanged ?? 0);
  const failed = (stats.runsByVerdict.error ?? 0) + (stats.runsByVerdict.regressed ?? 0);
  const regressions = stats.recentRuns.filter((r) => r.run.verdict === 'regressed');

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Overview of the local registry and recent evaluations."
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Repositories"
          value={stats.repositoryCount}
          hint="Sources artifacts were imported from"
        />
        <Stat label="Artifacts" value={stats.artifactCount} />
        <Stat label="Skills" value={stats.skillCount} />
        <Stat label="Rules & instructions" value={stats.ruleCount + stats.instructionCount} />
        <Stat
          label="Last synchronisation"
          value={stats.lastSyncAt ? formatDate(stats.lastSyncAt) : 'Never'}
          hint="Repository sync is planned (Milestone 2)"
        />
        <Stat
          label="Benchmark runs"
          value={Object.values(stats.runsByVerdict).reduce((a, b) => a + b, 0)}
        />
        <Stat
          label="Improved or unchanged"
          value={succeeded}
          hint="Completed runs without regression or error"
        />
        <Stat label="Regressions or errors" value={failed} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent benchmark runs</CardTitle>
          <CardDescription>
            Baseline (RED) vs candidate (GREEN) mean weighted scores.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stats.recentRuns.length === 0 ? (
            <EmptyState title="No benchmark runs yet">
              Run <code className="font-mono">npx directivebench demo</code> to import the bundled
              example and execute it with the deterministic mock agent, or start a run from{' '}
              <Link className="underline" href="/benchmarks">
                Benchmarks
              </Link>
              .
            </EmptyState>
          ) : (
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
                  <TH>Started</TH>
                </TR>
              </THead>
              <TBody>
                {stats.recentRuns.map(({ run, suite, artifact }) => {
                  const summary = run.summary as {
                    baseline?: { meanScore: number | null };
                    candidate?: { meanScore: number | null };
                    delta?: number | null;
                  } | null;
                  return (
                    <TR key={run.id}>
                      <TD>
                        <Link className="font-medium hover:underline" href={`/results/${run.id}`}>
                          {artifact.name}
                        </Link>
                        <span className="ml-1 text-xs text-muted-foreground">
                          v{artifact.version}
                        </span>
                      </TD>
                      <TD className="text-muted-foreground">{suite.name}</TD>
                      <TD>
                        {isMockAgent(run.agentAdapterId) ? <MockBadge /> : run.agentAdapterId}
                      </TD>
                      <TD>
                        {run.status === 'running' ? (
                          <span className="text-xs">running…</span>
                        ) : (
                          <StatusBadge status={runDisplayStatus(run)} />
                        )}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {formatScore(summary?.baseline?.meanScore)}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {formatScore(summary?.candidate?.meanScore)}
                      </TD>
                      <TD className="text-right tabular-nums">{formatDelta(summary?.delta)}</TD>
                      <TD className="text-xs text-muted-foreground">{formatDate(run.startedAt)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent regressions</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {regressions.length === 0
            ? 'No regressions among the recent runs.'
            : regressions.map(({ run, artifact }) => (
                <Link key={run.id} href={`/results/${run.id}`} className="block hover:underline">
                  {artifact.name} v{artifact.version}
                </Link>
              ))}
        </CardContent>
      </Card>
    </>
  );
}
