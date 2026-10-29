import 'server-only';
import {
  createCssVariablesTheme,
  createHighlighterCore,
  type HighlighterCore,
  type ThemedToken,
} from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import css from '@shikijs/langs/css';
import html from '@shikijs/langs/html';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import jsx from '@shikijs/langs/jsx';
import markdown from '@shikijs/langs/markdown';
import php from '@shikijs/langs/php';
import python from '@shikijs/langs/python';
import scss from '@shikijs/langs/scss';
import shellscript from '@shikijs/langs/shellscript';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';
import yaml from '@shikijs/langs/yaml';
import { displayLines } from './output-files';

// Server-side syntax highlighting of output files (SPEC-123 §6.7, ADR-0014). Shiki's
// fine-grained core with the JavaScript regular-expression engine (no WebAssembly) and a fixed
// list of grammars; the result is plain token data that components render as React text nodes.
// Only the @shikijs/* entry points are imported: Next.js keeps the `shiki` package external
// (serverExternalPackages), and the published CLI must not need it at run time (FR-123-77).

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

export type HighlightResult =
  | { kind: 'highlighted'; lines: HighlightedLine[] }
  | { kind: 'plain'; reason: 'no-language' | 'too-large' | 'failed' };

/** Largest stored content, in UTF-8 bytes, that is highlighted (FR-123-74, 256 KiB). */
export const SYNTAX_HIGHLIGHT_MAX_BYTES = 262_144;
/** Longer lines stay plain inside a highlighted file (FR-123-75, Shiki tokenizeMaxLineLength). */
export const SYNTAX_HIGHLIGHT_MAX_LINE_CHARS = 10_000;
/** Tokenizing one line stops after this time; the rest of it stays plain (tokenizeTimeLimit). */
export const SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS = 500;

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

const THEME_NAME = 'directivebench';

// Token colours are `var(--syntax-token-*)` references (FR-123-73); any other colour, including
// `var(--syntax-foreground)`, is rendered without a colour of its own.
const KINDS: readonly SyntaxTokenKind[] = [
  'comment',
  'keyword',
  'string',
  'string-expression',
  'constant',
  'function',
  'parameter',
  'punctuation',
  'link',
];
const kindByColour = new Map(KINDS.map((kind) => [`var(--syntax-token-${kind})`, kind]));

let highlighter: Promise<HighlighterCore> | null = null;

/** One highlighter per server process; a failed creation is forgotten so the next call retries. */
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [createCssVariablesTheme({ name: THEME_NAME, variablePrefix: '--syntax-' })],
    langs: [
      css,
      html,
      javascript,
      json,
      jsx,
      markdown,
      php,
      python,
      scss,
      shellscript,
      tsx,
      typescript,
      yaml,
    ],
    engine: createJavaScriptRegexEngine(),
  }).catch((error: unknown) => {
    highlighter = null;
    throw error;
  });
  return highlighter;
}

function toLine(tokens: readonly ThemedToken[]): HighlightedLine {
  const line: { text: string; token: SyntaxTokenKind | null }[] = [];
  for (const { content, color } of tokens) {
    const token = (color && kindByColour.get(color)) || null;
    const last = line.at(-1);
    // Neighbours of one kind are merged: less data in the page, the same text and colour.
    if (last && last.token === token) last.text += content;
    else line.push({ text: content, token });
  }
  return line;
}

/**
 * Highlights a whole text, so comments and strings spanning lines are coloured correctly, and
 * returns one HighlightedLine per display line (the same split as FileView, FR-123-76). Never
 * throws: no language, content over SYNTAX_HIGHLIGHT_MAX_BYTES or any highlighter error gives a
 * plain result with its reason (FR-123-74).
 */
export async function highlightLines(
  text: string,
  language: SyntaxLanguage | null,
): Promise<HighlightResult> {
  if (language === null) return { kind: 'plain', reason: 'no-language' };
  if (Buffer.byteLength(text, 'utf8') > SYNTAX_HIGHLIGHT_MAX_BYTES) {
    return { kind: 'plain', reason: 'too-large' };
  }
  const lines = displayLines(text);
  try {
    const shiki = await getHighlighter();
    if (lines.length === 0) return { kind: 'highlighted', lines: [] };
    const { tokens } = shiki.codeToTokens(lines.join('\n'), {
      lang: language,
      theme: THEME_NAME,
      // Shiki leaves a line plain from this length on; the spec keeps lines of exactly the limit.
      tokenizeMaxLineLength: SYNTAX_HIGHLIGHT_MAX_LINE_CHARS + 1,
      tokenizeTimeLimit: SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS,
    });
    return { kind: 'highlighted', lines: tokens.map(toLine) };
  } catch (error) {
    // Logged without file content (FR-123-74): only the language and the kind of error. The web
    // app has no logger; this server-only line is the one place it writes to the console.
    // eslint-disable-next-line no-console -- FR-123-74 requires a server log of the failure
    console.error(
      `Syntax highlighting failed for a ${language} file: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
    return { kind: 'plain', reason: 'failed' };
  }
}
