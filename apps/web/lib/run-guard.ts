import {
  executionBlockers,
  type BenchmarkDefinition,
} from '@directivebench/benchmark-engine/definition';
import { isMockAgent } from './mock-agent';

/**
 * The planned CLI command that runs a suite with a real agent (SPEC-118 FR-118-30). Shown,
 * never executed: the web app only enqueues mock-agent runs.
 */
export function cliRunCommand(artifactSlug: string): string {
  return `directivebench benchmark run <suite-folder> --artifact ${artifactSlug}`;
}

/**
 * Why the web app must not enqueue this suite version: the execution blockers the runner also
 * enforces, and — first — any agent other than the mock agent. Real agents run only from the
 * CLI in S1, so a `claude-code` suite is refused even when the server action is called directly
 * (SPEC-118 FR-118-05/53, SPEC-114 FR-114-02).
 */
export function webRunBlockers(definition: BenchmarkDefinition, approved: boolean): string[] {
  const blockers = executionBlockers(definition, approved);
  if (isMockAgent(definition.execution.agent)) return blockers;
  return [
    `This suite uses agent "${definition.execution.agent}". The web UI runs only mock-agent suites; real agents run from the CLI (planned — not implemented yet).`,
    ...blockers,
  ];
}
