import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Play, Trash2 } from 'lucide-react';
import { expect, fn, userEvent } from 'storybook/test';
import { Input } from '@/components/ui/input';
import { StateMatrix, stateProps } from '../../stories/blocks/state-matrix';
import { Button } from './button';

const variants = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const;
const sizes = ['default', 'sm', 'xs', 'lg'] as const;
const iconSizes = ['icon', 'icon-sm', 'icon-xs', 'icon-lg'] as const;

const meta = {
  title: 'Primitives/Button',
  component: Button,
  parameters: { layout: 'padded' },
  args: { children: 'Run benchmark', onClick: fn() },
  argTypes: {
    variant: { control: 'select', options: variants },
    size: { control: 'select', options: [...sizes, ...iconSizes] },
    asChild: { control: false },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Change the props in the Controls panel. */
export const Playground: Story = {
  play: async ({ args, canvas }) => {
    const button = canvas.getByRole('button', { name: 'Run benchmark' });
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    // A native button: Enter and Space activate it from the keyboard (WCAG 2.1.1).
    button.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    await expect(args.onClick).toHaveBeenCalledTimes(3);
    await expect(getComputedStyle(button).cursor).toBe('pointer');
    await expect(button.getBoundingClientRect().height).toBe(32);
  },
};

export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-inline">
      <Button {...args}>Run benchmark</Button>
      <Button {...args} variant="outline">
        Edit definition
      </Button>
      <Button {...args} variant="secondary">
        Rescan
      </Button>
      <Button {...args} variant="ghost">
        Show raw output
      </Button>
      <Button {...args} variant="destructive">
        Register anyway
      </Button>
      <Button {...args} variant="link">
        View specification
      </Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <div className="space-y-stack">
      <div className="flex flex-wrap items-center gap-inline">
        {sizes.map((size) => (
          <Button key={size} {...args} size={size}>
            {`Run (${size})`}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-inline">
        {iconSizes.map((size) => (
          <Button key={size} {...args} size={size} variant="outline" aria-label={`Run (${size})`}>
            <Play aria-hidden />
          </Button>
        ))}
      </div>
    </div>
  ),
  play: async ({ canvas }) => {
    const heights = Object.fromEntries(
      [...sizes, ...iconSizes].map((size) => [
        size,
        canvas.getByRole('button', { name: `Run (${size})` }).getBoundingClientRect().height,
      ]),
    );
    await expect(heights).toEqual({
      default: 32,
      sm: 28,
      xs: 24,
      lg: 36,
      icon: 32,
      'icon-sm': 28,
      'icon-xs': 24,
      'icon-lg': 36,
    });
  },
};

export const WithIcon: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-inline">
      <Button {...args} size="sm">
        <Play aria-hidden data-icon="inline-start" />
        Run
      </Button>
      <Button {...args} variant="destructive">
        <Trash2 aria-hidden data-icon="inline-start" />
        Remove repository
      </Button>
    </div>
  ),
};

/** Every variant in every state. Hover, focus and pressed are frozen previews. */
export const States: Story = {
  render: () => (
    <StateMatrix
      label="Button states"
      variants={variants}
      states={['rest', 'hover', 'focus', 'pressed', 'disabled', 'invalid', 'expanded']}
      render={(variant, state) => (
        <Button variant={variant} {...stateProps(state)}>
          Run
        </Button>
      )}
    />
  ),
};

/** Disabled with the reason next to it, as the Run button on a benchmark does. */
export const DisabledWithReason: Story = {
  render: (args) => (
    <div className="max-w-md space-y-stack">
      <div className="flex items-center gap-inline">
        <Button {...args} size="sm" disabled aria-describedby="run-blocked">
          <Play aria-hidden data-icon="inline-start" />
          Run
        </Button>
        <span className="font-mono text-ui">validate-external-input</span>
      </div>
      <p id="run-blocked" className="text-ui text-warning-foreground">
        Blocked: the suite has no definition file. Add benchmark.yaml to the repository and rescan.
      </p>
    </div>
  ),
  play: async ({ args, canvas }) => {
    const button = canvas.getByRole('button', { name: 'Run' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription(/no definition file/);
    await userEvent.click(button, { pointerEventsCheck: 0 });
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

/** An inline form button matches the field height (tokeny.md decision 11). */
export const InlineWithField: Story = {
  render: (args) => (
    <form className="flex max-w-md gap-inline" onSubmit={(event) => event.preventDefault()}>
      <Input aria-label="Path or GitHub URL" placeholder="~/code/agent-rules" />
      <Button {...args} type="submit">
        Register
      </Button>
    </form>
  ),
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Path or GitHub URL' });
    const button = canvas.getByRole('button', { name: 'Register' });
    await expect(button.getBoundingClientRect().height).toBe(field.getBoundingClientRect().height);
  },
};

/** Labels never wrap; a long label widens the button, so keep labels short. */
export const LongLabelNarrowScreen: Story = {
  render: (args) => (
    <div className="w-full max-w-80 space-y-stack border border-dashed p-2">
      <Button {...args}>Run all assigned benchmark suites again</Button>
      <Button {...args} className="w-full">
        Register
      </Button>
    </div>
  ),
};

/** asChild renders a link that looks like a button, for navigation. */
export const AsLink: Story = {
  render: (args) => (
    <Button {...args} asChild variant="outline">
      <a href="#results">Open results</a>
    </Button>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('link', { name: 'Open results' })).toHaveAttribute(
      'data-slot',
      'button',
    );
  },
};
