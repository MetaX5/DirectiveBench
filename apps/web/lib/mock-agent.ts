import type { MOCK_AGENT_ID } from '@directivebench/agent-adapters';

/**
 * The mock agent's adapter id. The web app may import agent adapters for detection only
 * (SPEC-003 §2.1), so the value is repeated here, and the type-only import makes `pnpm typecheck`
 * fail if it ever differs from `MOCK_AGENT_ID`.
 */
const mockAgentId: typeof MOCK_AGENT_ID = 'mock';

/**
 * True when a run or suite used the deterministic mock agent, so its score must carry the
 * "Mock agent — not an AI evaluation" label (AGENTS.md, SPEC-101 FR-101-14). Every page that
 * shows a score uses this check.
 */
export function isMockAgent(agentAdapterId: string | null | undefined): boolean {
  return agentAdapterId === mockAgentId;
}
