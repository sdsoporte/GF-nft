/**
 * T5a — `SqliteLocalSettlementProvider` is an *authentic* SQLite implementation
 * (S10), its reservations/lots/escrows and settlement arithmetic are unchanged
 * (20% collateral, 2% burned fee) and every multi-row operation is atomic (S7).
 *
 * Everything is driven through the provider's public interface (the contracts in
 * `src/domain/web3DomainModel.ts`) against a file-backed database; tests read
 * rows back through the repositories only to state what was persisted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateLotStateHash,
  type InventoryReservationService,
  type SettlementProvider,
} from '../../src/domain/web3DomainModel.ts';
import { SqliteLocalSettlementProvider } from '../../src/persistence/SqliteLocalSettlementProvider.ts';
import {
  BUYER,
  SELLER,
  closeWorld,
  countRows,
  creditsOf,
  openWorld,
  reputationOf,
  seedSettlementCompanies,
  snapshotProviderState,
  steelStock,
  withProviderDatabase,
} from './provider-fixtures.ts';

// --- interface compatibility ------------------------------------------------

test('the provider satisfies InventoryReservationService and SettlementProvider', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);

    // Type-level: both domain contracts are assignable to the concrete class.
    const reservationService: InventoryReservationService = world.provider;
    const settlementProvider: SettlementProvider = world.provider;
    assert.equal(typeof reservationService.lockMaterialsForLot, 'function');
    assert.equal(typeof reservationService.unpackLotToInventory, 'function');
    assert.equal(typeof reservationService.revertReservation, 'function');
    assert.equal(typeof settlementProvider.createEscrow, 'function');
    assert.equal(typeof settlementProvider.verifyAndSettleDelivery, 'function');
    assert.equal(typeof settlementProvider.reconcileLedgerState, 'function');

    // Behavioral: the declared methods work through the declared types.
    const lot = await reservationService.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 1, 4);
    assert.equal(lot.quantity, 1);
    const report = await settlementProvider.reconcileLedgerState();
    assert.equal(report.discrepanciesFound, 0);

    closeWorld(world);
  });
});

// --- InventoryReservationService --------------------------------------------

test('lockMaterialsForLot persists the lot, the reservation and the stock movement', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);

    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);

    assert.deepEqual(lot, {
      lotId: 'lot_10_1',
      originCompanyId: SELLER,
      currentHolderCompanyId: SELLER,
      itemId: 'STEEL_PLATE',
      quantity: 4,
      reservationId: 'res_10_1',
      status: 'RESERVED_OFF_CHAIN',
      stateHash: calculateLotStateHash('lot_10_1', 'STEEL_PLATE', 4, SELLER),
      createdAtTick: 10,
    });

    // Read back through the repositories: the rows, not a Map, hold the state.
    assert.deepEqual(world.repos.lots.load('lot_10_1'), lot);
    assert.deepEqual(world.repos.reservations.load('res_10_1'), {
      reservationId: 'res_10_1',
      companyId: SELLER,
      itemId: 'STEEL_PLATE',
      quantity: 4,
      lotId: 'lot_10_1',
      status: 'ACTIVE',
      createdAtTick: 10,
    });
    assert.deepEqual(steelStock(world.repos, SELLER), { available: 6, reserved: 4 });

    // Public readers serve the same rows.
    assert.deepEqual(world.provider.getAllLots(), [lot]);
    assert.deepEqual(world.provider.getLot('lot_10_1'), lot);
    assert.equal(world.provider.getLot('lot_missing'), undefined);
    assert.equal(countRows(world.database, 'commodity_lots'), 1);

    closeWorld(world);
  });
});

test('lockMaterialsForLot rejects an over-reserve and writes nothing', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const before = snapshotProviderState(world.database);

    await assert.rejects(
      () => world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 11, 10),
      /Insufficient available stock of STEEL_PLATE\. Requested: 11, Available: 10/,
    );

    assert.deepEqual(snapshotProviderState(world.database), before);

    closeWorld(world);
  });
});

test('lockMaterialsForLot refuses unknown companies and invalid quantities', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);

    await assert.rejects(
      () => world.provider.lockMaterialsForLot('comp_missing', 'STEEL_PLATE', 1, 10),
      /Company "comp_missing" not found/,
    );
    await assert.rejects(
      () => world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 0, 10),
      /positive safe integer/,
    );
    await assert.rejects(
      () => world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 1.5, 10),
      /safe integer/,
    );

    assert.equal(countRows(world.database, 'commodity_lots'), 0);
    assert.equal(countRows(world.database, 'inventory_reservations'), 0);

    closeWorld(world);
  });
});

test('unpackLotToInventory delivers a settled lot to the buyer exactly once', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);

    // `SETTLED_PENDING_CLAIM` is only reachable through a settlement; the
    // repository is the storage primitive, so the state is induced here to probe
    // the standalone unpack path without repeating the settlement arithmetic.
    world.repos.lots.setStatus(lot.lotId, 'SETTLED_PENDING_CLAIM', null);
    await world.provider.unpackLotToInventory(lot.lotId, BUYER, 12);

    assert.deepEqual(steelStock(world.repos, SELLER), { available: 6, reserved: 0 });
    assert.deepEqual(steelStock(world.repos, BUYER), { available: 6, reserved: 0 });
    assert.equal(world.repos.reservations.load(lot.reservationId)?.status, 'UNPACKED');
    const unpacked = world.provider.getLot(lot.lotId);
    assert.equal(unpacked?.status, 'CONSUMED_UNPACKED');
    assert.equal(unpacked?.settledAtTick, 12);

    // The lot state machine still guards a second unpack (terminal state).
    await assert.rejects(
      () => world.provider.unpackLotToInventory(lot.lotId, BUYER, 13),
      /Illegal transition from "CONSUMED_UNPACKED"/,
    );

    closeWorld(world);
  });
});

test('unpackLotToInventory refuses a lot that was never settled', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    const before = snapshotProviderState(world.database);

    await assert.rejects(
      () => world.provider.unpackLotToInventory(lot.lotId, BUYER, 12),
      /Illegal transition from "RESERVED_OFF_CHAIN" to "CONSUMED_UNPACKED"/,
    );

    assert.deepEqual(snapshotProviderState(world.database), before);

    closeWorld(world);
  });
});

test('revertReservation returns the stock to available and closes the reservation', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);

    await world.provider.revertReservation(lot.lotId, 11);

    assert.deepEqual(steelStock(world.repos, SELLER), { available: 10, reserved: 0 });
    assert.equal(world.repos.reservations.load(lot.reservationId)?.status, 'REVERTED');
    const reverted = world.provider.getLot(lot.lotId);
    assert.equal(reverted?.status, 'CANCELLED_RESTORED');
    assert.equal(reverted?.settledAtTick, 11);

    closeWorld(world);
  });
});

test('generateEip712Voucher advances a per-company anti-replay nonce', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const first = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 1, 10);
    const second = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 1, 10);

    const voucher = world.provider.generateEip712Voucher(first.lotId);
    assert.equal(voucher.nonce, 1);
    assert.equal(voucher.chainId, 8453);
    assert.equal(voucher.verifyingContract, '0xGigaForgeTradeEscrow1155');
    assert.equal(voucher.lotId, first.lotId);
    assert.equal(voucher.originCompanyId, SELLER);
    assert.equal(voucher.itemId, 'STEEL_PLATE');
    assert.equal(voucher.quantity, 1);
    assert.equal(voucher.signature, `0xsim_sig_${first.stateHash}_nonce_1`);
    assert.equal(world.provider.getLot(first.lotId)?.status, 'TOKENIZED_RECEIPT');

    const nextVoucher = world.provider.generateEip712Voucher(second.lotId, 84532, '0xOther');
    assert.equal(nextVoucher.nonce, 2);
    assert.equal(nextVoucher.chainId, 84532);
    assert.equal(nextVoucher.verifyingContract, '0xOther');

    // A buyer voucher is a different account: its own nonce chain starts at 1.
    const buyerLot = await world.provider.lockMaterialsForLot(BUYER, 'STEEL_PLATE', 1, 10);
    assert.equal(world.provider.generateEip712Voucher(buyerLot.lotId).nonce, 1);

    assert.throws(
      () => world.provider.generateEip712Voucher('lot_missing'),
      /Lot "lot_missing" not found/,
    );

    closeWorld(world);
  });
});

// --- SettlementProvider: escrow locking -------------------------------------

test('createEscrow locks the full price and the 20% seller collateral', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);

    const escrow = await world.provider.createEscrow(lot, BUYER, 800, 50);

    assert.deepEqual(escrow, {
      escrowId: 'esc_10_1',
      lotId: lot.lotId,
      sellerCompanyId: SELLER,
      buyerCompanyId: BUYER,
      agreedPriceAmount: 800,
      currencyType: 'INTERNAL_CREDITS',
      sellerCollateralAmount: 160,
      deadlineTick: 50,
      settlementState: 'LOCKED',
    });

    assert.deepEqual(world.repos.escrows.load('esc_10_1'), escrow);
    assert.equal(creditsOf(world.repos, SELLER), 9_840);
    assert.equal(creditsOf(world.repos, BUYER), 4_200);
    assert.equal(world.provider.getLot(lot.lotId)?.status, 'IN_ESCROW');
    assert.equal(lot.status, 'IN_ESCROW');
    assert.deepEqual(world.provider.getAllEscrows(), [escrow]);
    assert.deepEqual(world.provider.getEscrow('esc_10_1'), escrow);
    assert.equal(world.provider.getEscrow('esc_missing'), undefined);

    closeWorld(world);
  });
});

test('createEscrow refuses under-collateralized sellers without touching the database', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos, { sellerCredits: 100 });
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    const before = snapshotProviderState(world.database);

    await assert.rejects(
      () => world.provider.createEscrow(lot, BUYER, 800, 50),
      /Seller requires 160 Credits collateral/,
    );

    assert.deepEqual(snapshotProviderState(world.database), before);
    assert.equal(world.provider.getLot(lot.lotId)?.status, 'RESERVED_OFF_CHAIN');

    closeWorld(world);
  });
});

test('createEscrow refuses under-funded buyers without touching the database', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos, { buyerCredits: 799 });
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    const before = snapshotProviderState(world.database);

    await assert.rejects(
      () => world.provider.createEscrow(lot, BUYER, 800, 50),
      /Buyer requires 800 Credits for escrow/,
    );

    assert.deepEqual(snapshotProviderState(world.database), before);

    closeWorld(world);
  });
});

test('createEscrow rejects invalid amounts and unknown counterparties', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);

    await assert.rejects(
      () => world.provider.createEscrow(lot, BUYER, 0, 50),
      /positive integer/,
    );
    await assert.rejects(
      () => world.provider.createEscrow(lot, BUYER, 10.5, 50),
      /safe integer/,
    );
    await assert.rejects(
      () => world.provider.createEscrow(lot, 'comp_missing', 800, 50),
      /Seller or Buyer company not found/,
    );

    closeWorld(world);
  });
});

// --- SettlementProvider: settlement arithmetic ------------------------------

test('verifyAndSettleDelivery returns collateral, burns 2% and unpacks the goods', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    const escrow = await world.provider.createEscrow(lot, BUYER, 800, 50);

    const result = await world.provider.verifyAndSettleDelivery(escrow.escrowId, 55);

    // 800 price: 2% = 16 burned, 784 net to the seller, 160 collateral returned.
    assert.deepEqual(result, { settled: true, txReference: `gf_tx_55_${escrow.escrowId}` });
    assert.equal(creditsOf(world.repos, SELLER), 9_840 + 160 + 784);
    assert.equal(creditsOf(world.repos, BUYER), 4_200);
    assert.equal(reputationOf(world.repos, SELLER), 105);
    assert.equal(reputationOf(world.repos, BUYER), 55);

    assert.deepEqual(steelStock(world.repos, SELLER), { available: 6, reserved: 0 });
    assert.deepEqual(steelStock(world.repos, BUYER), { available: 6, reserved: 0 });
    assert.equal(world.repos.reservations.load(lot.reservationId)?.status, 'UNPACKED');

    const settledLot = world.provider.getLot(lot.lotId);
    assert.equal(settledLot?.status, 'CONSUMED_UNPACKED');
    assert.equal(settledLot?.settledAtTick, 55);

    const settledEscrow = world.provider.getEscrow(escrow.escrowId);
    assert.equal(settledEscrow?.settlementState, 'RELEASED_TO_BUYER');
    assert.equal(settledEscrow?.settledAtTick, 55);

    // Settling twice must not pay twice.
    await assert.rejects(
      () => world.provider.verifyAndSettleDelivery(escrow.escrowId, 56),
      /expected "LOCKED"/,
    );
    assert.equal(creditsOf(world.repos, SELLER), 9_840 + 160 + 784);

    closeWorld(world);
  });
});

test('verifyAndSettleDelivery floors the burned fee on an odd price', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 1, 10);
    const escrow = await world.provider.createEscrow(lot, BUYER, 1_007, 50);

    // 20% of 1007 = 201.4 -> 201 collateral; 2% of 1007 = 20.14 -> 20 burned.
    assert.equal(escrow.sellerCollateralAmount, 201);
    assert.equal(creditsOf(world.repos, SELLER), 10_000 - 201);
    assert.equal(creditsOf(world.repos, BUYER), 5_000 - 1_007);

    await world.provider.verifyAndSettleDelivery(escrow.escrowId, 60);

    assert.equal(creditsOf(world.repos, SELLER), 10_000 - 201 + 201 + 987);
    assert.equal(creditsOf(world.repos, BUYER), 5_000 - 1_007);

    closeWorld(world);
  });
});

test('verifyAndSettleDelivery rejects unknown and non-LOCKED escrows', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);

    await assert.rejects(
      () => world.provider.verifyAndSettleDelivery('esc_missing', 55),
      /Escrow "esc_missing" not found/,
    );

    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    const escrow = await world.provider.createEscrow(lot, BUYER, 800, 50);
    // A refunded/disputed escrow is not settleable; the repository is the storage
    // primitive, so it can put the row in that state for the probe.
    world.repos.escrows.setState(escrow.escrowId, 'REFUNDED', 51);

    await assert.rejects(
      () => world.provider.verifyAndSettleDelivery(escrow.escrowId, 55),
      /Escrow state is "REFUNDED", expected "LOCKED"/,
    );

    closeWorld(world);
  });
});

// --- S7: ACID through the provider ------------------------------------------

test('a settlement that fails mid-way rolls back lot, reservation, stock and balances', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    const escrow = await world.provider.createEscrow(lot, BUYER, 800, 50);

    // Induce the failure inside the settlement: the reservation is closed before
    // the delivery is verified, so `unpack` fails *after* the lot row was moved to
    // SETTLED_PENDING_CLAIM and the seller/buyer credits were about to move.
    world.repos.reservations.release({ reservationId: lot.reservationId, status: 'REVERTED' });
    const before = snapshotProviderState(world.database);

    await assert.rejects(
      () => world.provider.verifyAndSettleDelivery(escrow.escrowId, 55),
      /expected "ACTIVE"/,
    );

    assert.deepEqual(snapshotProviderState(world.database), before);
    assert.equal(world.provider.getLot(lot.lotId)?.status, 'IN_ESCROW');
    assert.equal(world.provider.getEscrow(escrow.escrowId)?.settlementState, 'LOCKED');

    closeWorld(world);
  });
});

test('a duplicate reservation id is rejected by SQLite through the provider path', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);

    // Storage-level duplicate: a row already owns the id the next reservation
    // will use. Only a real database can reject this, and the rejection must not
    // leave the balance movement behind.
    world.database
      .query(
        `INSERT INTO inventory_reservations
           (reservation_id, company_id, item_id, quantity, lot_id, status, created_at_tick)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      )
      .run('res_10_2', SELLER, 'RAW_ORE', 1, 'lot_decoy', 10);
    const before = snapshotProviderState(world.database);

    await assert.rejects(
      () => world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 5, 10),
      /UNIQUE constraint failed/,
    );

    assert.deepEqual(snapshotProviderState(world.database), before);
    assert.deepEqual(steelStock(world.repos, SELLER), { available: 6, reserved: 4 });
    assert.equal(countRows(world.database, 'commodity_lots'), 1);

    closeWorld(world);
  });
});

// --- circuit breaker --------------------------------------------------------

test('reconcileLedgerState trips on a reserved/lot mismatch and halts new operations', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);

    const clean = await world.provider.reconcileLedgerState();
    assert.deepEqual(clean, {
      discrepanciesFound: 0,
      haltedLots: [],
      isCircuitBreakerTripped: false,
    });
    assert.equal(world.provider.isCircuitBreakerTripped(), false);
    assert.equal(world.provider.getCircuitBreakerReason(), null);

    // Divergence the ledger cannot explain: reserved stock with no active lot.
    world.database
      .query('UPDATE inventories SET reserved_qty = reserved_qty + 3 WHERE company_id = ? AND item_id = ?')
      .run(SELLER, 'STEEL_PLATE');

    const tripped = await world.provider.reconcileLedgerState();
    assert.equal(tripped.discrepanciesFound, 1);
    assert.deepEqual(tripped.haltedLots, [lot.lotId]);
    assert.equal(tripped.isCircuitBreakerTripped, true);
    assert.equal(world.provider.isCircuitBreakerTripped(), true);
    assert.match(world.provider.getCircuitBreakerReason() ?? '', /inventory\.reserved \(7\) !== activeLotsSum \(4\)/);

    const blocked = snapshotProviderState(world.database);
    await assert.rejects(
      () => world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 1, 20),
      /\[Circuit Breaker Active\] New reservations halted/,
    );
    await assert.rejects(
      () => world.provider.createEscrow(lot, BUYER, 800, 50),
      /\[Circuit Breaker Active\] Escrow creation halted/,
    );
    assert.deepEqual(snapshotProviderState(world.database), blocked);

    world.provider.resetCircuitBreaker();
    assert.equal(world.provider.isCircuitBreakerTripped(), false);
    assert.equal(world.provider.getCircuitBreakerReason(), null);
    const recovered = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 1, 20);
    assert.equal(recovered.status, 'RESERVED_OFF_CHAIN');

    closeWorld(world);
  });
});

test('the provider refuses to run without a database handle', () => {
  assert.throws(
    () => new SqliteLocalSettlementProvider(undefined as never),
    /requires a Database/,
  );
});
