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

/**
 * Subtitle: a muted line under the title that tells the item apart from others with the same
 * title, here a suite's ID (issue 227). The suite page uses it; names repeat, the ID does not.
 */
export const WithSubtitle: Story = {
  args: {
    title: 'Input validation (mock agent demo)',
    subtitle: (
      <>
        ID <span className="font-mono">mock-input-validation-strict</span>
      </>
    ),
    description: 'Checks that the skill rejects unknown fields.',
    actions: <Badge variant="outline">v2</Badge>,
  },
  // The subtitle sits between the h1 and the description and stays out of the heading's name.
  play: async ({ canvas, canvasElement }) => {
    const heading = canvas.getByRole('heading', { level: 1 });
    await expect(heading).toHaveAccessibleName('Input validation (mock agent demo)');
    const subtitle = canvas.getByText('mock-input-validation-strict').parentElement!;
    await expect(subtitle).toHaveTextContent('ID mock-input-validation-strict');
    const description = canvas.getByText('Checks that the skill rejects unknown fields.');
    const order = [heading, subtitle, description].map((el) =>
      [...canvasElement.querySelectorAll('*')].indexOf(el),
    );
    await expect(order).toEqual([...order].sort((a, b) => a - b));
  },
};

/** A long subtitle at 320px: a 40-character ID wraps anywhere instead of leaving the screen. */
export const LongSubtitleNarrowScreen: Story = {
  args: {
    title: 'Safety review for repository instructions',
    subtitle: (
      <>
        ID <span className="font-mono">safety-review-repository-instructions-v2</span>
      </>
    ),
    actions: (
      <>
        <Badge variant="outline">v4</Badge>
        <MockBadge />
      </>
    ),
  },
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLElement>('.max-w-80')!;
    const right = frame.getBoundingClientRect().right;
    for (const item of frame.querySelectorAll<HTMLElement>('h1, p, span')) {
      await expect(item.getBoundingClientRect().right).toBeLessThanOrEqual(right + 0.5);
    }
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-80">
        <Story />
      </div>
    ),
  ],
};

/** A planned feature is labelled in the actions slot, as on /repositories. */
export const WithPlannedNotice: Story = {
  args: {
    actions: <Badge variant="muted">Planned: not implemented: private repositories, GitLab</Badge>,
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
