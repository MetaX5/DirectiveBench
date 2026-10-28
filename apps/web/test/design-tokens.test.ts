import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
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

// MDX documentation pages (SPEC-122 FR-122-4) are checked on the classes they render: the
// values of their className attributes. Their prose and code examples name forbidden classes
// on purpose. Returns [line, text] pairs; other files are checked line by line.
function checkedText(file: string, source: string): Array<[line: number, text: string]> {
  if (!file.endsWith('.mdx')) return source.split('\n').map((text, index) => [index + 1, text]);
  return [...source.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)].map((match) => [
    source.slice(0, match.index).split('\n').length,
    match[1] ?? match[2] ?? match[3]!,
  ]);
}

const forbidden: Array<[rule: string, pattern: RegExp]> = [
  ['raw palette token outside globals.css (D2)', /palette-/],
  ['arbitrary font size; use a text-* token (D2, D8)', /\btext-\[\d/],
  ['raw text-xs or text-sm; use text-ui or text-body (FR-121-1)', /\btext-(?:xs|sm)\b/],
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
        checkedText(file, readFileSync(file, 'utf8')).flatMap(([line, text]) =>
          pattern.test(text) ? [`${relative(root, file)}:${line}`] : [],
        ),
      );
      expect(hits).toEqual([]);
    });
  }
});

// Arbitrary Tailwind values (FR-121-5). Only class-like words inside string and template
// literals are read, found with the TypeScript parser so that literals spanning lines and
// apostrophes in JSX text cannot hide a class, and JS indexing such as versions[0] never matches.
// The variant prefix (has-data-[…]:, [.border-b]:, …) is a selector and is stripped; what remains
// is reported when it is an arbitrary value (p-[13px]), CSS-variable shorthand (px-(--x)) or
// arbitrary property ([--x:…]). The file name selects TS or TSX parsing. Returns [line, word].
function arbitraryValues(
  source: string,
  fileName = 'source.tsx',
): Array<[line: number, word: string]> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const words: Array<[line: number, word: string]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      const start = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      for (const match of node.text.matchAll(/\S+/g)) {
        const line = start + (node.text.slice(0, match.index).match(/\n/g)?.length ?? 0);
        words.push([line, match[0]]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return words.filter(([, word]) => {
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

describe('MDX pages', () => {
  it('are checked on their className values only', () => {
    const page = [
      'Never use `text-sm` or a `rounded` corner.',
      '<div className="flex gap-inline">',
      "  <p className='text-sm'>x</p>",
      '  <p className={`p-[13px]`}>y</p>',
    ].join('\n');
    expect(checkedText('page.mdx', page)).toEqual([
      [2, 'flex gap-inline'],
      [3, 'text-sm'],
      [4, 'p-[13px]'],
    ]);
  });

  it('keep every line of other files', () => {
    expect(checkedText('page.tsx', 'a\nb')).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });
});

// Documentation text follows the UI copy rule: no en or em dash (SPEC-122 FR-122-7, AGENTS.md
// §7). Storybook files are the stories/ and .storybook/ roots and colocated *.stories.tsx files.
describe('Storybook documentation copy', () => {
  it('contains no en or em dash', () => {
    const storybook = files.filter((file) => {
      const path = relative(root, file);
      return /^(?:stories|\.storybook)\//.test(path) || /\.stories\.tsx?$/.test(path);
    });
    expect(storybook.length).toBeGreaterThan(0);
    const hits = storybook.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          /[\u2013\u2014]/.test(line) ? [`${relative(root, file)}:${index + 1}`] : [],
        ),
    );
    expect(hits).toEqual([]);
  });
});

describe('arbitrary Tailwind values', () => {
  it.each([
    ['className="p-[13px]"', ['p-[13px]']],
    ["cn('md:hover:bg-[#fff]')", ['md:hover:bg-[#fff]']],
    ['`px-(--gutter)`', ['px-(--gutter)']],
    ["'[mask-type:luminance]'", ['[mask-type:luminance]']],
    ["'has-data-[slot=x]:-mt-[2px]'", ['has-data-[slot=x]:-mt-[2px]']],
    ['const x = <div className="flex\n  p-[13px]" />;', ['p-[13px]']],
    ['const x = `gap-inline\n  mt-[7px]`;', ['mt-[7px]']],
    ['const x = `gap-inline ${y} mt-[7px]`;', ['mt-[7px]']],
    ['const x = <p>Don\'t <b className="m-[3px]">it\'s</b></p>;', ['m-[3px]']],
  ])('finds the arbitrary value in %j', (source, expected) => {
    expect(arbitraryValues(source).map(([, word]) => word)).toEqual(expected);
  });

  it('reports the line of a word inside a literal that spans lines', () => {
    expect(arbitraryValues('const a = 1;\nconst x = `flex\n  p-[13px]`;')).toEqual([
      [3, 'p-[13px]'],
    ]);
  });

  it.each([
    'const latest = versions[0];',
    "const variant = props['variant'];",
    "className='has-data-[slot=x]:gap-inline [&_svg]:size-4 aria-[invalid]:border-destructive'",
    "import page from './results/[id]/page';",
    "'See [docs] for details'",
    '<p>Use [brackets] in text</p>;',
    "// a comment with 'p-[13px]'",
  ])('ignores %s', (source) => {
    expect(arbitraryValues(source)).toEqual([]);
  });

  it('appear only as documented exceptions (FR-121-5)', () => {
    const hits = files.flatMap((file) => {
      const path = relative(root, file);
      const source = readFileSync(file, 'utf8');
      const words = file.endsWith('.mdx')
        ? checkedText(file, source).flatMap(([line, text]) =>
            arbitraryValues(JSON.stringify(text)).map(([, word]): [number, string] => [line, word]),
          )
        : arbitraryValues(source, file);
      return words
        .filter(
          ([, word]) =>
            !arbitraryAllowlist.some(
              ([allowed, pattern]) => allowed === path && pattern.test(word),
            ),
        )
        .map(([line, word]) => `${path}:${line} ${word}`);
    });
    expect(hits).toEqual([]);
  });

  it('keeps no stale allowlist entry', () => {
    for (const [file, pattern] of arbitraryAllowlist) {
      const words = arbitraryValues(readFileSync(join(root, file), 'utf8'), file);
      expect(
        words.some(([, word]) => pattern.test(word)),
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
