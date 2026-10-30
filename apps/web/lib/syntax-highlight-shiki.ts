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
import { displayLines } from './output-files.ts';
import {
  SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS,
  SYNTAX_HIGHLIGHT_MAX_BYTES,
  SYNTAX_HIGHLIGHT_MAX_LINE_CHARS,
  type HighlightedLine,
  type HighlightOptions,
  type HighlightResult,
  type SyntaxLanguage,
  type SyntaxTokenKind,
} from './syntax-highlight-common.ts';

// The Shiki tokenizer (SPEC-123 §6.7, ADR-0014). It runs only inside the highlight worker
// thread (syntax-highlight-worker.ts, FR-123-78), never on the request thread: pages call
// syntax-highlight.ts, which sends jobs to that worker. Shiki's fine-grained core with the
// JavaScript regular-expression engine (no WebAssembly) and a fixed list of grammars; the result
// is plain token data that components render as React text nodes. Only the @shikijs/* entry
// points are imported: Next.js keeps the `shiki` package external (serverExternalPackages), and
// the published CLI must not need it at run time (FR-123-77).

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

/** One highlighter per worker; a failed creation is forgotten so the next call retries. */
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
 * Tokenizes a whole text in this thread, so comments and strings spanning lines are coloured
 * correctly, and returns one HighlightedLine per display line (the same split as FileView,
 * FR-123-76). Never throws: no language, content over SYNTAX_HIGHLIGHT_MAX_BYTES or any
 * highlighter error gives a plain result with its reason (FR-123-74). It is synchronous work
 * that no timer can interrupt, which is why only the highlight worker calls it.
 */
export async function tokenizeText(
  text: string,
  language: SyntaxLanguage | null,
  { lineTimeLimitMs = SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS }: HighlightOptions = {},
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
      tokenizeTimeLimit: lineTimeLimitMs,
    });
    return { kind: 'highlighted', lines: tokens.map(toLine) };
  } catch (error) {
    // Logged without file content (FR-123-74): only the language and the kind of error. The web
    // app has no logger; this server-only line is one of the places it writes to the console.
    // eslint-disable-next-line no-console -- FR-123-74 requires a server log of the failure
    console.error(
      `Syntax highlighting failed for a ${language} file: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
    return { kind: 'plain', reason: 'failed' };
  }
}
