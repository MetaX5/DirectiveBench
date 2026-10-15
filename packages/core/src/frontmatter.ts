import { parse } from 'yaml';

export interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Present when a frontmatter block exists but cannot be parsed as a YAML mapping. */
  error?: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits a leading YAML frontmatter block from Markdown content. Never throws. */
export function parseFrontmatter(content: string): FrontmatterResult {
  const text = content.startsWith('﻿') ? content.slice(1) : content;
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const body = text.slice(match[0].length);
  try {
    // Capture group 1 is not optional, so it is always defined when the expression matches.
    const value: unknown = parse(match[1] as string);
    if (value === null || value === undefined) return { frontmatter: {}, body };
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { frontmatter: {}, body, error: 'frontmatter is not a mapping' };
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
