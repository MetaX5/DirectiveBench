import { describe, expect, it } from 'vitest';
import type {
  RepositoryRecord,
  RepositoryRegistration,
  RepositoryScan,
} from '@directivebench/database';
import {
  branchLabel,
  canScan,
  describeRegistration,
  describeScan,
  lastScanLabel,
  pathFieldError,
  providerLabel,
} from '../lib/repositories';

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

describe('pathFieldError', () => {
  it('re-validates the path sent back by the action', () => {
    expect(pathFieldError('/srv/skills')).toBeNull();
    expect(pathFieldError('relative')).toBe(
      'Enter an absolute path, for example /home/you/project or ~/project.',
    );
    expect(pathFieldError('')).toBe('Enter the path of a local directory.');
  });
});

describe('describeRegistration', () => {
  it('keeps refreshing while the job waits for or runs in the runner', () => {
    expect(describeRegistration(registration({ status: 'pending' }))).toEqual({
      kind: 'active',
      path: '~/skills',
      message: 'Waiting for the runner to check ~/skills. It runs inside directivebench serve.',
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

describe('describeRegistration confirmation (FR-104-18)', () => {
  const confirm = (
    home: 'home' | 'contains-home' | null,
    overlaps: { relation: 'inside' | 'contains' }[],
  ) =>
    describeRegistration(
      registration({
        result: {
          ok: false,
          code: 'confirmation-required',
          location: '/home/me',
          home,
          overlaps: overlaps.map(({ relation }) => ({
            repositoryId: 'repo_1',
            name: 'skills',
            location: '/home/me/skills',
            relation,
          })),
        },
      }),
    );

  it('asks to confirm the canonical location and explains the home directory', () => {
    expect(confirm('home', [])).toEqual({
      kind: 'confirm',
      path: '~/skills',
      location: '/home/me',
      message: 'Register /home/me anyway?',
      reasons: [
        'This is your home directory. A scan reads every file below it (except .git and node_modules), which can take long, and includes user-level folders such as ~/.claude/skills and the skills of every project in it.',
      ],
    });
    const above = confirm('contains-home', []);
    expect(above.kind === 'confirm' && above.reasons[0]).toMatch(
      /^This directory contains your home directory\./,
    );
  });

  it('explains double counting for each overlapping repository', () => {
    const notice = confirm(null, [{ relation: 'contains' }, { relation: 'inside' }]);
    expect(notice.kind === 'confirm' && notice.reasons).toEqual([
      "It contains the registered repository skills (/home/me/skills). A scan reads that repository's files again and counts each of its artifacts twice, once per repository.",
      'It is inside the registered repository skills (/home/me/skills). Its files are already scanned there; registering it too counts each of its artifacts twice, once per repository.',
    ]);
  });
});

describe('canScan and lastScanLabel', () => {
  it('offers scanning for local repositories only', () => {
    expect(canScan(repository)).toBe(true);
    expect(canScan({ provider: 'local-directory' })).toBe(true);
    expect(canScan({ provider: 'bundled-examples' })).toBe(false);
    expect(canScan({ provider: 'github' })).toBe(false);
  });

  it('shows never, the last successful scan or the failure', () => {
    expect(lastScanLabel(repository)).toBe('Never');
    expect(
      lastScanLabel({ ...repository, syncStatus: 'ok', lastSyncAt: '2026-10-19T10:00:00.000Z' }),
    ).toBe('19 Oct 2026, 10:00 UTC');
    expect(lastScanLabel({ ...repository, syncStatus: 'error', syncError: 'gone' })).toBe(
      'Failed: gone',
    );
    expect(lastScanLabel({ ...repository, syncStatus: 'error' })).toBe('Failed: unknown error');
  });
});

describe('describeScan', () => {
  function scan(overrides: Partial<RepositoryScan>): RepositoryScan {
    return {
      jobId: 'job_1',
      status: 'completed',
      repositoryId: 'repo_1',
      error: null,
      result: null,
      repository,
      ...overrides,
    };
  }
  const empty = { errors: [], errorCount: 0 };

  it('keeps refreshing while the scan waits or runs', () => {
    expect(describeScan(scan({ status: 'pending' }))).toEqual({
      kind: 'active',
      message: 'Waiting for the runner to scan skills.',
      ...empty,
    });
    expect(describeScan(scan({ status: 'running', repository: null }))).toEqual({
      kind: 'active',
      message: 'Scanning the repository (read-only, working tree)…',
      ...empty,
    });
  });

  it('summarises a completed scan with its discovery errors', () => {
    const errors = [{ path: 'CLAUDE.md', code: 'symlink' as const, message: 'not followed' }];
    expect(
      describeScan(
        scan({
          result: {
            ok: true,
            scannedFiles: 1,
            discovered: 4,
            createdArtifacts: 4,
            createdVersions: 1,
            warningCount: 0,
            errorCount: 101,
            errors,
            durationMs: 1234,
          },
        }),
      ),
    ).toEqual({
      kind: 'done',
      message:
        'Scanned skills: 1 file in 1.2 s, 4 artifacts found (4 new, 1 new version), 101 errors.',
      errors,
      errorCount: 101,
    });
  });

  it('reports failures, cancellation and missing results', () => {
    const cases: [RepositoryScan, string][] = [
      [
        scan({ status: 'failed', error: 'database is locked' }),
        'The scan failed: database is locked',
      ],
      [scan({ status: 'failed' }), 'The scan failed: unknown error'],
      [scan({ status: 'cancelled' }), 'The scan was cancelled. Nothing was changed.'],
      [
        scan({ status: 'interrupted' }),
        'The runner stopped before the scan finished. Nothing was changed.',
      ],
      [scan({}), 'The runner finished without a result.'],
      [
        scan({
          result: {
            ok: false,
            code: 'path-not-found',
            message: 'The registered directory no longer exists.',
          },
        }),
        'The registered directory no longer exists.',
      ],
    ];
    for (const [input, message] of cases) {
      expect(describeScan(input)).toEqual({ kind: 'error', message, ...empty });
    }
  });
});
