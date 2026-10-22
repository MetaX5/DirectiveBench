import { z } from 'zod';

/**
 * Presentation logic for stored benchmark runs of real agents (SPEC-118 FR-118-50…52, SPEC-113
 * FR-113-10). The stored JSON (run summary, agent-run trace, usage, assertion details) is parsed
 * here with Zod, so a field this version does not know, or a run stored before a field existed,
 * reads as "not reported" instead of breaking the page — never as an invented value.
 */

/** The agent profile a real-agent adapter reports (SPEC-118 §8.2), in `summary.environment`. */
const agentProfileSchema = z.object({
  authMode: z.enum(['subscription', 'api-key']),
  isolationProfile: z.enum(['isolated', 'user-profile']),
  permissionProfile: z.enum(['edit-only', 'edit-and-shell']),
  flagsHash: z.string(),
  executionModel: z.string(),
  hostId: z.string().optional(),
});

export type AgentProfile = z.infer<typeof agentProfileSchema>;

const invocationSchema = z.object({ invoked: z.number(), runs: z.number() });

/** The parts of a stored run summary the results views read; everything else is ignored. */
const storedSummarySchema = z.object({
  // Nullish throughout: `listArtifactRuns` returns a lean summary whose missing fields are null.
  delta: z.number().nullish(),
  verdict: z.string().nullish(),
  candidateOutcome: z.enum(['passed', 'failed']).nullish(),
  candidate: z.object({ meanScore: z.number().nullish() }).nullish(),
  confidence: z.object({ level: z.string().nullish() }).nullish(),
  scoring: z.object({ minDelta: z.number().nullish() }).nullish(),
  environment: z.object({ agentProfile: agentProfileSchema.nullish() }).nullish(),
  /** Skill invocations per variant, `skill-md` runs of a real agent (SPEC-118 FR-118-09). */
  skillInvocation: z.object({ baseline: invocationSchema, candidate: invocationSchema }).optional(),
});

export type StoredSummary = z.infer<typeof storedSummarySchema>;

/** The readable parts of a stored summary; an unreadable or missing summary reads as empty. */
export function readSummary(summary: unknown): StoredSummary {
  const parsed = storedSummarySchema.safeParse(summary);
  return parsed.success ? parsed.data : {};
}

/** The agent profile of a run, or null when the adapter reported none (e.g. the mock agent). */
export function agentProfileOf(summary: unknown): AgentProfile | null {
  return readSummary(summary).environment?.agentProfile ?? null;
}

/** "no artifact" for baseline kind `none`, else the baseline version (SPEC-118 FR-118-50). */
export function baselineName(baseline: { version: number } | null): string {
  return baseline ? `v${baseline.version}` : 'no artifact';
}

/** Header and column label of the baseline variant (SPEC-118 FR-118-52). */
export function baselineLabel(baseline: { version: number } | null): string {
  return `Baseline (${baselineName(baseline)})`;
}

/** Header and column label of the candidate variant (SPEC-118 FR-118-52). */
export function candidateLabel(candidate: { version: number }): string {
  return `Candidate (v${candidate.version})`;
}

export const NOT_REPORTED = 'not reported';

/**
 * The model of a run: the requested model and, when the adapter reported one, the execution
 * model the agent actually ran on (SPEC-118 FR-118-04).
 */
export function modelLabel(
  requested: { provider: string; model: string } | null,
  profile: AgentProfile | null,
): string {
  const name = requested ? `${requested.provider}/${requested.model}` : null;
  if (!profile) return name ?? 'n/a';
  return `${name ?? 'agent default'} → ${profile.executionModel}`;
}

const AMBIENT_USER_CONFIG = 'ambient-user-config';

export interface RunWarning {
  /** The warning code (the stored text before its first colon), or null for free text. */
  code: string | null;
  text: string;
  /** Explanation shown next to known codes. */
  explanation: string | null;
}

const WARNING_EXPLANATIONS: Record<string, string> = {
  [AMBIENT_USER_CONFIG]:
    'May include user-level instructions (Local Subscription Mode): Claude Code loaded your user-level configuration (~/.claude) into both variants.',
  'artifact-not-invoked': 'The installed skill was loaded but the agent did not invoke it.',
  'unpinned-model': 'No model was pinned; the agent used its default model.',
  'auxiliary-models': 'The agent used other models for internal work; they are not compared.',
};

const CODE = /^([a-z][a-z0-9-]*)(?::|$)/;

/**
 * The warnings of a run with explanations for known codes (SPEC-118 §11). A run whose profile
 * says `user-profile` always carries the ambient-configuration warning, even if it was not
 * stored, so the label can never be missing (§12).
 */
export function runWarnings(
  warnings: readonly string[],
  profile: AgentProfile | null,
): RunWarning[] {
  const result = warnings.map((text) => {
    const code = CODE.exec(text)?.[1] ?? null;
    return {
      code,
      text,
      explanation:
        code !== null && Object.hasOwn(WARNING_EXPLANATIONS, code)
          ? (WARNING_EXPLANATIONS[code] as string)
          : null,
    };
  });
  if (
    profile?.isolationProfile === 'user-profile' &&
    !result.some((w) => w.code === AMBIENT_USER_CONFIG)
  ) {
    result.unshift({
      code: AMBIENT_USER_CONFIG,
      text: AMBIENT_USER_CONFIG,
      explanation: WARNING_EXPLANATIONS[AMBIENT_USER_CONFIG] as string,
    });
  }
  return result;
}

/** True when the results may include the user's own configuration (SPEC-118 §12). */
export function hasAmbientConfig(
  warnings: readonly string[],
  profile: AgentProfile | null,
): boolean {
  return runWarnings(warnings, profile).some((w) => w.code === AMBIENT_USER_CONFIG);
}

const agentMetadataEventSchema = z.object({
  type: z.literal('agent-metadata'),
  metadata: z.object({
    requestedModel: z.string().nullable(),
    executionModel: z.string().nullable(),
    reportedModels: z.array(z.string()),
  }),
  skillActivation: z
    .object({
      loaded: z.boolean(),
      invoked: z.boolean(),
      invocations: z.number(),
      otherSkills: z.array(z.string()),
    })
    .optional(),
});

export type AgentRunMetadataEvent = z.infer<typeof agentMetadataEventSchema>;

/** The `agent-metadata` trace event of a real-agent run (SPEC-118 §8.1), or null. */
export function agentRunMetadata(trace: unknown): AgentRunMetadataEvent | null {
  if (!Array.isArray(trace)) return null;
  for (const event of trace) {
    const parsed = agentMetadataEventSchema.safeParse(event);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Models the agent reported besides the execution model, over all agent runs, sorted
 * (SPEC-118 FR-118-52 "other reported models").
 */
export function otherReportedModels(
  traces: readonly unknown[],
  profile: AgentProfile | null,
): string[] {
  const models = new Set<string>();
  for (const trace of traces) {
    for (const model of agentRunMetadata(trace)?.metadata.reportedModels ?? []) models.add(model);
  }
  // A run whose agent runs disagreed stores the distinct models joined with " | " (FR-118-04).
  for (const model of profile?.executionModel.split(' | ') ?? []) models.delete(model);
  return [...models].sort();
}

/** "Skill invoked in n/N runs" per variant (SPEC-118 FR-118-09), or null when not recorded. */
export function invocationText(summary: unknown, variant: 'baseline' | 'candidate'): string | null {
  const rate = readSummary(summary).skillInvocation?.[variant];
  return rate ? `Skill invoked in ${rate.invoked}/${rate.runs} runs` : null;
}

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
});

function count(value: number | undefined): string {
  return value === undefined ? NOT_REPORTED : value.toLocaleString('en-US');
}

/**
 * Tokens and cost of one agent run exactly as reported, never invented (SPEC-118 FR-118-52):
 * "not reported" for a missing value; cost is "estimated" (a client-side figure) or, in Local
 * Subscription Mode, "n/a (subscription)".
 */
export function usageText(
  usage: unknown,
  profile: AgentProfile | null,
): { tokens: string; cost: string } {
  const parsed = usageSchema.safeParse(usage);
  const value = parsed.success ? parsed.data : {};
  const tokens =
    value.inputTokens === undefined && value.outputTokens === undefined
      ? NOT_REPORTED
      : `${count(value.inputTokens)} in / ${count(value.outputTokens)} out`;
  let cost: string;
  if (profile?.authMode === 'subscription') cost = 'n/a (subscription)';
  else if (value.costUsd === undefined) cost = NOT_REPORTED;
  else cost = `$${value.costUsd.toFixed(4)} (estimated)`;
  return { tokens, cost };
}

/** Counts of the Claude Code trace events the run detail summarises (SPEC-118 FR-118-52). */
export function traceCounts(trace: unknown): {
  toolCalls: number;
  permissionDenials: number;
  retries: number;
} {
  const counts = { toolCalls: 0, permissionDenials: 0, retries: 0 };
  if (!Array.isArray(trace)) return counts;
  for (const event of trace as unknown[]) {
    const type = (event as { type?: unknown } | null)?.type;
    if (type === 'tool-call') counts.toolCalls += 1;
    else if (type === 'permission-denied') counts.permissionDenials += 1;
    else if (type === 'retry') counts.retries += 1;
  }
  return counts;
}

const strings = z.array(z.string());

const errorDetailsSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  patterns: strings.optional(),
});
const globDetailsSchema = z.object({
  file: z.string(),
  matches: strings,
  matchCount: z.number(),
});
const readFailureDetailsSchema = z.object({ file: z.string(), target: z.string() });
const sectionsDetailsSchema = z.object({
  file: z.string(),
  found: strings,
  missing: strings,
  misordered: strings,
});
const phrasesDetailsSchema = z.object({ file: z.string(), found: strings, missing: strings });
const tableDetailsSchema = z.object({
  file: z.string(),
  row: z.string(),
  column: z.string(),
  tableIndex: z.number().optional(),
  rowText: z.string().optional(),
  cell: z.string().optional(),
  value: z.number().nullable().optional(),
});

/** The evaluation error of an assertion that could not finish (FR-118-46), or null. */
export function assertionErrorOf(details: unknown): { code: string; message: string } | null {
  const parsed = errorDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data.error : null;
}

export interface DetailLine {
  label: string;
  value: string;
}

function list(values: readonly string[]): string {
  return values.length ? values.join(', ') : '—';
}

/**
 * Readable lines for the details of the document assertions (SPEC-118 FR-118-40…46): an
 * evaluation error with its patterns, a glob that matched no or several files, and the
 * headings, phrases or table cell that were checked. Returned as plain strings, which React
 * renders as escaped text (§12); other details stay in the raw JSON view only.
 */
export function assertionDetailLines(type: string, details: unknown): DetailLine[] {
  const error = errorDetailsSchema.safeParse(details);
  if (error.success) {
    return [
      { label: 'Evaluation error', value: `${error.data.error.code}: ${error.data.error.message}` },
      ...(error.data.patterns ? [{ label: 'Patterns', value: list(error.data.patterns) }] : []),
    ];
  }
  const glob = globDetailsSchema.safeParse(details);
  if (glob.success) {
    return [
      { label: 'File pattern', value: glob.data.file },
      {
        label: `Matches (${glob.data.matchCount})`,
        value:
          glob.data.matchCount > glob.data.matches.length
            ? `${list(glob.data.matches)} … ${glob.data.matchCount - glob.data.matches.length} more`
            : list(glob.data.matches),
      },
    ];
  }
  const readFailure = readFailureDetailsSchema.safeParse(details);
  if (readFailure.success) {
    return [
      { label: 'File', value: readFailure.data.file },
      { label: 'Resolved to', value: readFailure.data.target },
    ];
  }
  if (type === 'markdown-sections') {
    const parsed = sectionsDetailsSchema.safeParse(details);
    if (!parsed.success) return [];
    return [
      { label: 'File', value: parsed.data.file },
      { label: 'Found', value: list(parsed.data.found) },
      { label: 'Missing', value: list(parsed.data.missing) },
      ...(parsed.data.misordered.length
        ? [{ label: 'Out of order', value: list(parsed.data.misordered) }]
        : []),
    ];
  }
  if (type === 'required-phrases') {
    const parsed = phrasesDetailsSchema.safeParse(details);
    if (!parsed.success) return [];
    return [
      { label: 'File', value: parsed.data.file },
      { label: 'Found', value: list(parsed.data.found) },
      { label: 'Missing', value: list(parsed.data.missing) },
    ];
  }
  if (type === 'markdown-table-value') {
    const parsed = tableDetailsSchema.safeParse(details);
    if (!parsed.success) return [];
    const { file, row, column, tableIndex, rowText, cell, value } = parsed.data;
    return [
      { label: 'File', value: file },
      { label: 'Row', value: row },
      { label: 'Column', value: column },
      ...(tableIndex === undefined ? [] : [{ label: 'Table', value: `#${tableIndex}` }]),
      ...(rowText === undefined ? [] : [{ label: 'Row text', value: rowText }]),
      ...(cell === undefined ? [] : [{ label: 'Cell', value: cell }]),
      ...(value === undefined
        ? []
        : [{ label: 'Value', value: value === null ? 'no number' : String(value) }]),
    ];
  }
  return [];
}
