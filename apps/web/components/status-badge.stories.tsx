import type { DisplayStatus } from '@directivebench/benchmark-engine/scoring';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { StatusBadge } from './common';

const statuses: DisplayStatus[] = [
  'passed',
  'failed',
  'regression',
  'unstable',
  'error',
  'not-tested',
  'not-comparable',
];

const meaning: Record<DisplayStatus, string> = {
  passed: 'The candidate passed and did not get worse than the baseline.',
  failed: 'The candidate failed a required assertion.',
  regression: 'The candidate scored lower than the baseline.',
  unstable: 'Repetitions disagree; the result is not reliable.',
  error: 'The run could not finish (infrastructure or definition error).',
  'not-tested': 'No completed run yet.',
  'not-comparable': 'Baseline and candidate ran under different conditions.',
};

const meta = {
  title: 'Product/Benchmarking/StatusBadge',
  component: StatusBadge,
  parameters: { layout: 'padded' },
  args: { status: 'passed' },
  argTypes: { status: { control: 'select', options: statuses } },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Passed')).toHaveAttribute('data-status', 'passed');
  },
};

/** Every display status with its variant and meaning (SPEC-111 display status). */
export const AllStatuses: Story = {
  render: () => (
    <Table aria-label="Display statuses">
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Badge</TableHead>
          <TableHead>Meaning</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {statuses.map((status) => (
          <TableRow key={status}>
            <TableCell className="font-mono">{status}</TableCell>
            <TableCell>
              <StatusBadge status={status} />
            </TableCell>
            <TableCell className="whitespace-normal">{meaning[status]}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll('[data-status]')).toHaveLength(statuses.length);
  },
};
