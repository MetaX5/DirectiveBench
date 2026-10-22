/**
 * The oldest Claude Code release the adapter supports: `--permission-prompts` exists from 2.1.259
 * (SPEC-203 §7, §10). Tested with 2.1.296.
 */
export const CLAUDE_CODE_MINIMUM_VERSION = '2.1.259';

const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})/;

/**
 * The semantic version in the first line of `claude --version` output (`2.1.296 (Claude Code)` →
 * `2.1.296`), or null when the line does not start with one (SPEC-203 §4).
 */
export function parseClaudeVersion(output: string): string | null {
  const firstLine = output.trimStart().split('\n', 1)[0] as string;
  const match = VERSION.exec(firstLine);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function parts(version: string): [number, number, number] | null {
  const match = VERSION.exec(version);
  return match && match[0] === version
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : null;
}

/**
 * True when `version` (as {@link parseClaudeVersion} returns it) is at least
 * {@link CLAUDE_CODE_MINIMUM_VERSION}; false for anything that is not exactly `major.minor.patch`
 * (fail closed: an unparsable version is `version-unsupported`, SPEC-203 §9).
 */
export function isSupportedClaudeVersion(version: string): boolean {
  const actual = parts(version);
  if (!actual) return false;
  const minimum = parts(CLAUDE_CODE_MINIMUM_VERSION) as [number, number, number];
  for (let index = 0; index < 3; index += 1) {
    const difference = (actual[index] as number) - (minimum[index] as number);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
