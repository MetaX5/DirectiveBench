import { posix } from 'node:path';
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';

export const ARTIFACT_TYPES = ['skill', 'instruction', 'rule'] as const;
export const artifactTypeSchema = z.enum(ARTIFACT_TYPES);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

/**
 * Source formats DirectiveBench understands. The format is derived from the file path,
 * never from content alone: an arbitrary Markdown file is not an artifact.
 */
export const ARTIFACT_FORMATS = [
  'skill-md',
  'agents-md',
  'claude-md',
  'claude-rule',
  'copilot-instructions',
  'copilot-path-instructions',
  'cursor-rule',
  'gitlab-duo-chat-rules',
] as const;
export const artifactFormatSchema = z.enum(ARTIFACT_FORMATS);
export type ArtifactFormat = z.infer<typeof artifactFormatSchema>;

export interface ArtifactClassification {
  format: ArtifactFormat;
  type: ArtifactType;
  /**
   * For directory-based artifacts (skills) the directory that holds the artifact and its
   * supporting files, relative to the scanned root. `null` for single-file artifacts.
   */
  rootDir: string | null;
}

/** Activation semantics preserved from the source format. */
export interface ArtifactActivation {
  /** Rule applies to every request (Cursor `alwaysApply`). */
  alwaysApply?: boolean;
  /** Path globs that scope the artifact (Cursor `globs`, Copilot `applyTo`, Claude rules `paths`). */
  globs?: string[];
  /** Natural-language description used by agents to decide relevance (skills, Cursor rules). */
  description?: string;
}

export interface ParsedArtifact {
  format: ArtifactFormat;
  type: ArtifactType;
  name: string;
  description: string | null;
  activation: ArtifactActivation;
  /** Raw frontmatter, preserved verbatim for format-specific metadata. */
  frontmatter: Record<string, unknown>;
  body: string;
  /** Relative file references found in the body (Markdown links to local files). */
  references: string[];
  warnings: string[];
}

function normalize(relPath: string): string {
  return posix.normalize(relPath.replaceAll('\\', '/')).replace(/^\.\//, '');
}

/** Classifies a repository-relative path. Returns `null` when the path is not a known artifact. */
export function classifyArtifactPath(relPath: string): ArtifactClassification | null {
  const path = normalize(relPath);
  const base = posix.basename(path);
  const dir = posix.dirname(path);

  if (base === 'SKILL.md') {
    return { format: 'skill-md', type: 'skill', rootDir: dir === '.' ? '' : dir };
  }
  if (base === 'AGENTS.md') return { format: 'agents-md', type: 'instruction', rootDir: null };
  if (base === 'CLAUDE.md') return { format: 'claude-md', type: 'instruction', rootDir: null };
  if (path === '.github/copilot-instructions.md') {
    return { format: 'copilot-instructions', type: 'instruction', rootDir: null };
  }
  if (/^\.github\/instructions\/.+\.instructions\.md$/.test(path)) {
    return { format: 'copilot-path-instructions', type: 'rule', rootDir: null };
  }
  if (/(^|\/)\.cursor\/rules\/.+\.mdc$/.test(path)) {
    return { format: 'cursor-rule', type: 'rule', rootDir: null };
  }
  if (/(^|\/)\.claude\/rules\/.+\.md$/.test(path)) {
    return { format: 'claude-rule', type: 'rule', rootDir: null };
  }
  if (path === '.gitlab/duo/chat-rules.md') {
    return { format: 'gitlab-duo-chat-rules', type: 'rule', rootDir: null };
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function toGlobList(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

function firstHeading(body: string): string | null {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim() ?? null;
}

function extractReferences(body: string): string[] {
  const refs = new Set<string>();
  // The link text cannot contain `[` and the target cannot contain `](`, so every candidate link
  // ends where the next one starts: otherwise a run of `[` or `[](` without a closing `)` is
  // rescanned from each of them, which is quadratic in its length.
  for (const match of body.matchAll(/\[[^[\]]*\]\(((?:[^)\s\]]|\](?!\())+)\)/g)) {
    const target = match[1];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    refs.add(target.replace(/#.*/, ''));
  }
  return [...refs].filter(Boolean).sort();
}

/**
 * Parses an artifact's primary file. The caller supplies the repository-relative path so the
 * format-specific semantics (frontmatter keys, activation rules) can be applied.
 */
export function parseArtifactFile(relPath: string, content: string): ParsedArtifact {
  const classification = classifyArtifactPath(relPath);
  if (!classification) {
    throw new Error(`Not a recognised artifact path: ${relPath}`);
  }
  const { frontmatter, body, error } = parseFrontmatter(content);
  const warnings: string[] = error ? [`Invalid frontmatter: ${error}`] : [];
  const path = normalize(relPath);
  const activation: ArtifactActivation = {};
  let name: string | null = null;
  let description = stringOrNull(frontmatter.description);

  switch (classification.format) {
    case 'skill-md': {
      name = stringOrNull(frontmatter.name);
      if (!name) warnings.push('SKILL.md has no `name` in frontmatter');
      if (!description) warnings.push('SKILL.md has no `description` in frontmatter');
      if (description) activation.description = description;
      name ??= classification.rootDir ? posix.basename(classification.rootDir) : 'skill';
      break;
    }
    case 'cursor-rule': {
      const globs = toGlobList(frontmatter.globs);
      if (globs) activation.globs = globs;
      if (typeof frontmatter.alwaysApply === 'boolean') {
        activation.alwaysApply = frontmatter.alwaysApply;
      }
      if (description) activation.description = description;
      name = posix.basename(path, '.mdc');
      break;
    }
    case 'copilot-path-instructions': {
      const globs = toGlobList(frontmatter.applyTo);
      if (globs) activation.globs = globs;
      else warnings.push('Path-specific instructions without `applyTo` apply to no files');
      name = posix.basename(path, '.instructions.md');
      break;
    }
    case 'claude-rule': {
      const globs = toGlobList(frontmatter.paths);
      if (globs) activation.globs = globs;
      else activation.alwaysApply = true;
      name = posix.basename(path, '.md');
      break;
    }
    case 'agents-md':
    case 'claude-md':
    case 'copilot-instructions':
    case 'gitlab-duo-chat-rules': {
      activation.alwaysApply = true;
      const dir = posix.dirname(path);
      name = dir === '.' ? posix.basename(path) : `${dir}/${posix.basename(path)}`;
      break;
    }
  }

  description ??= firstHeading(body);

  return {
    format: classification.format,
    type: classification.type,
    name,
    description,
    activation,
    frontmatter,
    body,
    references: extractReferences(body),
    warnings,
  };
}

/** Converts a human readable name into a stable, URL-safe slug. */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'item';
}
