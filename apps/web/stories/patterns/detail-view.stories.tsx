import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { expect } from 'storybook/test';
import { EmptyState, MockBadge, PageHeader, StatusBadge } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';

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
  /** The note of an item whose source is gone (rule 5). */
  missingNote?: string;
  /** Where the item was found and the version each place holds (rule 6). */
  occurrences?: { repository: string; path: string; version: number; status: string }[];
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
            {artifact.missingNote ? <Badge variant="muted">Missing</Badge> : null}
            <Button>
              <Play aria-hidden data-icon="inline-start" />
              Run benchmark
            </Button>
          </>
        }
      />
      {artifact.missingNote ? (
        <p role="note" className="mb-4 text-body">
          {artifact.missingNote}
        </p>
      ) : null}
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
        {artifact.occurrences ? (
          <Card>
            <CardHeader>
              <CardTitle>Occurrences</CardTitle>
              <CardDescription>
                Where this artifact was found, per repository and path, and the version each one
                holds.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table aria-label="Occurrences">
                <THead>
                  <TR>
                    <TH>Repository</TH>
                    <TH>Path</TH>
                    <TH>Version</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {artifact.occurrences.map((occurrence) => (
                    <TR key={`${occurrence.repository}:${occurrence.path}`}>
                      <TD>{occurrence.repository}</TD>
                      <TD className="font-mono text-ui">{occurrence.path}</TD>
                      <TD>
                        <span className="inline-flex flex-wrap items-center gap-inline-tight">
                          <Link
                            className="underline"
                            aria-label={`v${occurrence.version} of ${artifact.name}`}
                            href={`#content-v${occurrence.version}`}
                          >
                            v{occurrence.version}
                          </Link>
                          {occurrence.version < artifact.version ? (
                            <Badge variant="muted" className="whitespace-nowrap">
                              older version
                            </Badge>
                          ) : null}
                        </span>
                      </TD>
                      <TD>
                        <Badge variant={occurrence.status === 'active' ? 'outline' : 'muted'}>
                          {occurrence.status}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}
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

/** Source gone (rule 5): the page stays, with a muted Badge and a note on what is kept. */
export const MissingItem: Story = {
  args: {
    artifact: {
      ...skill,
      missingNote:
        'Missing: no registered repository contained this artifact in its last scan. Last found on 28 Oct 2026, 12:00 UTC. Its versions, categories, notes and benchmark results are kept, and it becomes active again when a scan finds it at the same path.',
    },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Missing', { exact: true })).toBeVisible();
    await expect(canvas.getByRole('note')).toHaveTextContent(/kept/);
    await expect(canvas.getByRole('button', { name: 'Run benchmark' })).toBeEnabled();
  },
};

/**
 * Found in several places (rule 6, SPEC-126): each place shows the version it holds, and a place
 * that holds an older one gets a muted "older version" Badge. The version link's accessible name
 * starts with its visible text ("v1 of review").
 */
export const SharedAcrossRepositories: Story = {
  args: {
    artifact: {
      ...skill,
      name: 'review',
      occurrences: [
        { repository: 'client-a', path: '.claude/skills/review', version: 3, status: 'active' },
        { repository: 'client-b', path: 'skills/review', version: 1, status: 'active' },
        { repository: 'client-c', path: '.agents/skills/review', version: 2, status: 'missing' },
      ],
    },
  },
  play: async ({ canvas }) => {
    const table = canvas.getByRole('region', { name: 'Occurrences' });
    await expect(table).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'v1 of review' })).toHaveAttribute(
      'href',
      '#content-v1',
    );
    await expect(canvas.getAllByText('older version')).toHaveLength(2);
    await expect(canvas.getByRole('link', { name: 'v3 of review' })).toBeVisible();
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
      <div className="w-full max-w-80 break-words">
        <Story />
      </div>
    ),
  ],
};
