import { listSuites } from '@directivebench/database';
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
                  ({ suite, latestVersion, assignedArtifactCount, lastRun, runCount }) => {
                    const definition = latestVersion?.definition as
                      { technologies?: string[]; execution?: { agent?: string } } | undefined;
                    return (
                      <TR key={suite.id}>
                        <TD className="font-medium">
                          <Link className="hover:underline" href={`/benchmarks/${suite.id}`}>
                            {suite.name}
                          </Link>
                        </TD>
                        <TD>v{latestVersion?.version}</TD>
                        <TD className="font-mono text-ui">{definition?.execution?.agent}</TD>
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
