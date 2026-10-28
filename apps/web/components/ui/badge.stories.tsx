import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { FlaskConical } from 'lucide-react';
import { expect } from 'storybook/test';
import { StateMatrix, stateProps } from '../../stories/blocks/state-matrix';
import { Badge } from './badge';

const variants = [
  'success',
  'warning',
  'info',
  'destructive',
  'muted',
  'outline',
  'secondary',
  'default',
  'ghost',
  'link',
] as const;

const meta = {
  title: 'Primitives/Badge',
  component: Badge,
  parameters: { layout: 'padded' },
  args: { children: 'Passed', variant: 'success' },
  argTypes: {
    variant: { control: 'select', options: variants },
    asChild: { control: false },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvas }) => {
    const badge = canvas.getByText('Passed');
    await expect(badge).toHaveAttribute('data-variant', 'success');
    // A badge is static text: no role, no tab stop.
    await expect(badge.tabIndex).toBe(-1);
  },
};

/** The variants with the meaning each carries in DirectiveBench. */
export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-inline">
      <Badge variant="success">Passed</Badge>
      <Badge variant="warning">Unstable</Badge>
      <Badge variant="info">running</Badge>
      <Badge variant="destructive">Regression</Badge>
      <Badge variant="muted">Not tested</Badge>
      <Badge variant="outline">skill</Badge>
      <Badge variant="secondary">security</Badge>
      <Badge variant="default">default</Badge>
      <Badge variant="ghost">ghost</Badge>
      <Badge variant="link">link</Badge>
    </div>
  ),
};

/** An icon is decorative and 12px; the word carries the meaning. */
export const WithIcon: Story = {
  render: () => (
    <Badge variant="warning">
      <FlaskConical aria-hidden />
      Mock agent: not an AI evaluation
    </Badge>
  ),
};

/**
 * Badges are not interactive. Rendered as a link (asChild), hover and focus apply; no page does
 * this today.
 */
export const States: Story = {
  render: () => (
    <StateMatrix
      label="Badge states"
      variants={variants}
      states={['rest', 'hover', 'focus']}
      render={(variant, state) =>
        state === 'rest' ? (
          <Badge variant={variant}>{variant}</Badge>
        ) : (
          <Badge variant={variant} asChild {...stateProps(state)}>
            <a href={`#${variant}`}>{variant}</a>
          </Badge>
        )
      }
    />
  ),
};

/** Badges wrap instead of clipping, down to a 390px viewport (SPEC-119 FR-7). */
export const LongTextNarrowScreen: Story = {
  render: () => (
    <div className="flex w-80 flex-wrap gap-inline-tight border border-dashed p-2">
      <Badge variant="muted">
        Planned: not implemented: private repositories, GitLab, marking deleted artifacts as missing
      </Badge>
      <Badge variant="warning">Not conclusive: single nondeterministic repetition</Badge>
      <Badge variant="outline">instruction</Badge>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLElement>('.w-80')!;
    for (const badge of frame.querySelectorAll<HTMLElement>('[data-slot="badge"]')) {
      await expect(badge.scrollWidth).toBeLessThanOrEqual(badge.clientWidth);
      await expect(badge.getBoundingClientRect().right).toBeLessThanOrEqual(
        frame.getBoundingClientRect().right,
      );
    }
  },
};
