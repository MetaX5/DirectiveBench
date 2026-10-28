import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent } from 'storybook/test';
import { StateMatrix, stateProps } from '../../stories/blocks/state-matrix';
import { Input } from './input';

const meta = {
  title: 'Primitives/Input',
  component: Input,
  parameters: { layout: 'padded' },
  args: { placeholder: '~/code/my-skills or https://github.com/owner/repo' },
  render: (args) => (
    <label className="flex max-w-md flex-col gap-1 text-ui text-muted-foreground">
      Path or GitHub URL
      <Input {...args} />
    </label>
  ),
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Path or GitHub URL' });
    await userEvent.click(field);
    await userEvent.keyboard('~/code/agent-rules');
    await expect(field).toHaveValue('~/code/agent-rules');
    await expect(field.getBoundingClientRect().height).toBe(32);
  },
};

/** The label is always visible; the placeholder is an example, never the label. */
export const WithLabel: Story = {
  args: { placeholder: 'Name or description', name: 'q' },
  render: (args) => (
    <form role="search" onSubmit={(event) => event.preventDefault()}>
      <label className="flex w-56 flex-col gap-1 text-ui text-muted-foreground">
        Search
        <Input {...args} />
      </label>
    </form>
  ),
};

/** Every state. Hover has no style of its own; focus is frozen. */
export const States: Story = {
  render: () => (
    <StateMatrix
      label="Input states"
      variants={['empty', 'filled'] as const}
      states={['rest', 'focus', 'disabled', 'invalid']}
      render={(variant, state) => (
        <Input
          aria-label={`${variant} ${state}`}
          placeholder="~/code/my-skills"
          defaultValue={variant === 'filled' ? '~/code/agent-rules' : undefined}
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
    defaultValue: '/',
    'aria-invalid': true,
    'aria-describedby': 'path-error',
    className: 'font-mono',
  },
  render: (args) => (
    <div className="max-w-md space-y-stack">
      <label className="flex flex-col gap-1 text-ui text-muted-foreground">
        Path or GitHub URL
        <Input {...args} />
      </label>
      <p id="path-error" role="alert" className="text-ui text-destructive-foreground">
        The filesystem root cannot be registered. Choose the folder that holds your skills.
      </p>
    </div>
  ),
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Path or GitHub URL' });
    await expect(field).toBeInvalid();
    await expect(field).toHaveAccessibleDescription(/filesystem root/);
  },
};

/** The field takes the width of its container; long values scroll inside it. */
export const LongValueNarrowScreen: Story = {
  args: {
    defaultValue:
      'https://github.com/acme-engineering/agent-rules-and-skills-for-every-team/tree/main',
    className: 'font-mono',
  },
  render: (args) => (
    <label className="flex w-80 flex-col gap-1 text-ui text-muted-foreground">
      Path or GitHub URL
      <Input {...args} />
    </label>
  ),
};
