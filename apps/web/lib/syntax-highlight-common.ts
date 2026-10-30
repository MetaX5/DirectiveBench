// Types, limits and the language map of syntax highlighting (SPEC-123 §6.7, §8.2), shared by
// the request side (syntax-highlight.ts, server-only) and the highlight worker
// (syntax-highlight-worker.ts). No Shiki code: importing this module loads no highlighter.
// The worker loads it with explicit `.ts` specifiers (see syntax-highlight-worker.ts), so it
// must stay plain, type-strippable TypeScript.

/** Token colours of the DirectiveBench theme, one `--syntax-token-*` design token each. */
export type SyntaxTokenKind =
  | 'comment'
  | 'keyword'
  | 'string'
  | 'string-expression'
  | 'constant'
  | 'function'
  | 'parameter'
  | 'punctuation'
  | 'link';

/** One display line as tokens; a null token is shown in the code text colour. */
export type HighlightedLine = readonly { text: string; token: SyntaxTokenKind | null }[];

/**
 * Tokens of a whole text, or why it is plain: no language for its path, over
 * SYNTAX_HIGHLIGHT_MAX_BYTES, a highlighter error, or over the deadline (FR-123-74, FR-123-78).
 */
export type HighlightResult =
  | { kind: 'highlighted'; lines: HighlightedLine[] }
  | { kind: 'plain'; reason: 'no-language' | 'too-large' | 'failed' | 'timeout' };

/** Largest stored content, in UTF-8 bytes, that is highlighted (FR-123-74, 256 KiB). */
export const SYNTAX_HIGHLIGHT_MAX_BYTES = 262_144;
/** Longer lines stay plain inside a highlighted file (FR-123-75, Shiki tokenizeMaxLineLength). */
export const SYNTAX_HIGHLIGHT_MAX_LINE_CHARS = 10_000;
/**
 * Tokenizing one line stops after this time; the rest of it stays plain (tokenizeTimeLimit).
 * Cooperative only (FR-123-75): it is checked between regular-expression matches and counts
 * the lazy compilation of a grammar's expressions, so where it cuts a line depends on the
 * machine's speed. The hard bound is SYNTAX_HIGHLIGHT_DEADLINE_MS.
 */
export const SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS = 500;

/** `lineTimeLimitMs` value that turns the per-line time limit off (Shiki's convention). */
export const SYNTAX_HIGHLIGHT_NO_LINE_TIME_LIMIT = 0;

export interface HighlightOptions {
  /**
   * Per-line time limit; defaults to SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS. Only code that needs
   * output independent of machine speed (tests, the Storybook fixtures) passes
   * SYNTAX_HIGHLIGHT_NO_LINE_TIME_LIMIT.
   */
  lineTimeLimitMs?: number;
}

/** The fixed extension map of FR-123-71; no detection from content. */
export const SYNTAX_LANGUAGE_BY_EXTENSION = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  php: 'php',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shellscript',
  bash: 'shellscript',
  py: 'python',
} as const;

export type SyntaxLanguage =
  (typeof SYNTAX_LANGUAGE_BY_EXTENSION)[keyof typeof SYNTAX_LANGUAGE_BY_EXTENSION];

/**
 * The language of a file from the last extension of its basename, case-insensitively; null for
 * an unknown extension, a name without one (`Makefile`) or a dotfile such as `.env`.
 */
export function languageForPath(path: string): SyntaxLanguage | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(SYNTAX_LANGUAGE_BY_EXTENSION, extension)
    ? SYNTAX_LANGUAGE_BY_EXTENSION[extension as keyof typeof SYNTAX_LANGUAGE_BY_EXTENSION]
    : null;
}

/** One text the worker tokenizes: its language is known and it is within the size bound. */
export interface HighlightJobText {
  text: string;
  language: SyntaxLanguage;
}

/** The message a page render sends to the highlight worker (FR-123-78). */
export interface HighlightJob {
  texts: HighlightJobText[];
  lineTimeLimitMs: number;
}

/** The worker's answer: one result per text of the job, in order. */
export interface HighlightJobResult {
  results: HighlightResult[];
}
