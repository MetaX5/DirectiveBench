import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { expect } from 'storybook/test';
import { EmptyState, MockBadge, PageHeader, StatusBadge } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Pattern: a detail view, modelled on /artifacts/[id] and /benchmarks/[id]. The key facts and
// the main action are in the first screen; everything else follows in cards.

type Detail = {
  name: string;
  type: string;
  version: number;
  repository: string;
  path: string;
  description?: string;
  latest?: { status: 'passed' | 'regression'; score: string; mock: boolean };
};

const skill: Detail = {
  name: 'validate-external-input',
  type: 'skill',
  version: 3,
  repository: 'acme/agent-rules',
  path: '.claude/skills/validate-external-input/SKILL.md',
  description: 'Validate every external input at the boundary and reject unknown fields.',
  latest: { status: 'passed', score: '50% → 100%', mock: true },
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="text-ui">{children}</dd>
    </div>
  );
}

function ArtifactDetail({ artifact }: { artifact: Detail | null }) {
  if (!artifact) {
    return (
      <div className="max-w-content">
        <PageHeader title="Artifact not found" />
        <EmptyState title="This artifact does not exist">
          It may have been removed by a rescan.{' '}
          <a href="#artifacts" className="text-primary-text underline">
            Back to all artifacts
          </a>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="max-w-content">
      <PageHeader
        title={artifact.name}
        description={artifact.description ?? 'No description in the artifact.'}
        actions={
          <>
            <Badge variant="outline">{artifact.type}</Badge>
            <Badge variant="outline">v{artifact.version}</Badge>
            <Button>
              <Play aria-hidden data-icon="inline-start" />
              Run benchmark
            </Button>
          </>
        }
      />
      <div className="space-y-section">
        <Card>
          <CardHeader>
            <CardTitle>Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-grid sm:grid-cols-3">
              <Fact label="Repository">
                <span className="font-mono">{artifact.repository}</span>
              </Fact>
              <Fact label="Primary file">
                <span className="font-mono break-all">{artifact.path}</span>
              </Fact>
              <Fact label="Latest result">
                {artifact.latest ? (
                  <span className="flex flex-wrap items-center gap-inline-tight">
                    <span className="tabular-nums">{artifact.latest.score}</span>
                    <StatusBadge status={artifact.latest.status} />
                    {artifact.latest.mock ? <MockBadge /> : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not tested yet</span>
                )}
              </Fact>
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const meta = {
  title: 'Patterns/Detail view',
  component: ArtifactDetail,
  parameters: { layout: 'padded' },
  args: { artifact: skill },
} satisfies Meta<typeof ArtifactDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Name, type, version, latest result and the main action in the first screen. */
export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole('heading', { level: 1, name: 'validate-external-input' }),
    ).toBeVisible();
    const action = canvas.getByRole('button', { name: 'Run benchmark' });
    await expect(action.getBoundingClientRect().bottom).toBeLessThan(window.innerHeight);
  },
};

/** Partial data: missing values are said in words, not left blank. */
export const PartialData: Story = {
  args: { artifact: { ...skill, description: undefined, latest: undefined } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Not tested yet')).toBeVisible();
  },
};

/** Does not exist: a page title, why, and the way back. */
export const NotFound: Story = {
  args: { artifact: null },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('link', { name: 'Back to all artifacts' })).toBeVisible();
  },
};

/** Long name and path at 320px: the actions wrap under the title. */
export const LongTextNarrowScreen: Story = {
  args: {
    artifact: {
      ...skill,
      name: 'validate-external-input-and-reject-unknown-fields-everywhere',
      path: '.claude/skills/validate-external-input-and-reject-unknown-fields-everywhere/SKILL.md',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-80 break-words">
        <Story />
      </div>
    ),
  ],
};
