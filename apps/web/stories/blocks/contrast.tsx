import { useMemo, useSyncExternalStore } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { currentTheme, onThemeChange, type Theme } from '../../.storybook/theme';
import { contrastRows } from './tokeny';

// Measures every colour pair of the tokeny.md contrast table on the stored token values, in the
// theme on screen (SPEC-122 stage 1, AGENTS.md §7). Colours are resolved by the browser and
// composited on a canvas, as e2e/ui-contrast.spec.ts does, so translucent tokens are measured
// on the real surface below them.

type Layer = string | [token: string, alpha: number];
type Surface = Layer[] | Record<Theme, Layer[]>;
type Pair = { foreground: Layer; surface: Surface; threshold: 3 | 4.5; exception?: string };

// The surface a pair sits on, bottom layer first. Values follow the component classes:
// outline and field backgrounds are transparent in light and input/30 in dark, ghost hover is
// muted in light and muted/50 in dark, and the destructive fill is /10 at rest and /20 on hover
// in light, /20 and /30 in dark (components/ui/button.tsx, input.tsx).
const text = (foreground: Layer, surface: Surface): Pair => ({
  foreground,
  surface,
  threshold: 4.5,
});
const ui = (foreground: Layer, surface: Surface): Pair => ({ foreground, surface, threshold: 3 });
const outline = { light: ['card'], dark: ['card', ['input', 0.3]] } satisfies Surface;
const outlineHover = { light: ['card', 'muted'], dark: ['card', ['input', 0.5]] } satisfies Surface;
const ghostHover = { light: ['card', 'muted'], dark: ['card', ['muted', 0.5]] } satisfies Surface;

const pairs: Record<string, Pair> = {
  T01: text('foreground', ['background']),
  T02: text('card-foreground', ['card']),
  T03: text('muted-foreground', ['background']),
  T04: text('muted-foreground', ['card']),
  T05: text('muted-foreground', ['card', 'muted']),
  T06: text('muted-foreground', ['sidebar']),
  T07: text('sidebar-accent-foreground', ['sidebar', 'sidebar-accent']),
  T08: text('muted-foreground', ['sidebar', 'sidebar-accent']),
  T09: text('primary-foreground', ['card', 'primary']),
  T10: text('primary-foreground', ['card', ['primary', 0.8]]),
  T11: text('primary-foreground', ['background', ['primary', 0.8]]),
  T12: text('secondary-foreground', ['card', 'secondary']),
  T13: text('secondary-foreground', ['card', 'button-secondary-hover']),
  T14: text('foreground', outline),
  T15: text('foreground', outlineHover),
  T16: text('foreground', ghostHover),
  T17: text('muted-foreground', ghostHover),
  T18: text('primary-text', ['background']),
  T19: text('primary-text', ['card']),
  T20: text('destructive-foreground', ['background']),
  T21: text('destructive-foreground', ['card']),
  T22: text('destructive-foreground', {
    light: ['card', ['destructive', 0.1]],
    dark: ['card', ['destructive', 0.2]],
  }),
  T23: text('destructive-foreground', {
    light: ['card', ['destructive', 0.2]],
    dark: ['card', ['destructive', 0.3]],
  }),
  T24: text('success-foreground', ['card', ['success', 0.1]]),
  T25: text('warning-foreground', ['card', ['warning', 0.1]]),
  T26: text('warning-foreground', ['card']),
  T27: text('info-foreground', ['card', ['info', 0.1]]),
  T28: text('success-foreground', ['background']),
  T29: text('foreground', ['card', ['muted', 0.4]]),
  T30: text('foreground', ['card', ['muted', 0.5]]),
  T31: text('foreground', ['card', 'muted']),
  T32: text('foreground', outline),
  T33: text('muted-foreground', outline),
  T34: text('primary-foreground', ['card', 'primary']),
  U01: ui('border-control', ['card']),
  U02: ui('border-control', ['background']),
  U03: ui('ring', ['card']),
  U04: ui('ring', ['card']),
  'U05.1': ui('sidebar-ring', ['sidebar']),
  'U05.2': ui('sidebar-ring', ['sidebar', 'sidebar-accent']),
  U06: ui('destructive', ['card']),
  U07: ui('warning-foreground', ['card']),
  U08: ui('muted-foreground', ['card']),
  U09: ui('scorebar-green-phase', ['card', 'scorebar-track']),
  U10: ui('scorebar-red-phase', ['card', 'scorebar-track']),
  U11: {
    ...ui('muted', ['card']),
    exception: 'ScoreBar is aria-hidden and prints its value as text',
  },
  U12: { ...ui('border', ['background']), exception: 'decorative separator' },
  U13: { ...ui('primary', ['background']), exception: 'the button is identified by its label' },
};

// S01 to S10: each syntax colour (SPEC-123 D20) on the code surface of FileView and under the
// removed, added and neutral row tints of SideBySideDiff (components/output-files/code-lines.tsx).
const codeSurface: Layer[] = ['card', ['muted', 0.4]];
const syntaxSurfaces: Layer[][] = [
  codeSurface,
  [...codeSurface, ['destructive', 0.1]],
  [...codeSurface, ['success', 0.1]],
  [...codeSurface, ['info', 0.1]],
];
const syntaxColours = [
  'syntax-foreground',
  'syntax-token-comment',
  'syntax-token-keyword',
  'syntax-token-string',
  'syntax-token-string-expression',
  'syntax-token-constant',
  'syntax-token-function',
  'syntax-token-parameter',
  'syntax-token-punctuation',
  'syntax-token-link',
];
syntaxColours.forEach((colour, index) => {
  syntaxSurfaces.forEach((surface, row) => {
    pairs[`S${String(index + 1).padStart(2, '0')}.${row + 1}`] = text(colour, surface);
  });
});

const css = (layer: Layer) =>
  typeof layer === 'string'
    ? `var(--${layer})`
    : `color-mix(in oklab, var(--${layer[0]}) ${layer[1] * 100}%, transparent)`;

function luminance([r, g, b]: number[]): number {
  return [r!, g!, b!].reduce((sum, value, i) => {
    const c = value / 255;
    const linear = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][i]!;
  }, 0);
}

function measure(pair: Pair, theme: Theme): number {
  const probe = document.createElement('span');
  document.body.append(probe);
  const resolve = (layer: Layer) => {
    probe.style.color = css(layer);
    return getComputedStyle(probe).color;
  };
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const paint = (layers: Layer[]) => {
    for (const layer of layers) {
      context.fillStyle = resolve(layer);
      context.fillRect(0, 0, 1, 1);
    }
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const surface = Array.isArray(pair.surface) ? pair.surface : pair.surface[theme];
  context.fillStyle = 'white';
  context.fillRect(0, 0, 1, 1);
  const background = paint(surface);
  const foreground = paint([pair.foreground]);
  probe.remove();
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

type Result = { id: string; measured: number; documented: number; outcome: Outcome };
type Outcome = 'pass' | 'fail' | 'exception';

const outcomes: Record<Outcome, { label: string; variant: 'success' | 'destructive' | 'muted' }> = {
  pass: { label: 'Pass', variant: 'success' },
  fail: { label: 'Below threshold', variant: 'destructive' },
  exception: { label: 'Accepted exception', variant: 'muted' },
};

/** Live contrast table: every tokeny.md pair, measured in the theme on screen. */
export function ContrastTable() {
  const theme = useSyncExternalStore(onThemeChange, currentTheme);
  // Measured while rendering: the theme class is already on <html> when the theme changes.
  const measured = useMemo(
    () =>
      contrastRows.map((row): Result => {
        const pair = pairs[row.id];
        if (!pair) throw new Error(`No surface defined for contrast pair ${row.id}`);
        const ratio = measure(pair, theme);
        const outcome = pair.exception ? 'exception' : ratio >= pair.threshold ? 'pass' : 'fail';
        return { id: row.id, measured: ratio, documented: row[theme], outcome };
      }),
    [theme],
  );

  return (
    <Table aria-label={`Measured contrast, ${theme} theme`} data-measured={theme}>
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Pair (text or element / background)</TableHead>
          <TableHead>Use</TableHead>
          <TableHead className="text-right">Threshold</TableHead>
          <TableHead className="text-right">tokeny.md</TableHead>
          <TableHead className="text-right">Measured</TableHead>
          <TableHead>Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {contrastRows.map((row, index) => {
          const pair = pairs[row.id]!;
          const result = measured[index]!;
          return (
            <TableRow key={row.id} data-id={row.id} data-outcome={result.outcome}>
              <TableCell className="font-mono">{row.id}</TableCell>
              <TableCell className="whitespace-normal">{row.pair}</TableCell>
              <TableCell className="whitespace-normal">
                {pair.exception ? `${row.use} (${pair.exception})` : row.use}
              </TableCell>
              <TableCell className="text-right tabular-nums">{pair.threshold}:1</TableCell>
              <TableCell className="text-right tabular-nums">{row[theme].toFixed(2)}</TableCell>
              <TableCell className="text-right tabular-nums" data-measured-ratio>
                {result.measured.toFixed(2)}
              </TableCell>
              <TableCell>
                <Badge variant={outcomes[result.outcome].variant}>
                  {outcomes[result.outcome].label}
                </Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
