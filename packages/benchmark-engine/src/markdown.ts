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

/**
 * Literal phrase search over `text` (FR-118-42): whitespace runs match any whitespace run, case is
 * folded unless `caseSensitive`, and a phrase is never a regular expression. The text is
 * normalised once, so searching several phrases stays linear in the text per phrase.
 */
export function literalSearch(text: string, caseSensitive: boolean): (phrase: string) => boolean {
  const haystack = normalizeText(text, caseSensitive);
  return (phrase) => haystack.includes(normalizeText(phrase, caseSensitive));
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
  /** Block-quote depth of the opening line; a closing fence needs the same depth. */
  quotes: number;
  /** Indentation of the opening line's list-item content; a closing fence needs at least it. */
  indent: number;
}

/** An opening code fence: up to three spaces, then three or more backticks or tildes. */
function openingFence(line: string): Omit<Fence, 'quotes' | 'indent'> | null {
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

function closesFence(line: string, fence: Omit<Fence, 'quotes' | 'indent'>): boolean {
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
    containerContent(line) !== null ||
    isThematicBreak(line)
  );
}

/** Three or more `-`, `*` or `_` (spaces allowed between), indented at most three spaces. */
function isThematicBreak(line: string): boolean {
  if (indentation(line) > 3) return false;
  const marks = line.replace(/[ \t]/g, '');
  const marker = marks[0];
  return (
    marks.length >= 3 &&
    (marker === '-' || marker === '*' || marker === '_') &&
    [...marks].every((c) => c === marker)
  );
}

const CONTAINER_MARKER = /^ {0,3}(?:>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))[ \t]?/;
const QUOTE_MARKER = /^ {0,3}>[ \t]?/;

interface Containers {
  /** Leading block-quote markers. */
  quotes: number;
  /** Width of the list-item markers after them (content indentation). */
  indent: number;
  content: string;
}

/**
 * Splits the block-quote and list-item markers off a line (`> # Risks` → `# Risks`,
 * `1. text` → `text`); nested markers are stripped one at a time.
 */
function splitContainers(line: string): Containers {
  const result: Containers = { quotes: 0, indent: 0, content: line };
  for (;;) {
    const marker = CONTAINER_MARKER.exec(result.content);
    if (!marker) return result;
    if (marker[0].trimStart().startsWith('>') && result.indent === 0) result.quotes += 1;
    else result.indent += marker[0].length;
    result.content = result.content.slice(marker[0].length);
  }
}

/** The content of a block-quote or list-item line, or null for any other line. */
function containerContent(line: string): string | null {
  const { quotes, indent, content } = splitContainers(line);
  return quotes > 0 || indent > 0 ? content : null;
}

/** The container a fenced code block or an HTML comment was opened in. */
interface Context {
  quotes: number;
  indent: number;
}

/**
 * The rest of `line` when it still continues `context` — the same block-quote depth and, inside
 * a list item, a blank line or content indented at least as far — or null when the container has
 * ended. Fenced code and HTML blocks have no lazy continuation (GFM §4.5, §4.6, §5.1, §5.2): a
 * line without the quote marker, or with less indentation, ends them with their container.
 */
function containerRest(line: string, context: Context): string | null {
  let rest = line;
  for (let depth = 0; depth < context.quotes; depth += 1) {
    const marker = QUOTE_MARKER.exec(rest);
    if (!marker) return null;
    rest = rest.slice(marker[0].length);
  }
  if (context.indent === 0 || rest.trim() === '') return rest;
  return indentation(rest) < context.indent ? null : rest.slice(context.indent);
}

/** An HTML comment opener at the start of a line; its content is never rendered. */
function opensComment(line: string): boolean {
  return line.trimStart().startsWith('<!--') && indentation(line) <= 3;
}

/**
 * Scans ATX and setext headings of any level and GFM tables, skipping fenced code blocks and
 * HTML comments. Headings inside block quotes and list items count; their other lines, and
 * indented code, are neither paragraphs nor setext content. Linear in the input length.
 */
export function scanMarkdown(text: string): MarkdownScan {
  const lines = text.split(/\r\n|\r|\n/);
  const headings: string[] = [];
  const tables: MarkdownTable[] = [];
  let fence: Fence | null = null;
  let paragraph: string[] = [];
  let table: MarkdownTable | null = null;
  let comment: Context | null = null;
  // Inside a block quote or list item until a blank line (lazy continuation lines).
  let container = false;
  // Content indentation of the open top-level list item; its lines are read relative to it.
  let listIndent = 0;

  for (const line of lines) {
    if (fence) {
      // Code until the closing fence, or until the fence's container ends; then the line is
      // read again as a new block.
      const rest = containerRest(line, fence);
      if (rest !== null) {
        // Lazy continuation follows paragraphs only, never a closed fence (GFM §5.1).
        if (closesFence(rest, fence)) [fence, container] = [null, false];
        continue;
      }
      fence = null;
    }
    if (comment) {
      const rest = containerRest(line, comment);
      if (rest !== null) {
        if (rest.includes('-->')) [comment, container] = [null, false];
        continue;
      }
      comment = null;
    }
    if (table) {
      if (!endsTable(line)) {
        table.rows.push({ text: line, cells: splitTableRow(line) });
        continue;
      }
      table = null;
    }
    // Only a bullet or an ordered list starting at 1 may interrupt a paragraph (GFM §5.2).
    const keepsParagraph: boolean =
      paragraph.length > 0 &&
      !container &&
      /^ {0,3}\d{1,9}[.)]/.test(line) &&
      !/^ {0,3}1[.)]/.test(line);
    const containers: Containers = keepsParagraph
      ? { quotes: 0, indent: 0, content: line }
      : splitContainers(line);
    const inner: string | null =
      containers.quotes > 0 || containers.indent > 0 ? containers.content : null;
    // A line indented at least as far as the open list item's content continues that item.
    const listRest =
      inner === null && listIndent > 0 && line.trim() !== '' && indentation(line) >= listIndent
        ? line.slice(listIndent)
        : null;
    if (inner === null && listRest === null && line.trim() !== '' && !container) listIndent = 0;
    // Fences and HTML comments open at the top level, in a block quote or list-item line, or on
    // a continuation line of the open list item, and remember that container.
    const block: Context & { text: string } =
      inner !== null
        ? { quotes: containers.quotes, indent: containers.indent, text: inner }
        : listRest !== null
          ? { quotes: 0, indent: listIndent, text: listRest }
          : { quotes: 0, indent: 0, text: line };
    const opened = openingFence(block.text);
    if (opened) {
      fence = { ...opened, quotes: block.quotes, indent: block.indent };
      paragraph = [];
      container = inner !== null;
      continue;
    }
    if (opensComment(block.text)) {
      const closed = block.text.slice(block.text.indexOf('<!--') + 4).includes('-->');
      comment = closed ? null : { quotes: block.quotes, indent: block.indent };
      paragraph = [];
      container = inner !== null;
      continue;
    }
    if (line.trim() === '') {
      paragraph = [];
      container = false;
      continue;
    }
    const atx = atxHeading(line) ?? (listRest === null ? null : atxHeading(listRest));
    if (atx !== null) {
      headings.push(atx);
      paragraph = [];
      container = false;
      continue;
    }
    const header = paragraph.at(-1);
    if (header !== undefined) {
      // Checked on the raw line first: `- | -` is a delimiter row, not a list item.
      const columns = header.includes('|') ? delimiterCells(line) : null;
      const headerCells = columns === null ? [] : splitTableRow(header);
      if (headerCells.length === columns) {
        table = { header: headerCells, rows: [] };
        tables.push(table);
        paragraph = [];
        continue;
      }
    }
    if (inner !== null) {
      const nested = atxHeading(inner);
      // A quote-only line continues the quote's paragraph; a list-item line starts a new one.
      const quoteContinuation = container && containers.indent === 0;
      if (
        nested === null &&
        quoteContinuation &&
        paragraph.length > 0 &&
        isSetextUnderline(inner)
      ) {
        headings.push(collapseWhitespace(paragraph.join(' ')));
        paragraph = [];
        continue;
      }
      listIndent = containers.quotes === 0 ? containers.indent : 0;
      container = true;
      if (nested !== null) headings.push(nested);
      if (nested !== null || inner.trim() === '') paragraph = [];
      else if (quoteContinuation) paragraph.push(inner.trim());
      else paragraph = [inner.trim()];
      continue;
    }
    if (container) {
      // A setext underline counts only inside the list item; a lazy line never underlines.
      if (listRest !== null && paragraph.length > 0 && isSetextUnderline(listRest)) {
        headings.push(collapseWhitespace(paragraph.join(' ')));
        paragraph = [];
        continue;
      }
      paragraph.push(line.trim());
      continue;
    }
    if (header === undefined && indentation(line) >= 4) continue;
    if (header === undefined && isSetextUnderline(line) && line.trim()[0] === '-') {
      // Without a paragraph above, `---` is a thematic break (or an empty list item), not text.
      continue;
    }
    if (header !== undefined && isSetextUnderline(line)) {
      headings.push(collapseWhitespace(paragraph.join(' ')));
      paragraph = [];
      continue;
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
 * with `,`) and an optional decimal part (`.5` is 0.5). A range such as `8–12` yields its first
 * number. A minus counts as a sign only at the start or after whitespace or `(`.
 */
export function parseFirstNumber(text: string, decimalSeparator: '.' | ','): number | null {
  const grouping = decimalSeparator === '.' ? ',' : '.';
  let start = 0;
  while (start < text.length && !isDigit(text[start])) start += 1;
  if (start === text.length) return null;
  // `.5` (or `,5`): a decimal part without an integer part.
  const fractionOnly = text[start - 1] === decimalSeparator && !isDigit(text[start - 2]);
  const signIndex = fractionOnly ? start - 2 : start - 1;
  const sign = text[signIndex];
  // A minus is a sign only at the start or after whitespace or `(`: `PM-5` is not negative.
  const negative =
    (sign === '-' || sign === '\u2212') && /^[\s(]?$/.test(text[signIndex - 1] ?? '');
  let index = start;
  let digits = '';
  while (isDigit(text[index])) digits += text[index++];
  if (fractionOnly) return finite(Number(`0.${digits}`), negative);
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
  return finite(Number(fraction ? `${digits}.${fraction}` : digits), negative);
}

/** A value too large for a double is no number at all (JSON would store `Infinity` as null). */
function finite(value: number, negative: boolean): number | null {
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}
