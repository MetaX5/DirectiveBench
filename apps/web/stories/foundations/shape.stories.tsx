import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TokenTable } from '../blocks/token-table';

const meta = {
  title: 'Foundations/Shape and depth',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Square corners, one-pixel outlines and no shadows on every surface and control. */
export const Surfaces: Story = {
  render: () => (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Benchmark suite</CardTitle>
        <CardDescription>claude-code, 4 cases</CardDescription>
      </CardHeader>
      <CardContent className="space-y-stack">
        <Input aria-label="Suite name" defaultValue="validate-external-input" />
        <div className="flex flex-wrap items-center gap-inline">
          <Button>Run</Button>
          <Button variant="outline">Edit definition</Button>
          <Badge variant="info">running</Badge>
        </div>
      </CardContent>
    </Card>
  ),
  play: async ({ canvasElement }) => {
    const elements = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot]')];
    await expect(elements.length).toBeGreaterThan(4);
    const withRadius = elements.filter(
      (element) => getComputedStyle(element).borderTopLeftRadius !== '0px',
    );
    await expect(withRadius.map((element) => element.dataset.slot)).toEqual([]);
    // Rings are box shadows without offset or blur; an offset or blurred layer is a drop shadow.
    const shadowed = elements.filter((element) =>
      getComputedStyle(element)
        .boxShadow.split(/,(?![^(]*\))/)
        .some((layer) => {
          const lengths = layer.replace(/\w+\([^)]*\)/g, '').match(/-?[\d.]+px/g) ?? [];
          return lengths.slice(0, 3).some((length) => Number.parseFloat(length) !== 0);
        }),
    );
    await expect(shadowed.map((element) => element.dataset.slot)).toEqual([]);
  },
};

/** The radius token. The shadcn radius scale stays in globals.css for the generator only. */
export const ShapeTokens: Story = {
  render: () => <TokenTable group="shape" />,
};
