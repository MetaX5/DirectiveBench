import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { baselineRender, file, longLine, longPath, numberedLines } from './fixtures';
import { SideBySideDiff } from './side-by-side-diff';

const baseline = { name: 'Left', description: 'Baseline (v2), repetition 1' };
const candidate = { name: 'Right', description: 'Candidate (v3), repetition 1' };

const meta = {
  title: 'Product/Benchmarking/SideBySideDiff',
  component: SideBySideDiff,
  parameters: { layout: 'padded' },
  args: {
    path: 'src/render.php',
    left: { ...baseline, file: file({ content: baselineRender }) },
    right: { ...candidate, file: file() },
  },
} satisfies Meta<typeof SideBySideDiff>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two variants of one file: removed lines on the left, added lines on the right, aligned. */
export const Playground: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('3 lines removed, 5 lines added.');
    await expect(
      canvas.getByRole('heading', { name: 'Left: Baseline (v2), repetition 1' }),
    ).toBeVisible();
    // Not colour alone: every changed line has a visible marker and a label for screen readers.
    await expect(canvas.getAllByText('Removed:')).toHaveLength(3);
    await expect(canvas.getAllByText('Added:')).toHaveLength(5);
    // Both columns have the same number of rows, so they line up.
    const [left, right] = [...canvasElement.querySelectorAll('pre')];
    await expect(left!.children.length).toBe(right!.children.length);
  },
};

/** Blind review: sides named A and B, no description, and no red or green direction. */
export const BlindReview: Story = {
  args: {
    variant: 'neutral',
    left: { name: 'A', file: file({ content: baselineRender }) },
    right: { name: 'B', file: file() },
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent(
      '3 lines only in A, 5 lines only in B.',
    );
    await expect(canvas.getByRole('heading', { name: 'A' })).toBeVisible();
    await expect(canvas.getAllByText('Only in A:')).toHaveLength(3);
    await expect(
      canvasElement.querySelectorAll('[data-tone="removed"], [data-tone="added"]'),
    ).toHaveLength(0);
  },
};

/** Identical files: said in words, no markers. */
export const Identical: Story = {
  args: {
    right: { ...candidate, file: file({ content: baselineRender }) },
    left: { ...baseline, file: file({ content: baselineRender }) },
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('The files are identical.');
    await expect(canvasElement.querySelectorAll('[data-tone]')).toHaveLength(0);
  },
};

/** Only additions: the left side gets empty filler rows. */
export const OnlyAdditions: Story = {
  args: {
    left: { ...baseline, file: file({ content: 'a\nb\n' }) },
    right: { ...candidate, file: file({ content: 'a\nnew 1\nnew 2\nb\n' }) },
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('2 lines added.');
    await expect(canvasElement.querySelectorAll('[data-tone="filler"]')).toHaveLength(2);
  },
};

/** Only deletions: the right side gets empty filler rows. */
export const OnlyDeletions: Story = {
  args: {
    left: { ...baseline, file: file({ content: 'a\nold 1\nold 2\nb\n' }) },
    right: { ...candidate, file: file({ content: 'a\nb\n' }) },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('2 lines removed.');
  },
};

/** Two empty files are identical. */
export const BothEmpty: Story = {
  args: {
    left: { ...baseline, file: file({ content: '', sizeBytes: 0 }) },
    right: { ...candidate, file: file({ content: '', sizeBytes: 0 }) },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('status')[0]).toHaveTextContent('The files are identical.');
    await expect(canvas.getAllByText('The file is empty.')).toHaveLength(2);
  },
};

/**
 * More than 1,000 changed lines: no alignment, both files as they are, and the page says why.
 */
export const LargeDiffOverTheBound: Story = {
  args: {
    path: 'build/index.js',
    left: { ...baseline, file: file({ content: numberedLines(501, 'baseline') }) },
    right: { ...candidate, file: file({ content: numberedLines(501, 'candidate') }) },
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'These files differ in more than 1,000 lines, so they are shown without alignment.',
    );
    await expect(canvasElement.querySelectorAll('[data-tone]')).toHaveLength(0);
  },
};

/** Exactly 1,000 changed lines is still aligned. */
export const LargeDiffAtTheBound: Story = {
  args: {
    path: 'build/index.js',
    left: { ...baseline, file: file({ content: numberedLines(500, 'baseline') }) },
    right: { ...candidate, file: file({ content: numberedLines(500, 'candidate') }) },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent(
      '500 lines removed, 500 lines added.',
    );
  },
};

/** A path one side lacks: that side says so, the other is shown without markers. */
export const OneSideMissing: Story = {
  args: {
    path: 'src/deprecated.js',
    left: { ...baseline, file: null },
    right: {
      ...candidate,
      file: file({ path: 'src/deprecated.js', change: 'added', content: 'export default [];\n' }),
    },
  },
  play: async ({ canvas }) => {
    const statuses = canvas.getAllByRole('status').map((status) => status.textContent);
    await expect(statuses).toEqual([
      'No line comparison: one side has no text to compare.',
      'Not present in this agent run.',
    ]);
  },
};

/** A side that was not kept (binary) or cut: its notices sit above its column. */
export const NotKeptAndTruncatedSides: Story = {
  args: {
    path: 'build/index.js',
    left: { ...baseline, file: file({ kept: 'none', reason: 'binary', content: null }) },
    right: {
      ...candidate,
      file: file({ kept: 'truncated', reason: 'file-limit', sizeBytes: 1_572_864, redactions: 1 }),
    },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Binary file, not kept.')).toBeVisible();
    await expect(
      canvas.getByText('Truncated at 1 MB: the file has 1,572,864 bytes.'),
    ).toBeVisible();
    await expect(canvas.getByText('1 secret redacted.')).toBeVisible();
  },
};

/** At 320px the columns stack, left first; a long path wraps and long lines scroll inside. */
export const NarrowScreen: Story = {
  args: {
    path: longPath,
    left: { ...baseline, file: file({ content: `${longLine}\nsame\n` }) },
    right: { ...candidate, file: file({ content: 'changed\nsame\n' }) },
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-80">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas, canvasElement }) => {
    const [left, right] = canvas.getAllByRole('heading', { level: 4 });
    await expect(left!.getBoundingClientRect().top).toBeLessThan(
      right!.getBoundingClientRect().top,
    );
    const box = canvasElement.firstElementChild!.getBoundingClientRect();
    for (const region of canvas.getAllByRole('region')) {
      await expect(region.getBoundingClientRect().right).toBeLessThanOrEqual(box.right);
    }
  },
};
