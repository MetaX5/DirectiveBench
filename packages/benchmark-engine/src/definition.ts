import { posix } from 'node:path';
import { z } from 'zod';
import { artifactTypeSchema, modelSelectionSchema } from '@directivebench/core';

export const CURRENT_SCHEMA_VERSION = 1;

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'must be a lowercase slug (a-z, 0-9, -), max 80 chars');

/** Relative POSIX path that stays inside its base directory. */
const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.includes('\\') &&
      !posix.isAbsolute(p) &&
      !p.includes('\0') &&
      !posix.normalize(p).startsWith('../') &&
      posix.normalize(p) !== '..',
    'must be a relative path that does not leave its base directory',
  );

const glob = z.string().min(1);

/** A command is an argv array; it is never interpreted by a shell. */
export const commandSchema = z.array(z.string().min(1)).min(1);

const assertionBase = {
  id: slug,
  description: z.string().optional(),
  weight: z.number().min(0).max(1000).default(1),
  /** A required assertion must pass for the run to pass, regardless of the score. */
  required: z.boolean().default(false),
};

export const commandAssertionSchema = z
  .object({
    ...assertionBase,
    type: z.literal('command'),
    command: commandSchema,
    expectExitCode: z.number().int().default(0),
    timeoutSeconds: z.number().positive().max(3600).optional(),
  })
  .strict();

export const fileExistsAssertionSchema = z
  .object({
    ...assertionBase,
    type: z.literal('file-exists'),
    path: relativePath,
    exists: z.boolean().default(true),
  })
  .strict();

/** Regular-expression flags allowed in definitions (FR-108-10); `g` and `y` would make matching stateful. */
const regexFlags = z
  .string()
  .regex(/^[imsu]*$/, 'only the regex flags i, m, s and u are allowed')
  .default('');

/** Adds a validation issue at `path` when `pattern` is not a valid regular expression. */
function checkRegex(
  pattern: string,
  flags: string,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  try {
    new RegExp(pattern, flags);
  } catch (error) {
    ctx.addIssue({ code: 'custom', path, message: `invalid regex: ${(error as Error).message}` });
  }
}

export const fileContainsAssertionSchema = z
  .object({
    ...assertionBase,
    type: z.literal('file-contains'),
    path: relativePath,
    pattern: z.string().min(1),
    flags: regexFlags,
    /** Pass when the pattern does NOT match. */
    negate: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => checkRegex(value.pattern, value.flags, ctx, ['pattern']));

export const changedFilesAssertionSchema = z
  .object({
    ...assertionBase,
    type: z.literal('changed-files'),
    /** Every changed file must match at least one of these globs. */
    allowed: z.array(glob).optional(),
    /** No changed file may match any of these globs. */
    forbidden: z.array(glob).optional(),
  })
  .strict()
  .refine((v) => v.allowed !== undefined || v.forbidden !== undefined, {
    message: 'changed-files needs `allowed` and/or `forbidden`',
  });

/** Longest regular expression a document assertion accepts (SPEC-118 FR-118-46). */
export const MAX_PATTERN_LENGTH = 1000;

/** Most headings or phrases one document assertion lists (SPEC-118 FR-118-46). */
export const MAX_MATCHERS_PER_ASSERTION = 100;

/** A user regular expression, e.g. `{ pattern: "project manag|PM\\b", flags: i }`. */
export const patternMatcherSchema = z
  .object({ pattern: z.string().min(1).max(MAX_PATTERN_LENGTH), flags: regexFlags })
  .strict()
  .superRefine((value, ctx) => checkRegex(value.pattern, value.flags, ctx, ['pattern']));
export type PatternMatcher = z.infer<typeof patternMatcherSchema>;

const nonBlank = z.string().regex(/\S/, 'must not be blank');

/** A literal string (never a regular expression) or a `{ pattern, flags }` regular expression. */
export const textMatcherSchema = z.union([nonBlank, patternMatcherSchema]);
export type TextMatcher = z.infer<typeof textMatcherSchema>;

export const markdownSectionsAssertionSchema = z
  .object({
    ...assertionBase,
    type: z.literal('markdown-sections'),
    /** Workspace-relative path, or a glob matching exactly one agent-changed file (FR-118-40). */
    file: relativePath,
    /** ATX or setext headings of any level; strings match case-insensitively, whitespace folded. */
    headings: z.array(textMatcherSchema).min(1).max(MAX_MATCHERS_PER_ASSERTION),
    /** The headings must occur in the listed order. */
    ordered: z.boolean().default(false),
  })
  .strict();

export const requiredPhrasesAssertionSchema = z
  .object({
    ...assertionBase,
    type: z.literal('required-phrases'),
    /** Workspace-relative path, or a glob matching exactly one agent-changed file (FR-118-40). */
    file: relativePath,
    /** Every phrase must occur; a string is a literal whose whitespace runs match any run. */
    phrases: z.array(textMatcherSchema).min(1).max(MAX_MATCHERS_PER_ASSERTION),
    /** Applies to literal phrases; a pattern uses its own flags. */
    caseSensitive: z.boolean().default(false),
  })
  .strict();

export const markdownTableValueAssertionSchema = z
  .object({
    ...assertionBase,
    type: z.literal('markdown-table-value'),
    /** Workspace-relative path, or a glob matching exactly one agent-changed file (FR-118-40). */
    file: relativePath,
    /** Selects the first body row whose first cell matches. */
    row: patternMatcherSchema,
    /** Header cell of the value column, compared case-insensitively after trimming. */
    column: nonBlank,
    min: z.number().optional(),
    max: z.number().optional(),
    decimalSeparator: z.enum(['.', ',']).default('.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.min === undefined && value.max === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'markdown-table-value needs `min` and/or `max`',
      });
    } else if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      ctx.addIssue({ code: 'custom', path: ['min'], message: '`min` must not exceed `max`' });
    }
  });

export const assertionSchema = z.discriminatedUnion('type', [
  commandAssertionSchema,
  fileExistsAssertionSchema,
  fileContainsAssertionSchema,
  changedFilesAssertionSchema,
  markdownSectionsAssertionSchema,
  requiredPhrasesAssertionSchema,
  markdownTableValueAssertionSchema,
]);
export type AssertionDefinition = z.infer<typeof assertionSchema>;
export type AssertionType = AssertionDefinition['type'];

/**
 * Static traits of every assertion type (SPEC-107 §8.3). Kept here, free of evaluator code,
 * because the web app imports this module; the evaluators live in the plugin registry
 * (`assertions.ts`), which reuses these traits.
 */
export const ASSERTION_TYPE_TRAITS: Readonly<
  Record<AssertionType, { deterministic: boolean; executesCommands: boolean }>
> = {
  command: { deterministic: true, executesCommands: true },
  'file-exists': { deterministic: true, executesCommands: false },
  'file-contains': { deterministic: true, executesCommands: false },
  'changed-files': { deterministic: true, executesCommands: false },
  'markdown-sections': { deterministic: true, executesCommands: false },
  'required-phrases': { deterministic: true, executesCommands: false },
  'markdown-table-value': { deterministic: true, executesCommands: false },
};

export const benchmarkCaseSchema = z
  .object({
    id: slug,
    name: z.string().min(1),
    description: z.string().optional(),
    /** The task given to the agent. Identical for baseline and candidate. */
    prompt: z.string().min(1),
    fixture: z.object({ path: relativePath }).strict(),
    /** Files copied into the workspace after the agent finishes (hidden tests). */
    verification: z.object({ overlay: relativePath }).strict().optional(),
    /** Commands run in a fresh workspace before the agent starts. */
    setup: z.array(commandSchema).default([]),
    assertions: z.array(assertionSchema).min(1),
    /** Adapter-specific options keyed by adapter id (e.g. `mock.playbook`). */
    agentOptions: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.assertions.forEach((assertion, index) => {
      if (seen.has(assertion.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['assertions', index, 'id'],
          message: `duplicate assertion id "${assertion.id}"`,
        });
      }
      seen.add(assertion.id);
    });
    if (value.assertions.every((a) => a.weight === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['assertions'],
        message: 'at least one assertion needs a weight > 0',
      });
    }
  });
export type BenchmarkCase = z.infer<typeof benchmarkCaseSchema>;

export const benchmarkDefinitionSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: slug,
    name: z.string().min(1),
    description: z.string().optional(),
    technologies: z.array(z.string().min(1)).default([]),
    /** Category slugs (see predefined categories). */
    categories: z.array(z.string().min(1)).default([]),
    /** Artifact types this suite is meant to evaluate. */
    artifactTypes: z.array(artifactTypeSchema).min(1).default(['skill', 'instruction', 'rule']),
    execution: z
      .object({
        /** Agent adapter id, e.g. `mock`, `claude-code`, `codex`, `cursor`. */
        agent: z.string().min(1),
        model: modelSelectionSchema.nullable().default(null),
        environment: z
          .object({
            kind: z.enum(['local-process', 'docker']),
            image: z.string().min(1).optional(),
          })
          .strict()
          .default({ kind: 'local-process' }),
        timeoutSeconds: z.number().positive().max(7200).default(300),
        repetitions: z.number().int().min(1).max(50).default(3),
        maxOutputBytes: z
          .number()
          .int()
          .min(1024)
          .max(10 * 1024 * 1024)
          .default(64 * 1024),
      })
      .strict(),
    scoring: z
      .object({
        /** Minimum run score (0–1) for a run to pass. */
        passThreshold: z.number().min(0).max(1).default(1),
        /** Minimum absolute score delta reported as improvement or regression. */
        minDelta: z.number().min(0).max(1).default(0.05),
        /** Maximum per-case standard deviation before a result is flagged unstable. */
        stabilityThreshold: z.number().min(0).max(1).default(0.1),
      })
      .strict()
      .prefault({}),
    cases: z.array(benchmarkCaseSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.cases.forEach((c, index) => {
      if (seen.has(c.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cases', index, 'id'],
          message: `duplicate case id "${c.id}"`,
        });
      }
      seen.add(c.id);
    });
    if (value.execution.environment.kind === 'docker' && !value.execution.environment.image) {
      ctx.addIssue({
        code: 'custom',
        path: ['execution', 'environment', 'image'],
        message: 'docker environment requires `image`',
      });
    }
  });

export type BenchmarkDefinition = z.infer<typeof benchmarkDefinitionSchema>;
/** The authored shape (before defaults are applied). */
export type BenchmarkDefinitionInput = z.input<typeof benchmarkDefinitionSchema>;

/** True when running the suite executes commands (setup or command assertions). */
export function definitionRunsCommands(definition: BenchmarkDefinition): boolean {
  return definition.cases.some(
    (c) =>
      c.setup.length > 0 ||
      c.assertions.some((a) => ASSERTION_TYPE_TRAITS[a.type].executesCommands),
  );
}

/** Environments the runner can execute in this build. */
export const SUPPORTED_ENVIRONMENTS: readonly BenchmarkDefinition['execution']['environment']['kind'][] =
  ['local-process'];

/**
 * Reasons why a suite version cannot run in this build, independent of the agent adapter.
 * Shared by the web app (checked before enqueueing) and the orchestrator (checked before running).
 */
export function executionBlockers(
  definition: BenchmarkDefinition,
  executionApproved: boolean,
): string[] {
  const blockers: string[] = [];
  const kind = definition.execution.environment.kind;
  if (!SUPPORTED_ENVIRONMENTS.includes(kind)) {
    blockers.push(
      `Execution environment "${kind}" is not implemented yet; only "local-process" is available.`,
    );
  }
  if (definitionRunsCommands(definition) && !executionApproved) {
    blockers.push('This suite version runs commands but has not been approved for execution.');
  }
  return blockers;
}

/**
 * All assertion types of format v1 are deterministic. Nondeterministic types (e.g. a future
 * `llm-judge`) are marked in `ASSERTION_TYPE_TRAITS` so results are flagged (SPEC-111 FR-111-42).
 */
export function isDeterministicAssertion(assertion: AssertionDefinition): boolean {
  return ASSERTION_TYPE_TRAITS[assertion.type].deterministic;
}
