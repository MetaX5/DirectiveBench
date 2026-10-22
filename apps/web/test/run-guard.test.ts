import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDefinitionFile } from '@directivebench/benchmark-engine/load';
import { cliRunCommand, webRunBlockers } from '../lib/run-guard';

const exampleDefinition = fileURLToPath(
  new URL('../../../examples/benchmarks/mock-input-validation/benchmark.yaml', import.meta.url),
);

describe('webRunBlockers (SPEC-118 FR-118-05)', () => {
  it('passes the execution blockers of a mock-agent suite through unchanged', async () => {
    const definition = await loadDefinitionFile(exampleDefinition);
    expect(webRunBlockers(definition, true)).toEqual([]);
    expect(webRunBlockers(definition, false)).toEqual([
      'This suite version runs commands but has not been approved for execution.',
    ]);
  });

  it('refuses every other agent first, before the execution blockers', async () => {
    const definition = await loadDefinitionFile(exampleDefinition);
    const claude = { ...definition, execution: { ...definition.execution, agent: 'claude-code' } };
    const refusal =
      'This suite uses agent "claude-code". The web UI runs only mock-agent suites; real agents run from the CLI (planned — not implemented yet).';
    expect(webRunBlockers(claude, true)).toEqual([refusal]);
    expect(webRunBlockers(claude, false)).toEqual([
      refusal,
      'This suite version runs commands but has not been approved for execution.',
    ]);
  });
});

describe('cliRunCommand', () => {
  it('names the planned benchmark run command for an artifact', () => {
    expect(cliRunCommand('estimate-project')).toBe(
      'directivebench benchmark run <suite-folder> --artifact estimate-project',
    );
  });
});
