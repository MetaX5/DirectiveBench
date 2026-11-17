import { describe, expect, it } from 'vitest';
import { CREDENTIALS_IN_URL_MESSAGE } from '@directivebench/core';
import type {
  RepositoryBranchChange,
  RepositoryRecord,
  RepositoryRegistration,
  RepositoryRemovalImpact,
  RepositoryScan,
} from '@directivebench/database';
import {
  branchCaption,
  branchChangeRequestError,
  branchFieldError,
  branchLabel,
  branchPanelHelp,
  branchPanelNote,
  describeBranchChange,
  echoedBranch,
  isHosted,
  parseChangeBranchParam,
  scannedBranchHint,
  canRemove,
  canScan,
  describeRegistration,
  describeScan,
  lastScanLabel,
  looksLikeProtocolRelativeUrl,
  mayCarryCredentials,
  parseRemovalParams,
  pathFieldError,
  providerLabel,
  removalReasons,
  removalResult,
  repositorySubject,
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
  scannedBranch: null,
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
    branch: null,
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

describe('repositorySubject (issue 215, E1)', () => {
  it('names a repository by name, provider and location, unique like the database key', () => {
    const subjects = (
      ['github', 'gitlab', 'local-git', 'local-directory', 'bundled-examples'] as const
    ).map((provider) =>
      repositorySubject({ name: 'skills', provider, location: '/home/dev/skills' }),
    );
    expect(subjects).toEqual([
      'skills (GitHub, /home/dev/skills)',
      'skills (GitLab, /home/dev/skills)',
      'skills (Local Git, /home/dev/skills)',
      'skills (Local directory, /home/dev/skills)',
      'skills (Bundled examples, /home/dev/skills)',
    ]);
    expect(new Set(subjects).size).toBe(subjects.length);
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
      'https:/github.com/a/b%253Ftoken',
      'https://u:t\uFF20github.com/a/b',
      '/a\uFF1Fb',
      '/a\uFF03b',
    ]) {
      expect(mayCarryCredentials(input)).toBe(true);
    }
    for (const input of ['/srv/skills', '~/skills', 'https:/github.com/a/b', 'code/skills', '']) {
      expect(mayCarryCredentials(input)).toBe(false);
    }
  });
});

describe('looksLikeProtocolRelativeUrl', () => {
  it('recognises a leading // or \\\\ only', () => {
    expect(looksLikeProtocolRelativeUrl(' //github.com/a/b')).toBe(true);
    expect(looksLikeProtocolRelativeUrl('\\\\server\\share')).toBe(true);
    expect(looksLikeProtocolRelativeUrl('/srv//skills')).toBe(false);
    expect(looksLikeProtocolRelativeUrl('~/skills')).toBe(false);
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
      branch: '',
      message: 'Waiting for the runner to check ~/skills. It runs inside directivebench serve.',
    });
    expect(describeRegistration(registration({ status: 'running' }))).toEqual({
      kind: 'active',
      path: '~/skills',
      branch: '',
      message: 'Checking ~/skills (read-only)…',
    });
    const url = 'https://github.com/acme/skills';
    expect(
      describeRegistration(registration({ status: 'running', input: url, source: 'url' })),
    ).toEqual({
      kind: 'active',
      path: url,
      branch: '',
      message: `Asking GitHub about ${url} (read-only, without credentials; nothing is downloaded yet)…`,
    });
    // Issue 58: the branch the user named is checked in the same request and kept in the field.
    expect(
      describeRegistration(
        registration({ status: 'running', input: url, source: 'url', branch: 'relase' }),
      ),
    ).toEqual({
      kind: 'active',
      path: url,
      branch: 'relase',
      message: `Asking GitHub about ${url} and its branch relase (read-only, without credentials; nothing is downloaded yet)…`,
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
      branch: '',
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
      // The runner stores a complete sentence (issue #70), shown without a second "failed".
      [
        registration({
          status: 'failed',
          error:
            'The repository registration failed unexpectedly. Try again, and report the problem if it persists.',
        }),
        'The repository registration failed unexpectedly. Try again, and report the problem if it persists.',
      ],
      [registration({ status: 'failed' }), 'The check failed.'],
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
        field: 'path',
        path: '~/skills',
        branch: '',
        message,
      });
    }
  });
});

describe('describeRegistration confirmation (FR-104-18)', () => {
  const confirm = (
    home: 'home' | 'contains-home' | null,
    overlaps: { relation: 'inside' | 'contains'; userLevel?: 'folder' | 'inside-folder' }[],
  ) =>
    describeRegistration(
      registration({
        result: {
          ok: false,
          code: 'confirmation-required',
          location: '/home/me',
          home,
          overlaps: overlaps.map((overlap) => ({
            repositoryId: 'repo_1',
            name: 'skills',
            location: '/home/me/skills',
            ...overlap,
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

  it('does not claim double counting for a user-level agent folder the scan skips (issue 244)', () => {
    const notice = confirm('home', [
      { relation: 'inside', userLevel: 'folder' },
      { relation: 'inside', userLevel: 'inside-folder' },
      { relation: 'contains', userLevel: 'folder' },
      { relation: 'contains', userLevel: 'inside-folder' },
    ]);
    expect(notice.kind === 'confirm' && notice.reasons.slice(1)).toEqual([
      'It is inside the registered repository skills (/home/me/skills), but it is a user-level agent folder: every scan skips it, so nothing is counted twice and a scan of it finds no artifacts.',
      'It is inside the registered repository skills (/home/me/skills), but it is inside a user-level agent folder: every scan skips it, so nothing is counted twice and a scan of it finds no artifacts.',
      'It contains the registered repository skills (/home/me/skills), a user-level agent folder. A scan skips that folder, so nothing is counted twice.',
      'It contains the registered repository skills (/home/me/skills), which is inside a user-level agent folder. A scan skips that folder, so nothing is counted twice.',
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

/** A scan result's SPEC-125 counts when nothing went missing, came back or was kept. */
const unchanged = {
  removedOccurrences: 0,
  reactivatedOccurrences: 0,
  emptyScanKeptOccurrences: 0,
  linkedOccurrences: 0,
  ambiguousLinks: 0,
  movedOccurrences: 0,
  ambiguousMoves: 0,
};

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
      ...unchanged,
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
            ...unchanged,
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

  it('adds what went missing, what came back, and the empty-scan sentence (SPEC-125)', () => {
    const done = (counts: Partial<typeof unchanged>, discovered = 9) =>
      describeScan(
        scan({
          result: {
            ok: true,
            scannedFiles: 12_400,
            discovered,
            createdArtifacts: 0,
            createdVersions: 1,
            ...unchanged,
            ...counts,
            warningCount: 0,
            errorCount: 0,
            errors: [],
            skippedUserLevelFolders: [],
            commitSha: null,
            durationMs: 1200,
          },
        }),
      );
    const counts =
      'Scanned skills: 12,400 files in 1.2 s, 9 artifacts found (0 new, 1 new version), 0 errors.';
    expect(done({ removedOccurrences: 2, reactivatedOccurrences: 1 })).toMatchObject({
      kind: 'done',
      message: `${counts} 2 no longer found (marked missing), 1 found again.`,
    });
    expect(done({ removedOccurrences: 1_240 }).message).toBe(
      `${counts} 1,240 no longer found (marked missing).`,
    );
    expect(done({ reactivatedOccurrences: 1 }).message).toBe(`${counts} 1 found again.`);
    expect(done({}).message).toBe(counts);
    const empty =
      'Scanned skills: 12,400 files in 1.2 s, 0 artifacts found (0 new, 1 new version), 0 errors.';
    expect(done({ emptyScanKeptOccurrences: 9 }, 0)).toMatchObject({
      kind: 'warning',
      message: `${empty} No artifacts found, so the 9 found before were not marked missing. Check that the location is mounted and has the expected files. If they were deleted on purpose, remove the repository.`,
    });
    expect(done({ emptyScanKeptOccurrences: 1 }, 0).message).toBe(
      `${empty} No artifacts found, so the 1 found before was not marked missing. Check that the location is mounted and has the expected files. If they were deleted on purpose, remove the repository.`,
    );
  });

  it('says how many new paths matched an existing artifact, and which chose the oldest (SPEC-126 F1, F2)', () => {
    const done = (counts: Partial<typeof unchanged>) =>
      describeScan(
        scan({
          result: {
            ok: true,
            scannedFiles: 214,
            discovered: 9,
            createdArtifacts: 6,
            createdVersions: 6,
            ...unchanged,
            ...counts,
            warningCount: 0,
            errorCount: 0,
            errors: [],
            skippedUserLevelFolders: [],
            commitSha: null,
            durationMs: 1200,
          },
        }),
      ).message;
    expect(done({ linkedOccurrences: 3 })).toBe(
      'Scanned skills: 214 files in 1.2 s, 9 artifacts found (6 new, 3 matched an existing artifact, 6 new versions), 0 errors.',
    );
    expect(done({ linkedOccurrences: 1_200 })).toContain(
      '1,200 matched an existing artifact, 6 new',
    );
    expect(
      done({
        linkedOccurrences: 1,
        ambiguousLinks: 1,
        removedOccurrences: 2,
        reactivatedOccurrences: 1,
      }),
    ).toBe(
      'Scanned skills: 214 files in 1.2 s, 9 artifacts found (6 new, 1 matched an existing artifact, 6 new versions), 0 errors. 1 matched several existing artifacts and was added to the oldest one. 2 no longer found (marked missing), 1 found again.',
    );
    expect(done({ linkedOccurrences: 2, ambiguousLinks: 2 })).toMatch(
      / 2 matched several existing artifacts and were added to the oldest one\.$/,
    );
  });

  it('says how many occurrences moved and which possible moves were not applied (SPEC-126 H1 to H3)', () => {
    const done = (
      counts: Partial<typeof unchanged> & { createdArtifacts?: number; createdVersions?: number },
    ) =>
      describeScan(
        scan({
          result: {
            ok: true,
            scannedFiles: 214,
            discovered: 9,
            createdArtifacts: 0,
            createdVersions: 0,
            ...unchanged,
            ...counts,
            warningCount: 0,
            errorCount: 0,
            errors: [],
            skippedUserLevelFolders: [],
            commitSha: null,
            durationMs: 1200,
          },
        }),
      );
    expect(done({ movedOccurrences: 1 })).toMatchObject({
      kind: 'done',
      message:
        'Scanned skills: 214 files in 1.2 s, 9 artifacts found (0 new, 1 moved, 0 new versions), 0 errors.',
    });
    expect(done({ movedOccurrences: 1, createdVersions: 1 }).message).toContain(
      '(0 new, 1 moved, 1 new version)',
    );
    expect(done({ movedOccurrences: 1_200 }).message).toContain('(0 new, 1,200 moved, 0 new');
    // Rule order: moved before matched; ambiguous moves before ambiguous links, then SPEC-125.
    expect(
      done({
        createdArtifacts: 2,
        createdVersions: 3,
        movedOccurrences: 2,
        linkedOccurrences: 1,
        ambiguousMoves: 1,
        ambiguousLinks: 1,
        removedOccurrences: 3,
        reactivatedOccurrences: 1,
      }).message,
    ).toBe(
      'Scanned skills: 214 files in 1.2 s, 9 artifacts found (2 new, 2 moved, 1 matched an existing artifact, 3 new versions), 0 errors. 1 possible move was not applied because several files matched. 1 matched several existing artifacts and was added to the oldest one. 3 no longer found (marked missing), 1 found again.',
    );
    const ambiguous = done({ linkedOccurrences: 2, ambiguousMoves: 2, removedOccurrences: 2 });
    expect(ambiguous).toMatchObject({
      kind: 'done',
      message:
        'Scanned skills: 214 files in 1.2 s, 9 artifacts found (0 new, 2 matched an existing artifact, 0 new versions), 0 errors. 2 possible moves were not applied because several files matched. 2 no longer found (marked missing).',
    });
    expect(ambiguous.message).not.toMatch(/[\u2013\u2014]/);
  });

  it('mentions the user-level agent folders a scan skipped, as information (D05)', () => {
    const done = (skippedUserLevelFolders: string[], skippedUserLevelFolderCount?: number) =>
      describeScan(
        scan({
          result: {
            ok: true,
            scannedFiles: 0,
            discovered: 0,
            createdArtifacts: 0,
            createdVersions: 0,
            ...unchanged,
            warningCount: 0,
            errorCount: 0,
            errors: [],
            skippedUserLevelFolders,
            ...(skippedUserLevelFolderCount === undefined ? {} : { skippedUserLevelFolderCount }),
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
    expect(done(['.'], 1).info).toBe(
      'This location is a user-level agent folder; those are never scanned, so nothing was read.',
    );
    expect(done([], 0).info).toBeNull();
  });

  it('says how many skipped user-level folders the capped list leaves out (issue 45)', () => {
    const info = (listed: number, total?: number) =>
      describeScan(
        scan({
          result: {
            ok: true,
            scannedFiles: 0,
            discovered: 0,
            createdArtifacts: 0,
            createdVersions: 0,
            ...unchanged,
            warningCount: 0,
            errorCount: 0,
            errors: [],
            skippedUserLevelFolders: Array.from({ length: listed }, (_, i) => `u${i}/.claude`),
            ...(total === undefined ? {} : { skippedUserLevelFolderCount: total }),
            commitSha: null,
            durationMs: 1,
          },
        }),
      ).info;
    const list = (n: number) => Array.from({ length: n }, (_, i) => `u${i}/.claude`).join(', ');
    const lead = 'Skipped user-level agent folders, which are never scanned: ';
    expect(info(3, 3)).toBe(`${lead}${list(3)}.`);
    expect(info(50, 51)).toBe(`${lead}${list(50)} and 1 more.`);
    expect(info(50, 237)).toBe(`${lead}${list(50)} and 187 more.`);
    expect(info(50, 1250)).toBe(`${lead}${list(50)} and 1,200 more.`);
    // Stored before the total existed: the list is all there is.
    expect(info(50)).toBe(`${lead}${list(50)}.`);
    // A total smaller than the list (a corrupt row) never says "and 0 more" or a negative.
    expect(info(3, 1)).toBe(`${lead}${list(3)}.`);
    expect(info(50, 1250)).not.toMatch(/[\u2013\u2014\u2026]/);
  });

  it('reports failures, cancellation and missing results', () => {
    const cases: [RepositoryScan, string][] = [
      [
        scan({
          status: 'failed',
          error:
            'The repository scan failed unexpectedly. Try again, and report the problem if it persists.',
        }),
        'The repository scan failed unexpectedly. Try again, and report the problem if it persists.',
      ],
      [scan({ status: 'failed' }), 'The scan failed.'],
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

describe('canRemove (SPEC-125 A15)', () => {
  it('offers Remove for every provider except the bundled examples', () => {
    for (const provider of ['github', 'gitlab', 'local-git', 'local-directory'] as const)
      expect(canRemove({ provider })).toBe(true);
    expect(canRemove({ provider: 'bundled-examples' })).toBe(false);
  });
});

describe('parseRemovalParams (SPEC-125 §10)', () => {
  it('reads the panel id, the counts as a pair and the error code', () => {
    expect(
      parseRemovalParams({
        remove: 'repo_ab-C_9',
        removedOccurrences: '14',
        missingArtifacts: '0',
        removeError: 'failed',
      }),
    ).toEqual({
      remove: 'repo_ab-C_9',
      removed: { occurrences: 14, missingArtifacts: 0 },
      error: 'failed',
    });
    expect(parseRemovalParams({})).toEqual({ remove: null, removed: null, error: null });
  });

  it('ignores invalid, repeated and incomplete values', () => {
    for (const remove of ['cat_1', 'repo_', 'repo_a/b', `repo_${'a'.repeat(65)}`, ''])
      expect(parseRemovalParams({ remove }).remove).toBeNull();
    expect(parseRemovalParams({ remove: ['repo_a', 'repo_b'] }).remove).toBeNull();
    for (const count of ['', ' 1', '-1', '1.5', '1e3', '0x10', '1234567890123456'])
      expect(
        parseRemovalParams({ removedOccurrences: count, missingArtifacts: '1' }).removed,
      ).toBeNull();
    expect(parseRemovalParams({ removedOccurrences: '3' }).removed).toBeNull();
    expect(parseRemovalParams({ missingArtifacts: '3' }).removed).toBeNull();
    expect(
      parseRemovalParams({ removedOccurrences: ['1', '2'], missingArtifacts: '1' }).removed,
    ).toBeNull();
    expect(parseRemovalParams({ removeError: 'boom' }).error).toBeNull();
    expect(parseRemovalParams({ removeError: ['failed'] }).error).toBeNull();
  });
});

describe('removalReasons (SPEC-125 FR-125-15, §11.3 D15)', () => {
  const impact = (overrides: Partial<RepositoryRemovalImpact> = {}): RepositoryRemovalImpact => ({
    id: 'repo_a',
    name: 'client-a',
    provider: 'local-git',
    location: '/home/dev/client-a',
    occurrences: 14,
    activeOccurrences: 12,
    artifactsLeftMissing: 9,
    ...overrides,
  });
  const reregister =
    'Registering it again later creates new artifacts. A skill or rule whose exact content is still recorded in another local repository is matched to its existing artifact instead.';
  const reregisterHosted =
    'Registering it again later creates new artifacts instead of reusing these ones.';

  it('says what is deleted, what goes missing, what is kept and what registering again does', () => {
    expect(removalReasons(impact())).toEqual([
      'Its 14 occurrences are deleted from DirectiveBench.',
      '9 artifacts are then missing from every repository. Their versions, categories, notes and benchmark results are kept.',
      'Nothing in /home/dev/client-a is changed.',
      reregister,
    ]);
    expect(
      removalReasons(impact({ occurrences: 1234, artifactsLeftMissing: 1200 })).slice(0, 2),
    ).toEqual([
      'Its 1,234 occurrences are deleted from DirectiveBench.',
      '1,200 artifacts are then missing from every repository. Their versions, categories, notes and benchmark results are kept.',
    ]);
  });

  it('uses singular forms and the zero-missing sentence', () => {
    expect(removalReasons(impact({ occurrences: 1, artifactsLeftMissing: 1 })).slice(0, 2)).toEqual(
      [
        'Its 1 occurrence is deleted from DirectiveBench.',
        '1 artifact is then missing from every repository. Its versions, categories, notes and benchmark results are kept.',
      ],
    );
    expect(removalReasons(impact({ artifactsLeftMissing: 0 }))[1]).toBe(
      'Every artifact found here is also found in another repository, or is already missing.',
    );
  });

  it('says the hosted download is deleted from the cache, and shows only two reasons without occurrences', () => {
    // Issue 59 J9: the runner deletes the cache of a removed repository (SPEC-105 FR-105-19).
    const hosted =
      "The copy downloaded from GitHub is deleted from DirectiveBench's cache. Nothing on GitHub is changed.";
    expect(
      removalReasons(impact({ provider: 'github', location: 'https://github.com/o/r' }))[2],
    ).toBe(hosted);
    // Hosted copies never link (SPEC-126 A16): the SPEC-125 sentence stays (§11.3 F8).
    expect(
      removalReasons(impact({ provider: 'github', location: 'https://github.com/o/r' }))[3],
    ).toBe(reregisterHosted);
    expect(removalReasons(impact({ provider: 'local-directory' }))[3]).toBe(reregister);
    expect(removalReasons(impact({ provider: 'gitlab' }))[2]).toBe(
      "The copy downloaded from GitLab is deleted from DirectiveBench's cache. Nothing on GitLab is changed.",
    );
    expect(
      removalReasons(
        impact({ provider: 'local-directory', occurrences: 0, artifactsLeftMissing: 0 }),
      ),
    ).toEqual(['It has no occurrences.', 'Nothing in /home/dev/client-a is changed.']);
    expect(removalReasons(impact({ provider: 'github', occurrences: 0 }))).toEqual([
      'It has no occurrences.',
      hosted,
    ]);
  });
});

describe('removalResult (SPEC-125 §11.3 D18)', () => {
  const none = { remove: null, removed: null, error: null };
  const known = { unknownTarget: false };

  it('reports a completed removal in every count form', () => {
    const done = (occurrences: number, missingArtifacts: number) =>
      removalResult({ ...none, removed: { occurrences, missingArtifacts } }, known);
    expect(done(14, 9)).toEqual({
      kind: 'done',
      message:
        'Repository removed: 14 occurrences deleted, 9 artifacts now missing from every repository. Their history is kept.',
    });
    expect(done(1, 1)?.message).toBe(
      'Repository removed: 1 occurrence deleted, 1 artifact now missing from every repository. Its history is kept.',
    );
    expect(done(3, 0)?.message).toBe(
      'Repository removed: 3 occurrences deleted. No artifact became missing.',
    );
    expect(done(0, 0)?.message).toBe('Repository removed. It had no occurrences.');
    expect(done(12345, 0)?.message).toBe(
      'Repository removed: 12,345 occurrences deleted. No artifact became missing.',
    );
  });

  it('shows an error before a result, and nothing without parameters', () => {
    const removed = { occurrences: 1, missingArtifacts: 1 };
    expect(removalResult({ ...none, removed, error: 'not-found' }, known)).toEqual({
      kind: 'error',
      message: 'That repository is no longer registered. Nothing was removed.',
    });
    expect(removalResult({ ...none, error: 'invalid' }, known)?.message).toBe(
      'The form was incomplete. Reload the page and try again.',
    );
    expect(removalResult({ ...none, error: 'failed' }, known)?.message).toBe(
      'The repository could not be removed. Nothing was changed.',
    );
    expect(removalResult(none, known)).toBeNull();
  });

  it('says an unknown panel target is no longer registered, and nothing for a listed one', () => {
    const remove = { ...none, remove: 'repo_gone' };
    expect(removalResult(remove, { unknownTarget: true })).toEqual({
      kind: 'info',
      message: 'That repository is no longer registered.',
    });
    expect(removalResult(remove, known)).toBeNull();
    expect(removalResult(none, { unknownTarget: true })).toBeNull();
  });
});

// Issue 58: the branch of a hosted repository.
const hosted: RepositoryRecord = {
  ...repository,
  id: 'repo_gh',
  provider: 'github',
  name: 'acme/team-rules',
  location: 'https://github.com/acme/team-rules',
};

describe('branchCaption and isHosted (issue 58 B4)', () => {
  it('says whether the branch is the default, chosen or the checked-out one', () => {
    expect(branchCaption(hosted)).toBe('Default branch');
    expect(branchCaption({ ...hosted, selectedBranch: 'release/2.0' })).toBe(
      'Chosen. Default: main',
    );
    expect(branchCaption({ ...hosted, selectedBranch: 'x', defaultBranch: null })).toBe(
      'Chosen. Default: not detected',
    );
    expect(branchCaption({ ...hosted, defaultBranch: null })).toBeNull();
    expect(branchCaption(repository)).toBe('Checked out (scans the working tree)');
    expect(branchCaption({ ...repository, provider: 'local-directory' })).toBeNull();
    expect(isHosted(hosted)).toBe(true);
    expect(isHosted(repository)).toBe(false);
  });
});

describe('scannedBranchHint (issue 58 B7)', () => {
  it('names the branch the last scan read when the repository now uses another', () => {
    const changed = { ...hosted, selectedBranch: 'release/2.0', scannedBranch: 'main' };
    expect(scannedBranchHint({ ...changed, syncStatus: 'ok' })).toBe(
      'That scan read main: scan again to read release/2.0.',
    );
    // Nothing to say: same branch, unknown scanned branch, a failed scan, a local repository,
    // or no branch at all.
    expect(scannedBranchHint({ ...hosted, scannedBranch: 'main', syncStatus: 'ok' })).toBeNull();
    expect(scannedBranchHint({ ...changed, scannedBranch: null, syncStatus: 'ok' })).toBeNull();
    expect(scannedBranchHint({ ...changed, syncStatus: 'error' })).toBeNull();
    expect(scannedBranchHint({ ...repository, scannedBranch: 'x', syncStatus: 'ok' })).toBeNull();
    expect(
      scannedBranchHint({ ...hosted, defaultBranch: null, scannedBranch: 'x', syncStatus: 'ok' }),
    ).toBeNull();
  });
});

describe('branch field errors and echo (issue 58 B3)', () => {
  it('maps the action codes to fixed messages', () => {
    expect(branchFieldError('invalid')).toMatch(/^A branch name may use letters, digits/);
    expect(branchFieldError('local')).toBe(
      'A local repository is scanned from its working tree; leave Branch empty.',
    );
    expect(branchFieldError(undefined)).toBeNull();
    expect(branchFieldError('other')).toBeNull();
  });

  it('never echoes a value that may carry credentials, and cuts a long one', () => {
    expect(echoedBranch('release 2.0')).toBe('release 2.0');
    expect(echoedBranch(undefined)).toBe('');
    for (const value of ['x@token', 'a?b', 'a#b', 'a%40b', 'a%2540b', 'a\uFF20b']) {
      expect(echoedBranch(value)).toBe('');
    }
    expect(echoedBranch('x'.repeat(300))).toHaveLength(256);
  });

  it('notes a branch a re-registration did not change', () => {
    const done = (branch: string | null, stored: Partial<RepositoryRecord>) =>
      describeRegistration(
        registration({
          source: 'url',
          input: hosted.location,
          branch,
          result: { ok: true, repositoryId: hosted.id, created: false },
          repository: { ...hosted, ...stored },
        }),
      ).message;
    const note = ' Its branch was not changed: use Change in the Branch column.';
    expect(done('dev', {})).toBe(
      `acme/team-rules (GitHub, ${hosted.location}) is already registered.${note}`,
    );
    // Equal choices, also the default's own name against a stored null.
    expect(done('main', {})).not.toContain(note);
    expect(done('dev', { selectedBranch: 'dev' })).not.toContain(note);
    expect(done(null, { selectedBranch: 'dev' })).not.toContain(note);
  });

  it('shows a branch the remote does not have under the Branch field', () => {
    const message =
      'The branch relase does not exist in acme/agent-skills. Check the name on GitHub, or leave Branch empty to use the default branch.';
    expect(
      describeRegistration(
        registration({
          source: 'url',
          input: 'https://github.com/acme/agent-skills',
          branch: 'relase',
          result: { ok: false, code: 'branch-not-found', message },
        }),
      ),
    ).toEqual({
      kind: 'fieldError',
      field: 'branch',
      path: 'https://github.com/acme/agent-skills',
      branch: 'relase',
      message,
    });
  });
});

describe('the Change branch panel (issue 58)', () => {
  function change(overrides: Partial<RepositoryBranchChange>): RepositoryBranchChange {
    return {
      jobId: 'job_b',
      status: 'completed',
      repositoryId: hosted.id,
      branch: 'release/2.0',
      error: null,
      result: null,
      repository: hosted,
      ...overrides,
    };
  }

  it('describes every state of a branch change', () => {
    expect(describeBranchChange(change({ status: 'pending' }))).toEqual({
      kind: 'active',
      value: 'release/2.0',
      message:
        'Waiting for the runner to check the branch of acme/team-rules. It runs inside directivebench serve.',
    });
    expect(describeBranchChange(change({ status: 'running' }))).toEqual({
      kind: 'active',
      value: 'release/2.0',
      message: 'Asking GitHub whether release/2.0 exists (read-only, nothing is downloaded)…',
    });
    expect(describeBranchChange(change({ status: 'running', branch: null }))).toEqual({
      kind: 'active',
      value: '',
      message: 'Asking GitHub for the default branch (read-only, nothing is downloaded)…',
    });
    expect(describeBranchChange(change({ status: 'pending', repository: null })).message).toContain(
      'the branch of the repository.',
    );
    const cases: [RepositoryBranchChange, string][] = [
      [change({ status: 'failed', error: 'Boom.' }), 'Boom.'],
      [change({ status: 'failed' }), 'The branch change failed.'],
      [change({ status: 'cancelled' }), 'The branch change was cancelled. Nothing was changed.'],
      [
        change({ status: 'interrupted' }),
        // A crash after the branch transaction committed: never "nothing was changed".
        'The runner stopped before it recorded the outcome of the branch change. The new branch may have been saved: check the Branch column before you scan.',
      ],
      [change({}), 'The runner finished without a result.'],
      [
        change({ result: { ok: false, code: 'scan-active', message: 'A scan is running.' } }),
        'A scan is running.',
      ],
    ];
    for (const [input, message] of cases) {
      expect(describeBranchChange(input)).toEqual({ kind: 'error', message });
    }
    expect(
      describeBranchChange(
        change({ result: { ok: false, code: 'branch-not-found', message: 'No such branch.' } }),
      ),
    ).toEqual({ kind: 'fieldError', message: 'No such branch.', value: 'release/2.0' });
    expect(
      describeBranchChange(
        change({ result: { ok: true, branch: 'release/2.0', defaultBranch: 'main' } }),
      ),
    ).toEqual({
      kind: 'done',
      message: 'acme/team-rules now uses the branch release/2.0. Scan it to read that branch.',
    });
    expect(
      describeBranchChange(
        change({ branch: null, result: { ok: true, branch: null, defaultBranch: 'main' } }),
      ).message,
    ).toBe('acme/team-rules now follows its default branch (main). Scan it to read that branch.');
    expect(
      describeBranchChange(
        change({ branch: null, result: { ok: true, branch: null, defaultBranch: null } }),
      ).message,
    ).toBe('acme/team-rules now follows its default branch. Scan it to read that branch.');
  });

  it('explains what saving does and what the empty field means', () => {
    expect(branchPanelNote({ ...hosted, selectedBranch: 'release/2.0' })).toBe(
      'Saving does not scan. The next scan reads the new branch: artifacts found only on release/2.0 are then marked missing (their history is kept) and return when a later scan finds them again.',
    );
    expect(branchPanelNote({ ...hosted, defaultBranch: null })).toContain(
      'found only on the current branch',
    );
    expect(branchPanelHelp(hosted)).toBe('Leave empty to follow the default branch (main).');
    expect(branchPanelHelp({ ...hosted, defaultBranch: null })).toBe(
      'Leave empty to follow the default branch.',
    );
  });

  it('parses the panel parameter and names why a change could not be requested', () => {
    expect(parseChangeBranchParam('repo_gh')).toBe('repo_gh');
    expect(parseChangeBranchParam(['repo_gh', 'repo_x'])).toBeNull();
    expect(parseChangeBranchParam('../x')).toBeNull();
    expect(parseChangeBranchParam(undefined)).toBeNull();
    for (const code of [
      'invalid',
      'not-found',
      'unsupported',
      'scan-active',
      'branch-change-active',
    ]) {
      expect(branchChangeRequestError(code)).toMatch(/\.$/);
    }
    expect(branchChangeRequestError('scan-active')).toBe(
      'A scan of this repository is waiting or running. Change its branch after the scan finishes.',
    );
    expect(branchChangeRequestError(undefined)).toBeNull();
    expect(branchChangeRequestError('other')).toBeNull();
  });
});
