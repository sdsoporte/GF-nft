/**
 * Write-path validation.
 *
 * SQLite cannot add CHECK constraints with `ALTER TABLE ... ADD COLUMN`, so the
 * two columns migration 2 introduces (`matches.tick_interval_ms`,
 * `companies.maintenance_paid_ticks`) have no schema-level range check. These
 * helpers keep the write path honest instead of letting a negative value in.
 */

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer, received ${String(value)}`);
  }
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer, received ${String(value)}`);
  }
}

export function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
