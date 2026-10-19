import { parse } from 'yaml';

export interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
  /**
   * Present when a frontmatter block exists but cannot be parsed as a YAML mapping, or holds a
   * value JSON cannot represent unchanged.
   */
  error?: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * The most alias nodes one frontmatter block may resolve (the `yaml` default, pinned here so a
 * library upgrade cannot loosen it). Each alias is weighted by the size of the node it repeats,
 * so an exponential alias bomb is rejected as invalid frontmatter long before it is expanded.
 */
export const MAX_FRONTMATTER_ALIAS_COUNT = 100;

/**
 * Why a parsed YAML value cannot be stored as JSON unchanged, or `null` when it can. YAML is not
 * JSON: an alias can refer to its own ancestor (a circular object `JSON.stringify` throws on),
 * `.inf`/`.nan` become `null`, and tags such as `!!binary`, `!!set`, `!!omap` and `!!timestamp`
 * produce a `Buffer`, `Set`, `Map` or `Date` that JSON drops or rewrites. A node shared by two
 * aliases (not circular) is fine. Depth needs no limit here: the parser itself fails on nesting
 * far shallower than the call stack.
 */
function jsonIncompatibility(value: unknown, ancestors: Set<object>): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : 'it contains .inf or .nan';
  }
  if (typeof value !== 'object') return `it contains an unsupported ${typeof value} value`;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return `it contains a ${typeof name === 'string' && name !== '' ? name : 'non-plain object'}`;
  }
  if (ancestors.has(value)) return 'it contains an alias that refers to itself';
  ancestors.add(value);
  for (const item of Object.values(value)) {
    const problem = jsonIncompatibility(item, ancestors);
    if (problem) return problem;
  }
  ancestors.delete(value);
  return null;
}

/**
 * Splits a leading YAML frontmatter block from Markdown content. Never throws. The returned
 * frontmatter is always JSON-serialisable without loss (it is stored in JSON columns); a block
 * that is not is reported like malformed YAML: `error` set, `frontmatter` empty.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const text = content.startsWith('﻿') ? content.slice(1) : content;
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const body = text.slice(match[0].length);
  try {
    // Capture group 1 is not optional, so it is always defined when the expression matches.
    const value: unknown = parse(match[1] as string, {
      maxAliasCount: MAX_FRONTMATTER_ALIAS_COUNT,
    });
    if (value === null || value === undefined) return { frontmatter: {}, body };
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { frontmatter: {}, body, error: 'frontmatter is not a mapping' };
    }
    const problem = jsonIncompatibility(value, new Set());
    if (problem) {
      return { frontmatter: {}, body, error: `frontmatter cannot be stored as JSON: ${problem}` };
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
