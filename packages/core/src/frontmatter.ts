import { Buffer } from 'node:buffer';
import { parse } from 'yaml';

export interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
  /**
   * Present when a frontmatter block exists but is longer than
   * {@link MAX_FRONTMATTER_SOURCE_BYTES}, cannot be parsed as a YAML mapping, holds a value JSON
   * cannot represent unchanged, or expands to more than {@link MAX_FRONTMATTER_JSON_BYTES} of JSON.
   */
  error?: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * The most UTF-8 bytes a frontmatter block (between the `---` lines, CR bytes included) may take;
 * a longer block is invalid frontmatter and is never parsed. `yaml`'s duplicate-key check is
 * quadratic in the keys of one mapping and the parse is synchronous, so the 1 MiB primary-file
 * limit let one file block the runner for tens of seconds — past the 30 s stale-job threshold,
 * with cancellation and SIGINT unobserved. Measured for a flat mapping of `kN: 1` keys: 64 KiB
 * (~7 400 keys) parses in about 0.2 s, 128 KiB in 1 s and 256 KiB in 3 s; the densest shape found
 * under 64 KiB, a flow mapping of ~13 600 one-letter null keys (`{qa, qb, …}`), takes about 0.65 s.
 * Real frontmatter is a few hundred bytes, so 64 KiB leaves over 100× headroom while bounding one
 * block on the event loop to under a second, far below the stale-job threshold.
 * Duplicate-key checking stays on: turning it off would change which duplicate keys are accepted.
 */
export const MAX_FRONTMATTER_SOURCE_BYTES = 64 * 1024;

/**
 * The most alias nodes one frontmatter block may resolve (the `yaml` default, pinned here so a
 * library upgrade cannot loosen it). It rejects an exponential alias bomb before it is expanded,
 * but it is **not** a size limit: `yaml` weights an alias by the aliases inside the node it
 * repeats, so an alias of a long string counts as 1 whatever its length (99 aliases of a 1 MB
 * string pass it). {@link MAX_FRONTMATTER_JSON_BYTES} bounds the size.
 */
export const MAX_FRONTMATTER_ALIAS_COUNT = 100;

/**
 * The most bytes the frontmatter may take as compact UTF-8 JSON — its stored form, with every
 * alias expanded. 4 MiB is 4 × the 1 MiB primary-file limit (`DISCOVERY_LIMITS`): frontmatter
 * without aliases serialises to roughly its own size (JSON adds quotes and commas; only text that
 * is mostly escaped control characters grows up to 6×), so any real frontmatter fits, while a
 * 1 MiB file can no longer expand ~100× through aliases. Frontmatter over the limit is invalid
 * frontmatter. The scan-wide total is bounded by `maxScanBytes`, which counts this JSON too.
 */
export const MAX_FRONTMATTER_JSON_BYTES = 4 * 1024 * 1024;

/** Longest key, in UTF-16 code units, quoted in a warning; a longer one is cut off with `…`. */
const MAX_REPORTED_KEY_LENGTH = 64;

const TOO_LARGE = `it expands to more than ${MAX_FRONTMATTER_JSON_BYTES} bytes of JSON`;

interface JsonWalk {
  /** Objects and arrays on the path to the current node: meeting one again is a cycle. */
  ancestors: Set<object>;
  /** The keys and indexes on the path to the current node, kept as they are when a walk fails. */
  path: string[];
  /** Bytes of JSON still allowed: {@link MAX_FRONTMATTER_JSON_BYTES} minus those counted. */
  remaining: number;
}

/** Counts `bytes` more of serialised JSON; the problem once the budget is exhausted. */
function spend(walk: JsonWalk, bytes: number): string | null {
  walk.remaining -= bytes;
  return walk.remaining < 0 ? TOO_LARGE : null;
}

/** UTF-8 bytes of a string as JSON writes it: quoted and escaped. */
function jsonStringBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text));
}

/**
 * Why a parsed YAML value cannot be stored as JSON unchanged, or `null` when it can. YAML is not
 * JSON: an alias can refer to its own ancestor (a circular object `JSON.stringify` throws on),
 * `.inf`/`.nan` become `null`, and tags such as `!!binary`, `!!set`, `!!omap` and `!!timestamp`
 * produce a `Buffer`, `Set`, `Map` or `Date` that JSON drops or rewrites. A node shared by two
 * aliases (not circular) is fine, but it is walked — and its bytes counted — once per alias, as
 * JSON expands it, so the walk stops as soon as the budget is spent: its work is bounded by
 * {@link MAX_FRONTMATTER_JSON_BYTES}, not by the expanded size. Depth needs no limit here: the
 * parser itself fails on nesting far shallower than the call stack.
 */
function jsonIncompatibility(value: unknown, walk: JsonWalk): string | null {
  if (value === null || typeof value === 'boolean') return spend(walk, String(value).length);
  if (typeof value === 'string') return spend(walk, jsonStringBytes(value));
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'it contains .inf or .nan';
    return spend(walk, JSON.stringify(value).length);
  }
  if (typeof value !== 'object') return `it contains an unsupported ${typeof value} value`;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return `it contains a ${typeof name === 'string' && name !== '' ? name : 'non-plain object'}`;
  }
  if (walk.ancestors.has(value)) return 'it contains an alias that refers to itself';
  const entries = Object.entries(value);
  // The brackets and the commas between the entries.
  const overhead = spend(walk, 2 + Math.max(entries.length - 1, 0));
  if (overhead) return overhead;
  walk.ancestors.add(value);
  for (const [key, item] of entries) {
    walk.path.push(key);
    // An array writes its items only; an object writes each key and a colon before the value.
    const problem =
      (Array.isArray(value) ? null : spend(walk, jsonStringBytes(key) + 1)) ??
      jsonIncompatibility(item, walk);
    if (problem) return problem;
    walk.path.pop();
  }
  walk.ancestors.delete(value);
  return null;
}

/**
 * Where a problem lies, by the top-level key on its path (cut to a safe length): the key holding
 * the offending value, or — for the size limit, which the keys before it count towards too — the
 * key at which the limit was reached.
 */
function whereInFrontmatter(problem: string, path: readonly string[]): string {
  const [key] = path;
  if (key === undefined) return '';
  const shown = JSON.stringify(
    key.length > MAX_REPORTED_KEY_LENGTH ? `${key.slice(0, MAX_REPORTED_KEY_LENGTH)}…` : key,
  );
  return problem === TOO_LARGE
    ? ` (the limit was reached under the key ${shown})`
    : ` under the key ${shown}`;
}

/**
 * Splits a leading YAML frontmatter block from Markdown content. Never throws. A block over
 * {@link MAX_FRONTMATTER_SOURCE_BYTES} is not parsed. The returned frontmatter is always
 * JSON-serialisable without loss (it is stored in JSON columns) and at most
 * {@link MAX_FRONTMATTER_JSON_BYTES} as JSON; a block that is not is reported like malformed
 * YAML: `error` set (naming the top-level key the problem lies under), `frontmatter` empty — one
 * bad value discards the whole block.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const text = content.startsWith('﻿') ? content.slice(1) : content;
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const body = text.slice(match[0].length);
  // Capture group 1 is not optional, so it is always defined when the expression matches.
  const source = match[1] as string;
  if (Buffer.byteLength(source) > MAX_FRONTMATTER_SOURCE_BYTES) {
    return {
      frontmatter: {},
      body,
      error: `frontmatter is longer than ${MAX_FRONTMATTER_SOURCE_BYTES} bytes`,
    };
  }
  try {
    const value: unknown = parse(source, {
      maxAliasCount: MAX_FRONTMATTER_ALIAS_COUNT,
    });
    if (value === null || value === undefined) return { frontmatter: {}, body };
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { frontmatter: {}, body, error: 'frontmatter is not a mapping' };
    }
    const walk: JsonWalk = {
      ancestors: new Set(),
      path: [],
      remaining: MAX_FRONTMATTER_JSON_BYTES,
    };
    const problem = jsonIncompatibility(value, walk);
    if (problem) {
      return {
        frontmatter: {},
        body,
        error: `frontmatter cannot be stored as JSON: ${problem}${whereInFrontmatter(problem, walk.path)}`,
      };
    }
    return { frontmatter: value as Record<string, unknown>, body };
  } catch (error) {
    return {
      frontmatter: {},
      body,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
