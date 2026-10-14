import type { Metadata } from 'next';
import { PlannedSection } from '@/components/common';

export const metadata: Metadata = { title: 'Repositories' };

export default function RepositoriesPage() {
  return (
    <PlannedSection
      title="Repositories"
      summary="Register GitHub, GitLab (including self-managed instances) and local Git repositories, then synchronise them read-only to discover skills, instructions and rules. In this release artifacts can only be loaded from the bundled examples."
      milestone="Milestones 1–2"
      specs={[
        '.ai/specs/2026-10-14-repository-management.md',
        '.ai/specs/2026-10-14-repository-synchronization.md',
        '.ai/specs/2026-10-14-integration-github.md',
        '.ai/specs/2026-10-14-integration-gitlab.md',
      ]}
    />
  );
}
