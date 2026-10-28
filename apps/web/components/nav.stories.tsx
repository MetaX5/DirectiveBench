import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { usePathname } from '@storybook/nextjs-vite/navigation.mock';
import { expect, userEvent } from 'storybook/test';
import { Nav } from './nav';

const meta = {
  title: 'Product/App shell/Nav',
  component: Nav,
  parameters: { layout: 'padded' },
  // The App Router context of Next 16.4 does not match Storybook's mock, so the hook is stubbed
  // (lesson 2026-10-28-storybook-nextjs-vite-app-directory-breaks-on-next-16-4).
  beforeEach: () => {
    usePathname.mockReturnValue('/artifacts');
  },
  decorators: [
    (Story) => (
      <aside className="w-sidebar bg-sidebar p-3">
        <Story />
      </aside>
    ),
  ],
} satisfies Meta<typeof Nav>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The current section is marked for sight and for assistive technology. */
export const ActivePage: Story = {
  play: async ({ canvas }) => {
    const nav = canvas.getByRole('navigation', { name: 'Main' });
    await expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    await expect(canvas.getByRole('link', { name: 'Artifacts' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Tab moves through the links in reading order.
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: 'Dashboard' })).toHaveFocus();
  },
};

/** A detail page keeps its section active (prefix match). */
export const DetailPage: Story = {
  beforeEach: () => {
    usePathname.mockReturnValue('/results/run_8c1f');
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('link', { name: 'Results' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

/** Planned sections stay in the menu, labelled "planned". */
export const PlannedSectionActive: Story = {
  beforeEach: () => {
    usePathname.mockReturnValue('/builder');
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('link', { name: /Benchmark Builder\s*planned/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};
