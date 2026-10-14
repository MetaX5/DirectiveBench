import { listJobs } from '@directivebench/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '@/components/auto-refresh';
import { EmptyState, JobStatusBadge, NotInitialized, PageHeader } from '@/components/common';
import {
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
import { cancelJobAction } from '@/lib/actions';
import { getDatabase } from '@/lib/db';
import { formatDate } from '@/lib/utils';

export const metadata: Metadata = { title: 'Executions' };

export default async function ExecutionsPage() {
  const handle = getDatabase();
  if (!handle)
    return (
      <>
        <PageHeader title="Executions" />
        <NotInitialized />
      </>
    );
  const jobs = await listJobs(handle.db, 100);
  const active = jobs.some(({ job }) => job.status === 'pending' || job.status === 'running');
  return (
    <>
      <AutoRefresh active={active} />
      <PageHeader
        title="Executions"
        description="Jobs in the local queue. Pending jobs are processed by the runner started with `directivebench serve`."
      />
      {jobs.length === 0 ? (
        <EmptyState title="No jobs yet">
          Start a run from a benchmark page or with{' '}
          <code className="font-mono">npx directivebench demo</code>.
        </EmptyState>
      ) : (
        <Card>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Job</TH>
                  <TH>Benchmark</TH>
                  <TH>Artifact</TH>
                  <TH>Status</TH>
                  <TH>Created</TH>
                  <TH>Finished</TH>
                  <TH>Details</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {jobs.map(({ job, suiteName, artifactName, benchmarkRunId }) => (
                  <TR key={job.id} data-job-status={job.status}>
                    <TD className="font-mono text-xs">{job.id}</TD>
                    <TD>{suiteName ?? '—'}</TD>
                    <TD>{artifactName ?? '—'}</TD>
                    <TD>
                      <JobStatusBadge status={job.status} />
                      {job.cancelRequestedAt && job.status === 'running' ? (
                        <span className="ml-1 text-xs text-muted-foreground">cancelling…</span>
                      ) : null}
                    </TD>
                    <TD className="text-xs text-muted-foreground">{formatDate(job.createdAt)}</TD>
                    <TD className="text-xs text-muted-foreground">{formatDate(job.finishedAt)}</TD>
                    <TD className="max-w-xs text-xs">
                      {benchmarkRunId ? (
                        <Link className="underline" href={`/results/${benchmarkRunId}`}>
                          View run
                        </Link>
                      ) : null}
                      {job.error ? <p className="text-destructive">{job.error}</p> : null}
                    </TD>
                    <TD>
                      {(job.status === 'pending' || job.status === 'running') &&
                      !job.cancelRequestedAt ? (
                        <form action={cancelJobAction}>
                          <input type="hidden" name="jobId" value={job.id} />
                          <Button size="sm" variant="outline" type="submit">
                            Cancel
                          </Button>
                        </form>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
