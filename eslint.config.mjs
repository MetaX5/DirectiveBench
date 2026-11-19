import { readFileSync } from 'node:fs';
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Package dependency direction (SPEC-003 §2.1, ADR-0003), enforced per package. Each file glob
// appears in exactly one boundary block because a later `no-restricted-imports` entry replaces
// an earlier one instead of merging with it.
const boundaryMessage = 'Breaks the package dependency direction (SPEC-003 §2.1).';
// Restricts `@directivebench/*` imports to `allowed`: package names (any subpath) or exact
// `package/subpath` specifiers. A regex is needed because gitignore-style `group` negations
// cannot re-include a subpath of an excluded package.
const onlyInternal = (allowed, message = boundaryMessage) => {
  const alternatives = allowed.map((name) => (name.includes('/') ? `${name}$` : `${name}(/|$)`));
  const exceptAllowed = alternatives.length > 0 ? `(?!(${alternatives.join('|')}))` : '';
  return { regex: `^@directivebench/${exceptAllowed}`, message };
};
const noUiFrameworks = {
  group: ['next', 'next/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
  message: 'Domain packages must not depend on Next.js or React (SPEC-003 §2).',
};
const packageBoundaries = [
  { files: ['packages/core/**/*.ts'], patterns: [onlyInternal([]), noUiFrameworks] },
  { files: ['packages/database/**/*.ts'], patterns: [onlyInternal(['core']), noUiFrameworks] },
  {
    files: ['packages/agent-adapters/**/*.ts'],
    patterns: [onlyInternal(['core']), noUiFrameworks],
  },
  {
    files: ['packages/benchmark-engine/**/*.ts'],
    patterns: [onlyInternal(['core', 'agent-adapters']), noUiFrameworks],
  },
  { files: ['packages/runner/**/*.ts'], patterns: [noUiFrameworks] },
].map(({ files, patterns }) => ({
  files,
  rules: { 'no-restricted-imports': ['error', { patterns }] },
}));

// The web process reads through repositories and enqueues jobs; it never executes benchmarks
// (SPEC-003 §2.1, SPEC-008 §2). Playwright tests in e2e/ seed the database directly.
const webBoundary = {
  files: ['apps/web/**/*.{ts,tsx}'],
  ignores: ['apps/web/e2e/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@directivebench/agent-adapters',
            allowImportNames: ['CLI_AGENTS', 'MockAgentAdapter', 'detectCliAgent'],
            allowTypeImports: true,
            message: 'The web app uses agent adapters for detection only.',
          },
          { name: 'node:child_process', message: 'The web app never executes processes.' },
          { name: 'child_process', message: 'The web app never executes processes.' },
          { name: 'node:sqlite', message: 'Use @directivebench/database repositories.' },
        ],
        patterns: [
          onlyInternal(
            [
              'core',
              'database',
              'agent-adapters',
              'benchmark-engine/definition',
              'benchmark-engine/load',
              'benchmark-engine/scoring',
            ],
            `${boundaryMessage} The web app never imports the runner or the engine orchestrator; use the benchmark-engine subpaths ./definition, ./load or ./scoring.`,
          ),
          {
            group: ['drizzle-orm', 'drizzle-orm/*'],
            message: 'Use @directivebench/database repositories; no ad-hoc SQL in the web app.',
          },
        ],
      },
    ],
  },
};

// Only the CLI and scripts write to the console; packages report through injected loggers or
// return values, and the web app renders errors (SPEC-014 §6).
const noConsoleOutsideCli = {
  files: ['packages/*/src/**/*.ts', 'apps/web/**/*.{ts,tsx}'],
  ignores: ['apps/web/e2e/**'],
  rules: { 'no-console': 'error' },
};

// App-authored copy has no en or em dash (AGENTS.md §7, SPEC-116 FR-116-24, issue 123). The
// selectors match the cooked value, so escapes such as `\u2014` are caught too, and HTML entities
// in JSX. Comments and regular expressions are not string nodes and stay unchecked. Flat config
// replaces a rule's options in a later block instead of merging them, so these selectors are
// spread into the one `no-restricted-syntax` block of every file glob (designSystemComponents
// and uiCopy below); apps/web/test/ui-copy-lint.test.ts checks both survive.
const dashCharacter = '[\\u2013\\u2014]';
const dashEntity = '&(?:ndash|mdash);|&#0*821[12];|&#x0*201[34];';
const uiCopyMessage =
  'App-authored copy must not contain an en or em dash (U+2013, U+2014). Use a colon, parentheses, a new sentence or a hyphen, and words such as n/a for a missing value (AGENTS.md §7, SPEC-116 FR-116-24).';
const uiCopySelectors = [
  { selector: `Literal[value=/${dashCharacter}|${dashEntity}/i]`, message: uiCopyMessage },
  { selector: `TemplateElement[value.cooked=/${dashCharacter}/]`, message: uiCopyMessage },
  { selector: `JSXText[value=/${dashCharacter}|${dashEntity}/i]`, message: uiCopyMessage },
];

// Pages and product components use the design-system components instead of raw form and table
// elements (SPEC-121 FR-121-4). The scope file is shared with apps/web/test/design-tokens.test.ts.
const designSystemScope = JSON.parse(
  readFileSync(new URL('apps/web/design-system-scope.json', import.meta.url), 'utf8'),
);
const designSystemMessage =
  'Use the design-system component from components/ui (Button, NativeSelect, Input, Table) or add one there (SPEC-121).';
// ESLint parses TypeScript only; design-tokens.test.ts checks the MDX pages in the scope.
const designSystemComponents = {
  files: designSystemScope.roots.flatMap((root) =>
    designSystemScope.extensions
      .filter((extension) => extension !== '.mdx')
      .map((extension) => `apps/web/${root}/**/*${extension}`),
  ),
  ignores: [`apps/web/${designSystemScope.componentLibrary}/**`],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: 'JSXOpeningElement[name.name=/^(button|select|textarea|table)$/]',
        message: designSystemMessage,
      },
      {
        selector:
          "JSXOpeningElement[name.name='input']:not(:has(JSXAttribute[name.name='type'][value.value='hidden']))",
        message: designSystemMessage,
      },
      ...uiCopySelectors,
    ],
  },
};

// The rest of the copy scope (decision D6): the component library, web helpers, the CLI and the
// packages, whose error and reason strings the web app and the CLI show. Tests, e2e and fixtures
// stay outside: they hold imported and agent content with dashes on purpose. No glob here may
// overlap designSystemComponents (see uiCopySelectors).
const uiCopy = {
  files: [
    `apps/web/${designSystemScope.componentLibrary}/**/*.{ts,tsx}`,
    'apps/web/lib/**/*.ts',
    'apps/cli/src/**/*.ts',
    'packages/*/src/**/*.ts',
  ],
  rules: { 'no-restricted-syntax': ['error', ...uiCopySelectors] },
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.agents/**',
      '.claude/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'examples/benchmarks/*/fixture/**',
      'examples/benchmarks/*/verification/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/storybook-static/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
    },
    settings: { next: { rootDir: 'apps/web' } },
  },
  ...packageBoundaries,
  webBoundary,
  noConsoleOutsideCli,
  designSystemComponents,
  uiCopy,
);
