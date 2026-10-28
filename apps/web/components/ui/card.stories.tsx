import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { Badge } from './badge';
import { Button } from './button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card';

const meta = {
  title: 'Primitives/Card',
  component: Card,
  parameters: { layout: 'padded' },
  args: { size: 'default' },
  argTypes: { size: { control: 'inline-radio', options: ['default', 'sm'] } },
  render: (args) => (
    <Card {...args} className="max-w-md">
      <CardHeader>
        <CardTitle>Register a repository</CardTitle>
        <CardDescription>
          Enter a local path or the URL of a public GitHub repository.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p>Read-only: DirectiveBench never writes to the repository.</p>
      </CardContent>
    </Card>
  ),
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvas }) => {
    // CardTitle is the h2 under the page's h1 (SPEC-122 P6).
    await expect(
      canvas.getByRole('heading', { level: 2, name: 'Register a repository' }),
    ).toBeVisible();
  },
};

/** size="sm" tightens the inside spacing from 16px to 12px. */
export const Sizes: Story = {
  render: () => (
    <div className="grid max-w-3xl gap-grid md:grid-cols-2">
      {(['default', 'sm'] as const).map((size) => (
        <Card key={size} size={size}>
          <CardHeader>
            <CardTitle>{`Recent runs (${size})`}</CardTitle>
            <CardDescription>Last 5 benchmark runs</CardDescription>
          </CardHeader>
          <CardContent>
            <p>validate-external-input: improved</p>
          </CardContent>
        </Card>
      ))}
    </div>
  ),
};

/** Every slot, including CardAction and CardFooter, which no page uses yet (P3). */
export const Anatomy: Story = {
  render: () => (
    <Card className="max-w-md">
      <CardHeader className="border-b">
        <CardTitle>acme/agent-rules</CardTitle>
        <CardDescription>Local folder, scanned 2 hours ago</CardDescription>
        <CardAction>
          <Badge variant="success">completed</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p>12 artifacts: 7 skills, 4 rules, 1 instruction.</p>
      </CardContent>
      <CardFooter className="border-t">
        <Button size="sm" variant="outline">
          Scan
        </Button>
      </CardFooter>
    </Card>
  ),
};

/** States are those of the content: empty and error are shown inside the card. */
export const ContentStates: Story = {
  render: () => (
    <div className="grid max-w-3xl gap-grid md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-body text-muted-foreground">
            No runs yet. Run a benchmark from the Benchmarks page.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Definition</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="alert" className="text-destructive-foreground">
            benchmark.yaml is invalid: cases[0].prompt is required.
          </p>
        </CardContent>
      </Card>
    </div>
  ),
};

/** Long titles wrap; paths and identifiers use font-mono and break anywhere. */
export const LongContentNarrowScreen: Story = {
  render: () => (
    <div className="w-80">
      <Card>
        <CardHeader>
          <CardTitle className="font-mono break-all">
            .claude/skills/validate-external-input-and-reject-unknown-fields/SKILL.md
          </CardTitle>
          <CardDescription>
            Version 3 · 4.2 kB · sha256 9f2c41d0b7e3a5c8 · primary file of a skill with a long
            description that wraps over several lines
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p>Rendered content follows.</p>
        </CardContent>
      </Card>
    </div>
  ),
};
