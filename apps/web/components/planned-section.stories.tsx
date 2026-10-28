import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { PlannedSection } from './common';

const meta = {
  title: 'Product/States/PlannedSection',
  component: PlannedSection,
  parameters: { layout: 'padded' },
  args: {
    title: 'Benchmark Builder',
    summary:
      'Build a benchmark suite from fixtures, prompts and assertions in the browser, then save it to the repository.',
    milestone: 'M4',
    specs: ['.ai/specs/2026-10-14-benchmark-builder.md'],
  },
} satisfies Meta<typeof PlannedSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The whole page of a planned section: honest, with no buttons that do nothing. */
export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Planned: not implemented')).toBeVisible();
    await expect(canvas.queryAllByRole('button')).toHaveLength(0);
  },
};

export const SeveralSpecs: Story = {
  args: {
    title: 'Model Providers',
    specs: [
      '.ai/specs/2026-10-14-model-providers.md',
      '.ai/specs/2026-10-14-agent-adapters.md',
      '.ai/specs/2026-10-15-engineering-standards.md',
    ],
  },
};

export const NarrowScreen: Story = {
  decorators: [
    (Story) => (
      <div className="w-full max-w-80 break-words">
        <Story />
      </div>
    ),
  ],
};
