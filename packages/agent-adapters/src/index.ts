import type { AgentAdapter } from './contract';
import { MockAgentAdapter } from './mock';

export * from './claude-code-readiness';
export * from './contract';
export * from './detection';
export * from './mock';
export * from './paths';
export * from './probe';

/**
 * Adapters that can execute benchmarks in this build. Real harness adapters are added here
 * once implemented (Milestone 4); until then only the mock is executable.
 */
export function createExecutableAdapters(): Map<string, AgentAdapter> {
  const mock = new MockAgentAdapter();
  return new Map<string, AgentAdapter>([[mock.id, mock]]);
}
