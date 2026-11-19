import { join } from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// The UI copy rule (AGENTS.md §7, SPEC-116 FR-116-24, issue 123): app-authored copy never
// contains an en dash (U+2013) or an em dash (U+2014). ESLint's `no-restricted-syntax` enforces
// it; this test lints inline sources with the repository's real eslint.config.mjs, so a config
// change that drops the selectors (or the design-system ones next to them) fails here.
const repoRoot = join(import.meta.dirname, '..', '..', '..');
const COPY_MESSAGE_START = 'App-authored copy must not contain an en or em dash';
const DESIGN_SYSTEM_MESSAGE_START = 'Use the design-system component';

// ESLint loads the config (typescript-eslint, Next.js and React hooks plugins) on the first lint,
// which takes about a second alone and over 8 s on the loaded 2-core CI runner while every
// package's suite runs in parallel (#149). The warm-up lint in beforeAll takes that cost; every
// test gets the same budget because each lint still parses TypeScript on that runner.
const LINT_TIMEOUT_MS = 30_000;

let eslint: ESLint;
beforeAll(async () => {
  eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: join(repoRoot, 'eslint.config.mjs') });
  await eslint.lintText('export {};', { filePath: join(repoRoot, 'apps/web/lib/warm-up.ts') });
}, LINT_TIMEOUT_MS);

async function restrictedSyntaxMessages(file: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: join(repoRoot, file) });
  return result!.messages
    .filter((message) => message.ruleId === 'no-restricted-syntax' || message.fatal)
    .map((message) => message.message);
}

async function copyViolations(file: string, source: string): Promise<number> {
  const messages = await restrictedSyntaxMessages(file, source);
  return messages.filter((message) => message.startsWith(COPY_MESSAGE_START)).length;
}

// Every root the rule covers (decision D6): the web app's pages, components, the component
// library, helpers and Storybook, the CLI and the packages' sources.
const inScope = [
  'apps/web/app/example/page.tsx',
  'apps/web/components/example.tsx',
  'apps/web/components/ui/example.tsx',
  'apps/web/lib/example.ts',
  'apps/web/stories/example.stories.tsx',
  'apps/web/.storybook/example.ts',
  'apps/cli/src/example.ts',
  'packages/core/src/example.ts',
  'packages/database/src/example.ts',
  'packages/agent-adapters/src/example.ts',
  'packages/benchmark-engine/src/example.ts',
  'packages/runner/src/example.ts',
];

// The dashes are written as escapes here so this test file reads the same in any editor; the
// sources below hold the real characters unless a case is about an escape form.
const EN = '\u2013';
const EM = '\u2014';

describe('UI copy lint rule', { timeout: LINT_TIMEOUT_MS }, () => {
  it.each([
    ['an em dash in a string literal', `export const a = 'A ${EM} B';`],
    ['an en dash in a string literal', `export const a = 'pages 1${EN}2';`],
    ['a \\u2014 escape in a string literal', "export const a = 'A \\u2014 B';"],
    ['a \\u{2013} escape in a string literal', "export const a = 'A \\u{2013} B';"],
    ['an em dash in a template literal', `export const a = (b: string) => \`A ${EM} \${b}\`;`],
    ['a \\u2013 escape in a template literal', 'export const a = `1\\u20132`;'],
    ['an em dash in JSX text', `export const A = () => <p>A ${EM} B</p>;`],
    ['an en dash in a JSX attribute', `export const A = () => <p title="1${EN}2">x</p>;`],
    ['&mdash; in JSX text', 'export const A = () => <p>A &mdash; B</p>;'],
    ['&ndash; in JSX text', 'export const A = () => <p>1&ndash;2</p>;'],
    ['&#8211; in JSX text', 'export const A = () => <p>1&#8211;2</p>;'],
    ['&#x2014; in JSX text', 'export const A = () => <p>A &#x2014; B</p>;'],
    ['&mdash; in a JSX attribute', 'export const A = () => <p title="A &mdash; B">x</p>;'],
  ])('reports %s', async (_name, source) => {
    expect(await copyViolations('apps/web/app/example/page.tsx', source)).toBe(1);
  });

  it.each(inScope)('checks %s', async (file) => {
    expect(await copyViolations(file, `export const a = 'A ${EM} B';`)).toBe(1);
  });

  it.each([
    ['a colon', "export const a = 'RED: without the artifact';"],
    ['a hyphen', "export const a = 'pages 1-2, -50 pts';"],
    ['parentheses', "export const a = 'CLI default (unpinned)';"],
    ['a full stop', "export const a = 'Run in progress. Results appear later.';"],
    ['missing-value words', "export const a = ['n/a', 'None', 'Not run'];"],
    ['JSX copy with a colon', 'export const A = () => <p title="Planned: x">Real agent: y</p>;'],
    ['a comment with dashes', `// A ${EM} comment ${EN} here\n/* and ${EM} */ export const a = 1;`],
    ['a regular expression that looks for dashes', `export const a = /[${EN}${EM}]/;`],
  ])('accepts %s', async (_name, source) => {
    expect(await restrictedSyntaxMessages('apps/web/app/example/page.tsx', source)).toEqual([]);
  });

  it.each([
    'apps/web/e2e/example.spec.ts',
    'apps/web/test/example.test.ts',
    'apps/cli/test/example.test.ts',
    'packages/core/test/example.test.ts',
    'packages/benchmark-engine/test/example.test.ts',
  ])('does not check test or fixture code in %s', async (file) => {
    // Tests and fixtures hold imported and agent content with dashes on purpose.
    expect(
      await copyViolations(file, `export const a = 'Imported ${EM} content ${EN} here';`),
    ).toBe(0);
  });

  it('keeps the design-system selectors in pages next to the copy selectors', async () => {
    // Flat config replaces a rule's options in a later block for the same file, so a second
    // `no-restricted-syntax` block would silently drop one of the two sets.
    const messages = await restrictedSyntaxMessages(
      'apps/web/app/example/page.tsx',
      `export const A = () => <button title="A ${EM} B">x</button>;`,
    );
    expect(messages.filter((m) => m.startsWith(DESIGN_SYSTEM_MESSAGE_START))).toHaveLength(1);
    expect(messages.filter((m) => m.startsWith(COPY_MESSAGE_START))).toHaveLength(1);
  });
});
