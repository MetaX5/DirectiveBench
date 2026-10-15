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
);
