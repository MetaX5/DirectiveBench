import {
  countArtifactRuns,
  getArtifactDetail,
  listActiveCategoryNames,
  listArtifactRuns,
  listSuiteNames,
  listVersionComparisonRuns,
  type ArtifactDetail,
  type Database,
} from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ContentTab } from '@/components/artifacts/content-tab';
import { CategoriesCard, NotesCard, SuitesCard, TagsCard } from './metadata-forms';
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
  historyNotices,
  resultsByVersion,
  type ComparabilityGroup,
  type VersionComparison,
  type VersionLineage,
  type VersionResults,
} from '@/lib/artifact-runs';
import { HASH_EXPLANATION, firstSeenLabel, shortHash } from '@/lib/artifact-versions';
import { CopyHashButton } from './copy-hash-button';
import {
  ARTIFACT_TABS,
  artifactHref,
  invalidParamsNotice,
  missingNote,
  occurrenceStatusLabel,
  occurrenceVersionLabel,
  parseArtifactDetailParams,
  parseArtifactId,
  possibleDuplicatesCard,
  selectContent,
  type ArtifactTab,
  type SearchParams,
} from '@/lib/artifacts';
import { metadataLimits, suiteOptions, suiteSubject } from '@/lib/artifact-metadata';
import { categoriesCardModel, type CategoriesCardModel } from '@/lib/categories';
import { getDatabase } from '@/lib/db';
import { isMockAgent } from '@/lib/mock-agent';
import { providerLabel } from '@/lib/repositories';
import { cn, formatDate, formatDelta, formatScore } from '@/lib/utils';

export const metadata: Metadata = { title: 'Artifact' };

type SuiteOption = Awaited<ReturnType<typeof listSuiteNames>>[number];

function Tabs({ artifactId, current }: { artifactId: string; current: ArtifactTab }) {
  return (
    <nav aria-label="Artifact sections" className="mb-4 flex flex-wrap gap-1 border-b">
      {ARTIFACT_TABS.map((tab) => (
        <Link
          key={tab.id}
          href={artifactHref(artifactId, { tab: tab.id })}
          aria-current={tab.id === current ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-1.5 text-body text-muted-foreground hover:text-foreground',
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

function OverviewTab({
  detail,
  categories,
}: {
  detail: ArtifactDetail;
  categories: CategoriesCardModel;
}) {
  const { artifact, occurrences, evaluations } = detail;
  const latestEval = evaluations[0];
  const latestVersion = detail.versions[0]?.version ?? 0;
  const duplicates = possibleDuplicatesCard(artifact, detail.possibleDuplicates);
  return (
    <div className="grid gap-grid lg:grid-cols-3">
      {/* Where it is and what else has its name, together (SPEC-126 §11.4 G4). */}
      <div className="flex min-w-0 flex-col gap-grid lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Occurrences</CardTitle>
            <CardDescription>
              Where this artifact was found, per repository and path, and the version each one
              holds.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {occurrences.length === 0 ? (
              <p data-testid="no-occurrences" className="text-body text-muted-foreground">
                No occurrences left: the repositories it was found in were removed.
              </p>
            ) : (
              <Table data-testid="occurrences" aria-label="Occurrences">
                <THead>
                  <TR>
                    <TH>Repository</TH>
                    <TH>Provider</TH>
                    <TH>Path</TH>
                    <TH>Version</TH>
                    <TH>Status</TH>
                    <TH>Last seen</TH>
                  </TR>
                </THead>
                <TBody>
                  {occurrences.map(({ occurrence, repository, version }) => {
                    const held = occurrenceVersionLabel(version, latestVersion, artifact.name);
                    return (
                      <TR key={occurrence.id} data-testid="occurrence-row">
                        <TD title={repository.location}>{repository.name}</TD>
                        <TD className="text-ui">{providerLabel(repository.provider)}</TD>
                        <TD className="font-mono text-ui">{occurrence.path}</TD>
                        <TD>
                          <span className="inline-flex flex-wrap items-center gap-inline-tight">
                            <Link
                              className="underline"
                              aria-label={held.accessibleName}
                              data-testid="occurrence-version"
                              href={artifactHref(artifact.id, { tab: 'content', version })}
                            >
                              {held.label}
                            </Link>
                            {held.older ? (
                              <Badge
                                variant="muted"
                                className="whitespace-nowrap"
                                data-testid="older-version"
                              >
                                older version
                              </Badge>
                            ) : null}
                          </span>
                        </TD>
                        <TD>
                          <Badge variant={occurrence.status === 'active' ? 'outline' : 'muted'}>
                            {occurrenceStatusLabel(occurrence.status)}
                          </Badge>
                        </TD>
                        <TD className="text-ui text-muted-foreground">
                          {formatDate(occurrence.lastSeenAt)}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
        {duplicates ? (
          <Card data-testid="possible-duplicates">
            <CardHeader>
              <CardTitle>Possible duplicates</CardTitle>
              <CardDescription>
                Other artifacts with the same name and format. Each one keeps its own versions and
                results.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-stack">
              <Table aria-label="Possible duplicates">
                <THead>
                  <TR>
                    <TH>Artifact</TH>
                    <TH>Repositories</TH>
                    <TH>Content</TH>
                  </TR>
                </THead>
                <TBody>
                  {duplicates.rows.map((row) => (
                    <TR key={row.id} data-testid="duplicate-row">
                      <TD className="whitespace-nowrap">
                        <Link className="font-mono text-ui underline" href={row.href}>
                          {row.slug}
                        </Link>
                      </TD>
                      <TD className="text-ui wrap-anywhere">
                        {row.repositories ?? <Badge variant="muted">Missing</Badge>}
                      </TD>
                      <TD className="text-ui">{row.content}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {duplicates.more ? (
                <p data-testid="duplicates-more" className="text-ui text-muted-foreground">
                  {duplicates.more.text}{' '}
                  <Link className="underline" href={duplicates.more.href}>
                    {duplicates.more.linkText}
                  </Link>
                </p>
              ) : null}
              {duplicates.note ? (
                <p data-testid="duplicates-note" className="text-ui text-muted-foreground">
                  {duplicates.note}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="flex flex-col gap-grid">
        <Card>
          <CardHeader>
            <CardTitle>Latest RED/GREEN comparison</CardTitle>
          </CardHeader>
          <CardContent className="space-y-stack text-body">
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
                <dl className="grid grid-cols-2 gap-1 text-ui">
                  <dt className="text-muted-foreground">Baseline (RED)</dt>
                  <dd className="tabular-nums">{formatScore(latestEval.baselineScore)}</dd>
                  <dt className="text-muted-foreground">Candidate (GREEN)</dt>
                  <dd className="tabular-nums">{formatScore(latestEval.candidateScore)}</dd>
                  <dt className="text-muted-foreground">Delta</dt>
                  <dd className="tabular-nums">{formatDelta(latestEval.delta)}</dd>
                </dl>
                <Link className="text-ui underline" href={`/results/${latestEval.runId}`}>
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
          <CardContent className="space-y-stack text-ui">
            <div>
              <p className="text-muted-foreground">Compatibility</p>
              <p title="Agent compatibility validation is planned">Not validated</p>
            </div>
          </CardContent>
        </Card>
        <CategoriesCard artifactId={artifact.id} model={categories} />
        <TagsCard
          artifactId={artifact.id}
          // Sorted on the server only, so the browser renders the same order (no hydration drift).
          tags={[...artifact.tags].sort()}
          maxTags={metadataLimits.tags}
          maxTagLength={metadataLimits.tagLength}
        />
        <NotesCard
          artifactId={artifact.id}
          notes={artifact.notes}
          maxLength={metadataLimits.notesLength}
        />
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
  // Versions come newest first, so the first row is the highest number (SPEC-103 §11).
  const latestId = detail.versions[0]?.id;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Version history</CardTitle>
        <CardDescription>
          Versions are immutable; a new version is created only when the content or a file name
          changes. The content hash is the {HASH_EXPLANATION}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table data-testid="versions" aria-label="Version history">
          <THead>
            <TR>
              <TH>Version</TH>
              <TH>Content hash</TH>
              <TH>Files</TH>
              <TH>First seen</TH>
              <TH>Created</TH>
            </TR>
          </THead>
          <TBody>
            {detail.versions.map((v) => (
              <TR key={v.id} data-testid="version-row">
                <TD>
                  <span className="inline-flex flex-wrap items-center gap-inline-tight">
                    <Link
                      className="underline"
                      href={artifactHref(detail.artifact.id, {
                        tab: 'content',
                        version: v.version,
                      })}
                    >
                      v{v.version}
                    </Link>
                    {v.id === latestId ? (
                      <Badge variant="info" data-testid="latest-version">
                        latest
                      </Badge>
                    ) : null}
                  </span>
                </TD>
                <TD>
                  <span className="inline-flex flex-wrap items-center gap-inline">
                    <span
                      className="font-mono text-ui"
                      data-testid="version-hash"
                      title={`${HASH_EXPLANATION}: ${v.contentHash}`}
                    >
                      {shortHash(v.contentHash)}
                    </span>
                    <CopyHashButton hash={v.contentHash} version={v.version} />
                  </span>
                </TD>
                <TD>{v.files.length}</TD>
                <TD
                  className="min-w-48 font-mono text-ui wrap-anywhere"
                  data-testid="version-first-seen"
                  title={v.sourceCommitSha === null ? undefined : `Commit ${v.sourceCommitSha}`}
                >
                  {firstSeenLabel(v, detail.sourceRepositories)}
                </TD>
                <TD className="text-ui text-muted-foreground">{formatDate(v.createdAt)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * The Assigned benchmarks card. Suite names can repeat, so the Unassign names and the picker's
 * option labels add the suite ID; they are built here because the client card imports no core
 * values (issue 219, SPEC-101 §11).
 */
function BenchmarksTab({ detail, suites }: { detail: ArtifactDetail; suites: SuiteOption[] }) {
  const assigned = new Set(detail.suites.map((s) => s.id));
  return (
    <SuitesCard
      artifactId={detail.artifact.id}
      assigned={detail.suites.map((s) => ({
        id: s.id,
        name: s.name,
        unassignName: `Unassign suite ${suiteSubject(s)}`,
      }))}
      available={suiteOptions(suites.filter((s) => !assigned.has(s.id)))}
    />
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
        <span className="text-ui text-muted-foreground" data-testid="comparison-reason">
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
        <span className="text-ui text-muted-foreground" data-testid="comparison-reason">
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
    <div className="space-y-stack" data-testid="comparability-group" data-key={group.key ?? ''}>
      <p className="text-ui font-medium">
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
                <Link className="font-mono text-ui underline" href={`/results/${row.runId}`}>
                  {row.runId}
                </Link>
              </TD>
              <TD className="text-ui">
                <Link className="underline" href={`/benchmarks/${row.suite.id}`}>
                  {row.suite.name}
                </Link>{' '}
                v{row.suite.version}
              </TD>
              <TD className="text-ui" data-testid="run-baseline">
                {row.baseline}
              </TD>
              <TD className="text-ui">
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
              <TD className="max-w-48 break-words font-mono text-ui">{row.model}</TD>
              <TD>
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge status={row.displayStatus} />
                  {row.comparison ? <ComparisonBadge comparison={row.comparison} /> : null}
                </div>
              </TD>
              <TD className="text-right tabular-nums">{formatDelta(row.delta)}</TD>
              <TD className="text-ui">{row.confidence ?? '—'}</TD>
              <TD className="whitespace-nowrap text-ui text-muted-foreground">
                {formatDate(row.startedAt)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

async function loadRunHistory(
  db: Database,
  artifactId: string,
  versions: readonly VersionLineage[],
): Promise<{ results: VersionResults[]; notices: string[] }> {
  const [items, total, comparisons] = await Promise.all([
    listArtifactRuns(db, artifactId),
    countArtifactRuns(db, artifactId),
    listVersionComparisonRuns(db, artifactId),
  ]);
  return {
    results: resultsByVersion(versions, items, comparisons.runs),
    notices: historyNotices(items.length, total, comparisons.truncated),
  };
}

function ResultsByVersionTab({
  slug,
  results,
  notices,
}: {
  slug: string;
  results: VersionResults[];
  notices: string[];
}) {
  const tested = results.some((b) => b.groups.length > 0 || b.otherRuns.length > 0);
  const groups = groupCount(results);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Benchmark results by version</CardTitle>
        <CardDescription>
          Completed runs per artifact version, newest first, grouped by comparability key. A version
          regression compares the latest run of a version with the latest run of the nearest tested
          version before it in its edit history, in the same group.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {notices.map((notice) => (
          <p key={notice} role="note" className="text-body" data-testid="history-notice">
            {notice}
          </p>
        ))}
        {!tested ? (
          <div className="space-y-stack text-body" data-testid="no-runs">
            <p className="text-muted-foreground">
              No benchmark runs yet. Create a suite with{' '}
              <code className="select-all rounded-surface bg-muted px-1 font-mono">
                directivebench benchmark init --artifact {slug}
              </code>
            </p>
          </div>
        ) : null}
        {tested && groups > 1 ? (
          <p role="note" className="text-body" data-testid="not-comparable-notice">
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
                <h3 className="flex flex-wrap items-center gap-2 text-body font-semibold">
                  v{block.version}
                  {block.editedFrom === null ? null : (
                    <span
                      className="text-ui font-normal text-muted-foreground"
                      data-testid="edited-from"
                    >
                      edited from v{block.editedFrom}
                    </span>
                  )}
                  {block.regressed ? (
                    <Badge variant="destructive">
                      {block.regressionMockOnly
                        ? 'Version regression (mock agent, not an AI evaluation)'
                        : 'Version regression'}
                    </Badge>
                  ) : null}
                </h3>
                {block.groups.length === 0 ? (
                  <p className="text-ui text-muted-foreground">
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
                  <p className="text-ui text-muted-foreground" data-testid="other-runs">
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
            {detail.missing ? <Badge variant="muted">Missing</Badge> : null}
            {/* Shown on every tab, not only with the Overview card (SPEC-126 §11.4 G3). */}
            {detail.possibleDuplicates.total > 0 ? (
              <Badge variant="outline" data-testid="possible-duplicate">
                Possible duplicate
              </Badge>
            ) : null}
          </>
        }
      />
      {/* No active occurrence anywhere (SPEC-125 FR-125-09, D1 to D3): shown on every tab. */}
      {detail.missing ? (
        <p role="note" data-testid="missing-note" className="mb-4 text-body">
          {missingNote(detail)}
        </p>
      ) : null}
      <Tabs artifactId={artifact.id} current={query.tab} />
      {notices.length ? (
        <div
          role="status"
          data-testid="artifact-notice"
          className="mb-4 text-body text-muted-foreground"
        >
          {notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      ) : null}
      {query.tab === 'overview' ? (
        <OverviewTab
          detail={detail}
          categories={categoriesCardModel(
            detail.categories,
            await listActiveCategoryNames(handle.db),
          )}
        />
      ) : null}
      {query.tab === 'content' ? (
        <ContentTab artifactId={artifact.id} versions={versions} selection={selection} />
      ) : null}
      {query.tab === 'metadata' ? <MetadataTab detail={detail} /> : null}
      {query.tab === 'versions' ? <VersionsTab detail={detail} /> : null}
      {query.tab === 'benchmarks' ? (
        <BenchmarksTab detail={detail} suites={await listSuiteNames(handle.db)} />
      ) : null}
      {query.tab === 'evaluations' ? (
        <ResultsByVersionTab
          slug={artifact.slug}
          {...await loadRunHistory(handle.db, artifact.id, versions)}
        />
      ) : null}
    </>
  );
}
