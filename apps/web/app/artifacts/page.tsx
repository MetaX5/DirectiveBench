import { ARTIFACT_TYPES } from '@directivebench/core';
import {
  hasArtifacts,
  listArtifacts,
  listCategories,
  listRepositories,
} from '@directivebench/database';
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
import {
  Badge,
  Button,
  Card,
  CardContent,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@/components/ui/primitives';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  MAX_SEARCH_LENGTH,
  invalidParamsNotice,
  parseArtifactListParams,
  repositoriesLabel,
  repositoryOptions,
  type SearchParams,
} from '@/lib/artifacts';
import { getDatabase } from '@/lib/db';
import { isMockAgent } from '@/lib/mock-agent';
import { formatDate, formatDelta, formatScore } from '@/lib/utils';

export const metadata: Metadata = { title: 'Artifacts' };

export default async function ArtifactsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const handle = getDatabase();
  if (!handle)
    return (
      <>
        <PageHeader title="Artifacts" />
        <NotInitialized />
      </>
    );
  const { value: filter, invalid } = parseArtifactListParams(await searchParams);
  const filtered = Object.keys(filter).length > 0;
  const artifacts = await listArtifacts(handle.db, filter);
  const registryEmpty = artifacts.length === 0 && (!filtered || !(await hasArtifacts(handle.db)));
  const repositories = repositoryOptions(await listRepositories(handle.db));
  const categories = (await listCategories(handle.db)).filter((c) => c.archivedAt === null);
  const notice = invalidParamsNotice(invalid);

  return (
    <>
      <PageHeader
        title="Artifacts"
        description="Skills, instructions and rules from every registered repository."
      />
      <Card>
        <CardContent>
          <form className="mb-4 flex flex-wrap items-end gap-inline" role="search">
            <label className="flex flex-col gap-1 text-ui text-muted-foreground">
              Search
              <Input
                name="q"
                defaultValue={filter.q ?? ''}
                maxLength={MAX_SEARCH_LENGTH}
                placeholder="Name or description"
                className="w-56"
              />
            </label>
            <label className="flex flex-col gap-1 text-ui text-muted-foreground">
              Repository
              <NativeSelect name="repository" defaultValue={filter.repository ?? ''}>
                <NativeSelectOption value="">All</NativeSelectOption>
                {repositories.map((r) => (
                  <NativeSelectOption key={r.value} value={r.value}>
                    {r.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1 text-ui text-muted-foreground">
              Type
              <NativeSelect name="type" defaultValue={filter.type ?? ''}>
                <NativeSelectOption value="">All</NativeSelectOption>
                {ARTIFACT_TYPES.map((t) => (
                  <NativeSelectOption key={t} value={t}>
                    {t}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1 text-ui text-muted-foreground">
              Category
              <NativeSelect name="category" defaultValue={filter.category ?? ''}>
                <NativeSelectOption value="">All</NativeSelectOption>
                {categories.map((c) => (
                  <NativeSelectOption key={c.slug} value={c.slug}>
                    {c.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <Button type="submit" variant="outline">
              Filter
            </Button>
            {filtered || invalid.length ? (
              <Link href="/artifacts" className="h-8 px-2 text-body leading-8 underline">
                Clear filters
              </Link>
            ) : null}
          </form>
          {notice ? (
            <p
              role="status"
              data-testid="filter-notice"
              className="mb-4 text-body text-muted-foreground"
            >
              {notice}
            </p>
          ) : null}

          {artifacts.length === 0 ? (
            <EmptyState
              title={registryEmpty ? 'No artifacts yet' : 'No artifacts match the filters'}
            >
              {registryEmpty ? (
                <>
                  Register and scan a repository on the{' '}
                  <Link href="/repositories" className="underline">
                    Repositories
                  </Link>{' '}
                  page, or run <code className="font-mono">npx directivebench demo</code> to load
                  the bundled example skill.
                </>
              ) : null}
            </EmptyState>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Type</TH>
                  <TH>Description</TH>
                  <TH>Categories</TH>
                  <TH>Repository</TH>
                  <TH className="text-right">Occurrences</TH>
                  <TH>Compatibility</TH>
                  <TH className="text-right">Latest score</TH>
                  <TH className="text-right">vs. baseline</TH>
                  <TH>Last evaluation</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {artifacts.map((a) => {
                  const e = a.latestEvaluation;
                  return (
                    <TR key={a.id} data-artifact-id={a.id}>
                      <TD className="font-medium">
                        <Link href={`/artifacts/${a.id}`} className="hover:underline">
                          {a.name}
                        </Link>
                        <span className="ml-1 text-ui text-muted-foreground">
                          v{a.latestVersion}
                        </span>
                      </TD>
                      <TD>
                        <Badge variant="outline">{a.type}</Badge>
                      </TD>
                      <TD
                        className="max-w-xs truncate text-muted-foreground"
                        title={a.description ?? ''}
                      >
                        {a.description ?? '—'}
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          {a.categories.map((c) => (
                            <Badge key={c.slug} variant="secondary">
                              {c.name}
                            </Badge>
                          ))}
                        </div>
                      </TD>
                      <TD
                        className="text-ui text-muted-foreground"
                        title={a.repositories.map((r) => r.name).join(', ')}
                      >
                        {repositoriesLabel(a.repositories)}
                      </TD>
                      <TD className="text-right tabular-nums">{a.occurrenceCount}</TD>
                      <TD
                        className="text-ui text-muted-foreground"
                        title="Agent compatibility validation is planned"
                      >
                        Not validated
                      </TD>
                      <TD className="text-right tabular-nums" data-testid="latest-score">
                        <div className="flex flex-col items-end gap-1">
                          <span>{formatScore(e?.candidateScore)}</span>
                          {isMockAgent(e?.agentAdapterId) ? <MockBadge /> : null}
                        </div>
                      </TD>
                      <TD className="text-right tabular-nums">{formatDelta(e?.delta)}</TD>
                      <TD className="text-ui text-muted-foreground">
                        {e ? formatDate(e.finishedAt ?? e.startedAt) : '—'}
                      </TD>
                      <TD>
                        {e ? (
                          <Link href={`/results/${e.runId}`}>
                            <StatusBadge
                              status={runDisplayStatus({
                                ...e,
                                summary: { candidateOutcome: e.candidateOutcome },
                              })}
                            />
                          </Link>
                        ) : (
                          <StatusBadge status="not-tested" />
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
