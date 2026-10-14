import { NextResponse, type NextRequest } from 'next/server';

/**
 * DNS-rebinding protection: the local server has no authentication, so only requests addressed
 * to an allowed host name are served. A malicious web page that rebinds its own domain to
 * 127.0.0.1 sends its own domain in the Host header and is rejected.
 * DIRECTIVEBENCH_ALLOWED_HOSTS is set by the CLI (comma-separated host names).
 */
const allowedHosts = new Set(
  [
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...(process.env.DIRECTIVEBENCH_ALLOWED_HOSTS ?? '').split(','),
  ]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

function hostname(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.toLowerCase();
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0] ?? null;
}

export function proxy(request: NextRequest) {
  const host = hostname(request.headers.get('host'));
  if (!host || !allowedHosts.has(host)) {
    return new NextResponse('Forbidden: unexpected Host header', { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/:path*',
};
