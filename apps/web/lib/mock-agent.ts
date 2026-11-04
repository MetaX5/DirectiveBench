import type { MOCK_AGENT_ID } from '@directivebench/agent-adapters';

/**
 * The mock agent's adapter id. The web app may import agent adapters for detection only
 * (SPEC-003 §2.1), so the value is repeated here, and the type-only import makes `pnpm typecheck`
 * fail if it ever differs from `MOCK_AGENT_ID`.
 */
const mockAgentId: typeof MOCK_AGENT_ID = 'mock';

/**
 * True when a run, a suite or an agent setting uses the deterministic mock agent. Every place
 * that shows such a run, result or configured agent must show `MockBadge` ("Mock agent: not an
 * AI evaluation"; AGENTS.md §7, SPEC-101 FR-101-14, SPEC-116 FR-116-14).
 */
export function isMockAgent(agentAdapterId: string | null | undefined): boolean {
  return agentAdapterId === mockAgentId;
}
