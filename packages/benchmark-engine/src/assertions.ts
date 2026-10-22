import { stat } from 'node:fs/promises';
import { matchesGlob } from 'node:path';
import { resolveInside } from '@directivebench/agent-adapters';
import {
  assertionError,
  assertionResult as result,
  readWorkspaceText,
  type AssertionContext,
  type AssertionResult,
} from './assertion-support';
import { runCommand } from './commands';
import { ASSERTION_TYPE_TRAITS, type AssertionDefinition, type AssertionType } from './definition';
import { documentAssertionEvaluators } from './document-assertions';
import { matchPatterns } from './pattern-worker';

export type { AssertionContext, AssertionResult } from './assertion-support';
export { ASSERTION_REGEX_TIMEOUT_MS } from './pattern-worker';

type Of<T extends AssertionType> = Extract<AssertionDefinition, { type: T }>;

/**
 * One assertion type (SPEC-107 §8.3). The definition schema of each type is part of the
 * discriminated union in `definition.ts`, which the web app imports without evaluator code.
 */
export interface AssertionPlugin<T extends AssertionType> {
  type: T;
  deterministic: boolean;
  /** True when evaluating runs commands, which requires suite execution approval. */
  executesCommands: boolean;
  /** Must not throw; `evaluateAssertion` still turns a thrown error into a failed result. */
  evaluate(assertion: Of<T>, context: AssertionContext): Promise<AssertionResult>;
}

async function evaluateCommand(
  assertion: Of<'command'>,
  context: AssertionContext,
): Promise<AssertionResult> {
  const run = await runCommand(assertion.command, {
    cwd: context.workspaceDir,
    env: context.commandEnv,
    timeoutMs: assertion.timeoutSeconds
      ? assertion.timeoutSeconds * 1000
      : context.defaultTimeoutMs,
    maxOutputBytes: context.maxOutputBytes,
    signal: context.signal,
  });
  const details = {
    command: run.command,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    stdout: run.stdout,
    stderr: run.stderr,
    truncated: run.truncated,
  };
  if (run.error) return result(assertion, false, `Command failed to start: ${run.error}`, details);
  if (run.timedOut) return result(assertion, false, 'Command timed out', details);
  if (run.cancelled) return result(assertion, false, 'Command cancelled', details);
  const passed = run.exitCode === assertion.expectExitCode;
  return result(
    assertion,
    passed,
    passed
      ? `Exited with ${run.exitCode}`
      : `Exited with ${run.exitCode ?? run.signal}, expected ${assertion.expectExitCode}`,
    details,
  );
}

async function evaluateFileExists(
  assertion: Of<'file-exists'>,
  context: AssertionContext,
): Promise<AssertionResult> {
  const path = resolveInside(context.workspaceDir, assertion.path);
  const exists = Boolean(await stat(path).catch(() => null));
  const passed = exists === assertion.exists;
  return result(assertion, passed, `${assertion.path} ${exists ? 'exists' : 'does not exist'}`);
}

async function evaluateFileContains(
  assertion: Of<'file-contains'>,
  context: AssertionContext,
): Promise<AssertionResult> {
  const read = await readWorkspaceText(context.workspaceDir, assertion.path);
  if (!read.ok) return result(assertion, false, read.message);
  const label = `/${assertion.pattern}/${assertion.flags}`;
  const outcome = await matchPatterns(
    [{ pattern: assertion.pattern, flags: assertion.flags, texts: [read.text], firstOnly: true }],
    context.signal,
  );
  if (!outcome.ok) return assertionError(assertion, outcome.error, [label]);
  const matched = (outcome.matches[0] as number[]).length > 0;
  const passed = assertion.negate ? !matched : matched;
  return result(
    assertion,
    passed,
    `${label} ${matched ? 'matched' : 'did not match'} in ${assertion.path}`,
  );
}

async function evaluateChangedFiles(
  assertion: Of<'changed-files'>,
  context: AssertionContext,
): Promise<AssertionResult> {
  const disallowed = assertion.allowed
    ? context.changedFiles.filter(
        (f) => !assertion.allowed?.some((pattern) => matchesGlob(f.path, pattern)),
      )
    : [];
  const forbidden = assertion.forbidden
    ? context.changedFiles.filter((f) =>
        assertion.forbidden?.some((pattern) => matchesGlob(f.path, pattern)),
      )
    : [];
  const violations = [...new Set([...disallowed, ...forbidden].map((f) => f.path))].sort();
  const passed = violations.length === 0;
  return result(
    assertion,
    passed,
    passed
      ? `${context.changedFiles.length} changed file(s), all within limits`
      : `Unexpected changes: ${violations.join(', ')}`,
    { changedFiles: context.changedFiles, violations },
  );
}

function plugin<T extends AssertionType>(
  type: T,
  evaluate: AssertionPlugin<T>['evaluate'],
): AssertionPlugin<T> {
  return { type, ...ASSERTION_TYPE_TRAITS[type], evaluate };
}

/** The assertion plugin registry: exactly one plugin per assertion type of the format. */
export const assertionPlugins: { readonly [T in AssertionType]: AssertionPlugin<T> } = {
  command: plugin('command', evaluateCommand),
  'file-exists': plugin('file-exists', evaluateFileExists),
  'file-contains': plugin('file-contains', evaluateFileContains),
  'changed-files': plugin('changed-files', evaluateChangedFiles),
  'markdown-sections': plugin(
    'markdown-sections',
    documentAssertionEvaluators['markdown-sections'],
  ),
  'required-phrases': plugin('required-phrases', documentAssertionEvaluators['required-phrases']),
  'markdown-table-value': plugin(
    'markdown-table-value',
    documentAssertionEvaluators['markdown-table-value'],
  ),
};

/**
 * Evaluates one assertion. Never throws: failures to evaluate are failed assertions, and an
 * evaluation that cannot finish (a bounded pattern) carries `error`.
 */
export async function evaluateAssertion(
  assertion: AssertionDefinition,
  context: AssertionContext,
): Promise<AssertionResult> {
  // Safe: the registry maps each type to the plugin for exactly that type, and `assertion.type`
  // selects it; TypeScript cannot correlate the two through the indexed access.
  const evaluator = assertionPlugins[assertion.type] as AssertionPlugin<AssertionType>;
  try {
    return await evaluator.evaluate(assertion, context);
  } catch (error) {
    return result(
      assertion,
      false,
      `Assertion could not be evaluated: ${(error as Error).message}`,
    );
  }
}
