import { redactSecrets } from '@directivebench/core';
import {
  assertionError,
  assertionResult,
  readTargetFile,
  type AssertionContext,
  type AssertionResult,
} from './assertion-support';
import type { AssertionDefinition, PatternMatcher, TextMatcher } from './definition';
import {
  literalSearch,
  normalizeText,
  parseFirstNumber,
  scanMarkdown,
  type MarkdownTableRow,
} from './markdown';
import { matchPatterns } from './pattern-worker';

type Of<T extends AssertionDefinition['type']> = Extract<AssertionDefinition, { type: T }>;

/** Longest excerpt of agent-written text kept in a result's message or details. */
export const MAX_EXCERPT_CHARS = 200;

/**
 * Agent-written text for messages and details: redacted before it is cut, so a cut cannot leave
 * a partial token the patterns no longer recognise (FR-107-16).
 */
function excerpt(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > MAX_EXCERPT_CHARS
    ? `${redacted.slice(0, MAX_EXCERPT_CHARS)}… [${redacted.length - MAX_EXCERPT_CHARS} more characters]`
    : redacted;
}

/** How a matcher is shown in messages and details. */
export function matcherLabel(matcher: TextMatcher): string {
  return typeof matcher === 'string' ? matcher : `/${matcher.pattern}/${matcher.flags}`;
}

/**
 * For each matcher, the indexes of the `texts` it matches: literals by normalised equality on
 * this thread, patterns in one bounded worker (FR-118-46). Returns the assertion error instead
 * when the worker does not finish.
 */
async function matchTexts(
  assertion: AssertionDefinition,
  matchers: readonly TextMatcher[],
  texts: readonly string[],
  context: AssertionContext,
): Promise<{ ok: true; matches: number[][] } | { ok: false; result: AssertionResult }> {
  const patterns = matchers.filter((m): m is PatternMatcher => typeof m !== 'string');
  const outcome = await matchPatterns({ patterns, texts, firstOnly: false }, context.signal);
  if (!outcome.ok) {
    return {
      ok: false,
      result: assertionError(assertion, outcome.error, patterns.map(matcherLabel)),
    };
  }
  const normalized = texts.map((t) => normalizeText(t));
  let next = 0;
  const matches = matchers.map((matcher) => {
    if (typeof matcher !== 'string') return outcome.matches[next++] as number[];
    const wanted = normalizeText(matcher);
    return normalized.flatMap((text, index) => (text === wanted ? [index] : []));
  });
  return { ok: true, matches };
}

/** `markdown-sections` (FR-118-41): every listed heading occurs, optionally in order. */
async function evaluateMarkdownSections(
  assertion: Of<'markdown-sections'>,
  context: AssertionContext,
): Promise<AssertionResult> {
  const target = await readTargetFile(assertion.file, context);
  if (!target.ok) return assertionResult(assertion, false, target.message, target.details);
  const { headings } = scanMarkdown(target.text);
  const matched = await matchTexts(assertion, assertion.headings, headings, context);
  if (!matched.ok) return matched.result;
  const labels = assertion.headings.map(matcherLabel);
  const found = labels.filter((_, i) => (matched.matches[i] as number[]).length > 0);
  const missing = labels.filter((_, i) => (matched.matches[i] as number[]).length === 0);
  const misordered: string[] = [];
  if (assertion.ordered && missing.length === 0) {
    // Greedy: each heading takes its first occurrence after the previous heading's.
    let previous = -1;
    matched.matches.forEach((indexes, i) => {
      const position = indexes.find((index) => index > previous);
      if (position === undefined) misordered.push(labels[i] as string);
      else previous = position;
    });
  }
  const details = { file: target.file, found, missing, misordered };
  if (missing.length > 0) {
    return assertionResult(assertion, false, `Missing headings: ${missing.join(', ')}`, details);
  }
  if (misordered.length > 0) {
    return assertionResult(
      assertion,
      false,
      `Headings out of order: ${misordered.join(', ')}`,
      details,
    );
  }
  return assertionResult(
    assertion,
    true,
    `All ${labels.length} heading(s) found${assertion.ordered ? ' in order' : ''} in ${target.file}`,
    details,
  );
}

/** `required-phrases` (FR-118-42): every literal or pattern occurs in the file text. */
async function evaluateRequiredPhrases(
  assertion: Of<'required-phrases'>,
  context: AssertionContext,
): Promise<AssertionResult> {
  const target = await readTargetFile(assertion.file, context);
  if (!target.ok) return assertionResult(assertion, false, target.message, target.details);
  const patterns = assertion.phrases.filter((m): m is PatternMatcher => typeof m !== 'string');
  const outcome = await matchPatterns(
    { patterns, texts: [target.text], firstOnly: true },
    context.signal,
  );
  if (!outcome.ok) return assertionError(assertion, outcome.error, patterns.map(matcherLabel));
  // Literals: whitespace runs match any run; never a regular expression (FR-118-42).
  const containsLiteral = literalSearch(target.text, assertion.caseSensitive);
  let next = 0;
  const present = assertion.phrases.map((phrase) =>
    typeof phrase === 'string'
      ? containsLiteral(phrase)
      : (outcome.matches[next++] as number[]).length > 0,
  );
  const labels = assertion.phrases.map(matcherLabel);
  const found = labels.filter((_, i) => present[i]);
  const missing = labels.filter((_, i) => !present[i]);
  const details = { file: target.file, found, missing };
  return missing.length > 0
    ? assertionResult(assertion, false, `Missing phrases: ${missing.join(', ')}`, details)
    : assertionResult(
        assertion,
        true,
        `All ${labels.length} phrase(s) found in ${target.file}`,
        details,
      );
}

/** `markdown-table-value` (FR-118-43/44): a number in a table cell lies within `min`/`max`. */
async function evaluateMarkdownTableValue(
  assertion: Of<'markdown-table-value'>,
  context: AssertionContext,
): Promise<AssertionResult> {
  const target = await readTargetFile(assertion.file, context);
  if (!target.ok) return assertionResult(assertion, false, target.message, target.details);
  const column = normalizeText(assertion.column);
  const candidates: { tableIndex: number; row: MarkdownTableRow; columnIndex: number }[] = [];
  let hasColumn = false;
  scanMarkdown(target.text).tables.forEach((table, index) => {
    const columnIndex = table.header.findIndex((cell) => normalizeText(cell) === column);
    if (columnIndex < 0) return;
    hasColumn = true;
    for (const row of table.rows) candidates.push({ tableIndex: index + 1, row, columnIndex });
  });
  const rowLabel = matcherLabel(assertion.row);
  const base = { file: target.file, row: rowLabel, column: assertion.column };
  if (!hasColumn) {
    return assertionResult(
      assertion,
      false,
      `No table has a column "${assertion.column}" in ${target.file}`,
      base,
    );
  }
  let first: number | undefined;
  if (candidates.length > 0) {
    const outcome = await matchPatterns(
      {
        patterns: [assertion.row],
        texts: candidates.map((c) => c.row.cells[0] as string),
        firstOnly: true,
      },
      context.signal,
    );
    if (!outcome.ok) return assertionError(assertion, outcome.error, [rowLabel]);
    first = (outcome.matches[0] as number[])[0];
  }
  if (first === undefined) {
    return assertionResult(
      assertion,
      false,
      `No row whose first cell matches ${rowLabel} in a table with column "${assertion.column}"`,
      base,
    );
  }
  const { tableIndex, row, columnIndex } = candidates[first] as (typeof candidates)[number];
  const value = parseFirstNumber(row.cells[columnIndex] ?? '', assertion.decimalSeparator);
  const cell = excerpt(row.cells[columnIndex] ?? '');
  const details = { ...base, tableIndex, rowText: excerpt(row.text), cell, value };
  if (value === null) {
    return assertionResult(assertion, false, `No number in cell "${cell}"`, details);
  }
  const { min, max } = assertion;
  const passed = (min === undefined || value >= min) && (max === undefined || value <= max);
  const range = `${min ?? '-∞'}…${max ?? '∞'}`;
  return assertionResult(
    assertion,
    passed,
    `${assertion.column} = ${value} is ${passed ? 'within' : 'outside'} ${range}`,
    details,
  );
}

export const documentAssertionEvaluators = {
  'markdown-sections': evaluateMarkdownSections,
  'required-phrases': evaluateRequiredPhrases,
  'markdown-table-value': evaluateMarkdownTableValue,
};
