/**
 * `production_lines` repository, including the seven `activeBatch` columns.
 *
 * `saveMany` is authoritative for one company: lines omitted from the payload
 * are deleted, because a restore must not leave a stale line running behind the
 * reconstructed engine state. The all-or-nothing `activeBatch` CHECK in
 * migration 1 still guards the row shape.
 */

import type { Database } from 'bun:sqlite';

import type { ProductionLine } from '../../domain/types.ts';
import { toProductionLine, type ProductionLineRow } from '../rows.ts';
import { runAtomic } from '../transaction.ts';

const COLUMNS = `line_id, company_id, priority, status, current_recipe_id,
  active_batch_recipe_id, active_batch_target_batches, active_batch_completed_batches,
  active_batch_progress_ticks, active_batch_total_duration_ticks, active_batch_energy_per_tick,
  active_batch_energy_remainder, total_batches_produced, last_action_tick`;

const SELECT_ALL_SQL = `SELECT ${COLUMNS} FROM production_lines WHERE company_id = ? ORDER BY line_id`;
const SELECT_ONE_SQL = `SELECT ${COLUMNS} FROM production_lines WHERE line_id = ?`;

const UPSERT_SQL = `
INSERT INTO production_lines (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(line_id) DO UPDATE SET
  company_id = excluded.company_id,
  priority = excluded.priority,
  status = excluded.status,
  current_recipe_id = excluded.current_recipe_id,
  active_batch_recipe_id = excluded.active_batch_recipe_id,
  active_batch_target_batches = excluded.active_batch_target_batches,
  active_batch_completed_batches = excluded.active_batch_completed_batches,
  active_batch_progress_ticks = excluded.active_batch_progress_ticks,
  active_batch_total_duration_ticks = excluded.active_batch_total_duration_ticks,
  active_batch_energy_per_tick = excluded.active_batch_energy_per_tick,
  active_batch_energy_remainder = excluded.active_batch_energy_remainder,
  total_batches_produced = excluded.total_batches_produced,
  last_action_tick = excluded.last_action_tick`;

const DELETE_STALE_SQL = 'DELETE FROM production_lines WHERE line_id = ?';
const SELECT_IDS_SQL = 'SELECT line_id FROM production_lines WHERE company_id = ?';

export class ProductionLineRepository {
  constructor(private readonly database: Database) {}

  load(lineId: string): ProductionLine | null {
    const row = this.database.query<ProductionLineRow>(SELECT_ONE_SQL).get(lineId);
    return row ? toProductionLine(row) : null;
  }

  listForCompany(companyId: string): ProductionLine[] {
    return this.database
      .query<ProductionLineRow>(SELECT_ALL_SQL)
      .all(companyId)
      .map(toProductionLine);
  }

  save(line: ProductionLine): void {
    runAtomic(this.database, () => this.write(line));
  }

  /** Replace the company's lines with exactly `lines`. */
  saveMany(companyId: string, lines: readonly ProductionLine[]): void {
    for (const line of lines) {
      if (line.companyId !== companyId) {
        throw new Error(
          `Production line "${line.lineId}" belongs to "${line.companyId}", not "${companyId}"`,
        );
      }
    }
    runAtomic(this.database, () => {
      const keep = new Set(lines.map((line) => line.lineId));
      for (const row of this.database.query<{ line_id: string }>(SELECT_IDS_SQL).all(companyId)) {
        if (!keep.has(row.line_id)) {
          this.database.query(DELETE_STALE_SQL).run(row.line_id);
        }
      }
      for (const line of lines) this.write(line);
    });
  }

  private write(line: ProductionLine): void {
    const batch = line.activeBatch;
    this.database
      .query(UPSERT_SQL)
      .run(
        line.lineId,
        line.companyId,
        line.priority,
        line.status,
        line.currentRecipeId,
        batch === null ? null : batch.recipeId,
        batch === null ? null : batch.targetBatches,
        batch === null ? null : batch.completedBatches,
        batch === null ? null : batch.progressTicks,
        batch === null ? null : batch.totalDurationTicks,
        batch === null ? null : batch.energyPerTick,
        batch === null ? null : batch.energyRemainder,
        line.totalBatchesProduced,
        line.lastActionTick,
      );
  }
}
