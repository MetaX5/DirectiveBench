import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { sha256 } from '@directivebench/core';
import {
  getArtifactDetail,
  getBenchmarkRunDetail,
  getJob,
  importArtifactVersion,
  openDatabase,
  schema,
  type ImportArtifactInput,
} from '@directivebench/database';
import { LocalRunner } from '@directivebench/runner';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { benchmarkRunCommand, type RunTerminal } from '../src/benchmark-run';
import { CliError, ExitCode, resolveAssets } from '../src/runtime';
import type * as DatabaseModule from '@directivebench/database';
import { initialize } from '../src/setup';
import { writeFakeClaude, type FakeClaudeMode } from './support/fake-claude';

// The final transaction passes through unless a test makes it fail once.
const transaction = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock('@directivebench/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    createBenchmarkRunJob: (...args: Parameters<typeof actual.createBenchmarkRunJob>) => {
      const failure = transaction.failure;
      transaction.failure = null;
      return failure ? Promise.reject(failure) : actual.createBenchmarkRunJob(...args);
    },
  };
});

/**
 * `benchmark run` end to end against a temporary data directory and a fake `claude` on `PATH`
 * (SPEC-118 §15 integration, NFR-118-01): no network, no credential, no real session.
 */
const posix = describe.skipIf(process.platform === 'win32');
const PLANTED_KEY = 'sk-planted-test-key-without-a-known-shape-0123';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-cli-bench-run-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skill(body: string, frontmatter = 'name: pdf\ndescription: Writes reports\n') {
  const content = `---\n${frontmatter}---\n${body}\n`;
  return {
    repository: { provider: 'local-directory', name: 'skills', location: '/tmp/skills' },
    path: '.claude/skills/pdf',
    slug: 'pdf',
    name: 'pdf',
    type: 'skill',
    description: 'Writes reports',
    format: 'skill-md',
    primaryFile: 'SKILL.md',
    files: [
      { path: 'SKILL.md', sha256: sha256(content), size: Buffer.byteLength(content), content },
    ],
    parsedMetadata: {},
  } satisfies ImportArtifactInput;
}

interface Setup {
  root: string;
  dataDir: string;
  suite: string;
  fake: ReturnType<typeof writeFakeClaude>;
  terminal: RunTerminal & { interrupt: () => void };
  output: () => string;
  errors: () => string;
  counts: () => Promise<Record<string, number>>;
}

/** v1 without the marker, v2 (latest) with it: the fake writes the report only for `GOOD`. */
async function setup(
  options: {
    mode?: FakeClaudeMode;
    versions?: ImportArtifactInput[];
    definition?: Record<string, unknown>;
    fixture?: Record<string, string>;
    env?: Record<string, string>;
    interactive?: boolean;
    confirm?: boolean;
  } = {},
): Promise<Setup> {
  const root = tempDir();
  const dataDir = join(root, 'data');
  const { handle } = await initialize(dataDir, resolveAssets().migrationsDir);
  for (const version of options.versions ?? [
    skill('Answer briefly.'),
    skill('GOOD: write a summary.'),
  ]) {
    await importArtifactVersion(handle, version);
  }
  handle.close();
  const suite = join(root, 'pdf-benchmark');
  mkdirSync(join(suite, 'fixtures', 'example'), { recursive: true });
  for (const [path, content] of Object.entries(
    options.fixture ?? { 'README.md': 'Brief: summarise the project.\n' },
  )) {
    mkdirSync(join(suite, 'fixtures', 'example', path, '..'), { recursive: true });
    writeFileSync(join(suite, 'fixtures', 'example', path), content);
  }
  writeFileSync(
    join(suite, 'benchmark.yaml'),
    stringify({
      schemaVersion: 1,
      id: 'pdf-benchmark',
      name: 'PDF benchmark',
      artifactTypes: ['skill'],
      execution: { agent: 'claude-code', model: null, repetitions: 1, timeoutSeconds: 60 },
      cases: [
        {
          id: 'example',
          name: 'Example',
          prompt: 'Read README.md and write output.md',
          fixture: { path: 'fixtures/example' },
          assertions: [
            { id: 'sections', type: 'markdown-sections', file: 'output.md', headings: ['Summary'] },
          ],
        },
      ],
      ...options.definition,
    }),
  );
  const fake = writeFakeClaude(root, options.mode ?? 'skill');
  const home = join(root, 'home');
  mkdirSync(home);
  let handler: (() => void) | null = null;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const terminal = {
    env: { PATH: `${fake.binDir}:/usr/bin:/bin`, HOME: home, ...options.env },
    interactive: options.interactive ?? false,
    confirm: vi.fn(async () => options.confirm ?? false),
    onInterrupt: (callback: () => void) => {
      handler = callback;
      return () => {
        handler = null;
      };
    },
    interrupt: () => handler?.(),
  };
  const counts = async () => {
    const db = openDatabase(join(dataDir, 'directivebench.db'), { readOnly: true });
    try {
      const count = async (table: SQLiteTable) => (await db.db.select().from(table)).length;
      return {
        jobs: await count(schema.jobs),
        suites: await count(schema.benchmarkSuites),
        suiteVersions: await count(schema.benchmarkSuiteVersions),
        fixtures: await count(schema.fixtureVersions),
        runs: await count(schema.benchmarkRuns),
        assignments: await count(schema.artifactBenchmarkAssignments),
      };
    } finally {
      db.close();
    }
  };
  return {
    root,
    dataDir,
    suite,
    fake,
    terminal,
    output: () => log.mock.calls.map((call) => String(call[0])).join('\n'),
    errors: () => error.mock.calls.map((call) => String(call[0])).join('\n'),
    counts,
  };
}

const NOTHING = { jobs: 0, suites: 0, suiteVersions: 0, fixtures: 0, runs: 0, assignments: 0 };

async function refused(s: Setup, flags: Partial<Parameters<typeof benchmarkRunCommand>[0]>) {
  const error = await benchmarkRunCommand(
    { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true, ...flags },
    s.terminal,
  ).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).exitCode).toBe(ExitCode.Usage);
  expect(await s.counts()).toEqual(NOTHING);
  return (error as CliError).message;
}

posix('benchmark run with a fake claude (SPEC-118 §6.4)', () => {
  it('runs cases × repetitions × 2 agent runs against no baseline, records the assignment and exits 0 (AC-2, AC-20)', async () => {
    const s = await setup();
    const code = await benchmarkRunCommand(
      { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
      s.terminal,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(s.fake.starts()).toBe(2);
    const out = s.output();
    expect(out).toContain('Agent runs: 2 (1 case(s) × 1 repetition(s) × 2 variants)');
    expect(out).toContain('Baseline:   no artifact');
    expect(out).toContain('Candidate:  pdf v2');
    expect(out).toContain('count against your Claude plan');
    expect(out).toContain('sent to Anthropic');
    expect(out).toContain('Not sandboxed');
    expect(out).toContain('may include user-level instructions');
    expect(out).toMatch(/Result: +passed \(verdict: improved/);
    expect(out).toContain('Skill invoked: candidate 1/1 runs, baseline 0/1 runs');
    expect(out).toContain('Model:      claude-sonnet-4-5-20250929');
    expect(out).toContain('Cost:       n/a (subscription)');
    expect(out).toMatch(/Warning: +ambient-user-config/);
    expect(await s.counts()).toMatchObject({ jobs: 1, suiteVersions: 1, runs: 1, assignments: 1 });
    // Subscription mode: no credential variable reaches claude.
    expect(
      Object.keys(s.fake.lastEnv()).filter((name) => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(name)),
    ).toEqual([]);

    // The same unchanged suite again reuses its version (AC-15, FR-118-23).
    expect(
      await benchmarkRunCommand(
        { suite: join(s.suite, 'benchmark.yaml'), artifact: 'pdf', dataDir: s.dataDir, yes: true },
        s.terminal,
      ),
    ).toBe(ExitCode.Ok);
    expect(await s.counts()).toMatchObject({ jobs: 2, suiteVersions: 1, runs: 2, assignments: 1 });
  }, 60_000);

  it('compares with another version (A/B), stores the baseline and exits 6 on a regression (AC-3, AC-11)', async () => {
    const s = await setup();
    // Candidate v1 against baseline v2: the baseline is the better version.
    const code = await benchmarkRunCommand(
      {
        suite: s.suite,
        artifact: 'pdf',
        version: '1',
        baseline: 'v2',
        dataDir: s.dataDir,
        yes: true,
        json: true,
      },
      s.terminal,
    );
    expect(code).toBe(ExitCode.CheckFailed);
    const report = JSON.parse(s.output()) as Record<string, unknown>;
    expect(report).toMatchObject({
      status: 'completed',
      displayStatus: 'regression',
      verdict: 'regressed',
      candidate: { artifact: 'pdf', version: 1 },
      baseline: { kind: 'artifact-version', version: 2 },
      usage: { cost: 'n/a (subscription)', costUsd: null },
    });
    // The plan went to stderr, so stdout holds only the JSON object.
    expect(s.errors()).toContain('Baseline:   v2');
    const db = openDatabase(join(s.dataDir, 'directivebench.db'), { readOnly: true });
    try {
      const detail = await getBenchmarkRunDetail(db.db, report.runId as string);
      expect(detail?.baselineArtifactVersion?.version).toBe(2);
      expect(detail?.artifactVersion.version).toBe(1);
    } finally {
      db.close();
    }
  }, 60_000);

  it('passes the key only to claude in API Key Mode and shows an estimated cost', async () => {
    const s = await setup({ env: { ANTHROPIC_API_KEY: PLANTED_KEY } });
    const code = await benchmarkRunCommand(
      {
        suite: s.suite,
        artifact: 'pdf',
        dataDir: s.dataDir,
        yes: true,
        auth: 'api-key',
        maxBudgetUsd: '1.5',
      },
      s.terminal,
    );
    expect(code).toBe(ExitCode.Ok);
    expect(s.fake.lastEnv().ANTHROPIC_API_KEY).toBe(PLANTED_KEY);
    expect(s.fake.lastEnv().HOME).not.toBe(s.terminal.env.HOME);
    expect(s.fake.lastArgv()).toEqual(expect.arrayContaining(['--max-budget-usd', '1.5']));
    expect(s.fake.lastArgv().join('\n')).not.toContain(PLANTED_KEY);
    const out = s.output();
    expect(out).toContain('billed to your API key');
    expect(out).toContain('Budget:     at most $1.5 per agent run');
    expect(out).not.toContain('may include user-level instructions');
    expect(out).toMatch(/Cost: +\$\d+\.\d{4} \(estimated\)/);
    expect(out).not.toContain(PLANTED_KEY);
    const db = openDatabase(join(s.dataDir, 'directivebench.db'), { readOnly: true });
    try {
      const rows = JSON.stringify([
        await db.db.select().from(schema.jobs),
        await db.db.select().from(schema.benchmarkRuns),
        await db.db.select().from(schema.agentRuns),
      ]);
      expect(rows).not.toContain(PLANTED_KEY);
    } finally {
      db.close();
    }
  }, 60_000);

  it('ends a rate-limited run as error without further agent runs and exits 6 (AC-17)', async () => {
    const s = await setup({ mode: 'rate-limited' });
    const code = await benchmarkRunCommand(
      { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
      s.terminal,
    );
    expect(code).toBe(ExitCode.CheckFailed);
    expect(s.fake.starts()).toBe(1);
    expect(s.output()).toMatch(/Result: +error/);
    expect(s.output()).toMatch(/Error: +Stopped after case example/);
    // Only a completed run is assigned to the artifact.
    expect(await s.counts()).toMatchObject({ runs: 1, assignments: 0 });
  }, 60_000);

  it('marks a none baseline that invokes the skill not comparable and exits 6', async () => {
    const s = await setup({ mode: 'always-invoke' });
    const code = await benchmarkRunCommand(
      { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
      s.terminal,
    );
    expect(code).toBe(ExitCode.CheckFailed);
    expect(s.output()).toMatch(/Result: +not-comparable/);
  }, 60_000);

  it('reports a candidate that never used its skill and a failed result', async () => {
    const s = await setup({
      versions: [
        skill('Answer briefly.', 'name: pdf\ndescription: d\ndisable-model-invocation: true\n'),
      ],
    });
    const code = await benchmarkRunCommand(
      { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
      s.terminal,
    );
    expect(code).toBe(ExitCode.CheckFailed);
    expect(s.output()).toContain('the result measures a skill that was never used');
    expect(s.output()).toContain('the skill sets disable-model-invocation');
    expect(s.output()).toMatch(/Result: +failed/);
  }, 60_000);

  it('cancels on Ctrl-C: the run is cancelled and the CLI exits 130 (FR-118-36)', async () => {
    const s = await setup({ mode: 'hang' });
    const running = benchmarkRunCommand(
      { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
      s.terminal,
    );
    const deadline = Date.now() + 30_000;
    while (!s.fake.started()) {
      if (Date.now() > deadline) throw new Error('the fake claude did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    s.terminal.interrupt();
    expect(await running).toBe(130);
    expect(s.output()).toContain('Cancelling…');
    expect(s.output()).toMatch(/Result: +cancelled/);
    // The handler is removed once the run is over.
    s.terminal.interrupt();
  }, 60_000);

  it('asks for confirmation on a terminal and stores nothing when declined', async () => {
    const declined = await setup({ interactive: true, confirm: false });
    expect(
      await benchmarkRunCommand(
        { suite: declined.suite, artifact: 'pdf', dataDir: declined.dataDir },
        declined.terminal,
      ),
    ).toBe(130);
    expect(declined.terminal.confirm).toHaveBeenCalledWith('Start the benchmark run?');
    expect(declined.output()).toContain('Not started; nothing was stored.');
    expect(await declined.counts()).toEqual(NOTHING);
    expect(declined.fake.starts()).toBe(0);

    const accepted = await setup({ interactive: true, confirm: true });
    expect(
      await benchmarkRunCommand(
        { suite: accepted.suite, artifact: 'pdf', dataDir: accepted.dataDir },
        accepted.terminal,
      ),
    ).toBe(ExitCode.Ok);
  }, 60_000);

  it('records approval source user on the suite version after --approve-commands (AC-7)', async () => {
    const definition = {
      cases: [
        {
          id: 'example',
          name: 'Example',
          prompt: 'Write output.md',
          fixture: { path: 'fixtures/example' },
          setup: [['true']],
          assertions: [
            { id: 'sections', type: 'markdown-sections', file: 'output.md', headings: ['Summary'] },
            { id: 'check', type: 'command', command: ['test', '-f', 'output.md'] },
          ],
        },
      ],
    };
    const s = await setup({ definition });
    expect(await refused(s, {})).toMatch(/--approve-commands/);
    expect(
      await benchmarkRunCommand(
        { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true, approveCommands: true },
        s.terminal,
      ),
    ).toBe(ExitCode.Ok);
    expect(s.output()).toContain(
      'Commands to approve for this suite version (--approve-commands):',
    );
    expect(s.output()).toContain('example setup:     ["true"]');
    expect(s.output()).toContain('example check: ["test","-f","output.md"]');
    const db = openDatabase(join(s.dataDir, 'directivebench.db'), { readOnly: true });
    try {
      const [version] = await db.db.select().from(schema.benchmarkSuiteVersions);
      expect(version?.executionApprovalSource).toBe('user');
    } finally {
      db.close();
    }
    // Approved once: the next run needs no flag and says so.
    expect(
      await benchmarkRunCommand(
        { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
        s.terminal,
      ),
    ).toBe(ExitCode.Ok);
    expect(s.output()).toContain('Commands (approved earlier for this suite version):');
  }, 60_000);
});

posix(
  'benchmark run refusals leave the database unchanged (AC-8, AC-14, AC-15, AC-16, AC-23, AC-26–28)',
  () => {
    it('refuses without a terminal and without --yes', async () => {
      const s = await setup();
      expect(await refused(s, { yes: false })).toMatch(/pass --yes/);
      expect(s.fake.starts()).toBe(0);
    });

    it('refuses bad flags', async () => {
      const s = await setup();
      expect(await refused(s, { maxBudgetUsd: '2' })).toMatch(/--auth api-key/);
      expect(await refused(s, { auth: 'api-key', maxBudgetUsd: '-1' })).toMatch(/positive number/);
      expect(await refused(s, { auth: 'token' })).toMatch(
        /--auth must be one of subscription, api-key/,
      );
      expect(await refused(s, { baseline: 'latest' })).toMatch(/--baseline expects none or v<n>/);
      expect(await refused(s, { baseline: 'v0' })).toMatch(
        /--baseline v<n> expects a version number/,
      );
      expect(await refused(s, { version: 'two' })).toMatch(/--artifact-version expects/);
    });

    it('refuses unknown artifacts, versions and baselines with the closest matches', async () => {
      const s = await setup();
      expect(await refused(s, { artifact: 'pd' })).toBe(
        'No artifact has the id or slug "pd". Closest matches: pdf.',
      );
      expect(await refused(s, { version: '9' })).toMatch(
        /no version 9\. Available versions: v2, v1/,
      );
      expect(await refused(s, { baseline: 'v2' })).toMatch(/Invalid baseline v2: /);
      const single = await setup({ versions: [skill('GOOD')] });
      expect(await refused(single, { baseline: 'v1' })).toMatch(/has one version/);
    });

    it('refuses a missing suite, a folder without benchmark.yaml and an invalid definition', async () => {
      const s = await setup();
      expect(await refused(s, { suite: join(s.root, 'missing') })).toMatch(/Suite not found/);
      expect(await refused(s, { suite: join(s.suite, 'fixtures') })).toMatch(
        /has no benchmark.yaml/,
      );
      writeFileSync(join(s.suite, 'benchmark.yaml'), 'schemaVersion: 1\nid: Bad Id\n');
      expect(await refused(s, {})).toMatch(/Invalid benchmark definition/);
    });

    it('refuses suites benchmark run cannot execute', async () => {
      const mock = await setup({ definition: { execution: { agent: 'mock' } } });
      expect(await refused(mock, {})).toMatch(/executes claude-code suites/);
      const docker = await setup({
        definition: {
          execution: { agent: 'claude-code', environment: { kind: 'docker', image: 'node' } },
        },
      });
      expect(await refused(docker, {})).toMatch(/not implemented yet/);
      const rule = await setup({ definition: { artifactTypes: ['rule'] } });
      expect(await refused(rule, {})).toMatch(/evaluates rule artifacts; "pdf" is a skill/);
      const options = await setup({
        definition: {
          cases: [
            {
              id: 'example',
              name: 'Example',
              prompt: 'Write output.md',
              fixture: { path: 'fixtures/example' },
              agentOptions: { 'claude-code': { permissionProfile: 'edit-and-shell' } },
              assertions: [{ id: 'exists', type: 'file-exists', path: 'output.md' }],
            },
          ],
        },
      });
      expect(await refused(options, {})).toMatch(/agentOptions\.claude-code must be empty/);
    });

    it('refuses an artifact format Claude Code cannot install (FR-118-25)', async () => {
      const s = await setup({
        versions: [
          {
            ...skill('x'),
            type: 'rule',
            format: 'cursor-rule',
            primaryFile: 'rule.mdc',
            path: '.cursor/rules/pdf.mdc',
          },
        ],
        definition: { artifactTypes: ['rule'] },
      });
      expect(await refused(s, {})).toMatch(/Refused \(artifact-format-unsupported\)/);
    });

    it('refuses versions with executable customizations, a different skill name or a slash prompt', async () => {
      const hooks = await setup({
        versions: [skill('x', 'name: pdf\ndescription: d\nhooks:\n  PreToolUse: []\n')],
      });
      expect(await refused(hooks, {})).toMatch(
        /Refused \(artifact-executes-code\):\n {2}- candidate SKILL\.md/,
      );
      expect(hooks.fake.starts()).toBe(0);
      const renamed = await setup({
        versions: [skill('a', 'name: pdf-old\ndescription: d\n'), skill('GOOD')],
      });
      expect(await refused(renamed, { baseline: 'v1' })).toMatch(
        /Refused \(baseline-skill-name-differs\)/,
      );
      const slash = await setup({
        definition: {
          cases: [
            {
              id: 'slash',
              name: 'Slash',
              prompt: '/pdf write output.md',
              fixture: { path: 'fixtures/example' },
              assertions: [{ id: 'exists', type: 'file-exists', path: 'output.md' }],
            },
          ],
        },
      });
      expect(await refused(slash, {})).toMatch(/Refused \(slash-prompt-needs-ab-baseline\)/);
    });

    it('refuses Claude Code configuration and imports out of the workspace in fixtures and overlays', async () => {
      const config = await setup({
        fixture: {
          'README.md': 'x',
          '.claude/settings.local.json': '{"permissions":{"allow":["Skill"]}}',
        },
      });
      expect(await refused(config, { approveCommands: true })).toMatch(
        /Refused \(fixture-contains-claude-config\):\n {2}- case example fixture \.claude/,
      );
      const many = await setup({
        fixture: Object.fromEntries(
          Array.from({ length: 22 }, (_, index) => [`d${index}/.mcp.json`, '{}']),
        ),
      });
      expect(await refused(many, {})).toMatch(/… and 2 more/);

      const imports = await setup({ fixture: { 'CLAUDE.md': '@~/secret.txt\n' } });
      writeFileSync(join(imports.terminal.env.HOME as string, 'secret.txt'), 'host secret');
      expect(await refused(imports, {})).toMatch(/Refused \(workspace-imports-outside\)/);
      // API Key Mode resolves ~ against a fresh, empty home: the same token names nothing there.
      expect(
        await benchmarkRunCommand(
          {
            suite: imports.suite,
            artifact: 'pdf',
            dataDir: imports.dataDir,
            yes: true,
            auth: 'api-key',
          },
          { ...imports.terminal, env: { ...imports.terminal.env, ANTHROPIC_API_KEY: PLANTED_KEY } },
        ),
      ).toBe(ExitCode.Ok);

      const overlay = await setup({
        definition: {
          cases: [
            {
              id: 'example',
              name: 'Example',
              prompt: 'Write output.md',
              fixture: { path: 'fixtures/example' },
              verification: { overlay: 'overlay' },
              assertions: [{ id: 'exists', type: 'file-exists', path: 'output.md' }],
            },
          ],
        },
      });
      mkdirSync(join(overlay.suite, 'overlay'));
      writeFileSync(join(overlay.suite, 'overlay', '.mcp.json'), '{}');
      expect(await refused(overlay, {})).toMatch(/case example overlay \.mcp\.json/);

      const bundled = await setup({
        versions: [
          {
            ...skill('x'),
            files: [
              ...skill('x').files,
              {
                path: 'docs/notes.md',
                sha256: sha256('@/etc/hosts'),
                size: 11,
                content: '@/etc/hosts',
              },
            ],
          },
        ],
      });
      expect(await refused(bundled, {})).toMatch(/case example with the candidate .*\/etc\/hosts/);
    });

    it('refuses when Claude Code is not ready or HOME is missing (FR-118-35)', async () => {
      const s = await setup();
      const missing = await benchmarkRunCommand(
        { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
        { ...s.terminal, env: { ...s.terminal.env, PATH: '/usr/bin:/bin' } },
      ).catch((error: unknown) => error);
      expect(missing).toMatchObject({
        exitCode: ExitCode.Usage,
        message: expect.stringMatching(/not ready \(binary-not-found\)/),
      });
      const noKey = await benchmarkRunCommand(
        { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true, auth: 'api-key' },
        s.terminal,
      ).catch((error: unknown) => error);
      expect(noKey).toMatchObject({ message: expect.stringMatching(/not ready \(auth-missing\)/) });
      const { HOME: _home, ...withoutHome } = s.terminal.env;
      const noHome = await benchmarkRunCommand(
        { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
        { ...s.terminal, env: withoutHome },
      ).catch((error: unknown) => error);
      expect(noHome).toMatchObject({ message: expect.stringMatching(/needs HOME/) });
      expect(await s.counts()).toEqual(NOTHING);
    });
  },
);

posix('benchmark run edge paths', () => {
  it('turns a baseline that became invalid before the transaction into a usage error', async () => {
    const s = await setup();
    const { InvalidBaselineError } = await import('@directivebench/database');
    transaction.failure = new InvalidBaselineError('the baseline changed');
    expect(await refused(s, {})).toBe('the baseline changed');
  });

  it('propagates other errors of the final transaction', async () => {
    const s = await setup();
    transaction.failure = new Error('disk full');
    await expect(
      benchmarkRunCommand(
        { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
        s.terminal,
      ),
    ).rejects.toThrow('disk full');
  });

  it('reports a job that failed before its benchmark run existed', async () => {
    const s = await setup();
    vi.spyOn(LocalRunner.prototype, 'runAcquiredJob').mockResolvedValueOnce({
      jobId: 'job_x',
      status: 'failed',
      benchmarkRunId: null,
      error: 'Suite or artifact version no longer exists',
    });
    const error = await benchmarkRunCommand(
      { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
      s.terminal,
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      exitCode: ExitCode.CheckFailed,
      message: 'The benchmark job failed: Suite or artifact version no longer exists',
    });
  });

  it('keeps the artifact detail consistent: the suite is listed after a completed run', async () => {
    const s = await setup();
    await benchmarkRunCommand(
      { suite: s.suite, artifact: 'pdf', dataDir: s.dataDir, yes: true },
      s.terminal,
    );
    const db = openDatabase(join(s.dataDir, 'directivebench.db'), { readOnly: true });
    try {
      const [artifact] = await db.db.select().from(schema.artifacts);
      const detail = await getArtifactDetail(db.db, artifact?.id as string);
      expect(detail?.suites.map((suite) => suite.slug)).toEqual(['pdf-benchmark']);
      const [job] = await db.db.select().from(schema.jobs);
      expect((await getJob(db.db, job?.id as string))?.status).toBe('completed');
    } finally {
      db.close();
    }
  }, 60_000);
});

describe('benchmark run terminal helpers', () => {
  it('reads a yes or no answer', async () => {
    const { PassThrough } = await import('node:stream');
    const { askYesNo } = await import('../src/benchmark-run');
    for (const [answer, expected] of [
      ['y\n', true],
      ['YES\n', true],
      ['n\n', false],
      ['\n', false],
    ] as const) {
      const input = new PassThrough();
      const output = new PassThrough();
      const asked = askYesNo('Start?', input, output);
      input.end(answer);
      expect(await asked).toBe(expected);
      expect(String(output.read())).toContain('Start? [y/N] ');
    }
  });

  it('listens for SIGINT until the run is over', async () => {
    const { processTerminal } = await import('../src/benchmark-run');
    const handler = vi.fn();
    const stop = processTerminal.onInterrupt(handler);
    process.emit('SIGINT');
    stop();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(process.listeners('SIGINT')).not.toContain(handler);
  });
});
