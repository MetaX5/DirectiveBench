import { describe, expect, it } from 'vitest';
import {
  agentRunFilesHref,
  agentRunFilesNotice,
  agentRunLabel,
  agentRunStatusBadge,
  outputFilesRow,
  parsePathParam,
  predatesCapture,
  selectFile,
  wholeRunPredatesCapture,
  type AgentRunOutputState,
} from '../lib/agent-run-files';

const run = (overrides: Partial<AgentRunOutputState> = {}): AgentRunOutputState => ({
  executionStatus: 'completed',
  passed: true,
  outputFilesKept: true,
  outputFilesReason: null,
  changedFiles: [{ path: 'a.js', change: 'added' }],
  ...overrides,
});

describe('agentRunStatusBadge (D23)', () => {
  it('says passed or failed for a completed run and the status otherwise', () => {
    expect(agentRunStatusBadge(run())).toEqual({ label: 'passed', variant: 'success' });
    expect(agentRunStatusBadge(run({ passed: false }))).toEqual({
      label: 'failed',
      variant: 'destructive',
    });
    expect(agentRunStatusBadge(run({ executionStatus: 'timeout', passed: null }))).toEqual({
      label: 'timeout',
      variant: 'muted',
    });
    expect(agentRunStatusBadge(run({ executionStatus: 'agent-error', passed: false }))).toEqual({
      label: 'agent-error',
      variant: 'destructive',
    });
  });
});

describe('agentRunLabel', () => {
  it('names the variant and the repetition', () => {
    expect(agentRunLabel('Candidate (v3)', 2)).toBe('Candidate (v3), repetition 2');
  });
});

describe('predatesCapture and wholeRunPredatesCapture (D26)', () => {
  it('treats only not kept without a reason as a pre-capture row', () => {
    expect(predatesCapture(run({ outputFilesKept: false }))).toBe(true);
    expect(predatesCapture(run({ outputFilesKept: false, outputFilesReason: 'x' }))).toBe(false);
    expect(predatesCapture(run())).toBe(false);
  });

  it('needs every agent run to predate capture, and at least one agent run', () => {
    const old = run({ outputFilesKept: false });
    expect(wholeRunPredatesCapture([old, old])).toBe(true);
    expect(wholeRunPredatesCapture([old, run()])).toBe(false);
    expect(wholeRunPredatesCapture([])).toBe(false);
  });
});

describe('outputFilesRow (D23, D25)', () => {
  it('shows the counts and kept size of a kept agent run', () => {
    expect(
      outputFilesRow(run(), { files: 4, truncated: 1, notKept: 2, storedBytes: 2048 }),
    ).toEqual({ changedFiles: 4, kept: '2.0 KB', notComplete: '1 truncated, 2 not kept' });
    expect(outputFilesRow(run(), { files: 2, truncated: 0, notKept: 1, storedBytes: 10 })).toEqual({
      changedFiles: 2,
      kept: '10 bytes',
      notComplete: '1 not kept',
    });
    expect(outputFilesRow(run(), { files: 2, truncated: 2, notKept: 0, storedBytes: 10 })).toEqual({
      changedFiles: 2,
      kept: '10 bytes',
      notComplete: '2 truncated',
    });
    expect(outputFilesRow(run(), { files: 1, truncated: 0, notKept: 0, storedBytes: 1 })).toEqual({
      changedFiles: 1,
      kept: '1 byte',
      notComplete: 'None',
    });
  });

  it('reads an agent run that changed no file as zero files', () => {
    expect(outputFilesRow(run({ changedFiles: [] }), undefined)).toEqual({
      changedFiles: 0,
      kept: '0 bytes',
      notComplete: 'None',
    });
  });

  it('says why the files of an agent run were not kept, with its change count', () => {
    expect(
      outputFilesRow(
        run({
          outputFilesKept: false,
          outputFilesReason: 'the agent did not stop after its timeout',
        }),
        undefined,
      ),
    ).toEqual({
      changedFiles: 1,
      kept: 'Not kept',
      notComplete: 'Not kept: the agent did not stop after its timeout.',
    });
    expect(
      outputFilesRow(
        run({ outputFilesKept: false, outputFilesReason: ' a file changed. ' }),
        undefined,
      ).notComplete,
    ).toBe('Not kept: a file changed.');
    expect(outputFilesRow(run({ outputFilesKept: false }), undefined).notComplete).toBe(
      'Not kept: this agent run predates output file capture.',
    );
  });
});

describe('agentRunFilesNotice (D34)', () => {
  it('has no sentence when there are files to list', () => {
    expect(agentRunFilesNotice(run(), 3)).toBeNull();
  });

  it('says the agent changed nothing, or why nothing was kept', () => {
    expect(agentRunFilesNotice(run(), 0)).toBe('The agent did not change any file.');
    expect(agentRunFilesNotice(run({ outputFilesKept: false }), 0)).toBe(
      'Output files were not kept for this agent run.',
    );
    expect(
      agentRunFilesNotice(
        run({ outputFilesKept: false, outputFilesReason: 'the workspace was replaced.' }),
        0,
      ),
    ).toBe('Output files were not kept: the workspace was replaced.');
  });
});

describe('parsePathParam (D33)', () => {
  it('accepts one non-empty value and treats empty or repeated values as absent', () => {
    expect(parsePathParam('src/a.js')).toBe('src/a.js');
    expect(parsePathParam(undefined)).toBeNull();
    expect(parsePathParam('')).toBeNull();
    expect(parsePathParam(['a', 'b'])).toBeNull();
  });
});

describe('selectFile (D32, D33)', () => {
  it('shows the first file without a request, and nothing when there is none', () => {
    expect(selectFile(['a', 'b'], null)).toEqual({ kind: 'file', path: 'a' });
    expect(selectFile([], null)).toEqual({ kind: 'none' });
  });

  it('shows a listed path and refuses any other', () => {
    expect(selectFile(['a', 'b'], 'b')).toEqual({ kind: 'file', path: 'b' });
    expect(selectFile(['a', 'b'], 'c')).toEqual({ kind: 'not-found' });
    expect(selectFile([], 'a')).toEqual({ kind: 'not-found' });
  });
});

describe('agentRunFilesHref', () => {
  it('builds the page URL with an encoded path query', () => {
    expect(agentRunFilesHref('run_1', 'arun_2')).toBe('/results/run_1/agent-runs/arun_2');
    expect(agentRunFilesHref('run_1', 'arun_2', 'src/a b&c.js')).toBe(
      '/results/run_1/agent-runs/arun_2?path=src%2Fa+b%26c.js',
    );
    expect(agentRunFilesHref('r/1', 'a?2')).toBe('/results/r%2F1/agent-runs/a%3F2');
  });
});
