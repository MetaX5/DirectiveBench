import type * as ShikiCore from '@shikijs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Failure paths of lib/syntax-highlight.ts (FR-123-70, FR-123-74): the highlighter is memoised
// per module, so each test loads a fresh module with a mocked Shiki core.
const create = vi.hoisted(() => vi.fn());
vi.mock('@shikijs/core', async (original) => ({
  ...(await original<typeof ShikiCore>()),
  createHighlighterCore: create,
}));

const SECRET_CONTENT = 'const token = "file content that must not be logged";';

async function load() {
  vi.resetModules();
  return import('../lib/syntax-highlight');
}

describe('highlightLines failures', () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof ShikiCore>('@shikijs/core');
    create.mockReset();
    create.mockImplementation(actual.createHighlighterCore);
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logged.mockRestore();
  });

  it('returns plain text when the highlighter cannot be created, and retries next time', async () => {
    create.mockRejectedValueOnce(new TypeError('grammar did not load'));
    const { highlightLines } = await load();

    expect(await highlightLines(SECRET_CONTENT, 'typescript')).toEqual({
      kind: 'plain',
      reason: 'failed',
    });
    expect(logged).toHaveBeenCalledWith(
      'Syntax highlighting failed for a typescript file: TypeError',
    );

    const retried = await highlightLines(SECRET_CONTENT, 'typescript');
    expect(retried.kind).toBe('highlighted');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('creates the highlighter once per process after it succeeded', async () => {
    const { highlightLines } = await load();
    await highlightLines('a', 'yaml');
    await highlightLines('b', 'json');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('returns plain text when tokenizing throws, and logs no file content', async () => {
    create.mockResolvedValueOnce({
      codeToTokens: () => {
        throw new RangeError(SECRET_CONTENT);
      },
    });
    const { highlightLines } = await load();

    expect(await highlightLines(SECRET_CONTENT, 'typescript')).toEqual({
      kind: 'plain',
      reason: 'failed',
    });
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0])).not.toContain('file content');
    expect(logged).toHaveBeenCalledWith(
      'Syntax highlighting failed for a typescript file: RangeError',
    );
  });

  it('names a thrown value that is not an Error', async () => {
    create.mockRejectedValueOnce('nope');
    const { highlightLines } = await load();
    expect((await highlightLines('a', 'css')).kind).toBe('plain');
    expect(logged).toHaveBeenCalledWith('Syntax highlighting failed for a css file: unknown error');
  });

  it('renders a token without a colour as uncoloured text', async () => {
    create.mockResolvedValueOnce({
      codeToTokens: () => ({
        tokens: [
          [
            { content: 'a' },
            { content: 'b', color: '#ff0000' },
            { content: 'c', color: 'var(--syntax-token-keyword)' },
          ],
        ],
      }),
    });
    const { highlightLines } = await load();
    expect(await highlightLines('abc', 'typescript')).toEqual({
      kind: 'highlighted',
      lines: [
        [
          { text: 'ab', token: null },
          { text: 'c', token: 'keyword' },
        ],
      ],
    });
  });
});
