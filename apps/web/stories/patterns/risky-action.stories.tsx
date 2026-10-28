import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent } from 'storybook/test';
import { Button } from '@/components/ui/button';

// Pattern: confirming a risky action, modelled on "Register anyway" (/repositories, D05). The
// question names the object, the reasons are listed, leaving is easy and the action is a verb.

function RiskyConfirmation({
  path,
  reasons,
  onConfirm,
}: {
  path: string;
  reasons: string[];
  onConfirm?: () => void;
}) {
  return (
    <div
      role="alert"
      className="max-w-xl space-y-stack rounded-surface border border-warning/40 bg-warning/10 p-3 text-ui"
    >
      <p className="font-medium">
        Register <span className="font-mono">{path}</span>? It needs a confirmation:
      </p>
      <ul className="list-disc space-y-1 pl-4">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <form
        className="flex items-center gap-inline"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm?.();
        }}
      >
        <Button type="submit" size="sm" variant="destructive">
          Register anyway
        </Button>
        <a href="#repositories" className="text-ui underline">
          Cancel
        </a>
      </form>
    </div>
  );
}

const meta = {
  title: 'Patterns/Risky-action confirmation',
  component: RiskyConfirmation,
  parameters: { layout: 'padded' },
  args: {
    path: '/home/dev',
    reasons: ['This is your home directory: every agent folder in it would be scanned.'],
    onConfirm: fn(),
  },
} satisfies Meta<typeof RiskyConfirmation>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One reason. The destructive button confirms; Cancel leaves without changing anything. */
export const OneReason: Story = {
  play: async ({ args, canvas }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent('/home/dev');
    await expect(canvas.getByRole('link', { name: 'Cancel' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Register anyway' }));
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
  },
};

/** Several reasons are listed, each in a sentence. */
export const SeveralReasons: Story = {
  args: {
    path: '/home/dev/code',
    reasons: [
      'It contains acme/agent-rules, which is already registered.',
      'It is inside your home directory.',
    ],
  },
};

/** At 320px the long path breaks and the actions stay together. */
export const NarrowScreen: Story = {
  args: { path: '/home/dev/code/acme-engineering/agent-rules-and-skills-for-every-team' },
  decorators: [
    (Story) => (
      <div className="w-80 break-words">
        <Story />
      </div>
    ),
  ],
};
