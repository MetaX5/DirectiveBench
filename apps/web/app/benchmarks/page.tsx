import { listSuites } from '@directivebench/database';
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
import { isMockAgent } from '@/lib/mock-agent';
import { suiteLinkName } from '@/lib/row-names';
import { formatDate } from '@/lib/utils';

export const metadata: Metadata = { title: 'Benchmarks' };

export default async function BenchmarksPage() {
  const handle = getDatabase();
  if (!handle)
    return (
      <>
        <PageHeader title="Benchmarks" />
        <NotInitialized />
      </>
    );
  const suites = await listSuites(handle.db);
  return (
    <>
      <PageHeader
        title="Benchmarks"
        description="Imported benchmark suites. Suite versions are immutable snapshots of the definition and its fixtures."
      />
      {suites.length === 0 ? (
        <EmptyState title="No benchmark suites yet">
          Run <code className="font-mono">npx directivebench demo</code> to import the bundled
          executable example.
        </EmptyState>
      ) : (
        <Card>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Version</TH>
                  <TH>Agent</TH>
                  <TH>Technologies</TH>
                  <TH className="text-right">Artifacts</TH>
                  <TH className="text-right">Runs</TH>
                  <TH>Last run</TH>
                </TR>
              </THead>
              <TBody>
                {suites.map(
                  ({
                    suite,
                    nameShared,
                    latestVersion,
                    assignedArtifactCount,
                    lastRun,
                    runCount,
                  }) => {
                    const definition = latestVersion?.definition as
                      { technologies?: string[]; execution?: { agent?: string } } | undefined;
                    return (
                      <TR key={suite.id}>
                        {/* The suite ID always shows under the name: names repeat, the ID does
                            not (issue 227, K1). It breaks only at its hyphens, so the column keeps
                            room for it; a longer ID scrolls the table, not the page. */}
                        <TD className="font-medium">
                          <Link
                            className="hover:underline"
                            href={`/benchmarks/${suite.id}`}
                            aria-label={suiteLinkName({ ...suite, nameShared })}
                          >
                            {suite.name}
                          </Link>
                          <div
                            className="font-mono text-ui font-normal text-muted-foreground"
                            data-testid="suite-id"
                          >
                            <span className="sr-only">ID </span>
                            {suite.slug}
                          </div>
                        </TD>
                        <TD>v{latestVersion?.version}</TD>
                        <TD>
                          {isMockAgent(definition?.execution?.agent) ? (
                            <MockBadge />
                          ) : (
                            <span className="font-mono text-ui">
                              {definition?.execution?.agent}
                            </span>
                          )}
                        </TD>
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            {definition?.technologies?.map((t) => (
                              <Badge key={t} variant="outline">
                                {t}
                              </Badge>
                            ))}
                          </div>
                        </TD>
                        <TD className="text-right tabular-nums">{assignedArtifactCount}</TD>
                        <TD className="text-right tabular-nums">{runCount}</TD>
                        <TD>
                          {lastRun ? (
                            <span className="flex items-center gap-2">
                              <StatusBadge status={runDisplayStatus(lastRun)} />
                              <span className="text-ui text-muted-foreground">
                                {formatDate(lastRun.startedAt)}
                              </span>
                            </span>
                          ) : (
                            <StatusBadge status="not-tested" />
                          )}
                        </TD>
                      </TR>
                    );
                  },
                )}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
