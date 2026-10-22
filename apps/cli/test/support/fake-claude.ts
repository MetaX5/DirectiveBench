import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Recorded-format Claude Code streams of `@directivebench/agent-adapters` (SPEC-203 L3). */
const STREAMS = fileURLToPath(
  new URL('../../../../packages/agent-adapters/test/fixtures/claude-code/2.1.302', import.meta.url),
);

/**
 * How the fake answers print mode:
 * - `skill`: a workspace whose installed skill contains `GOOD` gets `output.md` with a Summary
 *   heading and a stream that invokes the skill; any other workspace a stream that does not.
 * - `always-invoke`: every workspace, the baseline included, gets the invoking stream.
 * - `rate-limited`: every run ends with a rate-limit error.
 * - `hang`: writes `started` and waits until it is killed.
 */
export type FakeClaudeMode = 'skill' | 'always-invoke' | 'rate-limited' | 'hang';

export interface FakeClaude {
  binDir: string;
  /** Number of print-mode starts so far. */
  starts(): number;
  /** Environment of the last print-mode start (NAME=value lines). */
  lastEnv(): Record<string, string>;
  /** Argv lines of the last print-mode start. */
  lastArgv(): string[];
  started(): boolean;
}

/** Writes a POSIX `sh` fake `claude` into `root/bin`, its records into `root/records`. */
export function writeFakeClaude(root: string, mode: FakeClaudeMode): FakeClaude {
  const binDir = join(root, 'bin');
  const records = join(root, 'records');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(records, { recursive: true });
  const stream = (name: string) => `'${join(STREAMS, `${name}.ndjson`)}'`;
  const q = (name: string) => `'${join(records, name)}'`;
  // API Key Mode must report the key as its credential source, as the real CLI does.
  const replay = (name: string) =>
    `if [ -n "$ANTHROPIC_API_KEY" ]; then sed 's/"apiKeySource": "none"/"apiKeySource": "ANTHROPIC_API_KEY"/' ${stream(name)}; else cat ${stream(name)}; fi`;
  const body: Record<FakeClaudeMode, string[]> = {
    skill: [
      'if grep -rqs GOOD .claude/skills; then',
      "  printf '# Report\\n\\n## Summary\\n' > output.md",
      `  ${replay('skill-invoked')}`,
      'else',
      `  ${replay('skill-not-invoked')}`,
      'fi',
    ],
    'always-invoke': ["printf '# Report\\n\\n## Summary\\n' > output.md", replay('skill-invoked')],
    'rate-limited': [replay('rate-limited'), 'exit 1'],
    hang: [`: > ${q('started')}`, 'while :; do sleep 1; done'],
  };
  writeFileSync(
    join(binDir, 'claude'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "2.1.302 (Claude Code)"; exit 0 ;;',
      '  --setting-sources) echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0 ;;',
      'esac',
      `echo start >> ${q('starts')}`,
      `env > ${q('env')}`,
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > ${q('argv')}`,
      'cat > /dev/null',
      ...body[mode],
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(binDir, 'claude'), 0o755);
  const read = (name: string) =>
    existsSync(join(records, name)) ? readFileSync(join(records, name), 'utf8') : '';
  return {
    binDir,
    starts: () => read('starts').split('\n').filter(Boolean).length,
    lastEnv: () =>
      Object.fromEntries(
        read('env')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      ),
    lastArgv: () => read('argv').split('\n').filter(Boolean),
    started: () => existsSync(join(records, 'started')),
  };
}
