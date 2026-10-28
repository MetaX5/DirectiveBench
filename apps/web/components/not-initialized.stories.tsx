import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { NotInitialized } from './common';

const meta = {
  title: 'Product/States/NotInitialized',
  component: NotInitialized,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof NotInitialized>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shown by every page when the local database is missing. */
export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('The local database has not been initialised.')).toBeVisible();
    await expect(canvas.getByText('directivebench init')).toBeVisible();
  },
};

export const NarrowScreen: Story = {
  decorators: [
    (Story) => (
      <div className="w-full max-w-80">
        <Story />
      </div>
    ),
  ],
};
