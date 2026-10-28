import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { Badge } from './ui/badge';
import { MockBadge, NotSandboxedBadge } from './common';

const meta = {
  title: 'Product/Benchmarking/NotSandboxedBadge',
  component: NotSandboxedBadge,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof NotSandboxedBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shown wherever a suite runs in the local-process environment. */
export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Not sandboxed')).toHaveAttribute(
      'title',
      'Commands run as your user without isolation (local-process environment)',
    );
  },
};

/** In a benchmark header, with the version and the mock label. */
export const InABenchmarkHeader: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-inline">
      <Badge variant="outline">v3</Badge>
      <MockBadge />
      <NotSandboxedBadge />
    </div>
  ),
};
