/**
 * Line-based Markdown scanning for the document assertions (SPEC-118 FR-118-41…44). Every scan is
 * linear in the input: no regular expression runs over the whole text or a span that can
 * backtrack (lessons 2026-10-21 on delimited spans and superlinear parses). The scanner reads
 * Markdown, it never renders or evaluates it.
 */

export interface MarkdownTableRow {
  /** The source line of the row. */
  text: string;
  cells: string[];
}

export interface MarkdownTable {
  header: string[];
  rows: MarkdownTableRow[];
}

export interface MarkdownScan {
  /** Heading texts in document order, whitespace-collapsed and trimmed. */
  headings: string[];
  tables: MarkdownTable[];
}

/** Collapses whitespace runs to one space and trims. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Comparison form of a heading, header cell or literal phrase. */
export function normalizeText(text: string, caseSensitive = false): string {
  const collapsed = collapseWhitespace(text);
  return caseSensitive ? collapsed : collapsed.toLowerCase();
}

/** Number of leading spaces (a tab counts as four, which already exceeds every limit here). */
function indentation(line: string): number {
  let count = 0;
  while (count < line.length && (line[count] === ' ' || line[count] === '\t')) {
    if (line[count] === '\t') return 4;
    count += 1;
  }
  return count;
}

interface Fence {
  marker: string;
  length: number;
}

/** An opening code fence: up to three spaces, then three or more backticks or tildes. */
function openingFence(line: string): Fence | null {
  const indent = indentation(line);
  if (indent > 3) return null;
  const marker = line[indent];
  if (marker !== '`' && marker !== '~') return null;
  let end = indent;
  while (line[end] === marker) end += 1;
  const length = end - indent;
  if (length < 3) return null;
  // A backtick fence's info string cannot contain a backtick.
  if (marker === '`' && line.includes('`', end)) return null;
  return { marker, length };
}

function closesFence(line: string, fence: Fence): boolean {
  const indent = indentation(line);
  if (indent > 3) return false;
  const rest = line.slice(indent).trimEnd();
  return rest.length >= fence.length && [...rest].every((c) => c === fence.marker);
}

/** The text of an ATX heading (`# Title #`), or null. */
function atxHeading(line: string): string | null {
  const indent = indentation(line);
  if (indent > 3) return null;
  let level = 0;
  while (line[indent + level] === '#') level += 1;
  if (level < 1 || level > 6) return null;
  const after = line[indent + level];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  let content = line.slice(indent + level).trimEnd();
  // An optional closing sequence of #s, preceded by whitespace (or forming the whole content).
  let hashes = content.length;
  while (hashes > 0 && content[hashes - 1] === '#') hashes -= 1;
  if (hashes < content.length && (hashes === 0 || /[ \t]/.test(content[hashes - 1] as string))) {
    content = content.slice(0, hashes);
  }
  return collapseWhitespace(content);
}

/** True for a setext underline (`===` or `---`) indented by at most three spaces. */
function isSetextUnderline(line: string): boolean {
  if (indentation(line) > 3) return false;
  const rest = line.trim();
  const marker = rest[0];
  return (marker === '=' || marker === '-') && [...rest].every((c) => c === marker);
}

/** Splits a table row into trimmed cells; `\|` is a literal pipe. */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** A GFM delimiter row (`| --- | :-: |`); it needs a pipe, so `---` stays a setext underline. */
function delimiterCells(line: string): number | null {
  if (!line.includes('|') || indentation(line) > 3) return null;
  const cells = splitTableRow(line);
  return cells.every((cell) => /^:?-+:?$/.test(cell)) ? cells.length : null;
}

/** Ends a table body: a blank line or the start of another block. */
function endsTable(line: string): boolean {
  return (
    line.trim() === '' ||
    atxHeading(line) !== null ||
    openingFence(line) !== null ||
    line.trimStart().startsWith('>')
  );
}

/**
 * Scans ATX and setext headings of any level and GFM tables, skipping fenced code blocks.
 * Linear in the input length.
 */
export function scanMarkdown(text: string): MarkdownScan {
  const lines = text.split(/\r\n|\r|\n/);
  const headings: string[] = [];
  const tables: MarkdownTable[] = [];
  let fence: Fence | null = null;
  let paragraph: string[] = [];
  let table: MarkdownTable | null = null;

  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (table) {
      if (!endsTable(line)) {
        table.rows.push({ text: line, cells: splitTableRow(line) });
        continue;
      }
      table = null;
    }
    const opened = openingFence(line);
    if (opened) {
      fence = opened;
      paragraph = [];
      continue;
    }
    if (line.trim() === '') {
      paragraph = [];
      continue;
    }
    const atx = atxHeading(line);
    if (atx !== null) {
      headings.push(atx);
      paragraph = [];
      continue;
    }
    const header = paragraph.at(-1);
    if (header === undefined && isSetextUnderline(line) && line.trim()[0] === '-') {
      // Without a paragraph above, `---` is a thematic break (or an empty list item), not text.
      continue;
    }
    if (header !== undefined) {
      const columns = header.includes('|') ? delimiterCells(line) : null;
      const headerCells = columns === null ? [] : splitTableRow(header);
      if (headerCells.length === columns) {
        table = { header: headerCells, rows: [] };
        tables.push(table);
        paragraph = [];
        continue;
      }
      if (isSetextUnderline(line)) {
        headings.push(collapseWhitespace(paragraph.join(' ')));
        paragraph = [];
        continue;
      }
    }
    paragraph.push(line);
  }
  return { headings, tables };
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

/** Grouping separators besides `,`/`.`: space, no-break space, narrow no-break and thin space. */
const SPACE_SEPARATORS = new Set([' ', ' ', ' ', ' ']);

/** Exactly three digits at `index`, not followed by a fourth. */
function isDigitGroup(text: string, index: number): boolean {
  return (
    isDigit(text[index]) &&
    isDigit(text[index + 1]) &&
    isDigit(text[index + 2]) &&
    !isDigit(text[index + 3])
  );
}

/**
 * The first number in `text` (SPEC-118 FR-118-44): an optional minus sign, digits with optional
 * grouping (groups of three after `,` or a space with `decimalSeparator` `.`, after `.` or a space
 * with `,`) and an optional decimal part. A range such as `8–12` yields its first number.
 */
export function parseFirstNumber(text: string, decimalSeparator: '.' | ','): number | null {
  const grouping = decimalSeparator === '.' ? ',' : '.';
  let start = 0;
  while (start < text.length && !isDigit(text[start])) start += 1;
  if (start === text.length) return null;
  const sign = text[start - 1];
  const negative = (sign === '-' || sign === '−') && !isDigit(text[start - 2]);
  let index = start;
  let digits = '';
  while (isDigit(text[index])) digits += text[index++];
  for (;;) {
    const separator = text[index] ?? '';
    if (
      (separator === grouping || SPACE_SEPARATORS.has(separator)) &&
      isDigitGroup(text, index + 1)
    ) {
      digits += text.slice(index + 1, index + 4);
      index += 4;
    } else {
      break;
    }
  }
  let fraction = '';
  if (text[index] === decimalSeparator && isDigit(text[index + 1])) {
    index += 1;
    while (isDigit(text[index])) fraction += text[index++];
  }
  const value = Number(fraction ? `${digits}.${fraction}` : digits);
  return negative ? -value : value;
}
