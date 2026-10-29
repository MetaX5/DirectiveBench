import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import type { OutputFile } from '@/lib/output-files';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { file, longPath } from './fixtures';
import { FileStatusBadges } from './file-status-badges';

const rows: Array<{ meaning: string; file: OutputFile; onlyIn?: string }> = [
  { meaning: 'Added, kept in full.', file: file({ path: 'src/view.js', change: 'added' }) },
  { meaning: 'Modified, kept in full.', file: file({ path: 'block.json' }) },
  {
    meaning: 'Deleted by the agent; nothing to show.',
    file: file({ path: 'src/old-save.js', change: 'deleted', kept: 'none', reason: 'deleted' }),
  },
  {
    meaning: 'Cut at a limit; the start of the file is shown.',
    file: file({ path: 'build/index.js', kept: 'truncated', reason: 'file-limit' }),
  },
  {
    meaning: 'Binary; only size and hash kept.',
    file: file({ path: 'assets/icon.png', change: 'added', kept: 'none', reason: 'binary' }),
  },
  {
    meaning: 'Under the installed artifact; it is the skill, not output.',
    file: file({ path: '.claude/skills/x/SKILL.md', kept: 'none', reason: 'artifact-path' }),
  },
  {
    meaning: 'The agent run budget was used up before this file.',
    file: file({ path: 'vendor/autoload.php', kept: 'none', reason: 'run-limit' }),
  },
  {
    meaning: 'Secrets in the content were redacted.',
    file: file({ path: '.env.example', change: 'added', redactions: 2 }),
  },
  {
    meaning: 'Compare: only the right agent run has this path.',
    file: file({ path: 'src/deprecated.js', change: 'added' }),
    onlyIn: 'right',
  },
];

const meta = {
  title: 'Product/Benchmarking/FileStatusBadges',
  component: FileStatusBadges,
  parameters: { layout: 'padded' },
  args: { file: file({ kept: 'truncated', reason: 'file-limit', redactions: 1 }) },
} satisfies Meta<typeof FileStatusBadges>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Modified')).toHaveAttribute('data-variant', 'outline');
    await expect(canvas.getByText('Truncated')).toHaveAttribute('data-variant', 'warning');
    await expect(canvas.getByText('1 redacted')).toHaveAttribute('data-variant', 'info');
  },
};

/** Every change and kept state, as a file list would show them (SPEC-123 FR-123-21). */
export const AllStatuses: Story = {
  render: () => (
    <Table aria-label="Output file statuses">
      <TableHeader>
        <TableRow>
          <TableHead>Path</TableHead>
          <TableHead>Badges</TableHead>
          <TableHead>Meaning</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.file.path}>
            <TableCell className="font-mono">{row.file.path}</TableCell>
            <TableCell>
              <FileStatusBadges file={row.file} onlyIn={row.onlyIn} />
            </TableCell>
            <TableCell className="whitespace-normal">{row.meaning}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Only right')).toBeVisible();
    await expect(canvas.getByText('Binary, not kept')).toHaveAttribute('data-variant', 'muted');
  },
};

/** In a narrow list the badges wrap under a long path; nothing scrolls sideways. */
export const LongPathNarrowScreen: Story = {
  render: () => (
    <div className="flex w-full max-w-80 flex-col gap-inline-tight">
      <span className="font-mono text-ui wrap-anywhere">{longPath}</span>
      <FileStatusBadges
        file={file({ kept: 'truncated', reason: 'run-limit', redactions: 3 })}
        onlyIn="left"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
