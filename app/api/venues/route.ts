import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSessionActor, listVenues, VENUE_TYPES } from '@/db';
import { policy } from '@/policy';
import { toVenueView } from '@/views';

/**
 * `GET /venues` (docs/api.md Venues): session auth, public registry,
 * filterable by district and type. Read-only — no audit, no write path.
 * `type` is validated against `venueTypeEnum`'s values, never passed as free
 * text; both filters are applied in SQL by `listVenues`.
 */
const listQuery = z.object({
  district: z.string().trim().min(1).optional(),
  type: z.enum(VENUE_TYPES).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = listQuery.safeParse({
    district: request.nextUrl.searchParams.get('district') ?? undefined,
    type: request.nextUrl.searchParams.get('type') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const actor = await getSessionActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (policy(actor, 'venue.list', {}) !== 'allow') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const rows = await listVenues(actor, parsed.data);
  return NextResponse.json({ venues: rows.map(toVenueView) }, { status: 200 });
}
