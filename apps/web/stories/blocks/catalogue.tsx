import type { ReactNode } from 'react';
import {
  EmptyState,
  JobStatusBadge,
  MockBadge,
  NotSandboxedBadge,
  StatusBadge,
} from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Pre } from '@/components/ui/primitives';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

// The component catalogue of the "Components" page (SPEC-122 stage 4): a small live preview of
// the real component, its group, one sentence and a link to its page.

type Entry = {
  name: string;
  group: 'Primitive' | 'Product';
  docs: string;
  description: string;
  preview: ReactNode;
};

const entries: Entry[] = [
  {
    name: 'Button',
    group: 'Primitive',
    docs: 'primitives-button--docs',
    description: 'Starts an action on the current page.',
    preview: <Button size="sm">Run</Button>,
  },
  {
    name: 'Badge',
    group: 'Primitive',
    docs: 'primitives-badge--docs',
    description: 'A short static label for a status or a property.',
    preview: <Badge variant="outline">skill</Badge>,
  },
  {
    name: 'Card',
    group: 'Primitive',
    docs: 'primitives-card--docs',
    description: 'Groups one section of a page.',
    preview: (
      <Card size="sm" className="w-40">
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
        </CardHeader>
      </Card>
    ),
  },
  {
    name: 'Input',
    group: 'Primitive',
    docs: 'primitives-input--docs',
    description: 'A single-line text field with a visible label.',
    preview: <Input aria-label="Catalogue search" placeholder="Name" className="w-40" />,
  },
  {
    name: 'Textarea',
    group: 'Primitive',
    docs: 'primitives-textarea--docs',
    description: 'A multi-line text field with a visible label.',
    preview: <Textarea aria-label="Catalogue notes" placeholder="Notes" className="w-40" />,
  },
  {
    name: 'NativeSelect',
    group: 'Primitive',
    docs: 'primitives-nativeselect--docs',
    description: 'Chooses one value from a short, known list.',
    preview: (
      <NativeSelect aria-label="Catalogue type" defaultValue="">
        <NativeSelectOption value="">All</NativeSelectOption>
      </NativeSelect>
    ),
  },
  {
    name: 'Table',
    group: 'Primitive',
    docs: 'primitives-table--docs',
    description: 'Rows of items with the same columns.',
    preview: (
      <Table aria-label="Catalogue table" className="w-40">
        <TableHeader>
          <TableRow>
            <TableHead>Artifact</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>validate-input</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    ),
  },
  {
    name: 'Pre',
    group: 'Primitive',
    docs: 'primitives-pre--docs',
    description: 'Shows code and raw output exactly as it is.',
    preview: <Pre className="w-40">{'{ "agent": "mock" }'}</Pre>,
  },
  {
    name: 'PageHeader',
    group: 'Product',
    docs: 'product-app-shell-pageheader--docs',
    description: "The page's h1, description and page actions.",
    preview: <span className="text-page-title">Results</span>,
  },
  {
    name: 'Nav',
    group: 'Product',
    docs: 'product-app-shell-nav--docs',
    description: 'The main navigation in the app shell.',
    preview: <span className="text-caption text-muted-foreground uppercase">Registry</span>,
  },
  {
    name: 'ThemeToggle',
    group: 'Product',
    docs: 'product-app-shell-themetoggle--docs',
    description: 'Switches between the light and dark theme.',
    preview: <span className="text-ui text-muted-foreground">Icon button in the shell</span>,
  },
  {
    name: 'EmptyState',
    group: 'Product',
    docs: 'product-states-emptystate--docs',
    description: 'Says why a list is empty and what to do next.',
    preview: (
      <div className="w-40">
        <EmptyState title="No runs yet" />
      </div>
    ),
  },
  {
    name: 'NotInitialized',
    group: 'Product',
    docs: 'product-states-notinitialized--docs',
    description: 'Explains that the local database does not exist yet.',
    preview: <span className="text-ui text-muted-foreground">Card with the init command</span>,
  },
  {
    name: 'PlannedSection',
    group: 'Product',
    docs: 'product-states-plannedsection--docs',
    description: 'The honest page of a section that is not built yet.',
    preview: <Badge variant="muted">Planned: not implemented</Badge>,
  },
  {
    name: 'StatusBadge',
    group: 'Product',
    docs: 'product-benchmarking-statusbadge--docs',
    description: "A benchmark run's display status.",
    preview: <StatusBadge status="regression" />,
  },
  {
    name: 'JobStatusBadge',
    group: 'Product',
    docs: 'product-benchmarking-jobstatusbadge--docs',
    description: "A job's place in the runner queue.",
    preview: <JobStatusBadge status="running" />,
  },
  {
    name: 'MockBadge',
    group: 'Product',
    docs: 'product-benchmarking-mockbadge--docs',
    description: 'Labels every result of the mock agent.',
    preview: <MockBadge />,
  },
  {
    name: 'NotSandboxedBadge',
    group: 'Product',
    docs: 'product-benchmarking-notsandboxedbadge--docs',
    description: 'Warns that commands run without isolation.',
    preview: <NotSandboxedBadge />,
  },
  {
    name: 'Markdown',
    group: 'Product',
    docs: 'product-registry-markdown--docs',
    description: 'Renders untrusted Markdown from artifacts safely.',
    preview: <span className="text-body font-semibold">Validate external input</span>,
  },
];

/** Every documented component with a live preview and a link to its page. */
export function Catalogue() {
  return (
    <Table aria-label="Component catalogue">
      <TableHeader>
        <TableRow>
          <TableHead>Component</TableHead>
          <TableHead>Group</TableHead>
          <TableHead>Preview</TableHead>
          <TableHead>What it is for</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.name} className="hover:bg-transparent">
            <TableCell>
              <a
                href={`./?path=/docs/${entry.docs}`}
                target="_top"
                className="font-mono text-primary-text underline-offset-4 hover:underline"
              >
                {entry.name}
              </a>
            </TableCell>
            <TableCell>{entry.group}</TableCell>
            <TableCell>{entry.preview}</TableCell>
            <TableCell className="whitespace-normal">{entry.description}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
