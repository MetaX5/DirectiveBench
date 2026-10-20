import { describe, expect, it } from 'vitest';
import { CREDENTIALS_IN_URL_MESSAGE } from '@directivebench/core';
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
  mayCarryCredentials,
  pathFieldError,
  providerLabel,
  scanRequestError,
  urlFieldError,
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
    input: '~/skills',
    source: 'path',
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

  it('re-validates a URL sent back by the action', () => {
    expect(pathFieldError('https://github.com/acme/skills')).toBeNull();
    expect(pathFieldError('https://gitlab.com/acme/skills')).toContain(
      'Only public repositories on github.com',
    );
  });
});

describe('mayCarryCredentials', () => {
  it('flags user info, queries and fragments, also percent-encoded, in any shape', () => {
    for (const input of [
      'https://u:t@github.com/a/b',
      'http//u:t@github.com/a/b',
      'https:/github.com/a/b?access_token=t',
      'github.com/a/b#t',
      'https:/github.com/a/b%3Ftoken',
      'https:/github.com/a/b%3ftoken',
      'u%40github.com/a',
      '/a/b%23c',
    ]) {
      expect(mayCarryCredentials(input)).toBe(true);
    }
    for (const input of ['/srv/skills', '~/skills', 'https:/github.com/a/b', 'code/skills', '']) {
      expect(mayCarryCredentials(input)).toBe(false);
    }
  });
});

describe('urlFieldError', () => {
  it('names the reason for a URL sent back without its input', () => {
    expect(urlFieldError('credentials-in-url')).toBe(CREDENTIALS_IN_URL_MESSAGE);
    expect(urlFieldError('unsupported-provider')).toContain('Only public GitHub repositories');
    expect(urlFieldError('invalid-url')).toContain('https://github.com/<owner>/<repo>');
    expect(urlFieldError('not-echoed')).toContain('It is not shown again because');
    expect(urlFieldError(undefined)).toBeNull();
    expect(urlFieldError('toString')).toBeNull();
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
    const url = 'https://github.com/acme/skills';
    expect(
      describeRegistration(registration({ status: 'running', input: url, source: 'url' })),
    ).toEqual({
      kind: 'active',
      path: url,
      message: `Asking GitHub about ${url} (read-only, without credentials; nothing is downloaded yet)…`,
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
        'The runner stopped before the check finished. Register it again.',
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
        'This is your home directory. A scan reads every file below it (except .git and node_modules), which can take long, and includes the skills of every project in it. User-level agent folders such as ~/.claude, ~/.codex, ~/.cursor and ~/.agents are always skipped.',
      ],
    });
    // D05: user-level folders are never included, so the confirmation never promises them.
    const above = confirm('contains-home', []);
    expect(above.kind === 'confirm' && above.reasons).toEqual([
      'This directory contains your home directory. A scan reads every file below it (except .git and node_modules), which can take very long. User-level agent folders such as ~/.claude, ~/.codex, ~/.cursor and ~/.agents are always skipped.',
    ]);
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
  it('offers scanning for local and GitHub repositories only', () => {
    expect(canScan(repository)).toBe(true);
    expect(canScan({ provider: 'local-directory' })).toBe(true);
    expect(canScan({ provider: 'github' })).toBe(true);
    expect(canScan({ provider: 'bundled-examples' })).toBe(false);
    expect(canScan({ provider: 'gitlab' })).toBe(false);
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
  const empty = { errors: [], errorCount: 0, info: null };

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
    expect(
      describeScan(
        scan({
          status: 'running',
          repository: { ...repository, provider: 'github', name: 'acme/skills' },
        }),
      ).message,
    ).toBe(
      'Scanning acme/skills: downloading only the candidate files of its latest commit (read-only)…',
    );
  });

  it('names the commit a hosted scan read', () => {
    const result = {
      ok: true as const,
      scannedFiles: 2,
      discovered: 1,
      createdArtifacts: 1,
      createdVersions: 1,
      warningCount: 0,
      errorCount: 0,
      errors: [],
      skippedUserLevelFolders: [],
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      durationMs: 10,
    };
    expect(describeScan(scan({ result })).message).toBe(
      'Scanned skills at commit 0123456789ab: 2 files in 10 ms, 1 artifact found (1 new, 1 new version), 0 errors.',
    );
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
            skippedUserLevelFolders: [],
            commitSha: null,
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
      info: null,
    });
  });

  it('mentions the user-level agent folders a scan skipped, as information (D05)', () => {
    const done = (skippedUserLevelFolders: string[]) =>
      describeScan(
        scan({
          result: {
            ok: true,
            scannedFiles: 0,
            discovered: 0,
            createdArtifacts: 0,
            createdVersions: 0,
            warningCount: 0,
            errorCount: 0,
            errors: [],
            skippedUserLevelFolders,
            commitSha: null,
            durationMs: 1,
          },
        }),
      );
    expect(done(['.claude', '.codex'])).toMatchObject({
      kind: 'done',
      info: 'Skipped user-level agent folders, which are never scanned: .claude, .codex.',
      errorCount: 0,
    });
    expect(done(['.']).info).toBe(
      'This location is a user-level agent folder; those are never scanned, so nothing was read.',
    );
  });

  it('reports failures, cancellation and missing results', () => {
    const cases: [RepositoryScan, string][] = [
      [
        scan({ status: 'failed', error: 'database is locked' }),
        'The scan failed: database is locked',
      ],
      [scan({ status: 'failed' }), 'The scan failed: unknown error'],
      [
        scan({
          status: 'failed',
          error: 'The registered directory no longer exists.',
          result: {
            ok: false,
            code: 'path-not-found',
            message: 'The registered directory no longer exists.',
          },
        }),
        'The registered directory no longer exists.',
      ],
      [scan({ status: 'cancelled' }), 'The scan was cancelled. Nothing was changed.'],
      // A shutdown timeout can land after the apply committed: no "nothing was changed" here.
      [
        scan({ status: 'interrupted' }),
        "The runner stopped before it recorded the scan's outcome. A scan stores its changes completely or not at all; scan again to make sure the registry is up to date.",
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

describe('scanRequestError', () => {
  it('names why the Scan button could not enqueue a scan, and ignores other values', () => {
    expect(scanRequestError('invalid')).toBe(
      'The scan request was invalid. Reload the page and click Scan again.',
    );
    expect(scanRequestError('not-found')).toBe(
      'That repository no longer exists. It may have been removed; reload the list.',
    );
    expect(scanRequestError('unsupported')).toBe(
      'That repository cannot be scanned yet: only local and GitHub repositories can be scanned.',
    );
    expect(scanRequestError(undefined)).toBeNull();
    expect(scanRequestError('toString')).toBeNull();
    expect(scanRequestError('<script>')).toBeNull();
  });
});
