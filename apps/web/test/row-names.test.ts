import { describe, expect, it } from 'vitest';
import {
  artifactSubject,
  cancelJobName,
  latestRunStatusName,
  resultRunName,
  runOnArtifactName,
  suiteLinkName,
  viewRunOfJobName,
} from '../lib/row-names';
import { DISPLAY_STATUS_LABELS } from '../lib/run-status';

// Issues 227 and 228: unique accessible names for per-row controls, in the #219/#220 format.

const skill = { name: 'SKILL.md', slug: 'acme-validate-input-skill-md' };
const twin = { name: 'SKILL.md', slug: 'acme-review-skill-md' };

describe('artifact names', () => {
  it('adds the unique slug to a name that can repeat', () => {
    expect(artifactSubject(skill)).toBe('SKILL.md, slug acme-validate-input-skill-md');
    expect(artifactSubject(skill)).not.toBe(artifactSubject(twin));
  });

  it('names the suite page Run button for its artifact (K7)', () => {
    expect(runOnArtifactName(skill)).toBe('Run on SKILL.md, slug acme-validate-input-skill-md');
  });

  it('names the Artifacts list Status link by status, then the artifact', () => {
    expect(latestRunStatusName('passed', skill)).toBe(
      'Passed, latest run of SKILL.md, slug acme-validate-input-skill-md',
    );
    expect(latestRunStatusName('not-comparable', twin)).toBe(
      'Not comparable, latest run of SKILL.md, slug acme-review-skill-md',
    );
  });

  it('names the Results list Artifact link by the artifact, then the run', () => {
    expect(resultRunName('SKILL.md', 'run_a1')).toBe('SKILL.md, run run_a1');
  });
});

describe('job names (K8)', () => {
  it('names Cancel and View run by the job ID shown in the row', () => {
    expect(cancelJobName('job_Qm3x')).toBe('Cancel job job_Qm3x');
    expect(viewRunOfJobName('job_Qm3x')).toBe('View run of job job_Qm3x');
  });
});

describe('suiteLinkName', () => {
  it('adds the suite ID only when another suite has the name', () => {
    const suite = { name: 'Input validation (mock)', slug: 'mock-input-validation' };
    expect(suiteLinkName({ ...suite, nameShared: false })).toBeUndefined();
    expect(suiteLinkName({ ...suite, nameShared: true })).toBe(
      'Input validation (mock), ID mock-input-validation',
    );
  });
});

describe('DISPLAY_STATUS_LABELS', () => {
  it('has the text of every display status, free of long dashes', () => {
    expect(Object.keys(DISPLAY_STATUS_LABELS).sort()).toEqual([
      'error',
      'failed',
      'not-comparable',
      'not-tested',
      'passed',
      'regression',
      'unstable',
    ]);
    for (const label of Object.values(DISPLAY_STATUS_LABELS)) expect(label).not.toMatch(/[–—]/);
  });
});
