import type { ReactNode } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { tokenRows, type TokenRow } from './tokeny';

// Token tables for the Foundations pages, read from tokeny.md and previewed with the real CSS
// variables, so the page shows what globals.css stores (SPEC-122 stage 1).

export type TokenGroup = 'colour' | 'type' | 'space' | 'shape';

const groupOf = (property: string): TokenGroup =>
  property.startsWith('text-') || property.startsWith('font-')
    ? 'type'
    : property.startsWith('spacing-') || property.startsWith('container-')
      ? 'space'
      : property.startsWith('radius')
        ? 'shape'
        : 'colour';

// Tailwind emits a size token's line height and weight only through its utility, so type
// previews use the utilities themselves.
const typeClasses: Record<string, string> = {
  'text-page-title': 'text-page-title',
  'text-metric': 'text-metric tabular-nums',
  'text-body': 'text-body',
  'text-ui': 'text-ui',
  'text-caption': 'text-caption',
  'font-sans': 'font-sans text-body',
  'font-heading': 'font-heading text-body',
  'font-mono': 'font-mono text-body',
};

function Preview({ group, property }: { group: TokenGroup; property: string }): ReactNode {
  const variable = `var(--${property})`;
  if (group === 'colour') {
    return (
      <span
        aria-hidden
        data-preview={property}
        className="inline-block size-6 border border-control align-middle"
        style={{ background: variable }}
      />
    );
  }
  if (group === 'type') {
    return (
      <span data-preview={property} className={typeClasses[property]}>
        {property === 'text-metric' ? '0.83' : 'Benchmark run passed'}
      </span>
    );
  }
  if (group === 'shape') {
    return (
      <span
        aria-hidden
        data-preview={property}
        className="inline-block size-8 border border-control bg-muted align-middle"
        style={{ borderRadius: variable }}
      />
    );
  }
  // The content width (72rem) is wider than the table; it is described, not drawn.
  if (property.startsWith('container-')) return null;
  return (
    <span
      aria-hidden
      data-preview={property}
      className="block h-2 bg-primary"
      style={{ width: variable }}
    />
  );
}

const inGroup = (row: TokenRow, group: TokenGroup) =>
  row.layer !== 'raw' && row.properties.some((property) => groupOf(property) === group);

/** Semantic and component tokens of one group, with live previews. */
export function TokenTable({ group }: { group: TokenGroup }) {
  const rows = tokenRows.filter((row) => inGroup(row, group));
  return (
    <Table aria-label={`${group} tokens`}>
      <TableHeader>
        <TableRow>
          <TableHead>Token</TableHead>
          <TableHead>Preview</TableHead>
          <TableHead>Value (light / dark)</TableHead>
          <TableHead>Use for</TableHead>
          <TableHead>Do not use for</TableHead>
          <TableHead>Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name}>
            <TableCell className="font-mono whitespace-normal">{row.name}</TableCell>
            <TableCell className="whitespace-normal">
              <span className="flex flex-wrap items-center gap-inline">
                {row.properties
                  .filter((property) => groupOf(property) === group)
                  .map((property) => (
                    <Preview key={property} group={group} property={property} />
                  ))}
              </span>
            </TableCell>
            <TableCell className="whitespace-normal">{row.value}</TableCell>
            <TableCell className="whitespace-normal">{row.useFor}</TableCell>
            <TableCell className="whitespace-normal">{row.doNotUseFor}</TableCell>
            <TableCell className="whitespace-normal">{row.provenance}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
