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
