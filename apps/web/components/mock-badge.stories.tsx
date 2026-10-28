import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { MockBadge, StatusBadge } from './common';

const meta = {
  title: 'Product/Benchmarking/MockBadge',
  component: MockBadge,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof MockBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every result of the mock agent carries this label (AGENTS.md §7, SPEC-101 FR-101-14). */
export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Mock agent: not an AI evaluation')).toBeVisible();
  },
};

/** Next to a score, as in the Latest score column of /artifacts. */
export const NextToAResult: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-inline">
      <span className="tabular-nums">50% → 100%</span>
      <StatusBadge status="passed" />
      <MockBadge />
    </div>
  ),
};

/** At 320px the label wraps inside the badge instead of being cut. */
export const NarrowScreen: Story = {
  decorators: [
    (Story) => (
      <div className="w-40">
        <Story />
      </div>
    ),
  ],
};
