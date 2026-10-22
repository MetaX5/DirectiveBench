import { readFile, stat } from 'node:fs/promises';
import { matchesGlob } from 'node:path';
import { resolveInside } from '@directivebench/agent-adapters';
import { runCommand } from './commands';
import type { AssertionDefinition } from './definition';
import type { FileChange } from './files';

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
}

export interface AssertionContext {
  workspaceDir: string;
  changedFiles: readonly FileChange[];
  commandEnv: Record<string, string>;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

const MAX_READ_BYTES = 2 * 1024 * 1024;

function result(
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
    deterministic: true,
    message,
    details,
  };
}

/** Evaluates one assertion. Never throws: failures to evaluate are failed assertions. */
export async function evaluateAssertion(
  assertion: AssertionDefinition,
  context: AssertionContext,
): Promise<AssertionResult> {
  try {
    switch (assertion.type) {
      case 'command': {
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
          strayProcesses: run.strayProcesses,
        };
        if (run.error)
          return result(assertion, false, `Command failed to start: ${run.error}`, details);
        if (run.timedOut) return result(assertion, false, 'Command timed out', details);
        if (run.cancelled) return result(assertion, false, 'Command cancelled', details);
        // Survivors could still change the workspace under the following assertions.
        if (run.strayProcesses) {
          return result(
            assertion,
            false,
            'Command left processes that could not be stopped',
            details,
          );
        }
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
      case 'file-exists': {
        const path = resolveInside(context.workspaceDir, assertion.path);
        const exists = Boolean(await stat(path).catch(() => null));
        const passed = exists === assertion.exists;
        return result(
          assertion,
          passed,
          `${assertion.path} ${exists ? 'exists' : 'does not exist'}`,
        );
      }
      case 'file-contains': {
        const path = resolveInside(context.workspaceDir, assertion.path);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) return result(assertion, false, `${assertion.path} does not exist`);
        if (info.size > MAX_READ_BYTES) {
          return result(
            assertion,
            false,
            `${assertion.path} is larger than ${MAX_READ_BYTES} bytes`,
          );
        }
        const content = await readFile(path, 'utf8');
        const matched = new RegExp(assertion.pattern, assertion.flags).test(content);
        const passed = assertion.negate ? !matched : matched;
        return result(
          assertion,
          passed,
          `/${assertion.pattern}/${assertion.flags} ${matched ? 'matched' : 'did not match'} in ${assertion.path}`,
        );
      }
      case 'changed-files': {
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
    }
  } catch (error) {
    return result(
      assertion,
      false,
      `Assertion could not be evaluated: ${(error as Error).message}`,
    );
  }
}
