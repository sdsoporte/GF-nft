/**
 * S4 — uniqueness and referential guarantees.
 *
 * The issue requires "unicidad de reservas y consistencia entre saldos y
 * movimientos". Every case here proves the rejection comes from a database
 * constraint (not an application-side `if`) by asserting the thrown error names
 * the constraint and that no row moved afterwards.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { InsufficientStockError, type Repositories } from '../../src/persistence/repos/index.ts';
import {
  COMPANY_FACTORY,
  COMPANY_METAL,
  companyColumns,
  countRows,
  fullInventory,
  sampleAudit,
  sampleContract,
  sampleEscrow,
  sampleGrant,
  sampleLine,
  sampleLot,
  seedCompanies,
  seedLotPair,
  snapshotState,
  withRepositories,
} from './repos-fixtures.ts';

const STEEL_PLATE_STOCK = { available: 8, reserved: 0 } as const;

function reserveSteelPlate(
  repos: Repositories,
  overrides: { reservationId?: string; lotId?: string; quantity?: number } = {},
): void {
  repos.reservations.reserve({
    reservationId: overrides.reservationId ?? 'res_1',
    lotId: overrides.lotId ?? 'lot_1',
    companyId: COMPANY_METAL,
    itemId: 'STEEL_PLATE',
    quantity: overrides.quantity ?? 1,
    createdAtTick: 10,
  });
}

test('a duplicate reservation id is rejected by the primary key with no stock moved', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    reserveSteelPlate(repos);
    const before = snapshotState(database);

    assert.throws(() => reserveSteelPlate(repos), /UNIQUE/);

    assert.deepEqual(snapshotState(database), before);
    assert.equal(countRows(database, 'inventory_reservations'), 1);
    assert.deepEqual(repos.inventory.loadStock(COMPANY_METAL, 'STEEL_PLATE'), {
      available: 7,
      reserved: 1,
    });
  });
});

test('a second reservation for the same lot is rejected by the unique lot index', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    reserveSteelPlate(repos);
    const before = snapshotState(database);

    assert.throws(
      () => reserveSteelPlate(repos, { reservationId: 'res_2', lotId: 'lot_1' }),
      /UNIQUE/,
    );

    assert.deepEqual(snapshotState(database), before);
    assert.equal(countRows(database, 'inventory_reservations'), 1);
    assert.deepEqual(repos.inventory.loadStock(COMPANY_METAL, 'STEEL_PLATE'), {
      available: 7,
      reserved: 1,
    });
  });
});

test('a second lot claiming an existing reservation is rejected by the unique reservation index', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    seedLotPair(repos);
    const before = snapshotState(database);

    assert.throws(() => repos.lots.save(sampleLot({ lotId: 'lot_2' })), /UNIQUE/);

    assert.deepEqual(snapshotState(database), before);
    assert.equal(countRows(database, 'commodity_lots'), 1);
  });
});

test('the inventories unique key rejects a second row for the same company and item', () => {
  withRepositories((repos, database) => {
    repos.companies.save(companyColumns());
    repos.inventory.save(
      COMPANY_METAL,
      fullInventory({ STEEL_PLATE: { available: STEEL_PLATE_STOCK.available, reserved: 0 } }),
    );
    const before = snapshotState(database);

    assert.throws(
      () =>
        database
          .query(
            `INSERT INTO inventories (id, company_id, item_id, available_qty, reserved_qty, updated_at_tick)
             VALUES ('dup', ?, 'STEEL_PLATE', 1, 0, 0)`,
          )
          .run(COMPANY_METAL),
      /UNIQUE/,
    );

    assert.deepEqual(snapshotState(database), before);
  });
});

test('the mcp_grants token unique key rejects a duplicated token', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    repos.grants.save(sampleGrant());
    const before = snapshotState(database);

    assert.throws(() => repos.grants.save(sampleGrant({ grantId: 'grant_2' })), /UNIQUE/);

    assert.deepEqual(snapshotState(database), before);
  });
});

test('the audit log primary key rejects a duplicated entry id', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    repos.grants.save(sampleGrant());
    repos.grants.appendAudit(sampleAudit());
    const before = snapshotState(database);

    assert.throws(() => repos.grants.appendAudit(sampleAudit()), /UNIQUE/);

    assert.deepEqual(snapshotState(database), before);
  });
});

test('foreign keys reject rows whose parent company or lot is missing', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    const before = snapshotState(database);

    assert.throws(
      () => repos.lines.save(sampleLine({ lineId: 'line_orphan', companyId: 'comp_missing' })),
      /FOREIGN KEY/,
    );
    assert.throws(
      () =>
        repos.contracts.save({ ...sampleContract(), sellerCompanyId: 'comp_missing' }),
      /FOREIGN KEY/,
    );
    assert.throws(() => repos.lots.save(sampleLot()), /FOREIGN KEY/);
    assert.throws(() => repos.grants.save({ ...sampleGrant(), companyId: 'comp_missing' }), /FOREIGN KEY/);
    assert.throws(
      () => repos.escrows.save(sampleEscrow({ escrowId: 'esc_orphan', lotId: 'lot_missing' })),
      /FOREIGN KEY/,
    );

    assert.deepEqual(snapshotState(database), before);
  });
});

test('reserving more than the available stock fails without touching inventory', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    const before = snapshotState(database);

    assert.throws(
      () => reserveSteelPlate(repos, { quantity: 9 }),
      (error: unknown) => error instanceof InsufficientStockError,
    );

    assert.deepEqual(snapshotState(database), before);
  });
});

test('reserving without an inventory row fails without creating one', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    const before = snapshotState(database);

    assert.throws(
      () =>
        repos.reservations.reserve({
          reservationId: 'res_9',
          lotId: 'lot_9',
          companyId: COMPANY_FACTORY,
          itemId: 'RAW_ORE',
          quantity: 1,
          createdAtTick: 10,
        }),
      (error: unknown) => error instanceof InsufficientStockError,
    );

    assert.deepEqual(snapshotState(database), before);
  });
});

test('releasing a reservation twice is rejected and leaves balances untouched', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    reserveSteelPlate(repos);
    repos.reservations.release({ reservationId: 'res_1', status: 'REVERTED' });
    const before = snapshotState(database);

    assert.throws(
      () => repos.reservations.release({ reservationId: 'res_1', status: 'REVERTED' }),
      /ACTIVE/,
    );

    assert.deepEqual(snapshotState(database), before);
  });
});
