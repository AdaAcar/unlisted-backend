import type { VenueRecord } from '@/db/repositories/venues';

/**
 * The venue view model (C2, the second real one after `CircleView`). One
 * audience: any authenticated reader — a venue is a public registry entry,
 * not a social object, so there is no per-audience variation to make yet.
 *
 * `licence_ref` and `capacity_hint` are `internal` (docs/data-model.md) and
 * are absent by construction: `VenueRecord` never carries them (migration
 * 0010 does not even grant `unlisted_app` SELECT on those columns). This
 * view is still the explicit serialization boundary agent-rules section 3
 * requires, and F1's fork point if per-audience venue views are ever needed.
 */
export interface VenueView {
  id: string;
  name: string;
  address: string;
  district: string;
  type: VenueRecord['type'];
  operatorVerified: boolean;
}

export function toVenueView(venue: VenueRecord): VenueView {
  return {
    id: venue.id,
    name: venue.name,
    address: venue.address,
    district: venue.district,
    type: venue.type,
    operatorVerified: venue.operatorVerified,
  };
}
