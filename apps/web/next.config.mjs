import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const monorepoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Next 16.4 writes apps/web/AGENTS.md when `next dev` detects an AI coding agent; the
  // repository keeps its agent instructions in the root AGENTS.md.
  agentRules: false,
  // Workspace packages export TypeScript source ("just-in-time" packages).
  transpilePackages: [
    '@directivebench/core',
    '@directivebench/database',
    '@directivebench/agent-adapters',
    '@directivebench/benchmark-engine',
  ],
  // The CLI ships this app's build output inside the npm package; the monorepo root only
  // exists during development and builds.
  ...(existsSync(new URL('../../pnpm-workspace.yaml', import.meta.url))
    ? { turbopack: { root: monorepoRoot }, outputFileTracingRoot: monorepoRoot }
    : {}),
};

export default nextConfig;
