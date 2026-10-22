import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDefinitionFile } from '@directivebench/benchmark-engine';
import { sha256 } from '@directivebench/core';
import {
  ArtifactRefError,
  importArtifactVersion,
  type ImportArtifactInput,
} from '@directivebench/database';
import { artifactRefCliError, benchmarkInitCommand, suiteName } from '../src/benchmark-init';
import { CliError, ExitCode, resolveAssets } from '../src/runtime';
import { initialize } from '../src/setup';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-cli-bench-init-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

function artifact(slug: string, overrides: Partial<ImportArtifactInput> = {}): ImportArtifactInput {
  const content = `---\nname: ${slug}\ndescription: d\n---\nBody\n`;
  return {
    repository: { provider: 'local-directory', name: 'skills', location: '/tmp/skills' },
    path: `skills/${slug}`,
    slug,
    name: slug,
    type: 'skill',
    description: 'd',
    format: 'skill-md',
    primaryFile: 'SKILL.md',
    files: [
      { path: 'SKILL.md', sha256: sha256(content), size: Buffer.byteLength(content), content },
    ],
    parsedMetadata: {},
    ...overrides,
  };
}

async function dataDirWith(...inputs: ImportArtifactInput[]): Promise<string> {
  const dataDir = join(tempDir(), 'data');
  const { handle } = await initialize(dataDir, resolveAssets().migrationsDir);
  for (const input of inputs) await importArtifactVersion(handle, input);
  handle.close();
  return dataDir;
}

async function init(flags: Parameters<typeof benchmarkInitCommand>[0]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await benchmarkInitCommand(flags);
  const output = log.mock.calls.map((call) => String(call[0])).join('\n');
  log.mockRestore();
  return { code, output };
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

describe('suiteName (SPEC-118 FR-118-20)', () => {
  it('normalises a slug to one confined segment of the suite-id pattern', () => {
    expect(suiteName('estimate-project')).toBe('estimate-project');
    expect(suiteName('../../Etc/Passwd')).toBe('etc-passwd');
    expect(suiteName('Ünïcode_Skill  v2')).toBe('n-code-skill-v2');
    expect(suiteName('---')).toBe('artifact');
    expect(suiteName(`${'a'.repeat(69)}-b`)).toBe('a'.repeat(69));
    expect(suiteName('x'.repeat(100))).toHaveLength(70);
  });
});

describe('benchmark init (SPEC-118 FR-118-20/21, AC-1, AC-14)', () => {
  it('scaffolds a suite folder whose benchmark.yaml validates unchanged and writes no data', async () => {
    const dataDir = await dataDirWith(artifact('estimate-project'));
    const before = statSync(join(dataDir, 'directivebench.db')).mtimeMs;
    const cwd = tempDir();
    const { code, output } = await init({ dataDir, artifact: 'estimate-project', cwd });
    expect(code).toBe(ExitCode.Ok);
    const folder = join(cwd, 'estimate-project-benchmark');
    expect(output).toContain(`Created ${folder}`);
    expect(output).toContain(
      'Next: directivebench benchmark run estimate-project-benchmark --artifact estimate-project',
    );
    const definition = await loadDefinitionFile(join(folder, 'benchmark.yaml'));
    expect(definition).toMatchObject({
      id: 'estimate-project-benchmark',
      name: 'estimate-project benchmark',
      artifactTypes: ['skill'],
      execution: { agent: 'claude-code', model: null, repetitions: 3 },
      cases: [
        {
          id: 'example',
          fixture: { path: 'fixtures/example' },
          assertions: [{ type: 'markdown-sections', file: 'output.md', headings: ['Summary'] }],
        },
      ],
    });
    expect(readFileSync(join(folder, 'fixtures', 'example', 'README.md'), 'utf8')).toContain(
      'Example fixture',
    );
    expect(statSync(join(dataDir, 'directivebench.db')).mtimeMs).toBe(before);
  });

  it('confines a slug outside the suite-id pattern and resolves an artifact id', async () => {
    const dataDir = await dataDirWith(
      artifact('Weird_Slug.v2', { type: 'rule', format: 'claude-rule', primaryFile: 'r.md' }),
    );
    const cwd = tempDir();
    await init({ dataDir, artifact: 'Weird_Slug.v2', cwd });
    const definition = await loadDefinitionFile(
      join(cwd, 'weird-slug-v2-benchmark', 'benchmark.yaml'),
    );
    expect(definition.artifactTypes).toEqual(['rule']);
  });

  it('accepts an empty target directory and refuses a non-empty one or a file', async () => {
    const dataDir = await dataDirWith(artifact('pdf'));
    const cwd = tempDir();
    mkdirSync(join(cwd, 'pdf-benchmark'));
    expect((await init({ dataDir, artifact: 'pdf', cwd })).code).toBe(ExitCode.Ok);
    const again = await failure(benchmarkInitCommand({ dataDir, artifact: 'pdf', cwd }));
    expect(again.exitCode).toBe(ExitCode.Usage);
    expect(again.message).toMatch(/already exists and is not an empty directory/);
    const other = tempDir();
    writeFileSync(join(other, 'pdf-benchmark'), 'x');
    expect(
      (await failure(benchmarkInitCommand({ dataDir, artifact: 'pdf', cwd: other }))).exitCode,
    ).toBe(ExitCode.Usage);
  });

  it('propagates a target that cannot be inspected', async () => {
    const dataDir = await dataDirWith(artifact('pdf'));
    const cwd = tempDir();
    chmodSync(cwd, 0o000);
    await expect(benchmarkInitCommand({ dataDir, artifact: 'pdf', cwd })).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('names the closest matches for an unknown reference (exit 2)', async () => {
    const dataDir = await dataDirWith(artifact('estimate-project'), artifact('deploy'));
    const error = await failure(
      benchmarkInitCommand({ dataDir, artifact: 'estimate', cwd: tempDir() }),
    );
    expect(error.exitCode).toBe(ExitCode.Usage);
    expect(error.message).toBe(
      'No artifact has the id or slug "estimate". Closest matches: estimate-project.',
    );
    const none = await failure(benchmarkInitCommand({ dataDir, artifact: 'zzz', cwd: tempDir() }));
    expect(none.message).toBe('No artifact has the id or slug "zzz".');
  });

  it('refuses when there is no database yet', async () => {
    const error = await failure(
      benchmarkInitCommand({ dataDir: join(tempDir(), 'none'), artifact: 'pdf', cwd: tempDir() }),
    );
    expect(error.exitCode).toBe(ExitCode.Usage);
    expect(error.message).toMatch(/No database at .*scan a repository first/);
  });

  it('keeps errors that are not reference errors and lists versions for a missing one', () => {
    const other = new Error('boom');
    expect(artifactRefCliError(other)).toBe(other);
    const version = artifactRefCliError(
      new ArtifactRefError('version-not-found', 'Artifact "pdf" has no version 9.', ['v2', 'v1']),
    );
    expect(version).toMatchObject({
      exitCode: ExitCode.Usage,
      message: 'Artifact "pdf" has no version 9. Available versions: v2, v1.',
    });
  });

  it('writes into the current directory by default', async () => {
    const dataDir = await dataDirWith(artifact('pdf'));
    const cwd = tempDir();
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    await init({ dataDir, artifact: 'pdf' });
    expect(statSync(join(cwd, 'pdf-benchmark', 'benchmark.yaml')).isFile()).toBe(true);
  });
});
