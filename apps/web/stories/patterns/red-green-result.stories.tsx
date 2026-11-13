import type { DisplayStatus } from '@directivebench/benchmark-engine/scoring';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect } from 'storybook/test';
import { MockBadge, NotSandboxedBadge, PageHeader, StatusBadge } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDelta, formatScore } from '@/lib/utils';

// Pattern: a RED/GREEN result (SPEC-112, SPEC-118), modelled on /results/[id]. The same suite
// runs without the artifact (baseline, RED) and with it (candidate, GREEN); the verdict compares
// them. ScoreBar and VariantCard are locked in the page file, so this pattern uses Card.

type Result = {
  status: DisplayStatus;
  agent: string;
  baseline: number;
  candidate: number;
  repetitions: number;
  confidence: string;
  note?: string;
};

function RedGreenResult({ result }: { result: Result }) {
  const mock = result.agent === 'mock';
  const delta = result.candidate - result.baseline;
  return (
    <div className="max-w-content">
      <PageHeader
        title="validate-external-input: claude-code suite"
        description={`Run of 28 Oct 2026, 12:00 UTC, ${result.repetitions} repetitions`}
        actions={
          <>
            <StatusBadge status={result.status} />
            {mock ? <MockBadge /> : <Badge variant="outline">{result.agent}</Badge>}
            <NotSandboxedBadge />
          </>
        }
      />
      <div className="space-y-section">
        {mock ? (
          <p role="note" className="text-body text-warning-foreground">
            These scores come from the deterministic mock agent. They show that the pipeline works,
            not how an AI model behaves.
          </p>
        ) : null}
        <div className="grid gap-grid md:grid-cols-2">
          {(
            [
              ['Baseline (RED)', 'without the artifact', result.baseline],
              ['Candidate (GREEN)', 'with validate-external-input v3', result.candidate],
            ] as const
          ).map(([title, description, score]) => (
            <Card key={title}>
              <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-metric tabular-nums">{formatScore(score)}</p>
                <p className="text-caption text-muted-foreground">
                  Mean score over the repetitions
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Verdict</CardTitle>
          </CardHeader>
          <CardContent className="space-y-stack">
            <p>
              Change: <span className="tabular-nums">{formatDelta(delta)}</span>. Confidence:{' '}
              {result.confidence}.
            </p>
            {result.note ? <p className="text-muted-foreground">{result.note}</p> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const meta = {
  title: 'Patterns/RED-GREEN result',
  component: RedGreenResult,
  parameters: { layout: 'padded' },
  args: {
    result: {
      status: 'passed',
      agent: 'mock',
      baseline: 0.5,
      candidate: 1,
      repetitions: 3,
      confidence: 'medium (3 repetitions, deterministic agent)',
    },
  },
} satisfies Meta<typeof RedGreenResult>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The mock agent: labelled in the header and explained above the scores (AGENTS.md §7). */
export const ImprovedMock: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Mock agent: not an AI evaluation')).toBeVisible();
    await expect(canvas.getByRole('note')).toHaveTextContent('deterministic mock agent');
  },
};

/** A real agent run that got worse: no mock label, the regression is a word and a sign. */
export const Regression: Story = {
  args: {
    result: {
      status: 'regression',
      agent: 'claude-code',
      baseline: 0.83,
      candidate: 0.67,
      repetitions: 5,
      confidence: 'high (5 repetitions)',
    },
  },
  play: async ({ canvas }) => {
    await expect(canvas.queryByText('Mock agent: not an AI evaluation')).toBeNull();
    await expect(canvas.getByText('-16 pts')).toBeVisible();
  },
};

/** Repetitions disagree: the verdict says the result is not reliable. */
export const Unstable: Story = {
  args: {
    result: {
      status: 'unstable',
      agent: 'claude-code',
      baseline: 0.5,
      candidate: 0.67,
      repetitions: 3,
      confidence: 'low',
      note: 'Pass rates differ between repetitions. Run more repetitions before relying on this result.',
    },
  },
};

/** Baseline and candidate ran under different conditions: no number is compared. */
export const NotComparable: Story = {
  args: {
    result: {
      status: 'not-comparable',
      agent: 'claude-code',
      baseline: 0.5,
      candidate: 0.83,
      repetitions: 3,
      confidence: 'none',
      note: 'The baseline used claude-sonnet and the candidate claude-opus. Compare runs with the same model.',
    },
  },
};

/**
 * Results by version after two copies diverged (SPEC-126 §11.3 F10 to F12): v3 was edited from
 * v1 in another repository, so it is compared with v1 and never with the parallel edit v2; the
 * heading names the version it was edited from only where that is not the number one lower.
 */
export const DivergedVersions: Story = {
  render: () => {
    const blocks = [
      {
        version: 3,
        editedFrom: 1,
        regressed: true,
        status: 'regression' as const,
        comparison: 'Version regression vs v1 (-20 pts)',
      },
      {
        version: 2,
        editedFrom: null,
        regressed: false,
        status: 'passed' as const,
        comparison: 'No regression vs v1 (+10 pts)',
      },
      {
        version: 1,
        editedFrom: null,
        regressed: false,
        status: 'passed' as const,
        comparison: null,
      },
    ];
    return (
      <div className="max-w-content">
        <Card>
          <CardHeader>
            <CardTitle>Benchmark results by version</CardTitle>
            <CardDescription>
              Completed runs per artifact version, newest first, grouped by comparability key. A
              version regression compares the latest run of a version with the latest run of the
              nearest tested version before it in its edit history, in the same group.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {blocks.map((block) => (
              <section
                key={block.version}
                aria-label={`Version ${block.version}`}
                className="space-y-3"
              >
                <h3 className="flex flex-wrap items-center gap-2 text-body font-semibold">
                  v{block.version}
                  {block.editedFrom === null ? null : (
                    <span className="text-ui font-normal text-muted-foreground">
                      edited from v{block.editedFrom}
                    </span>
                  )}
                  {block.regressed ? (
                    <Badge variant="destructive">
                      Version regression (mock agent, not an AI evaluation)
                    </Badge>
                  ) : null}
                </h3>
                <div className="flex flex-wrap items-center gap-1">
                  <MockBadge />
                  <StatusBadge status={block.status} />
                  {block.comparison === null ? null : (
                    <Badge variant={block.regressed ? 'destructive' : 'muted'}>
                      {block.comparison}
                    </Badge>
                  )}
                </div>
              </section>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  },
  play: async ({ canvas }) => {
    const v3 = canvas.getByRole('region', { name: 'Version 3' });
    await expect(v3).toHaveTextContent('edited from v1');
    await expect(v3).toHaveTextContent('Version regression vs v1');
    await expect(canvas.getByRole('region', { name: 'Version 2' })).not.toHaveTextContent(
      'edited from',
    );
  },
};
