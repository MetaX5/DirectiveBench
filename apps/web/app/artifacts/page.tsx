import { listArtifacts } from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  EmptyState,
  NotInitialized,
  PageHeader,
  StatusBadge,
  runDisplayStatus,
} from '@/components/common';
import {
  Badge,
  Card,
  CardContent,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@/components/ui/primitives';
import { getDatabase } from '@/lib/db';
import { formatDate, formatDelta, formatScore } from '@/lib/utils';

export const metadata: Metadata = { title: 'Artifacts' };

const TYPES = ['skill', 'instruction', 'rule'] as const;

export default async function ArtifactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; category?: string }>;
}) {
  const handle = getDatabase();
  if (!handle)
    return (
      <>
        <PageHeader title="Artifacts" />
        <NotInitialized />
      </>
    );
  const params = await searchParams;
  const all = await listArtifacts(handle.db);
  const q = params.q?.trim().toLowerCase() ?? '';
  const artifacts = all.filter(
    (a) =>
      (!q || a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q)) &&
      (!params.type || a.type === params.type) &&
      (!params.category || a.categories.some((c) => c.slug === params.category)),
  );
  const categories = [
    ...new Map(all.flatMap((a) => a.categories).map((c) => [c.slug, c])).values(),
  ];

  return (
    <>
      <PageHeader
        title="Artifacts"
        description="Skills, instructions and rules in the local registry."
      />
      <Card>
        <CardContent>
          <form className="mb-4 flex flex-wrap items-end gap-2" role="search">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Search
              <input
                name="q"
                defaultValue={params.q ?? ''}
                placeholder="Name or description"
                className="h-8 w-56 rounded-md border bg-background px-2 text-sm text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Type
              <select
                name="type"
                defaultValue={params.type ?? ''}
                className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
              >
                <option value="">All</option>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Category
              <select
                name="category"
                defaultValue={params.category ?? ''}
                className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
              >
                <option value="">All</option>
                {categories.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="h-8 rounded-md border px-3 text-sm hover:bg-accent">
              Filter
            </button>
          </form>

          {artifacts.length === 0 ? (
            <EmptyState
              title={all.length === 0 ? 'No artifacts yet' : 'No artifacts match the filters'}
            >
              {all.length === 0 ? (
                <>
                  Repository import is planned. Run{' '}
                  <code className="font-mono">npx directivebench demo</code> to load the bundled
                  example skill.
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
                  <TH>Source</TH>
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
                    <TR key={a.id}>
                      <TD className="font-medium">
                        <Link href={`/artifacts/${a.id}`} className="hover:underline">
                          {a.name}
                        </Link>
                        <span className="ml-1 text-xs text-muted-foreground">
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
                      <TD className="text-xs text-muted-foreground">
                        {a.sources.join(', ') || '—'}
                      </TD>
                      <TD
                        className="text-xs text-muted-foreground"
                        title="Agent compatibility validation is planned"
                      >
                        Not validated
                      </TD>
                      <TD className="text-right tabular-nums">{formatScore(e?.candidateScore)}</TD>
                      <TD className="text-right tabular-nums">{formatDelta(e?.delta)}</TD>
                      <TD className="text-xs text-muted-foreground">
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
