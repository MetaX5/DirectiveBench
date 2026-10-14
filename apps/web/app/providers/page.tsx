import type { Metadata } from 'next';
import { PlannedSection } from '@/components/common';

export const metadata: Metadata = { title: 'Model Providers' };

export default function ProvidersPage() {
  return (
    <PlannedSection
      title="Model Providers"
      summary="Provider connections (Anthropic, OpenAI, DeepSeek, Z.AI GLM, Moonshot Kimi and custom OpenAI/Anthropic-compatible endpoints) are independent of agent harnesses. No provider integration or API-key storage exists in this release."
      milestone="Milestones 4 and 6"
      specs={[
        '.ai/specs/2026-10-14-integration-custom-model-providers.md',
        '.ai/specs/2026-10-14-integration-anthropic-api.md',
        '.ai/specs/2026-10-14-integration-openai-api.md',
      ]}
    />
  );
}
