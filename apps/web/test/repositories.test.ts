import { describe, expect, it } from 'vitest';
import type { RepositoryRecord, RepositoryRegistration } from '@directivebench/database';
import { branchLabel, describeRegistration, providerLabel } from '../lib/repositories';

const repository: RepositoryRecord = {
  id: 'repo_1',
  provider: 'local-git',
  name: 'skills',
  location: '/srv/skills',
  instanceUrl: null,
  defaultBranch: 'main',
  selectedBranch: null,
  lastCommitSha: null,
  lastSyncAt: null,
  syncStatus: 'never',
  syncError: null,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
};

function registration(overrides: Partial<RepositoryRegistration>): RepositoryRegistration {
  return {
    jobId: 'job_1',
    status: 'completed',
    path: '~/skills',
    error: null,
    result: null,
    repository: null,
    ...overrides,
  };
}

describe('providerLabel', () => {
  it('names every provider', () => {
    expect(
      (['github', 'gitlab', 'local-git', 'local-directory', 'bundled-examples'] as const).map(
        providerLabel,
      ),
    ).toEqual(['GitHub', 'GitLab', 'Local Git', 'Local directory', 'Bundled examples']);
  });
});

describe('branchLabel', () => {
  it('prefers the selected branch, then the detected one', () => {
    expect(branchLabel(repository)).toBe('main');
    expect(branchLabel({ ...repository, selectedBranch: 'release' })).toBe('release');
    expect(branchLabel({ ...repository, defaultBranch: null })).toBe('not detected');
  });

  it('has no branch for directories and bundled examples', () => {
    expect(branchLabel({ ...repository, provider: 'local-directory' })).toBeNull();
    expect(branchLabel({ ...repository, provider: 'bundled-examples' })).toBeNull();
  });
});

describe('describeRegistration', () => {
  it('keeps refreshing while the job waits for or runs in the runner', () => {
    expect(describeRegistration(registration({ status: 'pending' }))).toEqual({
      kind: 'active',
      path: '~/skills',
      message:
        'Waiting for the runner to check ~/skills. The runner is part of `directivebench serve`.',
    });
    expect(describeRegistration(registration({ status: 'running' }))).toEqual({
      kind: 'active',
      path: '~/skills',
      message: 'Checking ~/skills (read-only)…',
    });
  });

  it('confirms a new or an already registered repository', () => {
    expect(
      describeRegistration(
        registration({ result: { ok: true, repositoryId: 'repo_1', created: true }, repository }),
      ),
    ).toEqual({
      kind: 'done',
      path: '~/skills',
      message: 'Registered skills (Local Git, /srv/skills).',
    });
    expect(
      describeRegistration(
        registration({ result: { ok: true, repositoryId: 'repo_1', created: false }, repository }),
      ).message,
    ).toBe('skills (Local Git, /srv/skills) is already registered.');
  });

  it('turns rejections and failures into a field error', () => {
    const rejected = registration({
      result: { ok: false, code: 'path-not-found', message: 'No directory exists at this path.' },
    });
    const cases: [RepositoryRegistration, string][] = [
      [rejected, 'No directory exists at this path.'],
      [
        registration({ status: 'failed', error: 'database is locked' }),
        'The check failed: database is locked',
      ],
      [registration({ status: 'failed' }), 'The check failed: unknown error'],
      [registration({ status: 'cancelled' }), 'The registration was cancelled.'],
      [
        registration({ status: 'interrupted' }),
        'The runner stopped before the check finished. Register the path again.',
      ],
      [registration({}), 'The runner finished without a result.'],
      [
        registration({ result: { ok: true, repositoryId: 'repo_gone', created: true } }),
        'The registered repository no longer exists.',
      ],
    ];
    for (const [input, message] of cases) {
      expect(describeRegistration(input)).toEqual({
        kind: 'fieldError',
        path: '~/skills',
        message,
      });
    }
  });
});
