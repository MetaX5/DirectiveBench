import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent } from 'storybook/test';
import { CopyFileButton } from './copy-file-button';

const CRLF = '# Rules\r\n\r\nWindows line endings are kept.\r\n';

const meta = {
  title: 'Product/Registry/CopyFileButton',
  component: CopyFileButton,
  parameters: { layout: 'padded' },
  args: { content: CRLF, path: '.agents/skills/rules/SKILL.md' },
  // As in the Content tab: the button sits in a wrapping row next to Download.
  decorators: [
    (Story) => (
      <div className="flex max-w-80 flex-wrap items-center gap-inline">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CopyFileButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Replaces the clipboard write for one interaction and restores it. */
async function withClipboard(write: (text: string) => Promise<void>, act: () => Promise<void>) {
  const clipboard = navigator.clipboard;
  const original = clipboard.writeText.bind(clipboard);
  clipboard.writeText = write;
  try {
    await act();
  } finally {
    clipboard.writeText = original;
  }
}

/** Before a copy: the status line is empty. */
export const Idle: Story = {};

/** The stored string is copied as is, CR characters included. */
export const Copied: Story = {
  play: async ({ canvas }) => {
    let written = '';
    await withClipboard(
      async (text) => {
        written = text;
      },
      () =>
        userEvent.click(
          canvas.getByRole('button', {
            name: 'Copy the content of .agents/skills/rules/SKILL.md',
          }),
        ),
    );
    await expect(canvas.getByRole('status')).toHaveTextContent('Copied.');
    await expect(written).toBe(CRLF);
  },
};

/** The browser refused the clipboard: the line says so and points at Download. */
export const Refused: Story = {
  play: async ({ canvas }) => {
    await withClipboard(
      () => Promise.reject(new DOMException('denied')),
      () => userEvent.click(canvas.getByRole('button', { name: /^Copy the content of/ })),
    );
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Not copied: the browser blocked the clipboard. Use Download instead.',
    );
  },
};
