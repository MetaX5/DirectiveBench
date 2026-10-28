import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, waitFor } from 'storybook/test';
import { ContrastTable } from '../blocks/contrast';
import { TokenTable } from '../blocks/token-table';

const meta = {
  title: 'Foundations/Colour',
  component: ContrastTable,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ContrastTable>;

export default meta;
type Story = StoryObj<typeof meta>;

// tokeny.md composites translucent colours by calculation; Chromium composites in sRGB, which
// reads up to 0.2 higher on the dark translucent surfaces. A larger gap means the table and
// globals.css disagree.
const tolerance = 0.25;

/** Every pair from the tokeny.md contrast table, measured on the stored token values. */
export const MeasuredContrast: Story = {
  play: async ({ canvas, globals }) => {
    const table = canvas.getByRole('table');
    await waitFor(() => expect(table).toHaveAttribute('data-measured', globals.theme));
    const rows = [...table.querySelectorAll('tbody tr')];
    const below = rows
      .filter((row) => row.getAttribute('data-outcome') === 'fail')
      .map((row) => row.getAttribute('data-id'));
    await expect(below).toEqual([]);
    const drifted = rows.flatMap((row) => {
      const [documented, measured] = [4, 5].map((cell) => Number(row.children[cell]!.textContent));
      return Math.abs(measured! - documented!) > tolerance
        ? [`${row.getAttribute('data-id')}: ${documented} documented, ${measured} measured`]
        : [];
    });
    await expect(drifted).toEqual([]);
  },
};

/** Semantic and component colour tokens from tokeny.md, previewed with the stored values. */
export const ColourTokens: Story = {
  render: () => <TokenTable group="colour" />,
  play: async ({ canvas }) => {
    const table = canvas.getByRole('table', { name: 'colour tokens' });
    const swatches = [...table.querySelectorAll<HTMLElement>('[data-preview]')];
    await expect(swatches.length).toBeGreaterThan(20);
    // A token missing from globals.css would leave its swatch transparent.
    const empty = swatches
      .filter((swatch) => getComputedStyle(swatch).backgroundColor === 'rgba(0, 0, 0, 0)')
      .map((swatch) => swatch.dataset.preview);
    await expect(empty).toEqual([]);
  },
};
