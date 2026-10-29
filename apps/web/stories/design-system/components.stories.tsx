import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { Catalogue } from '../blocks/catalogue';

const meta = {
  title: 'Design system/Components',
  component: Catalogue,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Catalogue>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every documented component, linked to its page. */
export const Catalogue_: Story = {
  name: 'Catalogue',
  play: async ({ canvas }) => {
    const links = canvas.getAllByRole('link');
    await expect(links).toHaveLength(22);
    for (const link of links) {
      await expect(link.getAttribute('href')).toMatch(/^\.\/\?path=\/docs\/[a-z-]+--docs$/);
    }
  },
};
