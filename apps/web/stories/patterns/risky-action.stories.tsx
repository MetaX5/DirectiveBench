import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent } from 'storybook/test';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

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
      <div className="w-full max-w-80 break-words">
        <Story />
      </div>
    ),
  ],
};

/**
 * Rule 7: opened from a table row (Remove on `/repositories`, SPEC-125), here for a GitHub
 * repository, whose copies never link (SPEC-126 A16). The server renders the
 * panel at the top of the Card for `?remove=<id>#remove-panel`; the panel is the fragment target
 * (`tabIndex=-1`), so keyboard navigation starts there, and Cancel links back to the row.
 */
export const FromTableRow: Story = {
  render: () => (
    <div className="max-w-xl rounded-surface border border-border bg-card p-4">
      <div
        id="remove-panel"
        tabIndex={-1}
        role="alert"
        className="mb-4 min-w-0 space-y-stack rounded-surface border border-warning/40 bg-warning/10 p-3 text-ui outline-none"
      >
        <p className="font-medium wrap-anywhere">
          Remove acme/rules (GitHub,{' '}
          <span className="font-mono">https://github.com/acme/rules</span>)?
        </p>
        <ul className="list-disc space-y-1 pl-4 wrap-anywhere">
          <li>Its 14 occurrences are deleted from DirectiveBench.</li>
          <li>
            9 artifacts are then missing from every repository. Their versions, categories, notes
            and benchmark results are kept.
          </li>
          <li>
            The copy downloaded from GitHub stays in DirectiveBench&apos;s cache. Deleting it is
            planned.
          </li>
          <li>Registering it again later creates new artifacts instead of reusing these ones.</li>
        </ul>
        <form
          className="flex flex-wrap items-center gap-inline"
          onSubmit={(event) => event.preventDefault()}
        >
          <Button type="submit" size="sm" variant="destructive">
            Remove repository
          </Button>
          <a href="#repository-acme-rules" className="text-ui underline">
            Cancel
          </a>
        </form>
      </div>
      <Table>
        <TableBody>
          <TableRow id="repository-acme-rules">
            <TableCell className="font-medium">acme/rules</TableCell>
            <TableCell className="text-right">
              <Button
                size="sm"
                variant="outline"
                aria-label="Remove acme/rules (GitHub, https://github.com/acme/rules)"
              >
                Remove
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  ),
  play: async ({ canvas }) => {
    const panel = canvas.getByRole('alert');
    panel.focus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Remove repository' })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: 'Cancel' })).toHaveFocus();
  },
};

/**
 * Rule 7 for a local repository (SPEC-126 §11.3 F8): the last reason says that an exact copy of a
 * skill or rule still recorded in another local repository is matched to its artifact when the
 * repository is registered again. A GitHub repository keeps the sentence of `FromTableRow`.
 */
export const FromTableRowLocal: Story = {
  render: () => (
    <div className="max-w-xl rounded-surface border border-border bg-card p-4">
      <div
        id="remove-panel"
        tabIndex={-1}
        role="alert"
        className="min-w-0 space-y-stack rounded-surface border border-warning/40 bg-warning/10 p-3 text-ui outline-none"
      >
        <p className="font-medium wrap-anywhere">
          Remove client-a (Local Git, <span className="font-mono">/home/dev/client-a</span>)?
        </p>
        <ul className="list-disc space-y-1 pl-4 wrap-anywhere">
          <li>Its 14 occurrences are deleted from DirectiveBench.</li>
          <li>
            9 artifacts are then missing from every repository. Their versions, categories, notes
            and benchmark results are kept.
          </li>
          <li>Nothing in /home/dev/client-a is changed.</li>
          <li>
            Registering it again later creates new artifacts. A skill or rule whose exact content is
            still recorded in another local repository is matched to its existing artifact instead.
          </li>
        </ul>
        <form
          className="flex flex-wrap items-center gap-inline"
          onSubmit={(event) => event.preventDefault()}
        >
          <Button type="submit" size="sm" variant="destructive">
            Remove repository
          </Button>
          <a href="#repository-client-a" className="text-ui underline">
            Cancel
          </a>
        </form>
      </div>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent(
      'matched to its existing artifact instead.',
    );
    await expect(canvas.getByRole('alert')).not.toHaveTextContent('instead of reusing');
  },
};
