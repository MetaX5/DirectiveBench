import type { ReactNode } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// State matrices for the Primitives pages (SPEC-122 stage 2). Hover, focus and pressed are
// frozen with data-preview-state, which only the Storybook CSS (.storybook/states.css) reads.

export type PreviewState =
  'rest' | 'hover' | 'focus' | 'pressed' | 'disabled' | 'invalid' | 'expanded' | 'selected';

/** Props that put a component into a state for a frozen preview. */
export function stateProps(state: PreviewState): Record<string, string | boolean> {
  switch (state) {
    case 'hover':
    case 'focus':
    case 'pressed':
      return { 'data-preview-state': state };
    case 'disabled':
      return { disabled: true };
    case 'invalid':
      return { 'aria-invalid': true };
    case 'expanded':
      return { 'aria-expanded': true };
    case 'selected':
      return { 'data-state': 'selected' };
    case 'rest':
      return {};
  }
}

const stateLabels: Record<PreviewState, string> = {
  rest: 'Rest',
  hover: 'Hover',
  focus: 'Focus (keyboard)',
  pressed: 'Pressed',
  disabled: 'Disabled',
  invalid: 'Invalid',
  expanded: 'Expanded',
  selected: 'Selected',
};

/** Rows are variants, columns are states; each cell renders the real component. */
export function StateMatrix<Variant extends string>({
  label,
  variants,
  states,
  render,
}: {
  label: string;
  variants: readonly Variant[];
  states: readonly PreviewState[];
  render: (variant: Variant, state: PreviewState) => ReactNode;
}) {
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead>Variant</TableHead>
          {states.map((state) => (
            <TableHead key={state}>{stateLabels[state]}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {variants.map((variant) => (
          <TableRow key={variant} className="hover:bg-transparent">
            <TableCell className="font-mono">{variant}</TableCell>
            {states.map((state) => (
              <TableCell key={state}>{render(variant, state)}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
