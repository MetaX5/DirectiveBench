import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { PageHeader } from '@/components/common';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pre } from '@/components/ui/primitives';
import { TokenTable } from '../blocks/token-table';

const meta = {
  title: 'Foundations/Typography',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The type roles as the real components render them. */
export const Roles: Story = {
  render: () => (
    <div className="max-w-content">
      <PageHeader
        title="Results"
        description="RED/GREEN runs of every benchmark suite, newest first."
        actions={<Button>Run benchmark</Button>}
      />
      <div className="grid gap-grid md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>validate-external-input</CardTitle>
            <CardDescription>Skill from acme/agent-rules, version v3</CardDescription>
          </CardHeader>
          <CardContent className="space-y-stack">
            <p className="text-metric tabular-nums">0.83</p>
            <p className="text-caption text-muted-foreground">Mean score over 3 repetitions</p>
            <Badge variant="success">Passed</Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Command</CardTitle>
          </CardHeader>
          <CardContent>
            <Pre>directivebench run validate-input --agent mock --repetitions 3</Pre>
          </CardContent>
        </Card>
      </div>
    </div>
  ),
  play: async ({ canvas }) => {
    const title = canvas.getByRole('heading', { level: 1, name: 'Results' });
    await expect(getComputedStyle(title).fontSize).toBe('20px');
    const font = getComputedStyle(title).fontFamily;
    await expect(font).toMatch(/^"?Figtree Variable"?/);
    await expect(await document.fonts.load(`600 20px ${font}`)).not.toEqual([]);
  },
};

/** Size and font tokens from tokeny.md. */
export const TypeTokens: Story = {
  render: () => <TokenTable group="type" />,
};
