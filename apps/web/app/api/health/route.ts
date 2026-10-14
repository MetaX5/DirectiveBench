import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Liveness/readiness probe used by the CLI after starting the server. */
export function GET() {
  const database = getDatabase() ? 'ready' : 'not-initialized';
  return NextResponse.json(
    { status: 'ok', database },
    { headers: { 'cache-control': 'no-store' } },
  );
}
