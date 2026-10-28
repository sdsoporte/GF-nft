/**
 * T5a — S1/S10 across a real restart.
 *
 * The whole point of the task: after the database file is closed and reopened,
 * the provider must reconstruct lots/escrows/reservations and the balances it
 * moved from the *rows*, not from anything it remembered. Each test therefore
 * discards the first provider instance and builds a new one over the same file.
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { closeDatabase, openDatabase } from '../../src/persistence/database.ts';
import { migrate } from '../../src/persistence/migrations.ts';
import { SqliteLocalSettlementProvider } from '../../src/persistence/SqliteLocalSettlementProvider.ts';
import {
  BUYER,
  SELLER,
  closeWorld,
  countRows,
  creditsOf,
  openWorld,
  seedSettlementCompanies,
  snapshotProviderState,
  steelStock,
  withProviderDatabase,
} from './provider-fixtures.ts';

test('lots, escrows and reservations survive a process restart', async () => {
  await withProviderDatabase(async (path) => {
    const first = openWorld(path);
    seedSettlementCompanies(first.repos);
    const lot = await first.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    const escrow = await first.provider.createEscrow(lot, BUYER, 800, 50);
    const lotsBefore = first.provider.getAllLots();
    const escrowsBefore = first.provider.getAllEscrows();
    const stateBefore = snapshotProviderState(first.database);
    closeWorld(first);

    const second = openWorld(path);
    try {
      assert.deepEqual(second.provider.getAllLots(), lotsBefore);
      assert.deepEqual(second.provider.getAllEscrows(), escrowsBefore);
      assert.deepEqual(second.provider.getLot(lot.lotId), lot);
      assert.deepEqual(second.provider.getEscrow(escrow.escrowId), escrow);
      assert.deepEqual(snapshotProviderState(second.database), stateBefore);
      assert.deepEqual(steelStock(second.repos, SELLER), { available: 6, reserved: 4 });
      assert.equal(creditsOf(second.repos, SELLER), 9_840);
      assert.equal(creditsOf(second.repos, BUYER), 4_200);
    } finally {
      closeWorld(second);
    }
  });
});

test('a settlement started before a restart finishes afterwards with the stored balances', async () => {
  await withProviderDatabase(async (path) => {
    const first = openWorld(path);
    seedSettlementCompanies(first.repos);
    const lot = await first.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    const escrow = await first.provider.createEscrow(lot, BUYER, 800, 50);
    closeWorld(first);

    const second = openWorld(path);
    try {
      const result = await second.provider.verifyAndSettleDelivery(escrow.escrowId, 55);

      assert.deepEqual(result, { settled: true, txReference: `gf_tx_55_${escrow.escrowId}` });
      assert.equal(creditsOf(second.repos, SELLER), 9_840 + 160 + 784);
      assert.equal(creditsOf(second.repos, BUYER), 4_200);
      assert.deepEqual(steelStock(second.repos, SELLER), { available: 6, reserved: 0 });
      assert.deepEqual(steelStock(second.repos, BUYER), { available: 6, reserved: 0 });
      assert.equal(second.repos.reservations.load(lot.reservationId)?.status, 'UNPACKED');
      assert.equal(second.provider.getEscrow(escrow.escrowId)?.settlementState, 'RELEASED_TO_BUYER');
      assert.equal(second.provider.getLot(lot.lotId)?.status, 'CONSUMED_UNPACKED');
    } finally {
      closeWorld(second);
    }
  });
});

test('id allocation resumes from the database instead of restarting at one', async () => {
  await withProviderDatabase(async (path) => {
    const first = openWorld(path);
    seedSettlementCompanies(first.repos);
    const before = await first.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 2, 10);
    assert.equal(before.lotId, 'lot_10_1');
    assert.equal(before.reservationId, 'res_10_1');
    closeWorld(first);

    const second = openWorld(path);
    try {
      const after = await second.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 2, 12);
      // Fresh counters would produce `lot_12_1`, which is fine only by luck; the
      // sequence keeps growing so ids can never collide with an earlier process.
      assert.equal(after.lotId, 'lot_12_2');
      assert.equal(after.reservationId, 'res_12_2');
      assert.deepEqual(
        second.provider.getAllLots().map((lot) => lot.lotId),
        ['lot_10_1', 'lot_12_2'],
      );
      assert.deepEqual(steelStock(second.repos, SELLER), { available: 6, reserved: 4 });
    } finally {
      closeWorld(second);
    }
  });
});

test('the anti-replay nonce survives a restart', async () => {
  await withProviderDatabase(async (path) => {
    const first = openWorld(path);
    seedSettlementCompanies(first.repos);
    const early = await first.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 1, 10);
    const late = await first.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 1, 10);
    assert.equal(first.provider.generateEip712Voucher(early.lotId).nonce, 1);
    closeWorld(first);

    const second = openWorld(path);
    try {
      // A process-local counter would hand out nonce 1 again (a replay window).
      assert.equal(second.provider.generateEip712Voucher(late.lotId).nonce, 2);
      assert.equal(second.provider.getLot(late.lotId)?.status, 'TOKENIZED_RECEIPT');
    } finally {
      closeWorld(second);
    }
  });
});

test('the circuit breaker latch is process-local while its evidence is in SQLite', async () => {
  await withProviderDatabase(async (path) => {
    const first = openWorld(path);
    seedSettlementCompanies(first.repos);
    await first.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    first.database
      .query('UPDATE inventories SET reserved_qty = reserved_qty + 3 WHERE company_id = ? AND item_id = ?')
      .run(SELLER, 'STEEL_PLATE');
    assert.equal((await first.provider.reconcileLedgerState()).isCircuitBreakerTripped, true);
    closeWorld(first);

    const second = openWorld(path);
    try {
      // The latch is a runtime safety flag, deliberately not ledger data: a new
      // process starts unlatched ...
      assert.equal(second.provider.isCircuitBreakerTripped(), false);
      // ... but the discrepancy it detected is still in the rows, so the first
      // reconcile trips it again with the same reason.
      const report = await second.provider.reconcileLedgerState();
      assert.equal(report.discrepanciesFound, 1);
      assert.match(
        second.provider.getCircuitBreakerReason() ?? '',
        /inventory\.reserved \(7\) !== activeLotsSum \(4\)/,
      );
    } finally {
      closeWorld(second);
    }
  });
});

test('no state is shared between providers: only the database carries it', async () => {
  await withProviderDatabase(async (path) => {
    const first = openWorld(path);
    seedSettlementCompanies(first.repos);
    await first.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    await first.provider.createEscrow(first.provider.getLot('lot_10_1')!, BUYER, 800, 50);
    closeWorld(first);

    // A different file: nothing may leak in from the first provider's objects.
    const otherPath = join(dirname(path), 'second.db');
    const otherDatabase = openDatabase(otherPath);
    try {
      migrate(otherDatabase);
      const other = new SqliteLocalSettlementProvider(otherDatabase);
      assert.deepEqual(other.getAllLots(), []);
      assert.deepEqual(other.getAllEscrows(), []);
      assert.equal(countRows(otherDatabase, 'commodity_lots'), 0);
    } finally {
      closeDatabase(otherDatabase);
    }

    // The original file still has its rows (the assertion above was not a wipe).
    const reopened = openWorld(path);
    try {
      assert.equal(reopened.provider.getAllLots().length, 1);
      assert.equal(reopened.provider.getAllEscrows().length, 1);
    } finally {
      closeWorld(reopened);
    }
  });
});

test('an unmigrated database fails loudly instead of falling back to memory', async () => {
  await withProviderDatabase(async (path) => {
    const unmigrated = openDatabase(join(dirname(path), 'empty.db'));
    try {
      const provider = new SqliteLocalSettlementProvider(unmigrated);
      assert.throws(() => provider.getAllLots(), /no such table/i);
    } finally {
      closeDatabase(unmigrated);
    }
  });
});
