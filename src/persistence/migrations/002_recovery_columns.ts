/**
 * Migration 2 — "recovery_columns": the two columns version 1 lacked plus the
 * reservation uniqueness indexes S4 requires.
 *
 * T1 flagged both columns as necessary for exact mid-match recovery:
 * - `matches.tick_interval_ms` restores the clock cadence a match was started
 *   with (the backend default is 1000 ms, mirrored here as the column default);
 * - `companies.maintenance_paid_ticks` is part of `CompanyState` and is mutated
 *   every tick by the engine, so a restore that drops it silently changes
 *   company economics.
 *
 * SQLite cannot attach a CHECK constraint through `ALTER TABLE ... ADD COLUMN`,
 * so non-negativity of these two columns is enforced on the write path by the
 * repositories (`src/persistence/repos/validate.ts`) instead of by the schema.
 * That limitation is deliberate and recorded here rather than hidden.
 *
 * The two unique indexes make "one reservation per lot, one lot per
 * reservation" a database invariant, so a duplicate reservation cannot
 * double-count the same physical stock (S4).
 */

import type { Migration } from '../migrations.ts';

const SQL = `
ALTER TABLE matches ADD COLUMN tick_interval_ms INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE companies ADD COLUMN maintenance_paid_ticks INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_lot
    ON inventory_reservations(lot_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_lots_reservation
    ON commodity_lots(reservation_id);
`;

export const RECOVERY_COLUMNS_MIGRATION: Migration = {
  version: 2,
  name: 'recovery_columns',
  sql: SQL,
};
