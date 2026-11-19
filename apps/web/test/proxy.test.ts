import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The allowlist is read once at module load, as in the running server. */
async function loadProxy(allowedHosts?: string) {
  vi.resetModules();
  if (allowedHosts === undefined) vi.stubEnv('DIRECTIVEBENCH_ALLOWED_HOSTS', undefined);
  else vi.stubEnv('DIRECTIVEBENCH_ALLOWED_HOSTS', allowedHosts);
  return import('../proxy');
}

function request(host: string | null): NextRequest {
  const headers = new Headers();
  if (host !== null) headers.set('host', host);
  return new NextRequest('http://127.0.0.1:3210/artifacts', { headers });
}

function isForwarded(response: Response): boolean {
  return response.headers.get('x-middleware-next') === '1';
}

afterEach(() => vi.unstubAllEnvs());

describe('proxy (DNS-rebinding protection)', () => {
  it.each([
    'localhost',
    'localhost:3210',
    'LOCALHOST:3210',
    '127.0.0.1',
    '127.0.0.1:3210',
    '[::1]',
    '[::1]:3210',
  ])('serves requests addressed to the loopback host %s', async (host) => {
    const { proxy } = await loadProxy();
    const response = proxy(request(host));
    expect(response.status).toBe(200);
    expect(isForwarded(response)).toBe(true);
  });

  it.each([
    'evil.example',
    'evil.example:3210',
    'localhost.evil.example',
    '127.0.0.2:3210',
    '[::2]:3210',
    '[::1',
    ':3210',
  ])('rejects a foreign Host header %s', async (host) => {
    const { proxy } = await loadProxy();
    const response = proxy(request(host));
    expect(response.status).toBe(403);
    expect(isForwarded(response)).toBe(false);
    expect(await response.text()).toBe('Forbidden: unexpected Host header');
  });

  it('rejects a request without a Host header', async () => {
    const { proxy } = await loadProxy();
    expect(proxy(request(null)).status).toBe(403);
  });

  it('also allows the host names configured by the CLI', async () => {
    const { proxy } = await loadProxy(' Bench.Local , ,192.168.1.20 ');
    expect(proxy(request('bench.local:3210')).status).toBe(200);
    expect(proxy(request('192.168.1.20')).status).toBe(200);
    expect(proxy(request('localhost')).status).toBe(200);
    expect(proxy(request('other.local')).status).toBe(403);
  });

  it('does not allow extra hosts unless configured', async () => {
    const { proxy } = await loadProxy('');
    expect(proxy(request('bench.local')).status).toBe(403);
  });

  it('refuses a path holding an encoded U+0000 before any page reads it (issue 273)', async () => {
    const { proxy } = await loadProxy();
    for (const path of ['/results/%00', '/benchmarks/a%00b/', '/results/run_1/agent-runs/%00']) {
      const response = proxy(
        new NextRequest(`http://127.0.0.1:3210${path}`, { headers: { host: 'localhost' } }),
      );
      expect(response.status).toBe(400);
      expect(isForwarded(response)).toBe(false);
      expect(await response.text()).toBe(
        'Bad request: the address contains a NUL character (U+0000).',
      );
    }
    // `%2500` is the text "%00", not a NUL character.
    const literal = proxy(
      new NextRequest('http://127.0.0.1:3210/results/%2500', { headers: { host: 'localhost' } }),
    );
    expect(isForwarded(literal)).toBe(true);
  });

  it('runs for every path', async () => {
    const { config } = await loadProxy();
    expect(config).toEqual({ matcher: '/:path*' });
  });
});
