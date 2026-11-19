import type { StoredArtifactFile } from '@directivebench/database';
import { z } from 'zod';
import { MAX_FILE_PARAM_LENGTH } from './artifacts';

// Exact bytes of a stored file (issue #52, SPEC-101 §10 and §12). The page cannot show CR
// characters (lesson 2026-10-20), so Download and Copy give the stored string itself. Discovery
// stores only valid UTF-8 (FR-102-17, `isBinary`), so the UTF-8 encoding of the stored string is
// the repository's bytes.

interface VersionFiles {
  version: number;
  files: readonly StoredArtifactFile[];
}

const fileParamsSchema = z.object({
  version: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .transform(Number),
  path: z.string().min(1).max(MAX_FILE_PARAM_LENGTH),
});

/** The file route of a version's file; the Content tab links to it. */
export function artifactFileHref(artifactId: string, version: number, path: string): string {
  const query = new URLSearchParams({ version: String(version), path });
  return `/artifacts/${encodeURIComponent(artifactId)}/file?${query.toString()}`;
}

/**
 * `Content-Disposition` for a download: the base name only, an ASCII fallback (anything outside
 * printable ASCII, quotes and backslashes become `_`) and the exact name as RFC 5987 `filename*`.
 */
export function attachmentDisposition(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function textResponse(status: 400 | 404, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'no-store',
    },
  });
}

/**
 * The download of one stored file: `versions` is null for an unknown artifact. No fallback, unlike
 * the Content tab: a download names exactly the file it gives, or fails.
 */
export function artifactFileResponse(
  versions: readonly VersionFiles[] | null,
  params: URLSearchParams,
): Response {
  const parsed = fileParamsSchema.safeParse({
    version: params.get('version') ?? undefined,
    path: params.get('path') ?? undefined,
  });
  if (!parsed.success || params.getAll('version').length > 1 || params.getAll('path').length > 1) {
    return textResponse(400, 'Bad request: give one version number and one file path.');
  }
  const file = versions
    ?.find((v) => v.version === parsed.data.version)
    ?.files.find((f) => f.path === parsed.data.path);
  if (!file) return textResponse(404, 'Not found: no such artifact, version or file.');
  const body = Buffer.from(file.content, 'utf8');
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      // Never the type the extension suggests: stored HTML or scripts must not render or run.
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': attachmentDisposition(file.path),
      'content-length': String(body.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'no-store',
    },
  });
}
