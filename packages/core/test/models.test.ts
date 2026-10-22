import { describe, expect, it } from 'vitest';
import { baselineArtifactIssue, type BaselineIdentity } from '../src/models';

const candidate: BaselineIdentity = {
  artifactId: 'art_a',
  versionId: 'artv_2',
  format: 'skill-md',
  contentHash: 'hash-2',
};

describe('baselineArtifactIssue (SPEC-118 FR-118-12)', () => {
  it('accepts another version of the same artifact with other content and the same format', () => {
    expect(
      baselineArtifactIssue(candidate, { ...candidate, versionId: 'artv_1', contentHash: 'hash-1' }),
    ).toBeNull();
  });

  it('rejects a version of another artifact', () => {
    expect(
      baselineArtifactIssue(candidate, {
        ...candidate,
        artifactId: 'art_b',
        versionId: 'artv_1',
        contentHash: 'hash-1',
      }),
    ).toBe('The baseline must be another version of the same artifact as the candidate.');
  });

  it('rejects the candidate version itself', () => {
    expect(baselineArtifactIssue(candidate, candidate)).toBe(
      'The baseline is the candidate version itself; choose another version.',
    );
  });

  it('rejects another version with the same content hash', () => {
    expect(baselineArtifactIssue(candidate, { ...candidate, versionId: 'artv_1' })).toBe(
      'The baseline version has the same content as the candidate; choose a version with other content.',
    );
  });

  it('rejects another format', () => {
    expect(
      baselineArtifactIssue(candidate, {
        ...candidate,
        versionId: 'artv_1',
        contentHash: 'hash-1',
        format: 'claude-md',
      }),
    ).toBe(
      'The baseline version has format claude-md, the candidate skill-md; both must have the same format.',
    );
  });
});
