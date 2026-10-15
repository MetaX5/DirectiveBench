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

export const fileContainsAssertionSchema = z
  .object({
    ...assertionBase,
    type: z.literal('file-contains'),
    path: relativePath,
    pattern: z.string().min(1),
    flags: z
      .string()
      .regex(/^[imsu]*$/, 'only the regex flags i, m, s and u are allowed')
      .default(''),
    /** Pass when the pattern does NOT match. */
    negate: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      new RegExp(value.pattern, value.flags);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: `invalid regex: ${(error as Error).message}`,
      });
    }
  });

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

export const assertionSchema = z.discriminatedUnion('type', [
  commandAssertionSchema,
  fileExistsAssertionSchema,
  fileContainsAssertionSchema,
  changedFilesAssertionSchema,
]);
export type AssertionDefinition = z.infer<typeof assertionSchema>;
export type AssertionType = AssertionDefinition['type'];

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
    (c) => c.setup.length > 0 || c.assertions.some((a) => a.type === 'command'),
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
 * `llm-judge`) must be added here so results are flagged (SPEC-111 FR-111-42).
 */
export function isDeterministicAssertion(assertion: AssertionDefinition): boolean {
  switch (assertion.type) {
    case 'command':
    case 'file-exists':
    case 'file-contains':
    case 'changed-files':
      return true;
  }
}
