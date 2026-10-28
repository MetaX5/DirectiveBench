import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { JobStatusBadge } from './common';

const statuses = ['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;

const meta = {
  title: 'Product/Benchmarking/JobStatusBadge',
  component: JobStatusBadge,
  parameters: { layout: 'padded' },
  args: { status: 'running' },
  argTypes: { status: { control: 'select', options: statuses } },
} satisfies Meta<typeof JobStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('running')).toHaveAttribute('data-variant', 'info');
  },
};

/** Every job status of the runner queue (SPEC-008), in queue order. */
export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-wrap gap-inline">
      {statuses.map((status) => (
        <JobStatusBadge key={status} status={status} />
      ))}
    </div>
  ),
};
