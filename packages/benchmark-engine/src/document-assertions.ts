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
  MAX_MARKDOWN_NESTING,
  normalizeText,
  parseFirstNumber,
  scanMarkdown,
  type MarkdownNotReported,
  type MarkdownTableRow,
} from './markdown';
import { matchPatterns, placeMatchers, type Placement } from './pattern-worker';

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

/** Most `notReported` entries listed in a result's details; `notReportedCount` counts all. */
export const MAX_LISTED_GAPS = 20;

const STOP_REASONS: Record<Exclude<MarkdownNotReported['reason'], 'pipeless-table'>, string> = {
  'link-definition-underline':
    'a possible link reference definition before a setext underline ends the scan (not parsed)',
  'nesting-limit': `block quotes and list items nested deeper than ${MAX_MARKDOWN_NESTING} end the scan`,
};

/**
 * What the scan of the target file did not read (FR-118-41/43, ADR-0013): the details to add (the
 * stop first, then pipe-less tables in line order, at most MAX_LISTED_GAPS) and the sentences a
 * failing message ends with. Empty when the whole document was read.
 */
function describeGaps(gaps: readonly MarkdownNotReported[]): {
  details: { notReported?: MarkdownNotReported[]; notReportedCount?: number };
  /** `message`, then the sentences saying what was not read, as one failing message. */
  failure: (message: string) => string;
} {
  if (gaps.length === 0) return { details: {}, failure: (message) => message };
  const pipeless = gaps.filter((gap) => gap.reason === 'pipeless-table');
  const stops = gaps.filter((gap) => gap.reason !== 'pipeless-table');
  const sentences = stops.map(
    ({ line, reason }) =>
      ` The document was checked only before line ${line}: ${STOP_REASONS[reason as keyof typeof STOP_REASONS]}.`,
  );
  const first = pipeless[0];
  if (first !== undefined) {
    sentences.push(
      pipeless.length === 1
        ? ` 1 table without a pipe in its header or delimiter row was not read (header on line ${first.line}).`
        : ` ${pipeless.length} tables without a pipe in their header or delimiter row were not read (first header on line ${first.line}).`,
    );
  }
  return {
    details: {
      notReported: [...stops, ...pipeless].slice(0, MAX_LISTED_GAPS),
      notReportedCount: gaps.length,
    },
    failure: (message) => `${message}.${sentences.join('')}`,
  };
}

/** How a matcher is shown in messages and details. */
export function matcherLabel(matcher: TextMatcher): string {
  return typeof matcher === 'string' ? matcher : `/${matcher.pattern}/${matcher.flags}`;
}

/** `markdown-sections` (FR-118-41): every listed heading occurs, optionally in order. */
async function evaluateMarkdownSections(
  assertion: Of<'markdown-sections'>,
  context: AssertionContext,
): Promise<AssertionResult> {
  const target = await readTargetFile(assertion.file, context);
  if (!target.ok) return assertionResult(assertion, false, target.message, target.details);
  const { headings, notReported } = scanMarkdown(target.text);
  // A pipe-less table hides no heading: only a stop leaves headings unread.
  const gaps = describeGaps(notReported.filter((gap) => gap.reason !== 'pipeless-table'));
  // Literals compare with the lower-cased heading text (headings arrive whitespace-collapsed).
  const matchers = assertion.headings.map((m) =>
    typeof m === 'string' ? { literal: normalizeText(m) } : m,
  );
  const patterns = assertion.headings.filter((m): m is PatternMatcher => typeof m !== 'string');
  let placement: Placement;
  if (patterns.length === 0) {
    // Literals only: linear comparisons on the runner thread, no worker.
    placement = placeMatchers(matchers, headings, assertion.ordered);
  } else {
    const outcome = await matchPatterns(
      { matchers, texts: headings, ordered: assertion.ordered },
      context.signal,
    );
    if (!outcome.ok) return assertionError(assertion, outcome.error, patterns.map(matcherLabel));
    placement = outcome;
  }
  const labels = assertion.headings.map(matcherLabel);
  const found = labels.filter((_, i) => (placement.first[i] as number) >= 0);
  const missing = labels.filter((_, i) => (placement.first[i] as number) < 0);
  // Greedy order: each heading takes its first occurrence after the previous placed heading's.
  const misordered =
    placement.placed && missing.length === 0
      ? labels.filter((_, i) => (placement.placed?.[i] as number) < 0)
      : [];
  const details = { file: target.file, found, missing, misordered, ...gaps.details };
  if (missing.length > 0) {
    return assertionResult(
      assertion,
      false,
      gaps.failure(`Missing headings: ${missing.join(', ')}`),
      details,
    );
  }
  if (misordered.length > 0) {
    return assertionResult(
      assertion,
      false,
      gaps.failure(`Headings out of order: ${misordered.join(', ')}`),
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
    { matchers: patterns, texts: [target.text], ordered: false },
    context.signal,
  );
  if (!outcome.ok) return assertionError(assertion, outcome.error, patterns.map(matcherLabel));
  // Literals: whitespace runs match any run; never a regular expression (FR-118-42).
  const containsLiteral = literalSearch(target.text, assertion.caseSensitive);
  let next = 0;
  const present = assertion.phrases.map((phrase) =>
    typeof phrase === 'string' ? containsLiteral(phrase) : (outcome.first[next++] as number) >= 0,
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
  const { tables, notReported } = scanMarkdown(target.text);
  const gaps = describeGaps(notReported);
  tables.forEach((table, index) => {
    const columnIndex = table.header.findIndex((cell) => normalizeText(cell) === column);
    if (columnIndex < 0) return;
    hasColumn = true;
    for (const row of table.rows) candidates.push({ tableIndex: index + 1, row, columnIndex });
  });
  const rowLabel = matcherLabel(assertion.row);
  const base = { file: target.file, row: rowLabel, column: assertion.column, ...gaps.details };
  if (!hasColumn) {
    return assertionResult(
      assertion,
      false,
      gaps.failure(`No table has a column "${assertion.column}" in ${target.file}`),
      base,
    );
  }
  let first: number | undefined;
  if (candidates.length > 0) {
    const outcome = await matchPatterns(
      {
        matchers: [assertion.row],
        texts: candidates.map((c) => c.row.cells[0] as string),
        ordered: false,
      },
      context.signal,
    );
    if (!outcome.ok) return assertionError(assertion, outcome.error, [rowLabel]);
    const index = outcome.first[0] as number;
    first = index >= 0 ? index : undefined;
  }
  if (first === undefined) {
    return assertionResult(
      assertion,
      false,
      gaps.failure(
        `No row whose first cell matches ${rowLabel} in a table with column "${assertion.column}"`,
      ),
      base,
    );
  }
  const { tableIndex, row, columnIndex } = candidates[first] as (typeof candidates)[number];
  const value = parseFirstNumber(row.cells[columnIndex] ?? '', assertion.decimalSeparator);
  const cell = excerpt(row.cells[columnIndex] ?? '');
  const details = { ...base, tableIndex, rowText: excerpt(row.text), cell, value };
  if (value === null) {
    return assertionResult(assertion, false, gaps.failure(`No number in cell "${cell}"`), details);
  }
  const { min, max } = assertion;
  const passed = (min === undefined || value >= min) && (max === undefined || value <= max);
  const range = `${min ?? '-∞'}…${max ?? '∞'}`;
  const message = `${assertion.column} = ${value} is ${passed ? 'within' : 'outside'} ${range}`;
  return assertionResult(assertion, passed, passed ? message : gaps.failure(message), details);
}

export const documentAssertionEvaluators = {
  'markdown-sections': evaluateMarkdownSections,
  'required-phrases': evaluateRequiredPhrases,
  'markdown-table-value': evaluateMarkdownTableValue,
};
