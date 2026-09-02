import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, varchar } from 'drizzle-orm/pg-core';

import { timestamps, ulidFormatCheck, ulidPrimaryKey } from './_helpers';
import { venueTypeEnum } from './enums';

/**
 * A registered public facility. Infrastructure, not a host — a venue never
 * selects guests. There is deliberately no address-protection layer: the venue
 * is public (docs/data-model.md).
 *
 * `licence_ref` and `capacity_hint` are `internal` and must never appear in a
 * view model (enforced in phase C / F, not here).
 */
export const venue = pgTable(
  'venue',
  {
    id: ulidPrimaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    address: text('address').notNull(),
    district: varchar('district', { length: 80 }).notNull(),
    type: venueTypeEnum('type').notNull(),
    operatorVerified: boolean('operator_verified').notNull().default(false),
    licenceRef: text('licence_ref'),
    capacityHint: integer('capacity_hint'),
    ...timestamps,
  },
  (t) => [
    ulidFormatCheck('venue_id_ulid_chk', t.id),
    check(
      'venue_capacity_hint_nonneg_chk',
      sql`${t.capacityHint} IS NULL OR ${t.capacityHint} >= 0`,
    ),
    index('venue_district_type_idx').on(t.district, t.type),
  ],
);
