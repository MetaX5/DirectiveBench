import { ARTIFACT_TYPES } from '@directivebench/core';
import type { ArtifactListFilter, StoredArtifactFile } from '@directivebench/database';
import { z } from 'zod';

/** Next.js page search params: a repeated parameter arrives as an array. */
export type SearchParams = Record<string, string | string[] | undefined>;

/** The longest text search accepted from the URL. */
export const MAX_SEARCH_LENGTH = 200;
/** The longest file path accepted from the URL (a manifest path is never longer in practice). */
export const MAX_FILE_PARAM_LENGTH = 4096;
/** The longest category slug accepted from the URL; `slugify` itself sets no length. */
export const MAX_SLUG_PARAM_LENGTH = 256;

const listParamSchemas = {
  q: z.string().max(MAX_SEARCH_LENGTH),
  type: z.enum(ARTIFACT_TYPES),
  // The shape `slugify` produces: lower-case letters and digits, separated by single hyphens.
  category: z
    .string()
    .max(MAX_SLUG_PARAM_LENGTH)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  repository: z.string().regex(/^repo_[A-Za-z0-9_-]{1,64}$/),
} as const;

type ListParam = keyof typeof listParamSchemas;

export interface ParsedParams<T> {
  value: T;
  /** Parameters that were present but invalid, in a fixed order; they are ignored (SPEC-101 §13). */
  invalid: string[];
}

/** One search parameter: absent or empty is `undefined`, a repeated one is invalid. */
function single(params: SearchParams, name: string): string | undefined | null {
  const raw = params[name];
  if (Array.isArray(raw)) return null;
  return raw === undefined || raw === '' ? undefined : raw;
}

function parseField<S extends z.ZodType>(
  params: SearchParams,
  name: string,
  schema: S,
  invalid: string[],
): z.infer<S> | undefined {
  const raw = single(params, name);
  if (raw === undefined) return undefined;
  const parsed = raw === null ? null : schema.safeParse(raw);
  if (!parsed?.success) {
    invalid.push(name);
    return undefined;
  }
  return parsed.data;
}

/** The artifacts list filters from the URL (FR-101-11 subset); invalid values are dropped. */
export function parseArtifactListParams(params: SearchParams): ParsedParams<ArtifactListFilter> {
  const invalid: string[] = [];
  const value: ArtifactListFilter = {};
  for (const name of Object.keys(listParamSchemas) as ListParam[]) {
    const parsed = parseField(params, name, listParamSchemas[name], invalid);
    if (parsed !== undefined) Object.assign(value, { [name]: parsed });
  }
  return { value, invalid };
}

export function invalidParamsNotice(invalid: readonly string[]): string | null {
  if (invalid.length === 0) return null;
  return `Ignored invalid ${invalid.length === 1 ? 'value' : 'values'} in the URL: ${invalid.join(', ')}.`;
}

/** The "Repository" cell (FR-101-10): the first repository and "+N" for the others. */
export function repositoriesLabel(repositories: readonly { name: string }[]): string {
  const [first, ...rest] = repositories;
  if (!first) return '—';
  return rest.length ? `${first.name} +${rest.length}` : first.name;
}

/** Options of the repository filter; a name two repositories share gets its location appended. */
export function repositoryOptions(
  repositories: readonly { id: string; name: string; location: string }[],
): { value: string; label: string }[] {
  const counts = new Map<string, number>();
  for (const r of repositories) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  return repositories.map((r) => ({
    value: r.id,
    label: (counts.get(r.name) as number) > 1 ? `${r.name} (${r.location})` : r.name,
  }));
}

export const ARTIFACT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'content', label: 'Content' },
  { id: 'metadata', label: 'Parsed metadata' },
  { id: 'versions', label: 'Versions' },
  { id: 'benchmarks', label: 'Benchmarks' },
  { id: 'evaluations', label: 'Evaluation history' },
] as const;

export type ArtifactTab = (typeof ARTIFACT_TABS)[number]['id'];

const detailParamSchemas = {
  tab: z.enum(ARTIFACT_TABS.map((t) => t.id) as [ArtifactTab, ...ArtifactTab[]]),
  version: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .transform(Number),
  file: z.string().max(MAX_FILE_PARAM_LENGTH),
} as const;

export interface ArtifactDetailParams {
  tab: ArtifactTab;
  version?: number;
  file?: string;
}

/** The detail page's tab, version and file from the URL; invalid values are dropped. */
export function parseArtifactDetailParams(
  params: SearchParams,
): ParsedParams<ArtifactDetailParams> {
  const invalid: string[] = [];
  const tab = parseField(params, 'tab', detailParamSchemas.tab, invalid) ?? 'overview';
  const version = parseField(params, 'version', detailParamSchemas.version, invalid);
  const file = parseField(params, 'file', detailParamSchemas.file, invalid);
  return {
    value: {
      tab,
      ...(version === undefined ? {} : { version }),
      ...(file === undefined ? {} : { file }),
    },
    invalid,
  };
}

const artifactIdSchema = z.string().regex(/^art_[A-Za-z0-9_-]{1,64}$/);

/** The detail page's route parameter, or null when it cannot be an artifact id (a 404). */
export function parseArtifactId(id: string): string | null {
  const parsed = artifactIdSchema.safeParse(id);
  return parsed.success ? parsed.data : null;
}

/** A link to the detail page; parameters left out are not part of the URL. */
export function artifactHref(id: string, params: Partial<ArtifactDetailParams> = {}): string {
  const query = new URLSearchParams();
  if (params.tab && params.tab !== 'overview') query.set('tab', params.tab);
  if (params.version !== undefined) query.set('version', String(params.version));
  if (params.file !== undefined) query.set('file', params.file);
  const search = query.toString();
  return `/artifacts/${encodeURIComponent(id)}${search ? `?${search}` : ''}`;
}

interface VersionLike {
  version: number;
  primaryFile: string;
  files: StoredArtifactFile[];
}

export interface ContentSelection<V extends VersionLike> {
  version: V | null;
  file: StoredArtifactFile | null;
  /** Why the URL's version or file was not used. */
  notices: string[];
}

/**
 * The version and file the Content tab shows: the requested ones when they exist, otherwise the
 * latest version (versions are ordered newest first) and its primary file.
 */
export function selectContent<V extends VersionLike>(
  versions: readonly V[],
  requested: Pick<ArtifactDetailParams, 'version' | 'file'>,
): ContentSelection<V> {
  const notices: string[] = [];
  let version = versions[0] ?? null;
  if (requested.version !== undefined) {
    const match = versions.find((v) => v.version === requested.version);
    if (match) version = match;
    else notices.push(`Version ${requested.version} does not exist; showing the latest version.`);
  }
  if (!version) return { version: null, file: null, notices };
  const primary =
    version.files.find((f) => f.path === version.primaryFile) ?? version.files[0] ?? null;
  let file = primary;
  if (requested.file !== undefined) {
    const match = version.files.find((f) => f.path === requested.file);
    if (match) file = match;
    else {
      notices.push(
        `Version ${version.version} has no file ${JSON.stringify(requested.file)}; showing its primary file.`,
      );
    }
  }
  return { version, file, notices };
}

export interface FileTreeNode {
  name: string;
  /** The full manifest path for files; the directory path (no trailing slash) for directories. */
  path: string;
  /** Present for directories. */
  children?: FileTreeNode[];
}

/** The manifest as a tree (FR-101-15): directories first, then files, each sorted by name. */
export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', children: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    parts.forEach((name, index) => {
      const children = node.children as FileTreeNode[];
      const isFile = index === parts.length - 1;
      const childPath = parts.slice(0, index + 1).join('/');
      let child = children.find((c) => c.name === name && !c.children === isFile);
      if (!child) {
        child = isFile ? { name, path } : { name, path: childPath, children: [] };
        children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes
      .map((n) => (n.children ? { ...n, children: sort(n.children) } : n))
      .sort(
        // Siblings of one kind never share a name (they were merged above), so names differ.
        (a, b) => Number(!a.children) - Number(!b.children) || (a.name < b.name ? -1 : 1),
      );
  return sort(root.children as FileTreeNode[]);
}

/** A file size for the file tree and the content header. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What the raw view says about content the browser cannot show exactly: HTML turns CR LF and a
 * lone CR into LF, so carriage returns are invisible in the page although they are stored.
 */
export function rawViewNotice(content: string): string | null {
  return content.includes('\r')
    ? 'This file has CR or CRLF line endings. The browser shows them as plain line breaks; the stored content keeps them unchanged.'
    : null;
}
