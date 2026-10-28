import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { headingOrderException } from '../blocks/a11y';
import { TokenTable } from '../blocks/token-table';

const meta = {
  title: 'Foundations/Spacing and layout',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The four spacing relations on one page: inside a group (inline, inline-tight), between items
 * of a panel (stack), between panels (grid) and between sections (section), inside the page
 * padding (page-inline, page-block).
 */
export const Relations: Story = {
  parameters: headingOrderException,
  render: () => (
    <main className="mx-auto w-full max-w-content px-page-inline py-page-block">
      <PageHeader title="Repositories" description="Local folders and GitHub repositories." />
      <div className="space-y-section">
        <Card>
          <CardHeader>
            <CardTitle>Register a repository</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="flex gap-inline" onSubmit={(event) => event.preventDefault()}>
              <Input aria-label="Path or GitHub URL" placeholder="~/code/agent-rules" />
              <Button type="submit">Register</Button>
            </form>
          </CardContent>
        </Card>
        <div className="grid gap-grid md:grid-cols-2">
          {['acme/agent-rules', 'team/claude-skills'].map((name) => (
            <Card key={name}>
              <CardHeader>
                <CardTitle className="font-mono">{name}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-stack">
                <p className="text-muted-foreground">12 artifacts, scanned 2 hours ago</p>
                <div className="flex flex-wrap gap-inline-tight">
                  <Badge variant="muted">skill</Badge>
                  <Badge variant="muted">rule</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </main>
  ),
  play: async ({ canvas }) => {
    const input = canvas.getByRole('textbox', { name: 'Path or GitHub URL' });
    const button = canvas.getByRole('button', { name: 'Register' });
    // An inline form button matches the field height, 32px (tokeny.md decision 11).
    await expect(input.getBoundingClientRect().height).toBe(32);
    await expect(button.getBoundingClientRect().height).toBe(32);
  },
};

/** Spacing, size and width tokens from tokeny.md. */
export const SpacingTokens: Story = {
  parameters: { layout: 'padded' },
  render: () => <TokenTable group="space" />,
};
