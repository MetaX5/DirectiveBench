import { getArtifactDetail } from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  MockBadge,
  NotInitialized,
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
import { formatDate, formatDelta, formatScore } from '@/lib/utils';

export const metadata: Metadata = { title: 'Artifact' };

export default async function ArtifactPage({ params }: { params: Promise<{ id: string }> }) {
  const handle = getDatabase();
  if (!handle) return <NotInitialized />;
  const { id } = await params;
  const detail = await getArtifactDetail(handle.db, id);
  if (!detail) notFound();
  const { artifact, versions, occurrences, categories, suites, evaluations } = detail;
  const latest = versions[0];
  const primary = latest?.files.find((f) => f.path === latest.primaryFile) ?? latest?.files[0];
  const latestEval = evaluations[0];

  return (
    <>
      <PageHeader
        title={artifact.name}
        description={artifact.description ?? undefined}
        actions={<Badge variant="outline">{artifact.type}</Badge>}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Original content</CardTitle>
            <CardDescription>
              {primary
                ? `${primary.path} · version ${latest?.version} · ${latest?.files.length} file(s)`
                : 'No content'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Pre data-testid="artifact-content">{primary?.content ?? ''}</Pre>
            {latest && latest.files.length > 1 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Supporting files:{' '}
                {latest.files
                  .filter((f) => f !== primary)
                  .map((f) => f.path)
                  .join(', ')}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Latest RED/GREEN comparison</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {latestEval ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      status={runDisplayStatus({
                        ...latestEval,
                        summary: { candidateOutcome: latestEval.candidateOutcome },
                      })}
                    />
                    {latestEval.agentAdapterId === 'mock' ? <MockBadge /> : null}
                  </div>
                  <dl className="grid grid-cols-2 gap-1 text-xs">
                    <dt className="text-muted-foreground">Baseline (RED)</dt>
                    <dd className="tabular-nums">{formatScore(latestEval.baselineScore)}</dd>
                    <dt className="text-muted-foreground">Candidate (GREEN)</dt>
                    <dd className="tabular-nums">{formatScore(latestEval.candidateScore)}</dd>
                    <dt className="text-muted-foreground">Delta</dt>
                    <dd className="tabular-nums">{formatDelta(latestEval.delta)}</dd>
                  </dl>
                  <Link className="text-xs underline" href={`/results/${latestEval.runId}`}>
                    Open run details and traces
                  </Link>
                </>
              ) : (
                <StatusBadge status="not-tested" />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Metadata</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div>
                <p className="text-muted-foreground">Categories</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {categories.length
                    ? categories.map((c) => <Badge key={c.slug}>{c.name}</Badge>)
                    : '—'}
                </div>
              </div>
              <div>
                <p className="text-muted-foreground">Tags</p>
                <p>{artifact.tags.length ? artifact.tags.join(', ') : '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Sources</p>
                {occurrences.map(({ occurrence, repository }) => (
                  <p key={occurrence.id} className="font-mono">
                    {repository.name}: {occurrence.path}{' '}
                    {occurrence.status === 'removed' ? '(removed)' : ''}
                  </p>
                ))}
              </div>
              <div>
                <p className="text-muted-foreground">Assigned benchmarks</p>
                {suites.length
                  ? suites.map((s) => (
                      <Link key={s.id} href={`/benchmarks/${s.id}`} className="block underline">
                        {s.name}
                      </Link>
                    ))
                  : '—'}
              </div>
              <div>
                <p className="text-muted-foreground">Notes</p>
                <p>{artifact.notes ?? '—'}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Parsed metadata</CardTitle>
            <CardDescription>Format: {latest?.format}</CardDescription>
          </CardHeader>
          <CardContent>
            <Pre>{JSON.stringify(latest?.parsedMetadata ?? {}, null, 2)}</Pre>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Version history</CardTitle>
            <CardDescription>
              Versions are immutable; a new version is created only when content changes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Version</TH>
                  <TH>Content hash</TH>
                  <TH>Files</TH>
                  <TH>Source path</TH>
                  <TH>Created</TH>
                </TR>
              </THead>
              <TBody>
                {versions.map((v) => (
                  <TR key={v.id}>
                    <TD>v{v.version}</TD>
                    <TD className="font-mono text-xs">{v.contentHash.slice(0, 16)}…</TD>
                    <TD>{v.files.length}</TD>
                    <TD className="font-mono text-xs">{v.sourcePath ?? '—'}</TD>
                    <TD className="text-xs text-muted-foreground">{formatDate(v.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Evaluation history</CardTitle>
          </CardHeader>
          <CardContent>
            {evaluations.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not evaluated yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Run</TH>
                    <TH>Version</TH>
                    <TH>Agent</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Baseline</TH>
                    <TH className="text-right">Candidate</TH>
                    <TH className="text-right">Delta</TH>
                    <TH>Date</TH>
                  </TR>
                </THead>
                <TBody>
                  {evaluations.map((e) => (
                    <TR key={e.runId}>
                      <TD>
                        <Link className="font-mono text-xs underline" href={`/results/${e.runId}`}>
                          {e.runId}
                        </Link>
                      </TD>
                      <TD>v{e.artifactVersion}</TD>
                      <TD className="text-xs">{e.agentAdapterId}</TD>
                      <TD>
                        <StatusBadge
                          status={runDisplayStatus({
                            ...e,
                            summary: { candidateOutcome: e.candidateOutcome },
                          })}
                        />
                      </TD>
                      <TD className="text-right tabular-nums">{formatScore(e.baselineScore)}</TD>
                      <TD className="text-right tabular-nums">{formatScore(e.candidateScore)}</TD>
                      <TD className="text-right tabular-nums">{formatDelta(e.delta)}</TD>
                      <TD className="text-xs text-muted-foreground">{formatDate(e.startedAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
