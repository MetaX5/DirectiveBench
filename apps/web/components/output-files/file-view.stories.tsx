import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent } from 'storybook/test';
import { displayLines } from '@/lib/output-files';
import { file, longLine, longPath } from './fixtures';
import { FileView } from './file-view';
import {
  highlightedLineTexts,
  highlights,
  highlightSamples,
  sampleFile,
  tokenColour,
  type HighlightSample,
} from './highlight-fixtures';

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

// Syntax highlighting (SPEC-123 §6.7, D20). Tokens come precomputed from the server-only
// highlighter (highlight-fixtures.json); the component renders them as React text in spans.

/** Each line shows its own tokens, and a token of `kind` has its design-token colour. */
async function expectHighlighted(root: HTMLElement, sample: HighlightSample, kind: string) {
  const lines = displayLines(highlightSamples[sample].text);
  const shown = highlightedLineTexts(root);
  await expect(shown).toEqual(lines.map((text, index) => [index + 1, text]));
  const token = root.querySelector(`.text-syntax-token-${kind}`);
  await expect(token).not.toBeNull();
  await expect(getComputedStyle(token!).color).toBe(tokenColour(root, kind));
}

/** A PHP template with syntax colours: keywords, functions, strings and punctuation. */
export const HighlightedPhp: Story = {
  args: { file: file(sampleFile('candidateRender')), highlight: highlights.candidateRender },
  play: async ({ canvas, canvasElement }) => {
    await expectHighlighted(canvasElement, 'candidateRender', 'function');
    await expect(canvas.queryByRole('status')).toBeNull();
  },
};

/** TSX with a doc comment, a template string, JSX tags and attributes. */
export const HighlightedTsx: Story = {
  args: { file: file(sampleFile('editTsx')), highlight: highlights.editTsx },
  play: async ({ canvasElement }) => {
    await expectHighlighted(canvasElement, 'editTsx', 'comment');
  },
};

/** JSON: keys, string values and constants. */
export const HighlightedJson: Story = {
  args: { file: file(sampleFile('blockJson')), highlight: highlights.blockJson },
  play: async ({ canvasElement }) => {
    await expectHighlighted(canvasElement, 'blockJson', 'constant');
  },
};

/** Markdown: a heading, a link and a fenced block, coloured only as far as its grammar goes. */
export const HighlightedMarkdown: Story = {
  args: { file: file(sampleFile('readmeMarkdown')), highlight: highlights.readmeMarkdown },
  play: async ({ canvasElement }) => {
    await expectHighlighted(canvasElement, 'readmeMarkdown', 'link');
  },
};

/** Over 256 KB of stored content: plain text and a note saying why (FR-123-74). */
export const HighlightOffOverTheLimit: Story = {
  args: {
    file: file({ path: 'build/index.js', sizeBytes: 393_216 }),
    highlight: { kind: 'plain', reason: 'too-large' },
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Syntax highlighting is off for files over 256 KB.',
    );
    await expect(canvasElement.querySelectorAll('[data-highlighted]')).toHaveLength(0);
  },
};

/** The highlighter failed: plain text and a note; the file is still shown (FR-123-74). */
export const HighlightFailed: Story = {
  args: { highlight: { kind: 'plain', reason: 'failed' } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Syntax highlighting failed, so this file is shown as plain text.',
    );
    await expect(canvas.getByRole('region')).toHaveTextContent('esc_attr__');
    await expect(canvasElement.querySelectorAll('[data-highlighted]')).toHaveLength(0);
  },
};

/**
 * Highlighting passed its 2 s deadline, so the server stopped the highlight worker: plain text
 * and a note; the file is still shown (FR-123-78).
 */
export const HighlightTimedOut: Story = {
  args: { highlight: { kind: 'plain', reason: 'timeout' } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Syntax highlighting took too long, so this file is shown as plain text.',
    );
    await expect(canvas.getByRole('region')).toHaveTextContent('esc_attr__');
    await expect(canvasElement.querySelectorAll('[data-highlighted]')).toHaveLength(0);
  },
};

/** An extension the highlighter does not know: plain text and no note (FR-123-71). */
export const UnknownExtension: Story = {
  args: {
    file: file({ path: 'Makefile', content: 'build:\n\tnpm run build\n' }),
    highlight: { kind: 'plain', reason: 'no-language' },
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole('status')).toBeNull();
    await expect(canvasElement.querySelectorAll('[data-highlighted]')).toHaveLength(0);
  },
};

/** Highlighted markup is still text: tags are coloured, never rendered (AC-15). */
export const HighlightedUntrustedContent: Story = {
  args: { file: file(sampleFile('hostileHtml')), highlight: highlights.hostileHtml },
  play: async ({ canvas, canvasElement }) => {
    await expectHighlighted(canvasElement, 'hostileHtml', 'function');
    await expect(canvas.getByRole('region')).toHaveTextContent('<script>alert(1)</script>');
    await expect(canvasElement.querySelectorAll('pre script, pre img')).toHaveLength(0);
  },
};
