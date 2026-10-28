import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { EmptyState, JobStatusBadge, PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// Pattern: job progress, modelled on /executions and the scan status on /repositories. Pages
// re-render every 2 seconds while a job is active (AutoRefresh); progress is text, announced
// politely.

type Job = {
  id: string;
  kind: string;
  target: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  detail: string;
};

const queue: Job[] = [
  {
    id: 'job_8c1f',
    kind: 'benchmark',
    target: 'validate-external-input',
    status: 'running',
    detail: 'Repetition 2 of 3, candidate',
  },
  {
    id: 'job_8c20',
    kind: 'benchmark',
    target: 'commit-message-style',
    status: 'pending',
    detail: 'Waiting for the running job',
  },
  {
    id: 'job_8b77',
    kind: 'scan',
    target: 'acme/agent-rules',
    status: 'completed',
    detail: '12 artifacts, 2 new versions',
  },
  {
    id: 'job_8b70',
    kind: 'benchmark',
    target: 'no-secrets-in-logs',
    status: 'failed',
    detail: 'benchmark.yaml is invalid: cases[0].prompt is required',
  },
];

function Executions({ jobs, scan }: { jobs: Job[]; scan?: string }) {
  return (
    <div className="max-w-content space-y-section">
      <PageHeader title="Executions" description="Benchmark runs and scans, newest first." />
      {scan ? (
        <Card size="sm">
          <CardContent>
            <p role="status" className="text-body">
              {scan}
            </p>
          </CardContent>
        </Card>
      ) : null}
      {jobs.length === 0 ? (
        <EmptyState title="No jobs yet">
          Run a benchmark or scan a repository; its progress appears here.
        </EmptyState>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <Table aria-label="Jobs">
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <span className="font-mono">{job.target}</span>
                      <p className="text-muted-foreground">{job.kind}</p>
                    </TableCell>
                    <TableCell>
                      <JobStatusBadge status={job.status} />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <span
                        className={
                          job.status === 'failed' ? 'text-destructive-foreground' : undefined
                        }
                      >
                        {job.detail}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {job.status === 'pending' || job.status === 'running' ? (
                        <Button size="sm" variant="outline" aria-label={`Cancel ${job.target}`}>
                          Cancel
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const meta = {
  title: 'Patterns/Job progress',
  component: Executions,
  parameters: { layout: 'padded' },
  args: { jobs: queue },
} satisfies Meta<typeof Executions>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A mixed queue: only pending and running jobs can be cancelled, and each Cancel names its job. */
export const Queue: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('button', { name: /^Cancel / })).toHaveLength(2);
    await expect(
      canvas.getByRole('button', { name: 'Cancel validate-external-input' }),
    ).toBeVisible();
  },
};

/** A scan in progress: one status line that is announced without moving focus. */
export const ScanRunning: Story = {
  args: {
    jobs: queue.slice(0, 1),
    scan: 'Scanning acme/agent-rules: 18 of 40 files read.',
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('18 of 40 files');
  },
};

/** A failed job says why in its row, in error text. */
export const Failed: Story = { args: { jobs: queue.slice(3) } };

/** Nothing has run yet. */
export const NoJobs: Story = { args: { jobs: [] } };

/** Many jobs with long names at 320px: the table scrolls inside its card. */
export const ManyJobsNarrowScreen: Story = {
  args: {
    jobs: Array.from({ length: 12 }, (_, i) => ({
      ...queue[i % 4]!,
      id: `job_${i}`,
      target: `${queue[i % 4]!.target}-with-a-much-longer-name-${i + 1}`,
    })),
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-80">
        <Story />
      </div>
    ),
  ],
};
