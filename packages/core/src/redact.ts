/** What `redactSecrets` puts in place of a secret. */
export const REDACTION_MARKER = '[REDACTED]';

/**
 * Shortest known secret `redactSecrets` removes by its exact value; a shorter one would also match
 * ordinary text. Callers that must keep a secret out of every output refuse shorter values.
 */
export const MIN_KNOWN_SECRET_LENGTH = 8;

/** Token shapes of common providers. Patterns are intentionally conservative. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(authorization:\s*bearer\s+)[^\s"']+/gi,
];

/**
 * The shortest text each of {@link SECRET_PATTERNS} matches, in the same order (a unit test checks
 * each against a sample). A reader that cuts text must look at least this far past the cut to
 * recognise a secret that starts before it (SPEC-123 FR-123-06).
 */
export const SECRET_PATTERN_MIN_LENGTHS: readonly number[] = [23, 23, 24, 31, 26, 15, 20, 22];

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Replaces the body of every private-key block, keeping its markers. Equivalent to replacing
 * `BEGIN[\s\S]*?END` globally, but linear: that regex rescans to the end of the text from every
 * BEGIN marker without an END after it, which is quadratic in the number of such markers. Once a
 * marker has no END after it, no later marker has one either, so the scan stops there.
 */
function redactPrivateKeys(text: string): string {
  let result = '';
  let from = 0;
  for (;;) {
    PRIVATE_KEY_BEGIN.lastIndex = from;
    const begin = PRIVATE_KEY_BEGIN.exec(text);
    if (!begin) break;
    PRIVATE_KEY_END.lastIndex = PRIVATE_KEY_BEGIN.lastIndex;
    const end = PRIVATE_KEY_END.exec(text);
    if (!end) break;
    result += `${text.slice(from, begin.index)}${begin[0]}${REDACTION_MARKER}${end[0]}`;
    from = PRIVATE_KEY_END.lastIndex;
  }
  return result + text.slice(from);
}

/**
 * Removes secrets from text before it is persisted in traces, logs or reports.
 * `knownSecrets` are exact values (e.g. configured API keys) that must never appear.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (secret.length >= MIN_KNOWN_SECRET_LENGTH)
      result = result.split(secret).join(REDACTION_MARKER);
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, ...groups: unknown[]) => {
      const prefix = groups[0];
      return typeof prefix === 'string' && match.startsWith(prefix) && prefix !== match
        ? `${prefix}${REDACTION_MARKER}`
        : REDACTION_MARKER;
    });
  }
  return redactPrivateKeys(result);
}

/** Environment variable names that are treated as secrets and never forwarded or logged. */
export function isSecretEnvName(name: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i.test(name);
}

/** A span of a text in UTF-16 code units, `end` exclusive. */
export interface TextRange {
  start: number;
  end: number;
}

/**
 * Whether a text holds the whole of what it was read from (`file-end`), or was cut from a longer
 * one (`cut`), so a secret can continue beyond its end.
 */
export type TextEnd = 'file-end' | 'cut';

/** Sorts ranges and merges overlapping and adjacent ones; empty ranges are dropped. */
export function mergeTextRanges(ranges: readonly TextRange[]): TextRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

const KEY_MARKER = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g;

/**
 * The ranges of `text` that hold a secret, under the rules of SPEC-123 FR-123-07, merged and
 * sorted. Unlike {@link redactSecrets}, it returns offsets into the original text, so a caller
 * can cut the text without splitting a secret and count what it replaced:
 *
 * - every occurrence of a known secret (at least {@link MIN_KNOWN_SECRET_LENGTH} characters);
 * - every match of {@link SECRET_PATTERNS}, only the token where a pattern keeps a prefix;
 * - every private-key fragment, failing closed as trace redaction does: the text after a `BEGIN`
 *   marker up to the next key marker or the end of the text, and the text before an `END` marker
 *   that does not follow its `BEGIN`;
 * - for `textEnd: 'cut'`, the longest suffix of the text that starts a known secret.
 *
 * One pass per rule; every pattern is linear in the text.
 */
export function findSecretRanges(
  text: string,
  knownSecrets: readonly string[],
  options: { textEnd: TextEnd },
): TextRange[] {
  const ranges: TextRange[] = [];
  const secrets = knownSecrets.filter((secret) => secret.length >= MIN_KNOWN_SECRET_LENGTH);
  for (const secret of secrets) {
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      ranges.push({ start: at, end: at + secret.length });
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const prefix = match[1] ?? '';
      ranges.push({ start: match.index + prefix.length, end: match.index + match[0].length });
    }
  }
  let from = 0;
  let previous: string | undefined;
  for (const match of text.matchAll(KEY_MARKER)) {
    if (previous === 'BEGIN' || match[1] === 'END') ranges.push({ start: from, end: match.index });
    from = match.index + match[0].length;
    previous = match[1];
  }
  if (previous === 'BEGIN') ranges.push({ start: from, end: text.length });
  if (options.textEnd === 'cut') {
    for (const secret of secrets) {
      for (let length = Math.min(secret.length - 1, text.length); length > 0; length -= 1) {
        if (text.endsWith(secret.slice(0, length))) {
          ranges.push({ start: text.length - length, end: text.length });
          break;
        }
      }
    }
  }
  return mergeTextRanges(ranges);
}

/**
 * `text` with every range replaced by {@link REDACTION_MARKER}. `ranges` must be merged and
 * sorted ({@link mergeTextRanges}) and lie inside the text.
 */
export function replaceTextRanges(text: string, ranges: readonly TextRange[]): string {
  let result = '';
  let from = 0;
  for (const range of ranges) {
    result += text.slice(from, range.start) + REDACTION_MARKER;
    from = range.end;
  }
  return result + text.slice(from);
}
