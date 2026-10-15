import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  benchmarkDefinitionSchema,
  definitionRunsCommands,
  executionBlockers,
  isDeterministicAssertion,
  type BenchmarkDefinitionInput,
} from '../src/definition';
import {
  DefinitionValidationError,
  UnsupportedSchemaVersionError,
  formatFromPath,
  loadDefinitionFile,
  migrateDefinitionDocument,
  parseDefinitionText,
  validateDefinition,
} from '../src/load';
import { useTempDirs } from './helpers';

const tmp = useTempDirs();

function document(overrides: Partial<BenchmarkDefinitionInput> = {}): BenchmarkDefinitionInput {
  return {
    schemaVersion: 1,
    id: 'suite',
    name: 'Suite',
    execution: { agent: 'mock' },
    cases: [
      {
        id: 'c',
        name: 'C',
        prompt: 'p',
        fixture: { path: 'fixture' },
        assertions: [{ id: 'a', type: 'file-exists', path: 'a.txt' }],
      },
    ],
    ...overrides,
  };
}

const issuePaths = (input: unknown) => {
  const result = validateDefinition(input);
  return result.success ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
};

describe('path safety in definitions', () => {
  it.each([
    ['../outside', 'parent escape'],
    ['..', 'parent directory'],
    ['a/../../b', 'normalised escape'],
    ['/etc', 'absolute path'],
    ['a\\b', 'backslash'],
    ['a\0b', 'null byte'],
    ['', 'empty path'],
  ])('rejects fixture path %j (%s)', (path) => {
    const base = document();
    const [firstCase] = base.cases;
    const issues = issuePaths({ ...base, cases: [{ ...firstCase, fixture: { path } }] });
    expect(issues.some((i) => i.startsWith('cases.0.fixture.path:'))).toBe(true);
  });

  it('accepts nested paths that stay inside the base directory', () => {
    const base = document();
    const [firstCase] = base.cases;
    expect(
      issuePaths({ ...base, cases: [{ ...firstCase, fixture: { path: './a/../b/c' } }] }),
    ).toEqual([]);
  });
});

describe('definition rules', () => {
  it('requires at least one weighted assertion per case', () => {
    const base = document();
    const [firstCase] = base.cases;
    expect(
      issuePaths({
        ...base,
        cases: [
          {
            ...firstCase,
            assertions: [{ id: 'a', type: 'file-exists', path: 'a.txt', weight: 0 }],
          },
        ],
      }),
    ).toEqual(['cases.0.assertions: at least one assertion needs a weight > 0']);
  });

  it('rejects duplicate case ids and a docker environment without an image', () => {
    const base = document();
    const [firstCase] = base.cases;
    expect(
      issuePaths({
        ...base,
        execution: { agent: 'mock', environment: { kind: 'docker' } },
        cases: [firstCase, firstCase],
      }),
    ).toEqual([
      'cases.1.id: duplicate case id "c"',
      'execution.environment.image: docker environment requires `image`',
    ]);
  });

  it('only allows the regex flags i, m, s and u', () => {
    const base = document();
    const [firstCase] = base.cases;
    const issues = issuePaths({
      ...base,
      cases: [
        {
          ...firstCase,
          assertions: [{ id: 'a', type: 'file-contains', path: 'a', pattern: 'x', flags: 'g' }],
        },
      ],
    });
    expect(issues).toEqual([
      'cases.0.assertions.0.flags: only the regex flags i, m, s and u are allowed',
    ]);
  });

  it('detects suites that execute commands', () => {
    const plain = benchmarkDefinitionSchema.parse(document());
    expect(definitionRunsCommands(plain)).toBe(false);
    // A suite without commands needs no execution approval.
    expect(executionBlockers(plain, false)).toEqual([]);

    const [firstCase] = plain.cases;
    if (!firstCase) throw new Error('expected a case');
    const withSetup = { ...plain, cases: [{ ...firstCase, setup: [['npm', 'ci']] }] };
    expect(definitionRunsCommands(withSetup)).toBe(true);
    expect(executionBlockers(withSetup, false)).toHaveLength(1);
  });

  it('treats every format v1 assertion type as deterministic', () => {
    const assertions: BenchmarkDefinitionInput['cases'][number]['assertions'] = [
      { id: 'a', type: 'command', command: ['true'] },
      { id: 'a', type: 'file-exists', path: 'a' },
      { id: 'a', type: 'file-contains', path: 'a', pattern: 'x' },
      { id: 'a', type: 'changed-files', allowed: ['**'] },
    ];
    for (const assertion of assertions) {
      const parsed = benchmarkDefinitionSchema.parse(
        document({
          cases: [
            { id: 'c', name: 'C', prompt: 'p', fixture: { path: 'f' }, assertions: [assertion] },
          ],
        }),
      );
      const [parsedAssertion] = parsed.cases[0]?.assertions ?? [];
      if (!parsedAssertion) throw new Error('expected an assertion');
      expect(isDeterministicAssertion(parsedAssertion)).toBe(true);
    }
  });
});

describe('loading definitions', () => {
  it('reports root-level issues for documents that are not objects', () => {
    for (const input of [null, 'text', [1, 2]]) {
      expect(migrateDefinitionDocument(input)).toBe(input);
      const result = validateDefinition(input);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.issues[0]?.path).toBe('(root)');
    }
  });

  it('passes current documents through migration and rejects newer versions', () => {
    const current = document();
    expect(migrateDefinitionDocument(current)).toBe(current);
    expect(() => migrateDefinitionDocument({ schemaVersion: 2 })).toThrow(
      UnsupportedSchemaVersionError,
    );
  });

  it('reports invalid JSON as a document issue', () => {
    const result = parseDefinitionText('{', 'json');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues).toEqual([
      { path: '(document)', message: expect.stringMatching(/^Invalid JSON: /) as string },
    ]);
  });

  it('derives the format from the file extension', () => {
    expect(formatFromPath('a/benchmark.JSON')).toBe('json');
    expect(formatFromPath('benchmark.yaml')).toBe('yaml');
    expect(formatFromPath('benchmark.yml')).toBe('yaml');
    expect(() => formatFromPath('benchmark.toml')).toThrow(
      'Unsupported benchmark definition extension ".toml" (use .yaml, .yml or .json)',
    );
  });

  it('loads .yml and .json files and throws every issue for invalid files', async () => {
    const dir = tmp('definitions');
    const yml = join(dir, 'benchmark.yml');
    writeFileSync(
      yml,
      'schemaVersion: 1\nid: suite\nname: Suite\nexecution: { agent: mock }\ncases:\n  - { id: c, name: C, prompt: p, fixture: { path: f }, assertions: [{ id: a, type: file-exists, path: a }] }\n',
    );
    expect((await loadDefinitionFile(yml)).id).toBe('suite');

    const json = join(dir, 'broken.json');
    writeFileSync(json, JSON.stringify({ schemaVersion: 1, id: 'Bad Id', name: '' }));
    const error = await loadDefinitionFile(json).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DefinitionValidationError);
    if (!(error instanceof DefinitionValidationError)) return;
    expect(error.name).toBe('DefinitionValidationError');
    expect(error.source).toBe(json);
    expect(error.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['id', 'name', 'execution', 'cases']),
    );
    expect(error.message).toContain(`Invalid benchmark definition ${json}:\n  - id: `);
  });
});
