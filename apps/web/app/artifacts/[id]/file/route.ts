import { getArtifactDetail } from '@directivebench/database';
import { artifactFileResponse } from '@/lib/artifact-download';
import { parseArtifactId } from '@/lib/artifacts';
import { getDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** The exact bytes of one stored file, as a download (issue #52, SPEC-101 §10 and §12). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const handle = getDatabase();
  const id = parseArtifactId((await params).id);
  const detail = handle && id !== null ? await getArtifactDetail(handle.db, id) : null;
  return artifactFileResponse(detail?.versions ?? null, new URL(request.url).searchParams);
}
