import { readFile, stat } from 'node:fs/promises';
import { matchesGlob } from 'node:path';
import { resolveInside } from '@directivebench/agent-adapters';
import { ASSERTION_TYPE_TRAITS, type AssertionDefinition } from './definition';
import type { FileChange } from './files';
import type { PatternError } from './pattern-worker';

export interface AssertionResult {
  assertionId: string;
  type: AssertionDefinition['type'];
  passed: boolean;
  /** 0–1; deterministic assertions score 0 or 1. Partial credit is reserved for future types. */
  score: number;
  weight: number;
  required: boolean;
  deterministic: boolean;
  message: string;
  details: Record<string, unknown> | null;
  /**
   * Set when the evaluation could not finish (neither pass nor fail); the agent run then becomes
   * `infrastructure-error` (SPEC-118 FR-118-46). Also stored as `details.error`.
   */
  error?: PatternError;
}

export interface AssertionContext {
  workspaceDir: string;
  changedFiles: readonly FileChange[];
  commandEnv: Record<string, string>;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

/** Largest file an assertion reads. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

export function assertionResult(
  assertion: AssertionDefinition,
  passed: boolean,
  message: string,
  details: Record<string, unknown> | null = null,
): AssertionResult {
  return {
    assertionId: assertion.id,
    type: assertion.type,
    passed,
    score: passed ? 1 : 0,
    weight: assertion.weight,
    required: assertion.required,
    deterministic: ASSERTION_TYPE_TRAITS[assertion.type].deterministic,
    message,
    details,
  };
}

/** An evaluation that could not finish: stored as a failed result carrying `error`. */
export function assertionError(
  assertion: AssertionDefinition,
  error: PatternError,
  patterns: readonly string[],
): AssertionResult {
  return {
    ...assertionResult(assertion, false, error.message, { error, patterns }),
    error,
  };
}

export type TextRead = { ok: true; text: string } | { ok: false; message: string };

/** Reads a workspace file of at most `MAX_READ_BYTES` as UTF-8; the path stays inside. */
export async function readWorkspaceText(workspaceDir: string, relPath: string): Promise<TextRead> {
  const path = resolveInside(workspaceDir, relPath);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return { ok: false, message: `${relPath} does not exist` };
  if (info.size > MAX_READ_BYTES) {
    return { ok: false, message: `${relPath} is larger than ${MAX_READ_BYTES} bytes` };
  }
  return { ok: true, text: await readFile(path, 'utf8') };
}

export type TargetRead =
  | { ok: true; file: string; text: string }
  | { ok: false; message: string; details: Record<string, unknown> };

/** A `file` containing `*`, `?` or `[` is a glob; there is no escape for these characters. */
const GLOB_CHARACTERS = /[*?[]/;

/** Most glob matches named in a message or details; agents can create thousands of files. */
export const MAX_LISTED_MATCHES = 20;

function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_MATCHES).join(', ');
  return paths.length > MAX_LISTED_MATCHES
    ? `${shown} … ${paths.length - MAX_LISTED_MATCHES} more`
    : shown;
}

/**
 * Reads the document of a document assertion (SPEC-118 FR-118-40): `file` is a workspace path,
 * or a glob over the files the agent added or modified that must match exactly one of them.
 */
export async function readTargetFile(
  file: string,
  context: Pick<AssertionContext, 'workspaceDir' | 'changedFiles'>,
): Promise<TargetRead> {
  let target = file;
  if (GLOB_CHARACTERS.test(file)) {
    const matches = context.changedFiles
      .filter((change) => change.change !== 'deleted' && matchesGlob(change.path, file))
      .map((change) => change.path);
    if (matches.length !== 1) {
      return {
        ok: false,
        message:
          matches.length === 0
            ? `No file added or modified by the agent matches ${file}`
            : `${matches.length} files match ${file}, expected exactly one: ${listed(matches)}`,
        details: {
          file,
          matches: matches.slice(0, MAX_LISTED_MATCHES),
          matchCount: matches.length,
        },
      };
    }
    target = matches[0] as string;
  }
  const read = await readWorkspaceText(context.workspaceDir, target);
  if (!read.ok) return { ok: false, message: read.message, details: { file, target } };
  return { ok: true, file: target, text: read.text };
}
