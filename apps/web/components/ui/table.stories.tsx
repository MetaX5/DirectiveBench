import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { StateMatrix, stateProps } from '../../stories/blocks/state-matrix';
import { Badge } from './badge';
import { Button } from './button';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './table';

const runs = [
  ['validate-external-input', 'v3', 'mock', 'Passed', '50% → 100%'],
  ['commit-message-style', 'v1', 'claude-code', 'Unstable', '62.5% → 70.8%'],
  ['no-secrets-in-logs', 'v2', 'mock', 'Regression', '100% → 75%'],
] as const;

const statusVariant = {
  Passed: 'success',
  Unstable: 'warning',
  Regression: 'destructive',
} as const;

function RecentRuns() {
  return (
    <Table aria-label="Recent runs">
      <TableHeader>
        <TableRow>
          <TableHead>Artifact</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Score (RED → GREEN)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map(([artifact, version, agent, status, score]) => (
          <TableRow key={artifact}>
            <TableCell className="font-mono">{artifact}</TableCell>
            <TableCell>{version}</TableCell>
            <TableCell className="font-mono">{agent}</TableCell>
            <TableCell>
              <Badge variant={statusVariant[status]}>{status}</Badge>
            </TableCell>
            <TableCell className="text-right tabular-nums">{score}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const meta = {
  title: 'Primitives/Table',
  component: Table,
  parameters: { layout: 'padded' },
  render: () => <RecentRuns />,
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvas }) => {
    const table = canvas.getByRole('table', { name: 'Recent runs' });
    await expect(table.querySelectorAll('th')).toHaveLength(5);
    await expect(canvas.getAllByRole('row')).toHaveLength(4);
  },
};

/** Row states: hover is frozen; selected uses data-state="selected". */
export const RowStates: Story = {
  render: () => (
    <StateMatrix
      label="Table row states"
      variants={['row'] as const}
      states={['rest', 'hover', 'selected']}
      render={(_, state) => (
        <Table aria-label={`Row ${state}`}>
          <TableBody>
            <TableRow {...stateProps(state)}>
              <TableCell className="font-mono">acme/agent-rules</TableCell>
              <TableCell>12 artifacts</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    />
  ),
};

/** Caption and footer exist in the preset; no page uses them yet (P3). */
export const WithCaptionAndFooter: Story = {
  render: () => (
    <Table>
      <TableCaption>Assertions of validate-external-input, weights sum to 6</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Assertion</TableHead>
          <TableHead className="text-right">Weight</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>basic tests pass</TableCell>
          <TableCell className="text-right tabular-nums">2</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>validation tests pass</TableCell>
          <TableCell className="text-right tabular-nums">2</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell className="text-right tabular-nums">4</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};

/** An action per row uses a small outline button with a name that says which row. */
export const RowAction: Story = {
  render: () => (
    <Table aria-label="Repositories">
      <TableBody>
        {['acme/agent-rules', 'team/claude-skills'].map((name) => (
          <TableRow key={name}>
            <TableCell className="font-mono">{name}</TableCell>
            <TableCell className="text-right">
              <Button size="sm" variant="outline" aria-label={`Scan ${name}`}>
                Scan
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: 'Scan team/claude-skills' })).toBeVisible();
  },
};

/** No data: the table is replaced by a sentence, not shown with an empty body. */
export const Empty: Story = {
  render: () => (
    <p className="text-body text-muted-foreground">
      No repositories yet. Register a local folder or a GitHub URL above.
    </p>
  ),
};

/** At 320px the table scrolls sideways inside its container; the page does not. */
export const NarrowScreen: Story = {
  render: () => (
    <div className="w-80 border border-dashed">
      <RecentRuns />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const container = canvasElement.querySelector<HTMLElement>('[data-slot="table-container"]')!;
    await expect(container.scrollWidth).toBeGreaterThan(container.clientWidth);
    await expect(getComputedStyle(container).overflowX).toBe('auto');
    // A named region and a tab stop, so the keyboard can scroll it (SPEC-122 P13).
    await expect(container).toHaveAttribute('tabindex', '0');
    await expect(container).toHaveAccessibleName('Recent runs');
  },
};
