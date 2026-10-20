/**
 * A small, safe Markdown parser for previewing artifact content (SPEC-101 FR-101-18, SPEC-007 T1).
 *
 * It returns a syntax tree that the web app renders as React elements, so content is only ever
 * text nodes and a fixed set of elements: raw HTML (`<script>`, `<img onerror>`, …) stays literal
 * text, links are kept only for `http:`, `https:` and `mailto:` URLs, and images are never loaded.
 * No HTML string is produced anywhere, so there is nothing to sanitise afterwards.
 *
 * It covers the CommonMark subset artifacts use — ATX headings, paragraphs, fenced code,
 * block quotes, lists, thematic breaks, GFM tables, code spans, emphasis, links, autolinks — and
 * shows a leading YAML frontmatter block as code. Anything it does not recognise is shown as text.
 * Every scan is linear in the input: searches for a closing delimiter remember failures, and
 * nesting is capped, so crafted content cannot make rendering slow or overflow the stack.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'emphasis'; children: Inline[] }
  /** `href` is null when the destination is not a safe absolute URL: the link is inert. */
  | { kind: 'link'; href: string | null; destination: string; children: Inline[] }
  /** Images are never loaded (local-first: no requests to third-party hosts). */
  | { kind: 'image'; alt: string; destination: string };

export type Block =
  | { kind: 'frontmatter'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'rule' }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] };

/** Content longer than this is not rendered; the raw view still shows all of it (NFR-101-02). */
export const MAX_RENDERED_MARKDOWN_CHARS = 200_000;

/** Block quotes and lists nested deeper than this are shown as plain text. */
export const MAX_MARKDOWN_NESTING = 16;

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * The URL a link may point to, or null to render it inert. Only absolute `http:`, `https:` and
 * `mailto:` URLs are allowed; the WHATWG URL parser strips the tabs, newlines and leading control
 * characters a browser would, so `java\tscript:` is recognised as `javascript:` and rejected.
 * Relative links are inert too: they are relative to the artifact's repository, not to this app.
 */
export function safeHref(destination: string): string | null {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return null;
  }
  return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|mdc|markdown)$/i.test(path);
}

// ---------------------------------------------------------------------------------------------
// Blocks

// `[\s\S]` rather than `.`: `.` stops at U+2028, which would make an anchored match backtrack.
const FENCE = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]([\s\S]*))?$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?([\s\S]*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)([^ \t][\s\S]*)?)?$/;

/** The heading text without a closing sequence of `#` (one preceded by a space or alone). */
function headingText(text: string): string {
  const trimmed = text.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === '#') end -= 1;
  if (end === 0) return '';
  return /[ \t]/.test(trimmed[end - 1] as string) ? trimmed.slice(0, end).trim() : trimmed;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

interface ListMarker {
  ordered: boolean;
  /** The marker character (`-`, `*`, `+`) or delimiter (`.`, `)`): a different one ends a list. */
  delimiter: string;
  start: number;
  /** Columns before the item content; continuation lines are indented at least this much. */
  contentIndent: number;
  content: string;
}

function listMarker(line: string): ListMarker | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const [, indent = '', marker = '', spacing = '', content = ''] = match;
  const ordered = /\d/.test(marker);
  return {
    ordered,
    delimiter: ordered ? marker.slice(-1) : marker,
    start: ordered ? Number(marker.slice(0, -1)) : 1,
    // An empty item or one with 5+ spaces of padding starts its content one column after the marker.
    contentIndent: indent.length + marker.length + (spacing.length > 4 ? 1 : spacing.length || 1),
    content: spacing.length > 4 ? spacing.slice(1) + content : content,
  };
}

function sameList(a: ListMarker, b: ListMarker): boolean {
  return a.ordered === b.ordered && a.delimiter === b.delimiter;
}

/** Whether a line starts a block that interrupts a paragraph. */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    !!listMarker(line)
  );
}

/** Splits a table row into cell sources: outer pipes are optional, `\|` is a literal pipe. */
function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (char === '\\' && row[i + 1] === '|') {
      cell += '|';
      i += 1;
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

function isTableDelimiter(line: string): boolean {
  return line.includes('-') && tableCells(line).every((cell) => /^:?-+:?$/.test(cell));
}

function parseBlocks(lines: string[], depth: number, topLevel: boolean): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  if (topLevel && lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end > 0) {
      blocks.push({ kind: 'frontmatter', text: lines.slice(1, end).join('\n') });
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker = '', info = ''] = fence;
      // A backtick fence's info string cannot contain a backtick; such a line is a paragraph.
      if (!(marker.startsWith('`') && info.includes('`'))) {
        const closing = new RegExp(
          `^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`,
        );
        const body: string[] = [];
        i += 1;
        while (i < lines.length && !closing.test(lines[i] as string)) {
          body.push(lines[i] as string);
          i += 1;
        }
        i += 1; // the closing fence, or past the end
        blocks.push({
          kind: 'code',
          language: info.trim().split(/\s+/)[0] || null,
          text: body.join('\n'),
        });
        continue;
      }
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const [, hashes = '', text = ''] = heading;
      blocks.push({
        kind: 'heading',
        level: hashes.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(headingText(text)),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (depth < MAX_MARKDOWN_NESTING && QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const quoted = QUOTE.exec(lines[i] as string);
        if (quoted) inner.push(quoted[1] as string);
        else if (!isBlank(lines[i] as string) && !startsBlock(lines[i] as string) && inner.length) {
          inner.push(lines[i] as string); // lazy continuation of the quoted paragraph
        } else break;
        i += 1;
      }
      blocks.push({ kind: 'quote', children: parseBlocks(inner, depth + 1, false) });
      continue;
    }

    const first = depth < MAX_MARKDOWN_NESTING ? listMarker(line) : null;
    if (first) {
      const items: Block[][] = [];
      let marker: ListMarker | null = first;
      while (marker) {
        const itemLines = [marker.content];
        i += 1;
        let next: ListMarker | null = null;
        while (i < lines.length) {
          const current = lines[i] as string;
          if (isBlank(current)) {
            // Blank lines continue the item only if indented content follows them.
            let j = i;
            while (j < lines.length && isBlank(lines[j] as string)) j += 1;
            if (j === lines.length || indentOf(lines[j] as string) < marker.contentIndent) break;
            for (; i < j; i += 1) itemLines.push('');
            continue;
          } else if (indentOf(current) >= marker.contentIndent) {
            itemLines.push(current.slice(marker.contentIndent));
          } else {
            const sibling = listMarker(current);
            if (sibling) {
              if (sameList(first, sibling)) next = sibling;
              break;
            }
            const previous = itemLines.at(-1) as string;
            if (isBlank(previous) || startsBlock(current)) break;
            itemLines.push(current.trimStart()); // lazy continuation of the item's paragraph
          }
          i += 1;
        }
        items.push(parseBlocks(itemLines, depth + 1, false));
        if (next === null && i < lines.length && isBlank(lines[i] as string)) {
          // Items separated by a blank line still belong to one list.
          let j = i;
          while (j < lines.length && isBlank(lines[j] as string)) j += 1;
          const after = j < lines.length ? listMarker(lines[j] as string) : null;
          if (after && sameList(first, after)) {
            next = after;
            i = j;
          }
        }
        marker = next;
      }
      blocks.push({ kind: 'list', ordered: first.ordered, start: first.start, items });
      continue;
    }

    const delimiter = lines[i + 1];
    if (line.includes('|') && delimiter !== undefined && isTableDelimiter(delimiter)) {
      const header = tableCells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (
        i < lines.length &&
        !isBlank(lines[i] as string) &&
        (lines[i] as string).includes('|')
      ) {
        // A row keeps its own cells (at most the header's): padding short rows to the header's
        // width would let a wide header and many empty rows multiply the output (PR #50 review).
        const cells = tableCells(lines[i] as string).slice(0, header.length);
        rows.push(cells.map((cell) => parseInline(cell)));
        i += 1;
      }
      blocks.push({ kind: 'table', header: header.map((cell) => parseInline(cell)), rows });
      continue;
    }

    const paragraph = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlank(lines[i] as string) && !startsBlock(lines[i] as string)) {
      paragraph.push((lines[i] as string).trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }
  return blocks;
}

/** Parses Markdown into blocks. Callers check `MAX_RENDERED_MARKDOWN_CHARS` first. */
export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.split(/\r\n|\r|\n/), 0, true);
}

// ---------------------------------------------------------------------------------------------
// Inlines

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;

/** The length of the run of `char` starting at `start`. */
function runLength(text: string, start: number, char: string): number {
  let end = start;
  while (text[end] === char) end += 1;
  return end - start;
}

/**
 * Parses inline Markdown. The result of every closing-delimiter search is remembered: searches for
 * one delimiter start at non-decreasing positions, so a remembered match at or after the start is
 * still the next one, and a failed search stays failed. That keeps the scan linear on input such
 * as many `[` before one `]`.
 */
export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let buffer = '';
  /** Per delimiter, the index of its last search result (-1: none after that point). */
  const found = new Map<string, number>();
  const flush = () => {
    if (buffer) nodes.push({ kind: 'text', text: buffer });
    buffer = '';
  };
  /** The index of `needle` at or after `from`, or -1. */
  const find = (needle: string, from: number): number => {
    const known = found.get(needle);
    if (known !== undefined && (known < 0 || known >= from)) return known;
    const index = text.indexOf(needle, from);
    found.set(needle, index);
    return index;
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;

    if (char === '\\' && i + 1 < text.length && ASCII_PUNCTUATION.test(text[i + 1] as string)) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    if (char === '`') {
      const length = runLength(text, i, '`');
      // An unmatched run of one length cannot recur (it would have closed this one), so each
      // length is searched for to the end at most once.
      let close = -1;
      for (let j = text.indexOf('`', i + length); j >= 0; j = text.indexOf('`', j)) {
        const run = runLength(text, j, '`');
        if (run === length) {
          close = j;
          break;
        }
        j += run;
      }
      if (close < 0) {
        buffer += '`'.repeat(length);
        i += length;
        continue;
      }
      let code = text.slice(i + length, close).replaceAll('\n', ' ');
      if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) {
        code = code.slice(1, -1);
      }
      flush();
      nodes.push({ kind: 'code', text: code });
      i = close + length;
      continue;
    }

    const image = char === '!' && text[i + 1] === '[';
    if (char === '[' || image) {
      const labelStart = i + (image ? 2 : 1);
      const labelEnd = find(']', labelStart);
      if (labelEnd >= 0 && text[labelEnd + 1] === '(') {
        const destinationEnd = find(')', labelEnd + 2);
        if (destinationEnd >= 0) {
          const inside = text.slice(labelEnd + 2, destinationEnd).trim();
          const destination =
            inside.startsWith('<') && inside.includes('>')
              ? inside.slice(1, inside.indexOf('>'))
              : (inside.split(/\s/)[0] as string);
          const label = text.slice(labelStart, labelEnd);
          flush();
          nodes.push(
            image
              ? { kind: 'image', alt: label, destination }
              : {
                  kind: 'link',
                  href: safeHref(destination),
                  destination,
                  children: parseInline(label),
                },
          );
          i = destinationEnd + 1;
          continue;
        }
      }
      buffer += char;
      i += 1;
      continue;
    }

    if (char === '<') {
      const autolink = AUTOLINK.exec(text.slice(i, i + 2048));
      if (autolink) {
        const destination = autolink[1] as string;
        flush();
        nodes.push({
          kind: 'link',
          href: safeHref(destination),
          destination,
          children: [{ kind: 'text', text: destination }],
        });
        i += autolink[0].length;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const double = text[i + 1] === char;
      const delimiter = double ? char + char : char;
      const previous = text[i - 1] ?? ' ';
      // `_` inside a word (snake_case) is not emphasis.
      const intraword = char === '_' && /[\p{L}\p{N}]/u.test(previous);
      const close = intraword ? -1 : find(delimiter, i + delimiter.length);
      const inner = close >= 0 ? text.slice(i + delimiter.length, close) : '';
      const after = text[close + delimiter.length] ?? ' ';
      if (
        inner.trim() &&
        inner === inner.trim() &&
        !(char === '_' && /[\p{L}\p{N}]/u.test(after))
      ) {
        flush();
        nodes.push({ kind: double ? 'strong' : 'emphasis', children: parseInline(inner) });
        i = close + delimiter.length;
        continue;
      }
      buffer += delimiter;
      i += delimiter.length;
      continue;
    }

    buffer += char;
    i += 1;
  }
  flush();
  return nodes;
}
