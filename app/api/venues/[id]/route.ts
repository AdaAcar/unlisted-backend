import { NextResponse, type NextRequest } from 'next/server';

import { getSessionActor, getVenue } from '@/db';
import { policy } from '@/policy';
import { toVenueView } from '@/views';

/**
 * `GET /venues/:id` (docs/api.md Venues): session auth, public data only.
 * `licence_ref` / `capacity_hint` are never in the response — `VenueRecord`
 * does not carry them and migration 0010 does not grant SELECT on them.
 * A missing id is a plain 404 (venues are public; there is nothing to hide
 * behind 403).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const actor = await getSessionActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (policy(actor, 'venue.get', {}) !== 'allow') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const venue = await getVenue(actor, id);
  if (!venue) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return NextResponse.json(toVenueView(venue), { status: 200 });
}
