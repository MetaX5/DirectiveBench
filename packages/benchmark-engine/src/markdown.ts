/**
 * Markdown reading for the document assertions (SPEC-118 FR-118-41…44): a line-by-line GFM block
 * scanner that reads headings and tables as GitHub's cmark-gfm does (ADR-0013; verified against
 * its recorded readings in test/markdown-reference.test.ts). Every scan is linear in the input:
 * no regular expression runs over the whole text or a span that can backtrack (lessons
 * 2026-10-21 on delimited spans and superlinear parses). It reads Markdown, it never renders or
 * evaluates it.
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

/**
 * Deepest nesting of block quotes and list items the scanner follows. Every line re-checks each
 * open container, so the bound keeps a scan O(input × MAX_MARKDOWN_NESTING); a document nested
 * deeper ends the scan there — later headings and tables are not reported, never invented.
 */
export const MAX_MARKDOWN_NESTING = 32;

/** Most cells cmark-gfm reads in one table row (`uint16_t`); a wider row is no table row. */
export const MAX_TABLE_ROW_CELLS = 0xffff;

/**
 * cmark-gfm's budget of cells it fills in for short body rows (`MAX_AUTOCOMPLETED_CELLS`): once a
 * table has filled in more, the next line is no table row but starts a paragraph.
 */
export const MAX_TABLE_AUTOCOMPLETED_CELLS = 0x80000;

/** Columns per tab stop (CommonMark §2.2). */
const TAB_STOP = 4;
/** Indentation from which a line is indented code (CommonMark §4.4). */
const CODE_INDENT = 4;

/**
 * Whitespace as cmark-gfm's `cmark_isspace` reads it (space, tab, line feed, line tabulation, form
 * feed, carriage return). JavaScript's `trim` and `\s` also accept Unicode spaces such as U+00A0,
 * which cmark-gfm treats as content: a header row ending in one has an extra cell and is no table.
 */
const isMarkdownSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\v' || char === '\f' || char === '\r';

/** `text` without leading and trailing characters for which `isSpace` holds. */
function trimWith(text: string, isSpace: (char: string | undefined) => boolean): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text[start])) start += 1;
  while (end > start && isSpace(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** `text` without trailing characters for which `isSpace` holds. */
function trimEndWith(text: string, isSpace: (char: string | undefined) => boolean): string {
  let end = text.length;
  while (end > 0 && isSpace(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/**
 * Splits a table row into trimmed cells as cmark-gfm's `row_from_string` does; `\|` is a literal
 * pipe. `line` starts where cmark-gfm starts reading the row: after the indentation of spaces and
 * tabs, or at the line start for a lazy header line. Only a pipe as the very first character is a
 * leading pipe, so any other whitespace before it (`   |`, `\f|`) makes an empty first cell, and a
 * line of line tabulations or form feeds is one empty cell. A lone `|` (with optional whitespace)
 * has no cell and yields none: cmark-gfm reads no row there.
 */
export function splitTableRow(line: string): string[] {
  const leadingPipe = line.startsWith('|');
  if (leadingPipe && trimWith(line.slice(1), isMarkdownSpace) === '') return [];
  let text = trimEndWith(leadingPipe ? line.slice(1) : line, isMarkdownSpace);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(trimWith(cell, isMarkdownSpace));
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(trimWith(cell, isMarkdownSpace));
  return cells;
}

const isSpaceOrTab = (char: string | undefined): boolean => char === ' ' || char === '\t';

/**
 * A line being read, with the position after the container markers matched so far. Columns
 * follow tab stops; a tab can be consumed partly (CommonMark §2.2, the reference parsers'
 * `partiallyConsumedTab`).
 */
class Cursor {
  offset = 0;
  column = 0;
  nextNonspace = 0;
  nextNonspaceColumn = 0;
  indent = 0;
  blank = false;
  line = '';

  /** Starts reading `line` from its first column. */
  reset(line: string): void {
    this.line = line;
    this.offset = 0;
    this.column = 0;
  }

  /** Locates the next non-space character; sets `indent` (columns) and `blank`. */
  findNextNonspace(): void {
    let index = this.offset;
    let column = this.column;
    for (;;) {
      const char = this.line[index];
      if (char === ' ') column += 1;
      else if (char === '\t') column += TAB_STOP - (column % TAB_STOP);
      else break;
      index += 1;
    }
    this.blank = index >= this.line.length;
    this.nextNonspace = index;
    this.nextNonspaceColumn = column;
    this.indent = column - this.column;
  }

  get indented(): boolean {
    return this.indent >= CODE_INDENT;
  }

  advanceNextNonspace(): void {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
  }

  /** Advances `count` columns, consuming a tab only partly when it spans past them. */
  advance(count: number): void {
    let remaining = count;
    while (remaining > 0 && this.offset < this.line.length) {
      const width = this.line[this.offset] === '\t' ? TAB_STOP - (this.column % TAB_STOP) : 1;
      if (width > remaining) {
        this.column += remaining;
        return;
      }
      this.column += width;
      this.offset += 1;
      remaining -= width;
    }
  }

  /** The line from the current offset (a partly consumed tab is dropped: content is trimmed). */
  rest(): string {
    return this.line.slice(this.offset);
  }
}

/** The text of an ATX heading starting at `start` (`# Title #`), or null. */
function atxHeading(line: string, start: number): string | null {
  let level = 0;
  while (line[start + level] === '#') level += 1;
  if (level < 1 || level > 6) return null;
  const after = line[start + level];
  if (after !== undefined && !isSpaceOrTab(after)) return null;
  // Only spaces and tabs end the content (cmark-gfm keeps a trailing U+00A0 or form feed).
  let content = trimWith(line.slice(start + level), isSpaceOrTab);
  // An optional closing sequence of #s, preceded by whitespace (or forming the whole content).
  let hashes = content.length;
  while (hashes > 0 && content[hashes - 1] === '#') hashes -= 1;
  if (hashes < content.length && (hashes === 0 || isSpaceOrTab(content[hashes - 1]))) {
    content = content.slice(0, hashes);
  }
  return collapseWhitespace(content);
}

interface FenceMarker {
  char: string;
  length: number;
}

/** A run of `char` starting at `start`, and the index after it. */
function run(line: string, start: number, char: string): number {
  let end = start;
  while (line[end] === char) end += 1;
  return end;
}

/** An opening code fence at `start`: three or more backticks or tildes (CommonMark §4.5). */
function openingFence(line: string, start: number): FenceMarker | null {
  const char = line[start];
  if (char !== '`' && char !== '~') return null;
  const end = run(line, start, char);
  if (end - start < 3) return null;
  // A backtick fence's info string cannot contain a backtick.
  if (char === '`' && line.includes('`', end)) return null;
  return { char, length: end - start };
}

/** True when only spaces and tabs follow `start`. */
function onlyWhitespaceFrom(line: string, start: number): boolean {
  for (let index = start; index < line.length; index += 1) {
    if (!isSpaceOrTab(line[index])) return false;
  }
  return true;
}

function closesFence(line: string, start: number, fence: FenceMarker): boolean {
  const end = run(line, start, fence.char);
  return end - start >= fence.length && onlyWhitespaceFrom(line, end);
}

/** A setext underline at `start`: `=` or `-` only, then optional spaces (CommonMark §4.3). */
function setextUnderline(line: string, start: number): boolean {
  const char = line[start];
  return (char === '=' || char === '-') && onlyWhitespaceFrom(line, run(line, start, char));
}

/** Three or more `-`, `*` or `_` from `start`, spaces and tabs allowed between (§4.1). */
function isThematicBreak(line: string, start: number): boolean {
  const marker = line[start];
  if (marker !== '-' && marker !== '*' && marker !== '_') return false;
  let count = 0;
  for (let index = start; index < line.length; index += 1) {
    const char = line[index];
    if (char === marker) count += 1;
    else if (!isSpaceOrTab(char)) return false;
  }
  return count >= 3;
}

/**
 * A GFM delimiter row at `start` (`| --- | :-: |`): its cell count and whether it has a pipe, or
 * null. Only `|`, `:`, `-` and whitespace may occur.
 */
function delimiterRow(line: string, start: number): { columns: number; pipe: boolean } | null {
  let pipe = false;
  for (let index = start; index < line.length; index += 1) {
    const char = line[index] as string;
    if (char === '|') pipe = true;
    // Line tabulation and form feed count as whitespace here, as in cmark-gfm's table scanner.
    else if (char !== ':' && char !== '-' && !isMarkdownSpace(char)) return null;
  }
  const cells = splitTableRow(line.slice(start));
  return cells.length > 0 &&
    cells.length <= MAX_TABLE_ROW_CELLS &&
    cells.every((cell) => /^:?-+:?$/.test(cell))
    ? { columns: cells.length, pipe }
    : null;
}

/**
 * HTML block kinds (CommonMark §4.6): 1–5 end at a line containing their terminator, 6 and 7 at
 * a blank line; kind 7 cannot interrupt a paragraph. The content of an HTML block is not Markdown.
 */
type HtmlKind = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const RAW_TEXT_TAGS = ['script', 'pre', 'style', 'textarea'];
const HTML_TERMINATORS: Record<1 | 2 | 3 | 4 | 5, readonly string[]> = {
  1: RAW_TEXT_TAGS.map((tag) => `</${tag}>`),
  2: ['-->'],
  3: ['?>'],
  4: ['>'],
  5: [']]>'],
};
/** Block-level tag names of HTML kind 6 (CommonMark 0.31 §4.6, as markdown-it 15 lists them). */
const BLOCK_TAGS = new Set(
  (
    'address article aside base basefont blockquote body caption center col colgroup dd ' +
    'details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 ' +
    'h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol ' +
    'optgroup option p param search section summary table tbody td tfoot th thead title tr ' +
    'track ul'
  ).split(' '),
);

/**
 * The end of a run matched by the sticky, single-character-class `pattern` at `start`, or -1.
 * Every pattern here is one character class with a quantifier, so a match cannot backtrack.
 */
function runEnd(pattern: RegExp, line: string, start: number): number {
  pattern.lastIndex = start;
  return pattern.test(line) ? pattern.lastIndex : -1;
}

const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;
const ATTRIBUTE_NAME = /[A-Za-z_:][A-Za-z0-9_.:-]*/y;
// HTML whitespace is `cmark_isspace`'s, not JavaScript's `\s` (see `isMarkdownSpace`).
const UNQUOTED_VALUE = /[^ \t\n\v\f\r"'=<>`]+/y;
const HTML_WHITESPACE = /[ \t\n\v\f\r]*/y;
// After a complete tag (kind 7) cmark-gfm accepts spaces, tabs and form feeds, not a line tabulation.
const ONLY_WHITESPACE = /[ \t\f]*$/y;

/**
 * True when `line` from `start` is one complete open or closing tag followed only by whitespace
 * (HTML kind 7). One left-to-right pass without backtracking.
 */
function isCompleteTagLine(line: string, start: number): boolean {
  const closing = line[start + 1] === '/';
  let index = runEnd(TAG_NAME, line, start + (closing ? 2 : 1));
  if (index < 0) return false;
  if (!closing) {
    for (;;) {
      const afterSpace = runEnd(HTML_WHITESPACE, line, index);
      // An attribute needs whitespace before its name.
      const nameEnd = afterSpace === index ? -1 : runEnd(ATTRIBUTE_NAME, line, afterSpace);
      if (nameEnd < 0) {
        index = afterSpace;
        break;
      }
      index = nameEnd;
      const beforeValue = runEnd(HTML_WHITESPACE, line, index);
      if (line[beforeValue] !== '=') continue;
      const value = runEnd(HTML_WHITESPACE, line, beforeValue + 1);
      const quote = line[value];
      if (quote === '"' || quote === "'") {
        const close = line.indexOf(quote, value + 1);
        if (close < 0) return false;
        index = close + 1;
      } else {
        index = runEnd(UNQUOTED_VALUE, line, value);
        if (index < 0) return false;
      }
    }
    if (line[index] === '/') index += 1;
  } else {
    index = runEnd(HTML_WHITESPACE, line, index);
  }
  return line[index] === '>' && runEnd(ONLY_WHITESPACE, line, index + 1) >= 0;
}

/** The HTML block kind starting at `start`, or null. */
function htmlBlockStart(line: string, start: number): HtmlKind | null {
  if (line[start] !== '<') return null;
  const lower = line.slice(start, start + 12).toLowerCase();
  for (const tag of RAW_TEXT_TAGS) {
    const after = lower[tag.length + 1];
    if (
      lower.startsWith(`<${tag}`) &&
      (after === undefined || after === '>' || isMarkdownSpace(after))
    )
      return 1;
  }
  if (lower.startsWith('<!--')) return 2;
  if (lower.startsWith('<?')) return 3;
  if (lower.startsWith('<!') && /^[a-z]$/.test(lower[2] ?? '')) return 4;
  if (line.startsWith('<![CDATA[', start)) return 5;
  const nameStart = start + (line[start + 1] === '/' ? 2 : 1);
  const nameEnd = runEnd(TAG_NAME, line, nameStart);
  if (nameEnd > 0 && BLOCK_TAGS.has(line.slice(nameStart, nameEnd).toLowerCase())) {
    const after = line[nameEnd];
    if (
      after === undefined ||
      after === '>' ||
      isMarkdownSpace(after) ||
      line.startsWith('/>', nameEnd)
    ) {
      return 6;
    }
  }
  return isCompleteTagLine(line, start) ? 7 : null;
}

function endsHtmlBlock(kind: HtmlKind, text: string): boolean {
  if (kind === 6 || kind === 7) return false;
  const haystack = kind === 1 ? text.toLowerCase() : text;
  return HTML_TERMINATORS[kind].some((terminator) => haystack.includes(terminator));
}

/** A list-item marker at the cursor (CommonMark §5.2), or null. */
function listMarker(
  cursor: Cursor,
  interruptsParagraph: boolean,
): { length: number; markerOffset: number } | null {
  const { line, nextNonspace: start } = cursor;
  const char = line[start];
  let end = start;
  if (char === '-' || char === '+' || char === '*') {
    end = start + 1;
  } else {
    while (end - start < 9 && isDigit(line[end])) end += 1;
    if (end === start || (line[end] !== '.' && line[end] !== ')')) return null;
    // Only an ordered list starting at 1 may interrupt a paragraph.
    if (interruptsParagraph && Number(line.slice(start, end)) !== 1) return null;
    end += 1;
  }
  const after = line[end];
  if (after !== undefined && !isSpaceOrTab(after)) return null;
  // An empty list item cannot interrupt a paragraph.
  if (interruptsParagraph && onlyWhitespaceFrom(line, end)) return null;
  return { length: end - start, markerOffset: cursor.indent };
}

type Container = { kind: 'quote' } | { kind: 'item'; width: number; hasChild: boolean };

type Leaf =
  | { kind: 'paragraph'; lines: string[]; noTable: boolean }
  | { kind: 'fence'; marker: FenceMarker }
  | { kind: 'code' }
  | { kind: 'html'; html: HtmlKind }
  | { kind: 'table'; table: MarkdownTable; autocompleted: number };

/** Moves the cursor past a block-quote marker and its optional space. */
function enterQuote(cursor: Cursor): void {
  cursor.advanceNextNonspace();
  cursor.advance(1);
  if (isSpaceOrTab(cursor.line[cursor.offset])) cursor.advance(1);
}

/**
 * Scans ATX and setext headings of any level and GFM tables the way CommonMark 0.31 with the GFM
 * table extension reads them: block quotes and list items (with lazy continuation and tab stops)
 * are containers, fenced and indented code and HTML blocks hide their content. The algorithm is
 * the reference parsers' line-by-line block phase (CommonMark spec, "A parsing strategy"); inline
 * content is never parsed, and neither are link reference definitions: a setext heading whose
 * paragraph may start with one is not reported. Linear in the input times MAX_MARKDOWN_NESTING.
 */
export function scanMarkdown(text: string): MarkdownScan {
  const headings: string[] = [];
  const tables: MarkdownTable[] = [];
  const containers: Container[] = [];
  let leaf: Leaf | null = null;

  /** Closes the containers beyond `depth` and the open leaf with them. */
  const closeFrom = (depth: number) => {
    if (depth < containers.length) {
      containers.length = depth;
      leaf = null;
    }
  };
  // Read through a call: the leaf also changes inside the closures, which narrowing cannot see.
  const currentLeaf = (): Leaf | null => leaf;
  /** Marks the innermost container as having content (an item can start with one blank line). */
  const markChild = () => {
    const parent = containers.at(-1);
    if (parent?.kind === 'item') parent.hasChild = true;
  };

  const cursor = new Cursor();
  // After a blank line only list items with content remain open, and each continues on the next
  // blank line: consecutive blank lines skip the walk (a blank line cannot open a container).
  let afterBlankLine = false;
  // One byte order mark at the start is no content, as in cmark-gfm (`readFile` keeps it).
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  for (const line of body.split(/\r\n|\r|\n/)) {
    cursor.reset(line);
    const blankLine = onlyWhitespaceFrom(line, 0);
    // 1. Continue the open containers.
    let matched = blankLine && afterBlankLine ? containers.length : 0;
    afterBlankLine = blankLine;
    for (const container of containers.slice(matched)) {
      cursor.findNextNonspace();
      if (container.kind === 'quote') {
        if (cursor.indented || line[cursor.nextNonspace] !== '>') break;
        enterQuote(cursor);
      } else if (cursor.blank) {
        if (!container.hasChild) break;
        cursor.advanceNextNonspace();
      } else if (cursor.indent >= container.width) {
        cursor.advance(container.width);
      } else {
        break;
      }
      matched += 1;
    }
    const allMatched = matched === containers.length;

    // 2. Continue the open leaf.
    let leafContinues = false;
    if (allMatched && leaf) {
      cursor.findNextNonspace();
      const open: Leaf = leaf;
      if (open.kind === 'fence') {
        if (!cursor.indented && closesFence(line, cursor.nextNonspace, open.marker)) {
          leaf = null;
          continue;
        }
        leafContinues = true;
      } else if (open.kind === 'code') {
        leafContinues = cursor.indented || cursor.blank;
      } else if (open.kind === 'html') {
        leafContinues = !(cursor.blank && open.html >= 6);
      } else {
        leafContinues = !cursor.blank;
      }
    }
    const inLeafBlock =
      leafContinues && (leaf?.kind === 'fence' || leaf?.kind === 'code' || leaf?.kind === 'html');

    // 3. Open new blocks.
    let started = false;
    let lineDone = false;
    // Where the line's content starts before its indentation is skipped.
    let contentStart = cursor.offset;
    if (!inLeafBlock) {
      for (;;) {
        cursor.findNextNonspace();
        const start = cursor.nextNonspace;
        const current = currentLeaf();
        const inParagraph: boolean = allMatched && !started && current?.kind === 'paragraph';
        const openBlock = () => {
          closeFrom(matched);
          leaf = null;
          markChild();
          started = true;
        };
        if (!cursor.indented && line[start] === '>') {
          if (matched >= MAX_MARKDOWN_NESTING) return { headings, tables };
          openBlock();
          containers.push({ kind: 'quote' });
          matched = containers.length;
          enterQuote(cursor);
          continue;
        }
        if (!cursor.indented) {
          const atx = atxHeading(line, start);
          if (atx !== null) {
            openBlock();
            headings.push(atx);
            lineDone = true;
            break;
          }
          const fence = openingFence(line, start);
          if (fence) {
            openBlock();
            leaf = { kind: 'fence', marker: fence };
            lineDone = true;
            break;
          }
          const html = htmlBlockStart(line, start);
          // Kind 7 cannot interrupt a paragraph; a lazy continuation line is no paragraph yet (cmark).
          if (html !== null && (html < 7 || !inParagraph)) {
            openBlock();
            leaf = { kind: 'html', html };
            if (endsHtmlBlock(html, cursor.rest())) leaf = null;
            lineDone = true;
            break;
          }
          if (inParagraph && setextUnderline(line, start)) {
            const paragraph = current as Extract<Leaf, { kind: 'paragraph' }>;
            // A paragraph may start with link reference definitions, which are no heading text. They
            // are not parsed, and cmark-gfm reads the underline as paragraph text when only
            // definitions precede it, or as a heading of the text after them otherwise; the blocks
            // that may follow differ between the two. The scan stops here (fail-safe): nothing
            // below is reported. A label may span lines, so `]:` counts on any line.
            const first = paragraph.lines[0] as string;
            if (/^ {0,3}\[/.test(first) && paragraph.lines.some((l) => l.includes(']:'))) {
              return { headings, tables };
            }
            headings.push(collapseWhitespace(paragraph.lines.join(' ')));
            leaf = null;
            started = true;
            lineDone = true;
            break;
          }
          if (isThematicBreak(line, start)) {
            openBlock();
            lineDone = true;
            break;
          }
          const marker = listMarker(cursor, inParagraph);
          if (marker) {
            if (matched >= MAX_MARKDOWN_NESTING) return { headings, tables };
            openBlock();
            cursor.advanceNextNonspace();
            cursor.advance(marker.length);
            // Content starts after 1–4 spaces; 5 or more mean indented code after one space.
            const markerColumn = cursor.column;
            const markerOffset = cursor.offset;
            do cursor.advance(1);
            while (cursor.column - markerColumn < 5 && isSpaceOrTab(line[cursor.offset]));
            const spaces = cursor.column - markerColumn;
            let padding = marker.length + spaces;
            if (spaces >= 5 || spaces < 1 || cursor.offset >= line.length) {
              padding = marker.length + 1;
              cursor.column = markerColumn;
              cursor.offset = markerOffset;
              if (isSpaceOrTab(line[cursor.offset])) cursor.advance(1);
            }
            containers.push({
              kind: 'item',
              width: marker.markerOffset + padding,
              hasChild: false,
            });
            matched = containers.length;
            continue;
          }
          // GFM tables are tried last, as the reference implementation tries its extensions.
          const delimiter = inParagraph ? delimiterRow(line, start) : null;
          if (delimiter) {
            const paragraph = current as Extract<Leaf, { kind: 'paragraph' }>;
            const last = paragraph.lines.at(-1) as string;
            // cmark-gfm (GitHub) keeps a lazy line's indentation: `   | a |` has an empty first
            // cell. A lone pipe has no cell, so cmark-gfm opens no table on it.
            const header = splitTableRow(last);
            if (!paragraph.noTable && header.length === delimiter.columns) {
              const table: MarkdownTable = { header, rows: [] };
              // Reported only with a pipe in both rows, which every GFM reader accepts; without one
              // it is read as a table (its lines are no paragraph or heading) but not reported.
              if (delimiter.pipe && last.includes('|')) tables.push(table);
              leaf = { kind: 'table', table, autocompleted: 0 };
              started = true;
              lineDone = true;
              break;
            }
            // cmark-gfm opens no table later in a paragraph that already held a delimiter row.
            paragraph.noTable = true;
          }
        } else if (current?.kind !== 'paragraph' && !cursor.blank) {
          openBlock();
          leaf = { kind: 'code' };
          lineDone = true;
          break;
        }
        contentStart = cursor.offset;
        cursor.advanceNextNonspace();
        break;
      }
    }
    if (lineDone) continue;

    // 4. Lazy paragraph continuation, or add the line to the open (or a new) block.
    const tip = currentLeaf();
    if (!allMatched && !started && !cursor.blank && tip?.kind === 'paragraph') {
      // A lazy line keeps its indentation (cmark-gfm), which matters for a table header.
      tip.lines.push(line.slice(contentStart));
      continue;
    }
    closeFrom(matched);
    if (!started && !leafContinues) leaf = null;
    const open = currentLeaf();
    if (open?.kind === 'paragraph') {
      open.lines.push(cursor.rest());
    } else if (open?.kind === 'html') {
      if (endsHtmlBlock(open.html, cursor.rest())) leaf = null;
    } else if (open?.kind === 'table') {
      const cells = splitTableRow(cursor.rest());
      if (
        // A lone pipe has no cell, so cmark-gfm reads no row: the table ends.
        cells.length === 0 ||
        cells.length > MAX_TABLE_ROW_CELLS ||
        open.autocompleted > MAX_TABLE_AUTOCOMPLETED_CELLS
      ) {
        // cmark-gfm ends the table here; the line starts a paragraph.
        leaf = { kind: 'paragraph', lines: [cursor.rest()], noTable: false };
      } else {
        open.autocompleted += Math.max(0, open.table.header.length - cells.length);
        open.table.rows.push({ text: line, cells });
      }
    } else if (open === null && !cursor.blank) {
      markChild();
      leaf = { kind: 'paragraph', lines: [cursor.rest()], noTable: false };
    }
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
