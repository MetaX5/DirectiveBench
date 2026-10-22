import { getArtifactDetail, listArtifactRuns, type ArtifactDetail } from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ContentTab } from '@/components/artifacts/content-tab';
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
import {
  groupCount,
  groupLabel,
  resultsByVersion,
  type ComparabilityGroup,
  type VersionComparison,
  type VersionResults,
} from '@/lib/artifact-runs';
import {
  ARTIFACT_TABS,
  artifactHref,
  invalidParamsNotice,
  parseArtifactDetailParams,
  parseArtifactId,
  selectContent,
  type ArtifactTab,
  type SearchParams,
} from '@/lib/artifacts';
import { getDatabase } from '@/lib/db';
import { isMockAgent } from '@/lib/mock-agent';
import { providerLabel } from '@/lib/repositories';
import { cn, formatDate, formatDelta, formatScore } from '@/lib/utils';

export const metadata: Metadata = { title: 'Artifact' };

function Tabs({ artifactId, current }: { artifactId: string; current: ArtifactTab }) {
  return (
    <nav aria-label="Artifact sections" className="mb-4 flex flex-wrap gap-1 border-b">
      {ARTIFACT_TABS.map((tab) => (
        <Link
          key={tab.id}
          href={artifactHref(artifactId, { tab: tab.id })}
          aria-current={tab.id === current ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground',
            tab.id === current
              ? 'border-foreground font-medium text-foreground'
              : 'border-transparent',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

function OverviewTab({ detail }: { detail: ArtifactDetail }) {
  const { artifact, occurrences, categories, evaluations } = detail;
  const latestEval = evaluations[0];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Occurrences</CardTitle>
          <CardDescription>Where this artifact was found, per repository and path.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table data-testid="occurrences">
            <THead>
              <TR>
                <TH>Repository</TH>
                <TH>Provider</TH>
                <TH>Path</TH>
                <TH>Status</TH>
                <TH>Last seen</TH>
              </TR>
            </THead>
            <TBody>
              {occurrences.map(({ occurrence, repository }) => (
                <TR key={occurrence.id}>
                  <TD title={repository.location}>{repository.name}</TD>
                  <TD className="text-xs">{providerLabel(repository.provider)}</TD>
                  <TD className="font-mono text-xs">{occurrence.path}</TD>
                  <TD>
                    <Badge variant={occurrence.status === 'active' ? 'outline' : 'muted'}>
                      {occurrence.status}
                    </Badge>
                  </TD>
                  <TD className="text-xs text-muted-foreground">
                    {formatDate(occurrence.lastSeenAt)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
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
                  {isMockAgent(latestEval.agentAdapterId) ? <MockBadge /> : null}
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
              <p className="text-muted-foreground">Compatibility</p>
              <p title="Agent compatibility validation is planned">Not validated</p>
            </div>
            <div>
              <p className="text-muted-foreground">Notes</p>
              <p className="whitespace-pre-line">{artifact.notes ?? '—'}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetadataTab({ detail }: { detail: ArtifactDetail }) {
  const latest = detail.versions[0];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Parsed metadata</CardTitle>
        <CardDescription>
          Latest version{latest ? ` (v${latest.version})` : ''} · format {latest?.format ?? '—'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Pre>{JSON.stringify(latest?.parsedMetadata ?? {}, null, 2)}</Pre>
      </CardContent>
    </Card>
  );
}

function VersionsTab({ detail }: { detail: ArtifactDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Version history</CardTitle>
        <CardDescription>
          Versions are immutable; a new version is created only when content changes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table data-testid="versions">
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
            {detail.versions.map((v) => (
              <TR key={v.id}>
                <TD>
                  <Link
                    className="underline"
                    href={artifactHref(detail.artifact.id, { tab: 'content', version: v.version })}
                  >
                    v{v.version}
                  </Link>
                </TD>
                <TD
                  className="font-mono text-xs"
                  title={`${v.contentHash} — SHA-256 over the sorted file manifest`}
                >
                  {v.contentHash.slice(0, 16)}…
                </TD>
                <TD>{v.files.length}</TD>
                <TD className="font-mono text-xs">{v.sourcePath ?? '—'}</TD>
                <TD className="text-xs text-muted-foreground">{formatDate(v.createdAt)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function BenchmarksTab({ detail }: { detail: ArtifactDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Assigned benchmarks</CardTitle>
        <CardDescription>Run a benchmark from its suite page.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {detail.suites.length ? (
          <ul className="space-y-1">
            {detail.suites.map((s) => (
              <li key={s.id}>
                <Link href={`/benchmarks/${s.id}`} className="underline">
                  {s.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No benchmark suite is assigned.</p>
        )}
      </CardContent>
    </Card>
  );
}

function ComparisonBadge({ comparison }: { comparison: VersionComparison }) {
  if (comparison.kind === 'regression') {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Badge variant="destructive" data-testid="version-regression">
          Version regression vs v{comparison.previousVersion}
          {comparison.versionDelta === null ? '' : ` (${formatDelta(comparison.versionDelta)})`}
        </Badge>
        <span className="text-xs text-muted-foreground" data-testid="comparison-reason">
          {comparison.reasons.join('; ')}
        </span>
      </span>
    );
  }
  if (comparison.kind === 'inconclusive') {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Badge variant="warning" data-testid="version-comparison">
          Inconclusive vs v{comparison.previousVersion}
        </Badge>
        <span className="text-xs text-muted-foreground" data-testid="comparison-reason">
          {comparison.reason}
        </span>
      </span>
    );
  }
  return (
    <Badge variant="muted" data-testid="version-comparison">
      No regression vs v{comparison.previousVersion} ({formatDelta(comparison.versionDelta)})
    </Badge>
  );
}

function GroupTable({ group, several }: { group: ComparabilityGroup; several: boolean }) {
  return (
    <div className="space-y-2" data-testid="comparability-group" data-key={group.key ?? ''}>
      <p className="text-xs font-medium">
        <span className="font-mono">{groupLabel(group.key)}</span>
        {several ? (
          <span className="text-muted-foreground"> · not comparable with other groups</span>
        ) : null}
      </p>
      <Table aria-label={`${groupLabel(group.key)} runs`}>
        <THead>
          <TR>
            <TH>Run</TH>
            <TH>Suite</TH>
            <TH>Baseline</TH>
            <TH>Agent · auth mode · isolation</TH>
            <TH>Model</TH>
            <TH>Status</TH>
            <TH className="text-right">Delta</TH>
            <TH>Confidence</TH>
            <TH>Date</TH>
          </TR>
        </THead>
        <TBody>
          {group.runs.map((row) => (
            <TR
              key={row.runId}
              data-testid="version-run"
              data-run-id={row.runId}
              className={row.comparison?.kind === 'regression' ? 'bg-destructive/10' : undefined}
            >
              <TD>
                <Link className="font-mono text-xs underline" href={`/results/${row.runId}`}>
                  {row.runId}
                </Link>
              </TD>
              <TD className="text-xs">
                <Link className="underline" href={`/benchmarks/${row.suite.id}`}>
                  {row.suite.name}
                </Link>{' '}
                v{row.suite.version}
              </TD>
              <TD className="text-xs" data-testid="run-baseline">
                {row.baseline}
              </TD>
              <TD className="text-xs">
                {row.mock ? (
                  <MockBadge />
                ) : (
                  <span className="font-mono">
                    {row.agentAdapterId} {row.agentVersion ?? ''}
                  </span>
                )}
                <p className="text-muted-foreground" data-testid="run-conditions">
                  {row.authMode} · {row.isolationProfile}
                </p>
                {row.ambientConfig ? (
                  <Badge
                    variant="warning"
                    title="Claude Code loaded your user-level configuration into both variants"
                  >
                    May include user-level instructions
                  </Badge>
                ) : null}
              </TD>
              <TD className="max-w-48 break-words font-mono text-xs">{row.model}</TD>
              <TD>
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge status={row.displayStatus} />
                  {row.comparison ? <ComparisonBadge comparison={row.comparison} /> : null}
                </div>
              </TD>
              <TD className="text-right tabular-nums">{formatDelta(row.delta)}</TD>
              <TD className="text-xs">{row.confidence ?? '—'}</TD>
              <TD className="whitespace-nowrap text-xs text-muted-foreground">
                {formatDate(row.startedAt)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function ResultsByVersionTab({ slug, results }: { slug: string; results: VersionResults[] }) {
  const tested = results.some((b) => b.groups.length > 0 || b.otherRuns.length > 0);
  const groups = groupCount(results);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Benchmark results by version</CardTitle>
        <CardDescription>
          Completed runs per artifact version, newest first, grouped by comparability key. A version
          regression compares the latest run of a version with the latest run of the previous tested
          version in the same group.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!tested ? (
          <div className="space-y-2 text-sm" data-testid="no-runs">
            <p className="text-muted-foreground">
              No benchmark runs yet. Create a suite with{' '}
              <code className="select-all rounded bg-muted px-1 font-mono">
                directivebench benchmark init --artifact {slug}
              </code>
            </p>
            <Badge variant="muted">Planned — the command is not implemented yet</Badge>
          </div>
        ) : null}
        {tested && groups > 1 ? (
          <p role="note" className="text-sm" data-testid="not-comparable-notice">
            These runs fall into {groups} comparability groups that are{' '}
            <strong>not comparable with each other</strong>: no number is compared across groups.
          </p>
        ) : null}
        {tested
          ? results.map((block) => (
              <section
                key={block.versionId}
                aria-label={`Version ${block.version}`}
                data-testid="version-results"
                data-version={block.version}
                className="space-y-3"
              >
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  v{block.version}
                  {block.regressed ? (
                    <Badge variant="destructive">
                      {block.regressionMockOnly
                        ? 'Version regression (mock agent — not an AI evaluation)'
                        : 'Version regression'}
                    </Badge>
                  ) : null}
                </h3>
                {block.groups.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No completed runs for this version.
                  </p>
                ) : (
                  block.groups.map((group, index) => (
                    <GroupTable
                      key={group.key ?? `unkeyed-${index}`}
                      group={group}
                      several={groups > 1}
                    />
                  ))
                )}
                {block.otherRuns.length > 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid="other-runs">
                    Not completed:{' '}
                    {block.otherRuns.map((run, index) => (
                      <span key={run.runId}>
                        {index > 0 ? ', ' : null}
                        <Link className="font-mono underline" href={`/results/${run.runId}`}>
                          {run.runId}
                        </Link>{' '}
                        ({run.status})
                      </span>
                    ))}
                  </p>
                ) : null}
              </section>
            ))
          : null}
      </CardContent>
    </Card>
  );
}

export default async function ArtifactPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const handle = getDatabase();
  if (!handle) return <NotInitialized />;
  const id = parseArtifactId((await params).id);
  const detail = id === null ? null : await getArtifactDetail(handle.db, id);
  if (!detail) notFound();
  const { value: query, invalid } = parseArtifactDetailParams(await searchParams);
  const { artifact, versions } = detail;
  const latest = versions[0];
  const selection = selectContent(versions, query);
  const notices = [
    invalidParamsNotice(invalid),
    ...(query.tab === 'content' ? selection.notices : []),
  ].filter((n) => n !== null);

  return (
    <>
      <PageHeader
        title={artifact.name}
        description={artifact.description ?? undefined}
        actions={
          <>
            <Badge variant="outline">{artifact.type}</Badge>
            {latest ? <Badge variant="secondary">{latest.format}</Badge> : null}
          </>
        }
      />
      <Tabs artifactId={artifact.id} current={query.tab} />
      {notices.length ? (
        <div
          role="status"
          data-testid="artifact-notice"
          className="mb-4 text-sm text-muted-foreground"
        >
          {notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      ) : null}
      {query.tab === 'overview' ? <OverviewTab detail={detail} /> : null}
      {query.tab === 'content' ? (
        <ContentTab artifactId={artifact.id} versions={versions} selection={selection} />
      ) : null}
      {query.tab === 'metadata' ? <MetadataTab detail={detail} /> : null}
      {query.tab === 'versions' ? <VersionsTab detail={detail} /> : null}
      {query.tab === 'benchmarks' ? <BenchmarksTab detail={detail} /> : null}
      {query.tab === 'evaluations' ? (
        <ResultsByVersionTab
          slug={artifact.slug}
          results={resultsByVersion(versions, await listArtifactRuns(handle.db, artifact.id))}
        />
      ) : null}
    </>
  );
}
