import { describe, expect, it } from 'vitest';
import { sha256 } from '@directivebench/core';
import type { StoredArtifactFile } from '@directivebench/database';
import {
  artifactFileHref,
  artifactFileResponse,
  attachmentDisposition,
  exactBytesNotice,
} from '../lib/artifact-download';
import { MAX_FILE_PARAM_LENGTH } from '../lib/artifacts';

function stored(path: string, content: string): StoredArtifactFile {
  const bytes = Buffer.from(content, 'utf8');
  return { path, sha256: sha256(bytes), size: bytes.length, content };
}

const CRLF = '# Rules\r\n\r\nLine with a lone CR\rand Zażółć ✓\r\n';
const versions = [
  {
    version: 2,
    files: [stored('SKILL.md', CRLF), stored('scripts/run page.html', '<script>x()</script>\n')],
  },
  { version: 1, files: [stored('SKILL.md', 'old\n')] },
];

function query(params: Record<string, string | string[]>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of [value].flat()) search.append(key, v);
  }
  return search;
}

describe('artifactFileHref', () => {
  it('links to the file route with the version and the encoded path', () => {
    expect(artifactFileHref('art_a b', 3, 'scripts/run page.html')).toBe(
      '/artifacts/art_a%20b/file?version=3&path=scripts%2Frun+page.html',
    );
  });
});

describe('attachmentDisposition', () => {
  it('names the base name, with an ASCII fallback and the exact RFC 5987 name', () => {
    expect(attachmentDisposition('a/b/SKILL.md')).toBe(
      `attachment; filename="SKILL.md"; filename*=UTF-8''SKILL.md`,
    );
    expect(attachmentDisposition(`zó"ł\\'(x)*.md`)).toBe(
      `attachment; filename="z____'(x)*.md"; filename*=UTF-8''z%C3%B3%22%C5%82%5C%27%28x%29%2A.md`,
    );
  });
});

describe('artifactFileResponse', () => {
  it('serves the stored content byte for byte, CR characters kept, as an inert attachment', async () => {
    const response = artifactFileResponse(versions, query({ version: '2', path: 'SKILL.md' }));
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(Buffer.from(CRLF, 'utf8'))).toBe(true);
    expect(sha256(body)).toBe(versions[0]!.files[0]!.sha256);
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="SKILL.md"; filename*=UTF-8''SKILL.md`,
      'content-length': String(body.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'no-store',
    });
  });

  it('serves an HTML or script file as plain text, never its own type', async () => {
    const response = artifactFileResponse(
      versions,
      query({ version: '2', path: 'scripts/run page.html' }),
    );
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('<script>x()</script>\n');
  });

  it('serves the requested version, not the latest', async () => {
    const response = artifactFileResponse(versions, query({ version: '1', path: 'SKILL.md' }));
    expect(await response.text()).toBe('old\n');
  });

  it.each([
    ['an unknown artifact', null, { version: '1', path: 'SKILL.md' }],
    ['an unknown version', versions, { version: '9', path: 'SKILL.md' }],
    ['an unknown path', versions, { version: '1', path: 'scripts/run page.html' }],
  ])('is a 404 for %s, with no fallback', async (_, list, params) => {
    const response = artifactFileResponse(list, query(params));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('Not found: no such artifact, version or file.');
  });

  it.each([
    ['no parameters', {}],
    ['no path', { version: '1' }],
    ['an empty path', { version: '1', path: '' }],
    ['a path over the limit', { version: '1', path: 'a'.repeat(MAX_FILE_PARAM_LENGTH + 1) }],
    ['a version that is not a positive number', { version: '0', path: 'SKILL.md' }],
    ['a repeated version', { version: ['1', '2'], path: 'SKILL.md' }],
    ['a repeated path', { version: '1', path: ['SKILL.md', 'SKILL.md'] }],
  ])('is a 400 for %s', async (_, params) => {
    const response = artifactFileResponse(versions, query(params));
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('Bad request: give one version number and one file path.');
  });
});

describe('exactBytesNotice', () => {
  it('says nothing when the stored text is the repository bytes', () => {
    expect(exactBytesNotice(stored('a.md', CRLF))).toBeNull();
  });

  it('says so when the file was not valid UTF-8 and the stored text differs', () => {
    const source = Buffer.from([0x61, 0xff, 0x0d, 0x0a]);
    const file = {
      path: 'a.bin',
      sha256: sha256(source),
      size: source.length,
      content: source.toString('utf8'),
    };
    expect(exactBytesNotice(file)).toBe(
      'This file is not valid UTF-8 text. Download and Copy give the stored text, which differs from the bytes in the repository.',
    );
  });
});
