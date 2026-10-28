import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent } from 'storybook/test';
import { StateMatrix, stateProps } from '../../stories/blocks/state-matrix';
import { Textarea } from './textarea';

const notes =
  'Keep the review checklist short.\nCompare against v3 before changing the frontmatter.';

const meta = {
  title: 'Primitives/Textarea',
  component: Textarea,
  parameters: { layout: 'padded' },
  args: { name: 'notes', placeholder: 'What to remember about this artifact' },
  render: (args) => (
    <label className="flex max-w-md flex-col gap-1 text-ui text-muted-foreground">
      Notes
      <Textarea {...args} />
    </label>
  ),
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Enter adds a line; the field grows with its content. */
export const Playground: Story = {
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Notes' });
    const before = field.getBoundingClientRect().height;
    await userEvent.click(field);
    await userEvent.keyboard('First line{Enter}Second line{Enter}Third line{Enter}Fourth line');
    await expect(field).toHaveValue('First line\nSecond line\nThird line\nFourth line');
    await expect(field.getBoundingClientRect().height).toBeGreaterThan(before);
  },
};

/** Every state. Hover has no style of its own; focus is frozen. */
export const States: Story = {
  render: () => (
    <StateMatrix
      label="Textarea states"
      variants={['empty', 'filled'] as const}
      states={['rest', 'focus', 'disabled', 'invalid']}
      render={(variant, state) => (
        <Textarea
          aria-label={`${variant} ${state}`}
          placeholder="What to remember"
          defaultValue={variant === 'filled' ? notes : undefined}
          className="w-44"
          {...stateProps(state)}
        />
      )}
    />
  ),
};

/** The error sits under the field, is linked by aria-describedby and is announced. */
export const WithError: Story = {
  args: {
    defaultValue: notes,
    'aria-invalid': true,
    'aria-describedby': 'notes-error',
  },
  render: (args) => (
    <div className="max-w-md space-y-stack">
      <label className="flex flex-col gap-1 text-ui text-muted-foreground">
        Notes
        <Textarea {...args} />
      </label>
      <p id="notes-error" role="alert" className="text-ui text-destructive-foreground">
        Notes can be at most 10,000 characters. Shorten them.
      </p>
    </div>
  ),
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Notes' });
    await expect(field).toBeInvalid();
    await expect(field).toHaveAccessibleDescription(/at most 10,000 characters/);
  },
};

/** Long lines wrap inside the field at 320px; nothing scrolls the page sideways. */
export const LongTextNarrowScreen: Story = {
  args: {
    defaultValue:
      'Compare https://github.com/acme-engineering/agent-rules-and-skills-for-every-team/tree/main/skills/review against the bundled example before every release.',
  },
  render: (args) => (
    <label className="flex w-full max-w-80 flex-col gap-1 text-ui text-muted-foreground">
      Notes
      <Textarea {...args} />
    </label>
  ),
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Notes' });
    await expect(field.scrollWidth).toBeLessThanOrEqual(field.clientWidth);
  },
};
