import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { MockBadge, NotSandboxedBadge, PageHeader } from './common';

const meta = {
  title: 'Product/App shell/PageHeader',
  component: PageHeader,
  parameters: { layout: 'padded' },
  args: {
    title: 'Repositories',
    description: 'Sources DirectiveBench reads skills, instructions and rules from.',
  },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Repositories' })).toBeVisible();
  },
};

/** Title only: the description is optional. */
export const TitleOnly: Story = { args: { description: undefined } };

/** Actions sit at the right and wrap under the title on narrow screens. */
export const WithActions: Story = {
  args: {
    title: 'Benchmark: validate-external-input',
    description: 'claude-code suite, 4 cases, 3 repetitions',
    actions: (
      <>
        <Badge variant="outline">v3</Badge>
        <Button>Run benchmark</Button>
      </>
    ),
  },
};

/** A planned feature is labelled in the actions slot, as on /repositories. */
export const WithPlannedNotice: Story = {
  args: {
    actions: (
      <Badge variant="muted">
        Planned: not implemented: private repositories, GitLab, marking deleted artifacts as missing
      </Badge>
    ),
  },
};

/** Long title and description at 320px: everything wraps, nothing is cut. */
export const LongTextNarrowScreen: Story = {
  args: {
    title: 'validate-external-input-and-reject-unknown-fields',
    description:
      'Skill from acme-engineering/agent-rules-and-skills-for-every-team, version 3, primary file SKILL.md',
    actions: (
      <>
        <Badge variant="outline">v3</Badge>
        <MockBadge />
        <NotSandboxedBadge />
        <Button>Run benchmark</Button>
      </>
    ),
  },
  // The actions wrap, so badges and buttons stay inside 320px (SPEC-122 P14).
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLElement>('.max-w-80')!;
    const right = frame.getBoundingClientRect().right;
    for (const item of frame.querySelectorAll<HTMLElement>('[data-slot]')) {
      await expect(item.getBoundingClientRect().right).toBeLessThanOrEqual(right + 0.5);
    }
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-80 break-words">
        <Story />
      </div>
    ),
  ],
};
