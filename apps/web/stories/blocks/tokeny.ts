import source from '../../tokeny.md?raw';

// Documentation blocks read tokeny.md itself, so a page can never disagree with the approved
// token table or the contrast table (SPEC-122 FR-122-3).
const lines = source.split('\n');

function table(header: string): string[][] {
  const start = lines.findIndex((line) => line.startsWith(header));
  if (start < 0) throw new Error(`tokeny.md has no table starting with "${header}"`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

const plain = (cell: string) => cell.replaceAll('**', '').replaceAll('`', '');

// `--chart-{1,2}` expands to `--chart-1`, `--chart-2`, as in test/design-tokens.test.ts.
function expand(name: string): string[] {
  const group = /\{([^}]+)\}/.exec(name);
  if (!group) return [name];
  return group[1]!.split(',').flatMap((part) => expand(name.replace(group[0], part)));
}

export type TokenRow = {
  name: string;
  properties: string[];
  layer: string;
  value: string;
  provenance: string;
  useFor: string;
  doNotUseFor: string;
};

export const tokenRows: TokenRow[] = table('| Token | CSS property |').map(
  ([name, property, layer, value, provenance, useFor, doNotUseFor]) => ({
    name: plain(name!),
    properties: [...property!.matchAll(/`--([\w{},-]+)`/g)].flatMap((match) => expand(match[1]!)),
    layer: layer!,
    value: plain(value!),
    provenance: plain(provenance!),
    useFor: plain(useFor!),
    doNotUseFor: plain(doNotUseFor!),
  }),
);

export type ContrastRow = {
  id: string;
  pair: string;
  use: string;
  light: number;
  dark: number;
};

// "T10" to "T11" (joined by an en dash) is two pairs; "U05" lists two surfaces in one row. A
// cell keeps the value after "→" (the value in force) and splits "a / b" across the ids of the
// row, or across surfaces.
function values(cell: string): number[] {
  const current = cell.split('→').at(-1)!;
  return current.split('/').map((part) => Number.parseFloat(part.replace('✗', '')));
}

function ids(cell: string): string[] {
  const [first, last] = cell.split('\u2013');
  if (!last) return [first!];
  const prefix = first!.charAt(0);
  const from = Number(first!.slice(1));
  const to = Number(last.slice(1));
  return Array.from(
    { length: to - from + 1 },
    (_, i) => `${prefix}${String(from + i).padStart(2, '0')}`,
  );
}

export const contrastRows: ContrastRow[] = table('| ID | Pair').flatMap(
  ([id, pair, use, light, dark]) => {
    const names = ids(id!);
    const lightValues = values(light!);
    const darkValues = values(dark!);
    const count = Math.max(names.length, lightValues.length, darkValues.length);
    return Array.from({ length: count }, (_, i) => ({
      id: names.length === count ? names[i]! : `${names[0]}.${i + 1}`,
      pair: plain(pair!),
      use: use!,
      light: lightValues[lightValues.length === 1 ? 0 : i]!,
      dark: darkValues[darkValues.length === 1 ? 0 : i]!,
    }));
  },
);
