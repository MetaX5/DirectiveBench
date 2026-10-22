import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ASSERTION_REGEX_TIMEOUT_MS,
  assertionPlugins,
  evaluateAssertion,
  type AssertionContext,
  type AssertionResult,
} from '../src/assertions';
import { MAX_LISTED_MATCHES, MAX_READ_BYTES } from '../src/assertion-support';
import {
  ASSERTION_TYPE_TRAITS,
  assertionSchema,
  definitionRunsCommands,
  isDeterministicAssertion,
  type AssertionDefinition,
} from '../src/definition';
import type { FileChange } from '../src/files';
import { loadDefinitionFile } from '../src/load';
import { PATTERN_TIMEOUT_MESSAGE } from '../src/pattern-worker';
import { ADVERSARIAL, useTempDirs } from './helpers';

const tmp = useTempDirs();
const exampleDir = fileURLToPath(
  new URL('../../../examples/benchmarks/document-assertions', import.meta.url),
);

/** A workspace holding `files`; every file counts as added by the agent unless overridden. */
function workspace(
  files: Record<string, string>,
  changedFiles: FileChange[] = Object.keys(files).map((path) => ({ path, change: 'added' })),
): AssertionContext {
  const workspaceDir = tmp('workspace');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(workspaceDir, path)), { recursive: true });
    writeFileSync(join(workspaceDir, path), content);
  }
  return {
    workspaceDir,
    changedFiles,
    commandEnv: {},
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 1024,
    signal: new AbortController().signal,
  };
}

const assertion = (input: Record<string, unknown>): AssertionDefinition =>
  assertionSchema.parse({ id: 'a', ...input });

const estimate = [
  '# Estimate for the booking widget',
  '',
  'Assumptions',
  '-----------',
  '',
  'Part-time QA and  project',
  'management are included.',
  '',
  '### ESTIMATE',
  '',
  '| Work item | Hours |',
  '| --- | ---: |',
  '| Backend API (bookings) | 24 |',
  '| Widget | 20 |',
  '',
  '##### Risks #####',
  '',
  '```',
  '# Appendix',
  '```',
].join('\n');

describe('assertion plugin registry', () => {
  it('has one plugin per assertion type with the static traits', () => {
    expect(Object.keys(assertionPlugins).sort()).toEqual(Object.keys(ASSERTION_TYPE_TRAITS).sort());
    for (const [type, plugin] of Object.entries(assertionPlugins)) {
      expect(plugin.type).toBe(type);
      expect({
        deterministic: plugin.deterministic,
        executesCommands: plugin.executesCommands,
      }).toEqual(ASSERTION_TYPE_TRAITS[type as keyof typeof ASSERTION_TYPE_TRAITS]);
    }
    expect(Object.values(assertionPlugins).filter((p) => p.executesCommands)).toEqual([
      assertionPlugins.command,
    ]);
  });

  it('treats the document assertions as deterministic and command-free', () => {
    const sections = assertion({ type: 'markdown-sections', file: 'a.md', headings: ['A'] });
    expect(isDeterministicAssertion(sections)).toBe(true);
    expect(
      definitionRunsCommands({
        cases: [{ setup: [], assertions: [sections] }],
      } as unknown as Parameters<typeof definitionRunsCommands>[0]),
    ).toBe(false);
  });
});

describe('markdown-sections', () => {
  it('passes when every heading occurs as an ATX or setext heading of any level', async () => {
    const result = await evaluateAssertion(
      assertion({
        type: 'markdown-sections',
        file: 'out/estimate.md',
        headings: ['  assumptions ', 'Estimate', { pattern: '^risks$', flags: 'i' }],
      }),
      workspace({ 'out/estimate.md': estimate }),
    );
    expect(result).toMatchObject({
      type: 'markdown-sections',
      passed: true,
      score: 1,
      deterministic: true,
      message: 'All 3 heading(s) found in out/estimate.md',
      details: {
        file: 'out/estimate.md',
        found: ['  assumptions ', 'Estimate', '/^risks$/i'],
        missing: [],
        misordered: [],
      },
    });
    expect(result.error).toBeUndefined();
  });

  it('fails with the missing headings, ignoring headings inside fenced code', async () => {
    const result = await evaluateAssertion(
      assertion({
        type: 'markdown-sections',
        file: 'estimate.md',
        headings: ['Assumptions', 'Appendix', { pattern: 'timeline' }],
      }),
      workspace({ 'estimate.md': estimate }),
    );
    expect(result).toMatchObject({
      passed: false,
      score: 0,
      message: 'Missing headings: Appendix, /timeline/',
      details: { found: ['Assumptions'], missing: ['Appendix', '/timeline/'], misordered: [] },
    });
  });

  it('checks the listed order when ordered', async () => {
    const ctx = workspace({ 'estimate.md': estimate });
    const inOrder = await evaluateAssertion(
      assertion({
        type: 'markdown-sections',
        file: 'estimate.md',
        headings: ['Assumptions', 'Estimate', 'Risks'],
        ordered: true,
      }),
      ctx,
    );
    expect(inOrder).toMatchObject({
      passed: true,
      message: 'All 3 heading(s) found in order in estimate.md',
    });
    const reversed = await evaluateAssertion(
      assertion({
        type: 'markdown-sections',
        file: 'estimate.md',
        headings: ['Risks', 'Estimate', { pattern: 'ASSUMPTIONS', flags: 'i' }],
        ordered: true,
      }),
      ctx,
    );
    expect(reversed).toMatchObject({
      passed: false,
      message: 'Headings out of order: Estimate, /ASSUMPTIONS/i',
      details: { missing: [], misordered: ['Estimate', '/ASSUMPTIONS/i'] },
    });
  });

  it('places repeated headings greedily in order', async () => {
    const result = await evaluateAssertion(
      assertion({
        type: 'markdown-sections',
        file: 'doc.md',
        headings: [{ pattern: '^Step' }, 'Summary', { pattern: '^Step' }],
        ordered: true,
      }),
      workspace({ 'doc.md': '# Step 1\n# Summary\n# Step 2\n' }),
    );
    expect(result.passed).toBe(true);
  });
});

describe('markdown structure boundaries (Codex review)', () => {
  it('does not accept a heading that only appears in a fenced example inside a container', async () => {
    for (const example of [
      '> ```markdown\n> # Risks\n> ```\n',
      '- ```markdown\n  # Risks\n  ```\n',
    ]) {
      const result = await evaluateAssertion(
        assertion({ type: 'markdown-sections', file: 'doc.md', headings: ['Risks'] }),
        workspace({ 'doc.md': `# Estimate\n\n${example}` }),
      );
      expect(result).toMatchObject({ passed: false, message: 'Missing headings: Risks' });
    }
  });

  it('does not accept a heading after quoted or listed fence text inside an outer fence', async () => {
    for (const inner of ['> ```', '- ```']) {
      const result = await evaluateAssertion(
        assertion({ type: 'markdown-sections', file: 'doc.md', headings: ['Risks'] }),
        workspace({
          'doc.md': `# Estimate\n\n\`\`\`markdown\n${inner}\n# Risks\n${inner}\n\`\`\`\n`,
        }),
      );
      expect(result).toMatchObject({ passed: false, message: 'Missing headings: Risks' });
    }
  });

  it('grades fences that end with their container as GFM does', async () => {
    const sections = (document: string) =>
      evaluateAssertion(
        assertion({ type: 'markdown-sections', file: 'doc.md', headings: ['Fake', 'Risks'] }),
        workspace({ 'doc.md': document }),
      );
    expect(await sections('> ~~~\n> code\n\n~~~\n> ~~~\n# Fake\n~~~\n# Risks\n')).toMatchObject({
      passed: false,
      message: 'Missing headings: Fake',
    });
    expect(await sections('# Fake\n> ```\n> code\n# Risks\n')).toMatchObject({ passed: true });
  });

  it('does not read numbers after a list or thematic break as table rows', async () => {
    for (const boundary of ['- no table anymore', '---', '* * *']) {
      const result = await evaluateAssertion(
        assertion({
          type: 'markdown-table-value',
          file: 'doc.md',
          row: { pattern: '^PM$' },
          column: 'Hours',
          min: 1,
        }),
        workspace({ 'doc.md': `| Role | Hours |\n|---|---|\n| Dev | 5 |\n${boundary}\nPM | 10\n` }),
      );
      expect(result).toMatchObject({
        passed: false,
        message: expect.stringMatching(/^No row whose/),
      });
    }
  });

  // Issue #110: two false passes found by the fourth Codex review of PR #105.
  it('does not accept a heading that a list marker padding puts inside a fence', async () => {
    const result = await evaluateAssertion(
      assertion({ type: 'markdown-sections', file: 'doc.md', headings: ['Risks'] }),
      workspace({ 'doc.md': '-   ```\n  ```\n# Risks\n```' }),
    );
    expect(result).toMatchObject({ passed: false, message: 'Missing headings: Risks' });
  });

  it('does not accept a link definition with a multi-line label as a heading (Codex review)', async () => {
    const result = await evaluateAssertion(
      assertion({ type: 'markdown-sections', file: 'doc.md', headings: ['[foo bar]: /url'] }),
      workspace({ 'doc.md': '[foo\nbar]: /url\n---' }),
    );
    expect(result).toMatchObject({ passed: false, message: 'Missing headings: [foo bar]: /url' });
  });

  it('does not accept a heading in a list that cannot interrupt a definition paragraph (Codex review)', async () => {
    const result = await evaluateAssertion(
      assertion({ type: 'markdown-sections', file: 'doc.md', headings: ['Fake'] }),
      workspace({ 'doc.md': '[foo\nbar]: /url\n---\n2. # Fake' }),
    );
    expect(result).toMatchObject({ passed: false, message: 'Missing headings: Fake' });
  });

  it('does not accept a heading in a fence after a byte order mark (Codex review)', async () => {
    const result = await evaluateAssertion(
      assertion({ type: 'markdown-sections', file: 'doc.md', headings: ['Fake'] }),
      workspace({ 'doc.md': '\uFEFF```\n# Fake\n```' }),
    );
    expect(result).toMatchObject({ passed: false, message: 'Missing headings: Fake' });
  });

  it('does not accept a heading hidden in an HTML block after a definition paragraph (Codex review)', async () => {
    const result = await evaluateAssertion(
      assertion({ type: 'markdown-sections', file: 'doc.md', headings: ['Fake'] }),
      workspace({ 'doc.md': '[foo]: /url\ntext\n---\n<x>\n# Fake' }),
    );
    expect(result).toMatchObject({ passed: false, message: 'Missing headings: Fake' });
  });

  it('does not read a row after a table filled in its cell budget (Codex review)', async () => {
    const columns = 1000;
    const doc = [
      ['Role', 'Hours', ...Array<string>(columns - 2).fill('c')].join('|'),
      Array<string>(columns).fill('-').join('|'),
      ...Array<string>(1000).fill('x'),
      'Dev|24',
    ].join('\n');
    const result = await evaluateAssertion(
      assertion({
        type: 'markdown-table-value',
        file: 'doc.md',
        row: { pattern: '^Dev$' },
        column: 'Hours',
        min: 24,
        max: 24,
      }),
      workspace({ 'doc.md': doc }),
    );
    expect(result).toMatchObject({
      passed: false,
      message: expect.stringMatching(/^No row whose first cell matches/),
    });
  });

  it('does not read a row hidden in an HTML comment after a table', async () => {
    const result = await evaluateAssertion(
      assertion({
        type: 'markdown-table-value',
        file: 'doc.md',
        row: { pattern: 'Backend API' },
        column: 'Hours',
        min: 16,
        max: 40,
      }),
      workspace({ 'doc.md': '| Role | Hours |\n|---|---|\n<!--\n| Backend API | 24 |\n-->' }),
    );
    expect(result).toMatchObject({
      passed: false,
      message: expect.stringMatching(/^No row whose first cell matches/),
    });
  });
});

describe('required-phrases', () => {
  it('passes when every literal and pattern occurs', async () => {
    const result = await evaluateAssertion(
      assertion({
        type: 'required-phrases',
        file: 'estimate.md',
        // Patterns run on the raw text, so the line break needs \s+.
        phrases: ['qa AND project management', { pattern: 'project\\s+manag|PM\\b', flags: 'i' }],
      }),
      workspace({ 'estimate.md': estimate }),
    );
    expect(result).toMatchObject({
      passed: true,
      message: 'All 2 phrase(s) found in estimate.md',
      details: {
        file: 'estimate.md',
        found: ['qa AND project management', '/project\\s+manag|PM\\b/i'],
        missing: [],
      },
    });
  });

  it('fails with the missing phrases', async () => {
    const result = await evaluateAssertion(
      assertion({
        type: 'required-phrases',
        file: 'estimate.md',
        phrases: ['QA', 'Q.', { pattern: 'PM\\b' }],
      }),
      workspace({ 'estimate.md': 'Includes QA only.' }),
    );
    expect(result).toMatchObject({
      passed: false,
      message: 'Missing phrases: Q., /PM\\b/',
      details: { found: ['QA'], missing: ['Q.', '/PM\\b/'] },
    });
  });

  it('matches literals case-sensitively when asked to', async () => {
    const ctx = workspace({ 'estimate.md': 'Includes qa.' });
    const sensitive = assertion({
      type: 'required-phrases',
      file: 'estimate.md',
      phrases: ['QA'],
      caseSensitive: true,
    });
    expect((await evaluateAssertion(sensitive, ctx)).passed).toBe(false);
    const insensitive = assertion({
      type: 'required-phrases',
      file: 'estimate.md',
      phrases: ['QA'],
    });
    expect((await evaluateAssertion(insensitive, ctx)).passed).toBe(true);
  });
});

describe('markdown-table-value', () => {
  const table = (rows: string[], header = '| Work item | Hours |') =>
    [header, '| --- | --- |', ...rows].join('\n');

  it('passes and reports the table, row, cell and parsed value', async () => {
    const result = await evaluateAssertion(
      assertion({
        type: 'markdown-table-value',
        file: 'estimate.md',
        row: { pattern: 'Backend API', flags: 'i' },
        column: ' hours ',
        min: 16,
        max: 40,
      }),
      workspace({ 'estimate.md': estimate }),
    );
    expect(result).toMatchObject({
      passed: true,
      message: ' hours  = 24 is within 16…40',
      details: {
        file: 'estimate.md',
        row: '/Backend API/i',
        column: ' hours ',
        tableIndex: 1,
        rowText: '| Backend API (bookings) | 24 |',
        cell: '24',
        value: 24,
      },
    });
  });

  it('uses the first matching row of the first table that has the column', async () => {
    const document = [
      table(['| Backend API | 99 |'], '| Work item | Cost |'),
      '',
      table(['| Frontend | 5 |', '| Backend API | 1 234,5 |', '| Backend API | 3 |']),
    ].join('\n');
    const result = await evaluateAssertion(
      assertion({
        type: 'markdown-table-value',
        file: 'estimate.md',
        row: { pattern: '^backend', flags: 'i' },
        column: 'Hours',
        max: 2000,
        decimalSeparator: ',',
      }),
      workspace({ 'estimate.md': document }),
    );
    expect(result).toMatchObject({
      passed: true,
      message: 'Hours = 1234.5 is within -∞…2000',
      details: { tableIndex: 2, cell: '1 234,5', value: 1234.5 },
    });
  });

  it('fails outside the range and reads a range cell as its first number', async () => {
    const result = await evaluateAssertion(
      assertion({
        type: 'markdown-table-value',
        file: 'estimate.md',
        row: { pattern: 'QA' },
        column: 'Hours',
        min: 10,
      }),
      workspace({ 'estimate.md': table(['| QA | 8–12 |']) }),
    );
    expect(result).toMatchObject({
      passed: false,
      message: 'Hours = 8 is outside 10…∞',
      details: { value: 8 },
    });
  });

  it.each([
    [
      'no table has the column',
      table(['| Backend API | 24 |'], '| Item | Days |'),
      'No table has a column "Hours" in estimate.md',
    ],
    [
      'the table has no body rows',
      table([]),
      'No row whose first cell matches /Backend/ in a table with column "Hours"',
    ],
    [
      'no row matches',
      table(['| Widget | 24 |']),
      'No row whose first cell matches /Backend/ in a table with column "Hours"',
    ],
    ['the cell has no number', table(['| Backend | n/a |']), 'No number in cell "n/a"'],
    ['the row has no such cell', table(['| Backend |']), 'No number in cell ""'],
  ])('fails when %s', async (_, document, message) => {
    const result = await evaluateAssertion(
      assertion({
        type: 'markdown-table-value',
        file: 'estimate.md',
        row: { pattern: 'Backend' },
        column: 'Hours',
        min: 0,
      }),
      workspace({ 'estimate.md': document }),
    );
    expect(result).toMatchObject({ passed: false, message });
  });
});

describe('markdown-table-value excerpts', () => {
  it('redacts and shortens agent-written text in the message and details', async () => {
    const token = `ghp_${'a'.repeat(30)}`;
    const long = `${token} ${'x'.repeat(400)}`;
    const result = await evaluateAssertion(
      assertion({
        type: 'markdown-table-value',
        file: 'estimate.md',
        row: { pattern: 'Backend' },
        column: 'Hours',
        min: 0,
      }),
      workspace({ 'estimate.md': `| Item | Hours |\n| - | - |\n| Backend | ${long} |\n` }),
    );
    const redacted = `[REDACTED] ${'x'.repeat(400)}`;
    const cell = `${redacted.slice(0, 200)}… [${redacted.length - 200} more characters]`;
    expect(result).toMatchObject({
      passed: false,
      message: `No number in cell "${cell}"`,
      details: { cell, value: null },
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(String(result.details?.rowText)).toMatch(
      /^\| Backend \| \[REDACTED\] x+… \[\d+ more characters\]$/,
    );
  });
});

const documentAssertions: Record<string, Record<string, unknown>> = {
  'markdown-sections': { type: 'markdown-sections', headings: ['Estimate'] },
  'required-phrases': { type: 'required-phrases', phrases: ['QA'] },
  'markdown-table-value': {
    type: 'markdown-table-value',
    row: { pattern: 'Backend' },
    column: 'Hours',
    min: 1,
  },
};

describe.each(Object.keys(documentAssertions))('%s target file', (type) => {
  const make = (file: string) => assertion({ ...documentAssertions[type], file });

  it('reads the one agent-changed file a glob matches', async () => {
    const ctx = workspace({ 'notes.txt': 'x', 'docs/estimate.md': estimate, 'old.md': '' }, [
      { path: 'docs/estimate.md', change: 'added' },
      { path: 'notes.txt', change: 'modified' },
      { path: 'gone.md', change: 'deleted' },
    ]);
    const result = await evaluateAssertion(make('**/*.md'), ctx);
    expect(result).toMatchObject({ passed: true, details: { file: 'docs/estimate.md' } });
  });

  it('fails when a glob matches no changed file', async () => {
    const ctx = workspace({ 'old.md': estimate }, [{ path: 'old.md', change: 'deleted' }]);
    expect(await evaluateAssertion(make('*.md'), ctx)).toMatchObject({
      passed: false,
      message: 'No file added or modified by the agent matches *.md',
      details: { file: '*.md', matches: [] },
    });
  });

  it('fails with the list of matches when a glob matches two changed files', async () => {
    const ctx = workspace({ 'a.md': estimate, 'b/c.md': estimate });
    expect(await evaluateAssertion(make('**/*.md'), ctx)).toMatchObject({
      passed: false,
      message: '2 files match **/*.md, expected exactly one: a.md, b/c.md',
      details: { matches: ['a.md', 'b/c.md'], matchCount: 2 },
    });
  });

  it('names at most the first matches when a glob matches many files', async () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_LISTED_MATCHES + 3 }, (_, i) => [
        `d/${String(i).padStart(2, '0')}.md`,
        '',
      ]),
    );
    const result = await evaluateAssertion(make('d/*.md'), workspace(files));
    expect(result.message).toMatch(
      /^23 files match d\/\*\.md, expected exactly one: d\/00\.md, .*d\/19\.md … 3 more$/,
    );
    expect(result.details).toMatchObject({ matchCount: 23 });
    expect((result.details?.matches as string[]).length).toBe(MAX_LISTED_MATCHES);
  });

  it('fails when the named file is missing, too large or outside the workspace', async () => {
    const ctx = workspace({ 'big.md': 'x'.repeat(MAX_READ_BYTES + 1) });
    expect(await evaluateAssertion(make('missing.md'), ctx)).toMatchObject({
      passed: false,
      message: 'missing.md does not exist',
      details: { file: 'missing.md', target: 'missing.md' },
    });
    expect(await evaluateAssertion(make('big.md'), ctx)).toMatchObject({
      passed: false,
      message: `big.md is larger than ${MAX_READ_BYTES} bytes`,
    });
    // The schema rejects such paths; resolveInside refuses them again at evaluation.
    const outside = { ...make('a.md'), file: '../outside.md' } as AssertionDefinition;
    expect(await evaluateAssertion(outside, ctx)).toMatchObject({
      passed: false,
      message: 'Assertion could not be evaluated: Path escapes the workspace: ../outside.md',
    });
  });
});

describe('bounded pattern evaluation in assertions', () => {
  const adversarial = (pattern: string): Record<string, Record<string, unknown>> => ({
    'file-contains': { type: 'file-contains', path: 'doc.md', pattern },
    'markdown-sections': {
      type: 'markdown-sections',
      file: 'doc.md',
      headings: ['A', { pattern }],
    },
    'required-phrases': { type: 'required-phrases', file: 'doc.md', phrases: [{ pattern }] },
    'markdown-table-value': {
      type: 'markdown-table-value',
      file: 'doc.md',
      row: { pattern },
      column: 'Hours',
      max: 1,
    },
  });

  it('ends adversarial patterns in every regex-capable type as assertion errors', async () => {
    const started = performance.now();
    const runs = ADVERSARIAL.flatMap(({ pattern, text }) => {
      // The text appears as the whole file, a heading and a table's first cell.
      const ctx = workspace({
        'doc.md': `# ${text}\n\n| ${text} | Hours |\n| - | - |\n| ${text} | 1 |\n`,
      });
      return Object.values(adversarial(pattern)).map((input) =>
        evaluateAssertion(assertion(input), ctx).then((result) => ({ pattern, result })),
      );
    });
    const results = await Promise.all(runs);
    const elapsed = performance.now() - started;
    expect(results).toHaveLength(12);
    for (const { pattern, result } of results) {
      const error = { code: 'pattern-timeout' as const, message: PATTERN_TIMEOUT_MESSAGE };
      expect(result).toMatchObject<Partial<AssertionResult>>({
        passed: false,
        score: 0,
        message: PATTERN_TIMEOUT_MESSAGE,
        error,
      });
      expect(result.details).toMatchObject({ error });
      expect(String((result.details?.patterns as string[])[0])).toBe(`/${pattern}/`);
    }
    // All twelve ran concurrently, each bounded by its own deadline.
    expect(elapsed).toBeLessThan(ASSERTION_REGEX_TIMEOUT_MS + 6000);
  }, 30_000);
});

/** Wall-clock bound for one 2 MiB evaluation on a loaded CI runner (lesson 2026-10-21). */
const MAX_LOADED_RUNNER_MS = 5000;

describe('performance on a 2 MiB document (NFR-118-02)', () => {
  it('evaluates each document assertion quickly, worker start-up included', async () => {
    const block = [
      '## Section heading',
      '',
      'Prose that mentions QA and project management.',
      '',
      '| Work item | Hours |',
      '| --- | ---: |',
      '| Widget | 20 |',
      '| Backend API | 24 |',
      '',
      '',
    ].join('\n');
    const document = `# Assumptions\n# Estimate\n# Risks\n${block.repeat(
      Math.floor((MAX_READ_BYTES - 100) / block.length),
    )}`;
    expect(document.length).toBeGreaterThan(MAX_READ_BYTES - block.length - 100);
    const ctx = workspace({ 'doc.md': document });
    const definitions = [
      {
        type: 'markdown-sections',
        file: '*.md',
        headings: ['Assumptions', { pattern: '^estimate$', flags: 'i' }, 'Risks'],
        ordered: true,
      },
      {
        type: 'required-phrases',
        file: '*.md',
        phrases: ['QA', { pattern: 'project manag|PM\\b', flags: 'i' }, 'absent phrase'],
      },
      {
        type: 'markdown-table-value',
        file: '*.md',
        row: { pattern: 'Backend API', flags: 'i' },
        column: 'Hours',
        min: 16,
        max: 40,
      },
    ].map((input) => assertion(input));
    for (const definition of definitions) {
      let fastest = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        const result = await evaluateAssertion(definition, ctx);
        fastest = Math.min(fastest, performance.now() - started);
        expect(result.error).toBeUndefined();
      }
      // NFR-118-02 targets < 200 ms (measured 65–110 ms locally, see the run log). On a 2-core
      // CI runner, shared with the adversarial tests' busy workers, it took 1.2 s, so the bound is
      // 5 s: far above a loaded run, far below a superlinear scan of 2 MiB (seconds to minutes).
      // Linearity itself is tested by the normalised size-ratio tests in markdown.test.ts.
      expect(fastest).toBeLessThan(MAX_LOADED_RUNNER_MS);
    }
  }, 30_000);
});

describe('the specification-only document example', () => {
  it('validates and grades the sample documents as its README describes', async () => {
    const definition = await loadDefinitionFile(join(exampleDir, 'benchmark.yaml'));
    expect(definition.execution.agent).toBe('claude-code');
    const assertions = definition.cases[0]?.assertions ?? [];
    expect(assertions.map((a) => a.type)).toEqual([
      'markdown-sections',
      'required-phrases',
      'markdown-table-value',
    ]);
    const grade = async (sample: string) => {
      const ctx = workspace({});
      copyFileSync(join(exampleDir, 'documents', sample), join(ctx.workspaceDir, 'estimate.md'));
      // The fixture's brief is unchanged; only the agent's estimate counts as changed.
      writeFileSync(join(ctx.workspaceDir, 'brief.md'), 'brief');
      const changed = { ...ctx, changedFiles: [{ path: 'estimate.md', change: 'added' as const }] };
      return Promise.all(assertions.map((a) => evaluateAssertion(a, changed)));
    };
    expect((await grade('estimate-passing.md')).map((r) => [r.assertionId, r.passed])).toEqual([
      ['structure', true],
      ['mentions-qa-and-pm', true],
      ['backend-hours-realistic', true],
    ]);
    expect((await grade('estimate-failing.md')).map((r) => [r.assertionId, r.message])).toEqual([
      ['structure', 'Missing headings: Risks'],
      ['mentions-qa-and-pm', 'Missing phrases: QA, /project manag|PM\\b/i'],
      ['backend-hours-realistic', 'Hours = 80 is outside 16…40'],
    ]);
  });
});
