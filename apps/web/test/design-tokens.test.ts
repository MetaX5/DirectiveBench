import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static checks for the token rules in tokeny.md (SPEC-120): raw values stay in globals.css and
// app code uses only semantic and component tokens.
const root = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'))
    .map((file) => join(root, dir, file));
}

const files = [...sources('app'), ...sources('components')];

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
  ['translucent focus ring; focus uses solid ring (D4)', /\bring-(?:sidebar-)?ring\/\d/],
  [
    'rounded corner; surfaces are square (D7)',
    /\brounded(?:-(?:xs|sm|md|lg|xl|[234]xl|full))?(?![-\w])/,
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
