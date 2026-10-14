import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type z } from 'zod';
import {
  CURRENT_SCHEMA_VERSION,
  benchmarkDefinitionSchema,
  type BenchmarkDefinition,
} from './definition';

export type DefinitionFormat = 'yaml' | 'json';

export interface DefinitionIssue {
  /** Dotted path into the document, e.g. `cases.0.assertions.1.pattern`. */
  path: string;
  message: string;
}

export type ParseDefinitionResult =
  | { success: true; definition: BenchmarkDefinition }
  | { success: false; issues: DefinitionIssue[] };

/**
 * Upgrades older documents to the current schema version. Stored suite versions are never
 * rewritten; migration happens on load. Version 1 is the first format, so there is nothing to
 * migrate yet — new versions add a step here.
 */
export function migrateDefinitionDocument(document: unknown): unknown {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const version = (document as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === 'number' && version > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(version);
  }
  return document;
}

export class UnsupportedSchemaVersionError extends Error {
  override name = 'UnsupportedSchemaVersionError';
  constructor(version: number) {
    super(
      `Benchmark schemaVersion ${version} is newer than this DirectiveBench supports (${CURRENT_SCHEMA_VERSION}). Upgrade DirectiveBench.`,
    );
  }
}

export function validateDefinition(document: unknown): ParseDefinitionResult {
  let migrated: unknown;
  try {
    migrated = migrateDefinitionDocument(document);
  } catch (error) {
    return {
      success: false,
      issues: [{ path: 'schemaVersion', message: (error as Error).message }],
    };
  }
  const result = benchmarkDefinitionSchema.safeParse(migrated);
  if (result.success) return { success: true, definition: result.data };
  return { success: false, issues: toIssues(result.error) };
}

function toIssues(error: z.ZodError): DefinitionIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

export function parseDefinitionText(text: string, format: DefinitionFormat): ParseDefinitionResult {
  let document: unknown;
  try {
    document = format === 'json' ? JSON.parse(text) : parseYaml(text, { prettyErrors: true });
  } catch (error) {
    return {
      success: false,
      issues: [
        {
          path: '(document)',
          message: `Invalid ${format.toUpperCase()}: ${(error as Error).message}`,
        },
      ],
    };
  }
  return validateDefinition(document);
}

export function formatFromPath(path: string): DefinitionFormat {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  throw new Error(`Unsupported benchmark definition extension "${ext}" (use .yaml, .yml or .json)`);
}

export class DefinitionValidationError extends Error {
  override name = 'DefinitionValidationError';
  constructor(
    readonly source: string,
    readonly issues: DefinitionIssue[],
  ) {
    super(
      `Invalid benchmark definition ${source}:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`,
    );
  }
}

/** Reads and validates a definition file; throws `DefinitionValidationError` with all issues. */
export async function loadDefinitionFile(path: string): Promise<BenchmarkDefinition> {
  const text = await readFile(path, 'utf8');
  const result = parseDefinitionText(text, formatFromPath(path));
  if (!result.success) throw new DefinitionValidationError(path, result.issues);
  return result.definition;
}
