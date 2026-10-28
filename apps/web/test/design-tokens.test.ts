import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cn } from '../lib/utils';

// Static checks for the token rules in tokeny.md (SPEC-120, SPEC-121): raw values stay in
// globals.css and app code uses only semantic and component tokens. The checked files come
// from design-system-scope.json, which the ESLint design-system rule reads too.
const root = join(import.meta.dirname, '..');
const scope = JSON.parse(readFileSync(join(root, 'design-system-scope.json'), 'utf8')) as {
  roots: string[];
  extensions: string[];
};

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => scope.extensions.some((extension) => file.endsWith(extension)))
    .map((file) => join(root, dir, file));
}

const files = scope.roots.flatMap(sources);

const forbidden: Array<[rule: string, pattern: RegExp]> = [
  ['raw palette token outside globals.css (D2)', /palette-/],
  ['arbitrary font size; use a text-* token (D2, D8)', /\btext-\[\d/],
  [
    'Tailwind palette colour; use a semantic token (D2)',
    /\b(?:bg|text|border|ring|outline|fill|stroke|from|to|divide|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)\b/,
  ],
  ['hex colour; use a semantic token (D2)', /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![-\w])/],
  [
    'status fill used as text or icon colour; use *-foreground (D5)',
    /\btext-(?:success|warning|info|destructive)(?![-\w])/,
  ],
  [
    'translucent focus ring or border; focus uses solid ring (D4)',
    /\bring-(?:sidebar-)?ring\/\d|focus-visible:(?:ring|border)-[\w-]+\/\d/,
  ],
  [
    'rounded corner; surfaces are square (D7)',
    /\brounded(?:-[\w[\].]+)*(?<!-none|-surface)(?![-\w[\].])/,
  ],
];

describe('design token usage in app and components', () => {
  for (const [rule, pattern] of forbidden) {
    it(rule, () => {
      const hits = files.flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, index) =>
            pattern.test(line) ? [`${relative(root, file)}:${index + 1}`] : [],
          ),
      );
      expect(hits).toEqual([]);
    });
  }
});

// Arbitrary Tailwind values (FR-121-5). Only class-like words inside string literals are read,
// so JS indexing such as versions[0] never matches. The variant prefix (has-data-[…]:,
// [.border-b]:, …) is a selector and is stripped; what remains is reported when it is an
// arbitrary value (p-[13px]), CSS-variable shorthand (px-(--x)) or arbitrary property ([--x:…]).
function arbitraryValues(line: string): string[] {
  const words = [...line.matchAll(/(['"`])((?:(?!\1).)*)\1/g)].flatMap((literal) =>
    literal[2]!.split(/\s+/),
  );
  return words.filter((word) => {
    let depth = 0;
    let variantEnd = 0;
    for (const [index, char] of [...word].entries()) {
      if (char === '[' || char === '(') depth += 1;
      else if (char === ']' || char === ')') depth -= 1;
      else if (char === ':' && depth === 0) variantEnd = index + 1;
    }
    const utility = word.slice(variantEnd).replace(/^!|!$/g, '');
    return /^-?[a-z][\w-]*-[[(]/.test(utility) || /^\[[\w-]+:/.test(utility);
  });
}

// Documented exceptions: [file, arbitrary class, reason]. Add one only when no token fits.
const arbitraryAllowlist: Array<[file: string, pattern: RegExp, reason: string]> = [
  [
    'components/ui/native-select.tsx',
    /^(?:bg-\[Canvas\]|text-\[CanvasText\])$/,
    'options use the system Canvas colours (tokeny.md decision 12)',
  ],
  [
    'components/ui/card.tsx',
    /^(?:data-\[size=sm\]:)?\[--card-spacing:--spacing\(\d\)\]$|-\(--card-spacing\)$/,
    'card-spacing component token defined inline by the shadcn generator (tokeny.md)',
  ],
  [
    'components/ui/card.tsx',
    /:grid-(?:cols|rows)-\[[\w_]+\]$/,
    'grid track template for the card header; no token describes track lists',
  ],
  [
    'app/results/[id]/page.tsx',
    /^grid-cols-\[auto_1fr\]$/,
    'label and value grid track template; no token describes track lists',
  ],
  ['components/ui/primitives.tsx', /^max-h-\[28rem\]$/, 'scroll limit of Pre'],
  [
    'components/artifacts/content-tab.tsx',
    /^max-h-\[40rem\]$/,
    'scroll limit of the artifact content view',
  ],
];

describe('arbitrary Tailwind values', () => {
  it.each([
    ['className="p-[13px]"', ['p-[13px]']],
    ["cn('md:hover:bg-[#fff]')", ['md:hover:bg-[#fff]']],
    ['`px-(--gutter)`', ['px-(--gutter)']],
    ["'[mask-type:luminance]'", ['[mask-type:luminance]']],
    ["'has-data-[slot=x]:-mt-[2px]'", ['has-data-[slot=x]:-mt-[2px]']],
  ])('finds the arbitrary value in %s', (line, expected) => {
    expect(arbitraryValues(line)).toEqual(expected);
  });

  it.each([
    'const latest = versions[0];',
    "const variant = props['variant'];",
    "className='has-data-[slot=x]:gap-inline [&_svg]:size-4 aria-[invalid]:border-destructive'",
    "import page from './results/[id]/page';",
    "'See [docs] for details'",
  ])('ignores %s', (line) => {
    expect(arbitraryValues(line)).toEqual([]);
  });

  it('appear only as documented exceptions (FR-121-5)', () => {
    const hits = files.flatMap((file) => {
      const path = relative(root, file);
      return readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          arbitraryValues(line)
            .filter(
              (word) =>
                !arbitraryAllowlist.some(
                  ([allowed, pattern]) => allowed === path && pattern.test(word),
                ),
            )
            .map((word) => `${path}:${index + 1} ${word}`),
        );
    });
    expect(hits).toEqual([]);
  });

  it('keeps no stale allowlist entry', () => {
    for (const [file, pattern] of arbitraryAllowlist) {
      const words = readFileSync(join(root, file), 'utf8').split('\n').flatMap(arbitraryValues);
      expect(
        words.some((word) => pattern.test(word)),
        `${file} ${pattern}`,
      ).toBe(true);
    }
  });
});

describe('form controls', () => {
  it('draw their boundary with border-control (D3)', () => {
    for (const control of ['input.tsx', 'native-select.tsx']) {
      const source = readFileSync(join(root, 'components', 'ui', control), 'utf8');
      expect(source, control).toMatch(/\bborder-control\b/);
      expect(source, control).not.toMatch(/\bborder-input\b/);
    }
  });
});

describe('globals.css token layers', () => {
  const css = readFileSync(join(root, 'app', 'globals.css'), 'utf8');

  it('keeps every literal colour in the raw palette layer', () => {
    const literals = css
      .split('\n')
      .filter((line) => /oklch\(/.test(line) && !/^\s*--palette-[\w-]+:/.test(line));
    expect(literals).toEqual([]);
  });

  it('defines the semantic tokens added by SPEC-120 in both themes', () => {
    const [light, dark] = css.split(/^\.dark \{/m);
    for (const block of [light, dark]) {
      expect(block).toMatch(/--border-control: var\(--palette-neutral-500\);/);
    }
    expect(light).toMatch(/--ring: var\(--palette-neutral-700\);/);
    expect(dark).toMatch(/--ring: var\(--palette-neutral-400\);/);
    expect(dark).toMatch(/--success-foreground: var\(--palette-green-72\);/);
  });
});

describe('tokeny.md', () => {
  // Every token custom property in globals.css is documented in the "CSS property" column of
  // the tokeny.md token table, and the reverse (FR-121-6). Out of scope: the --color-* bridge
  // aliases, --*--line-height style sub-properties and --page-inline, the source of
  // --spacing-page-inline.
  const css = readFileSync(join(root, 'app', 'globals.css'), 'utf8');
  const defined = new Set(
    [...css.matchAll(/^\s*--([\w-]+):/gm)]
      .map((match) => match[1]!)
      .filter((name) => !name.startsWith('color-') && !name.includes('--'))
      .filter((name) => name !== 'page-inline'),
  );

  const expand = (name: string): string[] => {
    const group = /\{([^}]+)\}/.exec(name);
    if (!group) return [name];
    return group[1]!.split(',').flatMap((part) => expand(name.replace(group[0], part)));
  };
  const lines = readFileSync(join(root, 'tokeny.md'), 'utf8').split('\n');
  const header = lines.findIndex((line) => line.startsWith('| Token | CSS property |'));
  const end = lines.findIndex((line, index) => index > header && !line.startsWith('|'));
  const rows = lines.slice(header + 2, end);
  const documented = new Set(
    rows.flatMap((row) =>
      [...row.split('|')[2]!.matchAll(/`--([\w{},-]+)`/g)].flatMap((match) => expand(match[1]!)),
    ),
  );

  it('documents every token defined in globals.css', () => {
    expect([...defined].filter((name) => !documented.has(name))).toEqual([]);
  });

  it('documents no token that globals.css does not define', () => {
    expect([...documented].filter((name) => !defined.has(name))).toEqual([]);
  });
});

describe('cn merge config', () => {
  // Every custom size, spacing, radius and width token in @theme must be registered with
  // tailwind-merge (lib/utils.ts), or cn() drops or fails to merge it.
  const theme = readFileSync(join(root, 'app', 'globals.css'), 'utf8');
  const tokens = (namespace: string) =>
    [...theme.matchAll(new RegExp(`^\\s*--${namespace}-([a-z][\\w-]*?):`, 'gm'))]
      .map((match) => match[1]!)
      .filter((name) => !name.includes('--'));

  it.each(tokens('text'))('merges text-%s as a font size', (name) => {
    expect(cn('text-xs', `text-${name}`)).toBe(`text-${name}`);
    expect(cn(`text-${name}`, 'text-muted-foreground')).toBe(`text-${name} text-muted-foreground`);
  });

  it.each(tokens('spacing'))('merges %s as a spacing value', (name) => {
    expect(cn('p-1', `p-${name}`)).toBe(`p-${name}`);
  });

  it.each(tokens('radius'))('merges rounded-%s as a radius', (name) => {
    expect(cn('rounded-none', `rounded-${name}`)).toBe(`rounded-${name}`);
  });

  it.each(tokens('container'))('merges max-w-%s as a width', (name) => {
    expect(cn('max-w-6xl', `max-w-${name}`)).toBe(`max-w-${name}`);
  });
});
