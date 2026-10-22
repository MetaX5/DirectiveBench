import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateAssertion, type AssertionContext } from '../src/assertions';
import { buildCommandEnv } from '../src/commands';
import { assertionSchema, type AssertionDefinition } from '../src/definition';
import type { FileChange } from '../src/files';
import { nodeScript, useTempDirs } from './helpers';

const tmp = useTempDirs();

function context(overrides: Partial<AssertionContext> = {}): AssertionContext {
  const workspaceDir = tmp('workspace');
  return {
    workspaceDir,
    changedFiles: [],
    commandEnv: buildCommandEnv(tmp('home'), { PATH: process.env.PATH }),
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 1024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const assertion = (input: Record<string, unknown>): AssertionDefinition =>
  assertionSchema.parse({ id: 'a', ...input });

describe('command assertions', () => {
  it.skipIf(process.platform === 'win32')(
    'fails when the command leaves a process that cannot be stopped',
    async () => {
      const result = await evaluateAssertion(
        assertion({
          type: 'command',
          command: [
            'sh',
            '-c',
            'setsid sh -c "echo \\$\\$ > esc.pid; exec sleep 600" & while [ ! -s esc.pid ]; do sleep 0.01; done; cat esc.pid',
          ],
        }),
        context(),
      );
      const details = result.details as { stdout: string; strayProcesses: boolean };
      process.kill(Number(details.stdout.trim()), 'SIGKILL');
      expect(result).toMatchObject({
        passed: false,
        message: 'Command left processes that could not be stopped',
      });
      expect(details.strayProcesses).toBe(true);
    },
    30_000,
  );

  it('passes on the expected exit code and records command details', async () => {
    const result = await evaluateAssertion(
      assertion({
        type: 'command',
        command: nodeScript('console.log("ok")'),
        weight: 2,
        required: true,
      }),
      context(),
    );
    expect(result).toMatchObject({
      assertionId: 'a',
      type: 'command',
      passed: true,
      score: 1,
      weight: 2,
      required: true,
      deterministic: true,
      message: 'Exited with 0',
    });
    expect(result.details).toMatchObject({ exitCode: 0, stdout: 'ok\n', timedOut: false });
  });

  it('honours a non-zero expected exit code', async () => {
    const ctx = context();
    const expectThree = assertion({
      type: 'command',
      command: nodeScript('process.exit(3)'),
      expectExitCode: 3,
    });
    expect((await evaluateAssertion(expectThree, ctx)).passed).toBe(true);
    const expectZero = assertion({ type: 'command', command: nodeScript('process.exit(3)') });
    expect(await evaluateAssertion(expectZero, ctx)).toMatchObject({
      passed: false,
      score: 0,
      message: 'Exited with 3, expected 0',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'reports the signal when the command is killed by one',
    async () => {
      const result = await evaluateAssertion(
        assertion({ type: 'command', command: nodeScript("process.kill(process.pid, 'SIGKILL')") }),
        context(),
      );
      expect(result).toMatchObject({ passed: false, message: 'Exited with SIGKILL, expected 0' });
    },
  );

  it('fails when the executable cannot be started', async () => {
    const result = await evaluateAssertion(
      assertion({ type: 'command', command: ['definitely-not-a-command-xyz'] }),
      context(),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/^Command failed to start: .*ENOENT/);
  });

  it('uses the assertion timeout over the default and fails on timeout', async () => {
    const result = await evaluateAssertion(
      assertion({
        type: 'command',
        command: nodeScript('setTimeout(() => {}, 30000)'),
        timeoutSeconds: 0.2,
      }),
      context({ defaultTimeoutMs: 60_000 }),
    );
    expect(result).toMatchObject({ passed: false, message: 'Command timed out' });
    expect(result.details).toMatchObject({ timedOut: true });
  });

  it('fails when the run is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await evaluateAssertion(
      assertion({ type: 'command', command: nodeScript('process.exit(0)') }),
      context({ signal: controller.signal }),
    );
    expect(result).toMatchObject({ passed: false, message: 'Command cancelled' });
  });
});

describe('file-exists assertions', () => {
  it('checks presence and absence inside the workspace', async () => {
    const ctx = context();
    writeFileSync(join(ctx.workspaceDir, 'present.txt'), 'x');
    const present = await evaluateAssertion(
      assertion({ type: 'file-exists', path: 'present.txt' }),
      ctx,
    );
    expect(present).toMatchObject({ passed: true, message: 'present.txt exists', details: null });
    const missing = await evaluateAssertion(
      assertion({ type: 'file-exists', path: 'missing.txt' }),
      ctx,
    );
    expect(missing).toMatchObject({ passed: false, message: 'missing.txt does not exist' });
    const mustBeAbsent = await evaluateAssertion(
      assertion({ type: 'file-exists', path: 'missing.txt', exists: false }),
      ctx,
    );
    expect(mustBeAbsent.passed).toBe(true);
  });

  it('refuses paths that escape the workspace instead of checking them', async () => {
    const ctx = context();
    // The parent directory exists, but it is outside the workspace.
    const escape = {
      id: 'a',
      type: 'file-exists',
      path: '..',
      exists: true,
      weight: 1,
      required: false,
    } as const;
    const result = await evaluateAssertion(escape, ctx);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/^Assertion could not be evaluated: Path escapes the workspace/);
    const absolute = await evaluateAssertion({ ...escape, path: '/etc/passwd' }, ctx);
    expect(absolute.message).toMatch(/Path must be relative/);
  });
});

describe('file-contains assertions', () => {
  it('matches a pattern with flags and supports negation', async () => {
    const ctx = context();
    mkdirSync(join(ctx.workspaceDir, 'src'));
    writeFileSync(join(ctx.workspaceDir, 'src/a.js'), 'throw new RangeError("x")');
    const matched = await evaluateAssertion(
      assertion({ type: 'file-contains', path: 'src/a.js', pattern: 'rangeerror', flags: 'i' }),
      ctx,
    );
    expect(matched).toMatchObject({
      passed: true,
      message: '/rangeerror/i matched in src/a.js',
    });
    const negated = await evaluateAssertion(
      assertion({ type: 'file-contains', path: 'src/a.js', pattern: 'RangeError', negate: true }),
      ctx,
    );
    expect(negated).toMatchObject({ passed: false, message: '/RangeError/ matched in src/a.js' });
    const absent = await evaluateAssertion(
      assertion({ type: 'file-contains', path: 'src/a.js', pattern: 'TypeError', negate: true }),
      ctx,
    );
    expect(absent).toMatchObject({
      passed: true,
      message: '/TypeError/ did not match in src/a.js',
    });
  });

  it('fails for missing files and directories', async () => {
    const ctx = context();
    mkdirSync(join(ctx.workspaceDir, 'dir'));
    for (const path of ['missing.js', 'dir']) {
      const result = await evaluateAssertion(
        assertion({ type: 'file-contains', path, pattern: 'x' }),
        ctx,
      );
      expect(result).toMatchObject({ passed: false, message: `${path} does not exist` });
    }
  });

  it('refuses to read files larger than the read limit', async () => {
    const ctx = context();
    writeFileSync(join(ctx.workspaceDir, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 'x'));
    const result = await evaluateAssertion(
      assertion({ type: 'file-contains', path: 'big.txt', pattern: 'x', negate: true }),
      ctx,
    );
    expect(result).toMatchObject({
      passed: false,
      message: `big.txt is larger than ${2 * 1024 * 1024} bytes`,
    });
  });
});

describe('changed-files assertions', () => {
  const changes: FileChange[] = [
    { path: 'src/a.js', change: 'modified' },
    { path: 'src/secret.env', change: 'added' },
    { path: 'package.json', change: 'modified' },
  ];

  it('flags files outside the allowed globs', async () => {
    const result = await evaluateAssertion(
      assertion({ type: 'changed-files', allowed: ['src/**'] }),
      context({ changedFiles: changes }),
    );
    expect(result).toMatchObject({ passed: false, message: 'Unexpected changes: package.json' });
    expect(result.details).toEqual({ changedFiles: changes, violations: ['package.json'] });
  });

  it('flags forbidden files and merges violations without duplicates', async () => {
    const result = await evaluateAssertion(
      assertion({ type: 'changed-files', allowed: ['src/**'], forbidden: ['**/*.env', '*.json'] }),
      context({ changedFiles: changes }),
    );
    expect(result.details).toMatchObject({ violations: ['package.json', 'src/secret.env'] });
    const forbiddenOnly = await evaluateAssertion(
      assertion({ type: 'changed-files', forbidden: ['**/*.env'] }),
      context({ changedFiles: changes }),
    );
    expect(forbiddenOnly).toMatchObject({
      passed: false,
      message: 'Unexpected changes: src/secret.env',
    });
  });

  it('passes when every change is within limits', async () => {
    const result = await evaluateAssertion(
      assertion({ type: 'changed-files', forbidden: ['dist/**'] }),
      context({ changedFiles: changes }),
    );
    expect(result).toMatchObject({
      passed: true,
      message: '3 changed file(s), all within limits',
    });
  });
});
