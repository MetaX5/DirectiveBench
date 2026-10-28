import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { X } from 'lucide-react';
import { expect } from 'storybook/test';
import { EmptyState, MockBadge, PageHeader, StatusBadge } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// Pattern: a filtered list, modelled on /artifacts. Filters are a GET form, so the URL holds
// them and the browser's back button works.

type Artifact = {
  name: string;
  type: string;
  repository: string;
  description: string;
  status: 'passed' | 'regression' | 'not-tested';
  mock: boolean;
};

const artifacts: Artifact[] = [
  {
    name: 'validate-external-input',
    type: 'skill',
    repository: 'acme/agent-rules',
    description: 'Validate every external input at the boundary and reject unknown fields.',
    status: 'passed',
    mock: true,
  },
  {
    name: 'commit-message-style',
    type: 'rule',
    repository: 'acme/agent-rules',
    description: 'Conventional Commits with a scope.',
    status: 'regression',
    mock: false,
  },
  {
    name: 'no-secrets-in-logs',
    type: 'instruction',
    repository: 'team/claude-skills',
    description: 'Never print tokens, keys or .env values.',
    status: 'not-tested',
    mock: false,
  },
];

type Filters = { q?: string; type?: string };

function ArtifactList({
  items,
  filters,
  total,
}: {
  items: Artifact[];
  filters: Filters;
  total: number;
}) {
  const active = Object.entries(filters).filter(([, value]) => value);
  return (
    <div className="max-w-content">
      <PageHeader
        title="Artifacts"
        description="Skills, instructions and rules from every registered repository."
      />
      {total === 0 ? (
        <EmptyState title="No artifacts yet">
          Register a repository and scan it; its skills, instructions and rules appear here.
        </EmptyState>
      ) : (
        <Card>
          <CardContent className="space-y-stack">
            <form role="search" className="flex flex-wrap items-end gap-inline">
              <label className="flex flex-col gap-1 text-ui text-muted-foreground">
                Search
                <Input
                  name="q"
                  defaultValue={filters.q}
                  placeholder="Name or description"
                  className="w-56"
                />
              </label>
              <label className="flex flex-col gap-1 text-ui text-muted-foreground">
                Type
                <NativeSelect name="type" defaultValue={filters.type ?? ''}>
                  <NativeSelectOption value="">All</NativeSelectOption>
                  {['skill', 'instruction', 'rule'].map((type) => (
                    <NativeSelectOption key={type} value={type}>
                      {type}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <Button type="submit" variant="outline">
                Filter
              </Button>
            </form>
            <div className="flex flex-wrap items-center gap-inline">
              <p role="status" className="text-ui text-muted-foreground">
                {items.length === total
                  ? `${total} artifacts`
                  : `${items.length} of ${total} artifacts`}
              </p>
              {active.map(([key, value]) => (
                <Button key={key} asChild variant="outline" size="xs">
                  <a href="#remove-filter" aria-label={`Remove filter ${key}: ${value}`}>
                    {key}: {value}
                    <X aria-hidden data-icon="inline-end" />
                  </a>
                </Button>
              ))}
              {active.length > 1 ? (
                <Button asChild variant="link" size="xs">
                  <a href="#clear-filters">Clear all filters</a>
                </Button>
              ) : null}
            </div>
            {items.length === 0 ? (
              <EmptyState title="No artifacts match these filters">
                <a href="#clear-filters" className="text-primary-text underline">
                  Clear all filters
                </a>
              </EmptyState>
            ) : (
              <Table aria-label="Artifacts">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Repository</TableHead>
                    <TableHead>Latest score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((artifact, index) => (
                    <TableRow key={`${artifact.name}-${index}`}>
                      <TableCell className="whitespace-normal">
                        <a href="#artifact" className="font-medium hover:underline">
                          {artifact.name}
                        </a>
                        <p className="text-muted-foreground">{artifact.description}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{artifact.type}</Badge>
                      </TableCell>
                      <TableCell className="font-mono">{artifact.repository}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-inline-tight">
                          <StatusBadge status={artifact.status} />
                          {artifact.mock ? <MockBadge /> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const meta = {
  title: 'Patterns/Filtered list',
  component: ArtifactList,
  parameters: { layout: 'padded' },
  args: { items: artifacts, filters: {}, total: artifacts.length },
} satisfies Meta<typeof ArtifactList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** All results, with the count. */
export const Results: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('3 artifacts');
  },
};

/** Active filters are visible and each one can be removed on its own. */
export const ActiveFilters: Story = {
  args: { items: artifacts.slice(0, 1), filters: { q: 'valid', type: 'skill' } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('1 of 3 artifacts');
    await expect(canvas.getByRole('link', { name: 'Remove filter type: skill' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Clear all filters' })).toBeVisible();
  },
};

/** No results for these filters: says so and offers to clear them. Not the empty state. */
export const NoResultsForFilters: Story = {
  args: { items: [], filters: { q: 'kubernetes' } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('No artifacts match these filters')).toBeVisible();
  },
};

/** Nothing here yet: a different message, pointing at where artifacts come from. */
export const NothingYet: Story = {
  args: { items: [], total: 0 },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('No artifacts yet')).toBeVisible();
    await expect(canvas.queryByRole('search')).toBeNull();
  },
};

/** Many results with long descriptions. */
export const ManyResults: Story = {
  args: {
    items: Array.from({ length: 24 }, (_, i) => ({
      ...artifacts[i % 3]!,
      name: `${artifacts[i % 3]!.name}-${i + 1}`,
      description: `${artifacts[i % 3]!.description} Applies to every service in the monorepo, including the CLI, the web app and the background runner.`,
    })),
    total: 24,
  },
};
