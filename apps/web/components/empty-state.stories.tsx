import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import Link from 'next/link';
import { expect } from 'storybook/test';
import { EmptyState } from './common';

const meta = {
  title: 'Product/States/EmptyState',
  component: EmptyState,
  parameters: { layout: 'padded' },
  args: { title: 'No repositories yet' },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing here yet: say why it is empty and what to do next. */
export const NothingYet: Story = {
  args: {
    children: (
      <>
        Register a local folder or a public GitHub repository on the{' '}
        <Link href="/repositories" className="text-primary-text underline">
          Repositories
        </Link>{' '}
        page.
      </>
    ),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('No repositories yet')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Repositories' })).toBeVisible();
  },
};

/** No results for the current filters: a different message and action than "nothing yet". */
export const NoResultsForFilters: Story = {
  args: {
    title: 'No artifacts match these filters',
    children: (
      <Link href="/artifacts" className="text-primary-text underline">
        Clear all filters
      </Link>
    ),
  },
};

/** Title only, when the next step is obvious from the page. */
export const TitleOnly: Story = { args: { title: 'No runs yet' } };

/** A long explanation stays centred and wraps. */
export const LongTextNarrowScreen: Story = {
  args: {
    title: 'No benchmark suites are assigned to this artifact',
    children:
      'Suites are found when a repository contains a benchmark.yaml next to the artifact. Add one, rescan the repository and the suite appears here.',
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-80">
        <Story />
      </div>
    ),
  ],
};
