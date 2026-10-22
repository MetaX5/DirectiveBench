/**
 * The longest import token, in UTF-16 code units, that is resolved. A longer token names a path
 * longer than `PATH_MAX` (4096 bytes on Linux, 1024 on macOS), which no file system call can open
 * — unless `.`/`..` segments, repeated `/` or escaped spaces shorten it when it is normalised, in
 * which case it is reported as {@link ImportCandidate} `too-long` and the scan fails closed.
 */
export const IMPORT_TOKEN_MAX_LENGTH = 4096;

/**
 * A path an `@` import could name that needs a file system check (SPEC-118 FR-118-27):
 *
 * - `absolute` — starts with `/`;
 * - `home` — `~` or `~/…`, resolved against the agent's `HOME`;
 * - `relative` — relative to the containing file and containing a `..` segment (a relative token
 *   without one stays below its file's directory and is never reported);
 * - `too-long` — longer than {@link IMPORT_TOKEN_MAX_LENGTH} but possibly shorter once normalised
 *   (`token` holds its first characters only).
 */
export interface ImportCandidate {
  kind: 'absolute' | 'home' | 'relative' | 'too-long';
  token: string;
}

const AT = 0x40;
const BACKSLASH = 0x5c;
const DOT = 0x2e;
const SLASH = 0x2f;
const SPACE = 0x20;
const TILDE = 0x7e;

/** Characters that may close a sentence after a path; a variant without them is also checked. */
const TRAILING_PUNCTUATION = new Set(
  ['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', "'", '"', '`'].map((c) => c.charCodeAt(0)),
);

/** JavaScript's `\s`: what a regular expression in Claude Code would treat as whitespace. */
function isWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === SPACE ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Where a word that starts at `start` ends: at whitespace, except a space escaped by `\`. */
function wordEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === BACKSLASH && text.charCodeAt(index + 1) === SPACE) {
      index += 2;
    } else if (isWhitespace(code)) {
      break;
    } else {
      index += 1;
    }
  }
  return index;
}

/**
 * Tokens of one whitespace-delimited word. Every `@` starts a token running to the end of the word
 * — a superset of Claude Code's own rule (an `@` after whitespace). For each token the candidate
 * paths are: the whole token, the token cut at the first `\` that does not escape a space (where
 * a `(?:[^\s\\]|\\ )+` pattern would stop), each without its trailing punctuation, and each with
 * `\ ` unescaped and kept as written. The word is processed right to left, so what lies after a
 * token start (a `..` segment, a shortening sequence, the next lone backslash) is known in O(1)
 * per `@` and the whole word costs O(length) plus O(candidate length) for reported candidates.
 */
function* wordCandidates(text: string, start: number, end: number): Generator<ImportCandidate> {
  const code = (index: number) => (index < end ? text.charCodeAt(index) : -1);
  const trailingPunctuationStart = (stop: number) => {
    let index = stop;
    while (index > start && TRAILING_PUNCTUATION.has(code(index - 1))) index -= 1;
    return index;
  };
  const wordPunctuation = trailingPunctuationStart(end);
  let seenDotDot = false;
  let seenShortening = false;
  let loneBackslash = -1;
  let loneBackslashPunctuation = -1;
  /**
   * A `.`/`..` segment may end here in some candidate: at the end of the word, a `/`, or where a
   * variant may be cut — any backslash or punctuation character (conservative: a cut variant
   * strips the whole punctuation run, while Claude Code might strip less).
   */
  const segmentEnds = (index: number) =>
    index >= end ||
    code(index) === SLASH ||
    code(index) === BACKSLASH ||
    TRAILING_PUNCTUATION.has(code(index));
  for (let index = end - 1; index >= start; index -= 1) {
    const current = code(index);
    if (current === BACKSLASH) {
      // An escaped space becomes one character; a lone backslash is kept (and cuts a variant).
      if (code(index + 1) === SPACE) {
        seenShortening = true;
      } else {
        loneBackslash = index;
        loneBackslashPunctuation = trailingPunctuationStart(index);
      }
    } else if (current === SLASH) {
      const next = code(index + 1);
      if (next === SLASH || (next === DOT && segmentEnds(index + 2))) seenShortening = true;
      if (next === DOT && code(index + 2) === DOT && segmentEnds(index + 3)) {
        seenShortening = true;
        seenDotDot = true;
      }
    } else if (current === AT && index + 1 < end) {
      yield* tokenCandidates(index + 1);
    }
  }

  function* tokenCandidates(tokenStart: number): Generator<ImportCandidate> {
    const first = code(tokenStart);
    const startsWithDot = first === DOT;
    const startsWithDotDot =
      startsWithDot && code(tokenStart + 1) === DOT && segmentEnds(tokenStart + 2);
    const afterTilde = tokenStart + 1;
    const home =
      first === TILDE &&
      (code(afterTilde) === SLASH ||
        afterTilde === end ||
        afterTilde === wordPunctuation ||
        afterTilde === loneBackslash ||
        afterTilde === loneBackslashPunctuation);
    const kind: ImportCandidate['kind'] = first === SLASH ? 'absolute' : home ? 'home' : 'relative';
    // A relative token without a `..` segment cannot leave its file's directory (O(1) per `@`).
    if (kind === 'relative' && !startsWithDotDot && !seenDotDot) return;
    const ends = new Set([end, Math.max(wordPunctuation, tokenStart)]);
    if (loneBackslash >= 0) {
      ends.add(loneBackslash);
      ends.add(Math.max(loneBackslashPunctuation, tokenStart));
    }
    const yielded = new Set<string>();
    for (const stop of ends) {
      if (stop <= tokenStart) continue;
      if (stop - tokenStart > IMPORT_TOKEN_MAX_LENGTH) {
        if (seenShortening || startsWithDot) {
          yield { kind: 'too-long', token: text.slice(tokenStart, tokenStart + 200) };
          return;
        }
        continue;
      }
      const raw = text.slice(tokenStart, stop);
      for (const token of raw.includes('\\ ') ? [raw.replaceAll('\\ ', ' '), raw] : [raw]) {
        // A `~` followed only by punctuation is home only once the punctuation is stripped.
        if (yielded.has(token) || (kind === 'home' && token !== '~' && !token.startsWith('~/'))) {
          continue;
        }
        yielded.add(token);
        yield { kind, token };
      }
    }
  }
}

/**
 * Every import candidate in `text` that needs a file system check (FR-118-27): one linear pass
 * over the text, treating every `@` followed by a non-whitespace character as an import token.
 * Code spans and fences are not excluded, which only adds tokens.
 */
export function* importCandidates(text: string): Generator<ImportCandidate> {
  let index = 0;
  // The next `@` at or after `index`; searched again only once passed, so the search is linear.
  let nextAt = text.indexOf('@');
  while (nextAt !== -1 && index < text.length) {
    if (isWhitespace(text.charCodeAt(index))) {
      index += 1;
      continue;
    }
    const end = wordEnd(text, index);
    if (nextAt < end) yield* wordCandidates(text, index, end);
    index = end;
    if (nextAt < index) nextAt = text.indexOf('@', index);
  }
}
