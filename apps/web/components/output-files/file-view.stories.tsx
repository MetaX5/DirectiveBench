import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent } from 'storybook/test';
import { file, longLine, longPath } from './fixtures';
import { FileView } from './file-view';

const meta = {
  title: 'Product/Benchmarking/FileView',
  component: FileView,
  parameters: { layout: 'padded' },
  args: { file: file() },
  decorators: [
    (Story) => (
      <div className="max-w-content">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FileView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A text file kept in full: path, size and numbered lines. */
export const Playground: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { name: 'src/render.php' })).toBeVisible();
    const region = canvas.getByRole('region', { name: 'Content of src/render.php' });
    await expect(region).toHaveTextContent(
      "$label = esc_attr__( 'Close notice', 'notice-block' );",
    );
    // Line numbers are decoration: hidden from assistive technology and from selection.
    const numbers = canvasElement.querySelectorAll('pre [aria-hidden="true"]');
    await expect(numbers).toHaveLength(10);
    await expect(numbers[9]).toHaveTextContent('10');
    await expect(canvas.queryByRole('status')).toBeNull();
  },
};

/** Keyboard: the content is one tab stop, so arrow keys can scroll long lines. */
export const Keyboard: Story = {
  args: { file: file({ content: `${longLine}\n` }) },
  play: async ({ canvas }) => {
    await userEvent.tab();
    const region = canvas.getByRole('region', { name: 'Content of src/render.php' });
    await expect(region).toHaveFocus();
  },
};

/** An empty file says so and shows no block. */
export const Empty: Story = {
  args: { file: file({ content: '', sizeBytes: 0 }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('The file is empty.');
    await expect(canvas.queryByRole('region')).toBeNull();
  },
};

/** A long line scrolls inside the block; the block never widens the page. */
export const LongLines: Story = {
  args: { file: file({ content: `${longLine}\n${longLine}\n` }) },
  play: async ({ canvas, canvasElement }) => {
    const region = canvas.getByRole('region');
    await expect(region.scrollWidth).toBeGreaterThan(region.clientWidth);
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};

/** A very long path wraps anywhere at 320px; long lines still scroll inside the block. */
export const LongPathNarrowScreen: Story = {
  args: { file: file({ path: longPath, content: `${longLine}\n` }) },
  decorators: [
    (Story) => (
      <div className="w-full max-w-80">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas, canvasElement }) => {
    const heading = canvas.getByRole('heading');
    const box = canvasElement.firstElementChild!.getBoundingClientRect();
    await expect(heading.getBoundingClientRect().right).toBeLessThanOrEqual(box.right);
    await expect(canvas.getByRole('region').getBoundingClientRect().right).toBeLessThanOrEqual(
      box.right,
    );
  },
};

/** Cut at the per-file limit: the notice gives the original size. */
export const TruncatedAtFileLimit: Story = {
  args: {
    file: file({
      path: 'build/index.js',
      kept: 'truncated',
      reason: 'file-limit',
      sizeBytes: 1_572_864,
      content: '(()=>{"use strict";var e={};\n',
    }),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Truncated at 1 MB: the file has 1,572,864 bytes.',
    );
    await expect(canvas.getByText('1.5 MB')).toBeVisible();
  },
};

/** Cut because the agent run's budget ran out. */
export const TruncatedAtRunLimit: Story = {
  args: { file: file({ kept: 'truncated', reason: 'run-limit' }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Truncated: the 10 MB limit for this agent run was reached.',
    );
  },
};

/** A binary file: metadata only, no content. */
export const Binary: Story = {
  args: {
    file: file({
      path: 'assets/icon.png',
      change: 'added',
      kept: 'none',
      reason: 'binary',
      content: null,
      sizeBytes: 4_812,
    }),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('Binary file, not kept.');
    await expect(canvas.queryByRole('region')).toBeNull();
  },
};

/** The other reasons nothing is shown: deleted, artifact file, run budget used up. */
export const NotKept: Story = {
  render: () => (
    <div className="space-y-section">
      <FileView
        file={file({
          path: 'src/old-save.js',
          change: 'deleted',
          kept: 'none',
          reason: 'deleted',
          sizeBytes: null,
          content: null,
        })}
      />
      <FileView
        file={file({
          path: '.claude/skills/notice-block/SKILL.md',
          change: 'added',
          kept: 'none',
          reason: 'artifact-path',
          content: null,
        })}
      />
      <FileView
        file={file({
          path: 'vendor/autoload.php',
          kept: 'none',
          reason: 'run-limit',
          content: null,
        })}
      />
    </div>
  ),
  play: async ({ canvas }) => {
    const notices = canvas.getAllByRole('status').map((status) => status.textContent);
    await expect(notices).toEqual([
      'Deleted by the agent.',
      'Artifact file, not kept.',
      'Not kept: the 10 MB limit for this agent run was reached.',
    ]);
  },
};

/** Redacted secrets stay as the marker the redaction wrote; the count is stated. */
export const Redacted: Story = {
  args: {
    file: file({
      path: '.env.example',
      change: 'added',
      content: 'API_URL=https://api.example.com\nAPI_KEY=[REDACTED]\nTOKEN=[REDACTED]\n',
      redactions: 2,
    }),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('2 secrets redacted.');
  },
};

/** Carriage returns cannot be shown in HTML, so the view says it shows LF endings. */
export const CarriageReturns: Story = {
  args: { file: file({ path: 'notes.txt', content: 'first line\r\nsecond line\r\n' }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('Shown with LF line endings.');
  },
};

/** Untrusted content is text: markup in the file is shown, never rendered. */
export const UntrustedContent: Story = {
  args: {
    file: file({
      path: 'index.html',
      content: '<script>alert(1)</script>\n<img src="x" onerror="alert(2)">\n',
    }),
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText('<script>alert(1)</script>')).toBeVisible();
    await expect(canvasElement.querySelectorAll('pre script, pre img')).toHaveLength(0);
  },
};
