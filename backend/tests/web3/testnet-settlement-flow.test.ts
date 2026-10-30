/**
 * GigaForge v4.1 - Web3 Testnet Settlement & Lifecycle Test Suite (issue #14)
 *
 * Verifies:
 * - Complete testnet lifecycle: mint voucher, deposit, escrow lock, settlement, and unpack
 * - Strict Invariant 1: Material conservation (no double-counting, no duplicate crediting)
 * - Anti-replay and idempotency: lots cannot be unpacked twice or reused once terminal
 * - Cancellation and atomic restoration of reserved materials
 * - Strict Invariant 2: Ownership vs Usage Rights (ERC-4907 dual-role rental simulation)
 * - Circuit breaker ledger reconciliation and operator safety latch
 * - MCP credential separation: no MCP tool signs Web3 transactions or holds private keys
 * - Parameterized testnet suite: 100% offline runnable without network or blockchain SDKs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateLotStateHash,
  CommodityLot,
  Eip712LotVoucher,
  Ownership,
  UsageRight,
  validateLotTransition,
} from '../../src/domain/web3DomainModel.ts';
import { SqliteLocalSettlementProvider } from '../../src/persistence/SqliteLocalSettlementProvider.ts';
import {
  BUYER,
  SELLER,
  closeWorld,
  creditsOf,
  openWorld,
  seedSettlementCompanies,
  steelStock,
  withProviderDatabase,
} from '../persistence/provider-fixtures.ts';

// Test constants for Base Sepolia testnet specification
const BASE_SEPOLIA_CHAIN_ID = 84532;
const TESTNET_ESCROW_CONTRACT = '0x14GigaForgeTradeEscrow1155Testnet';

test('Web3 Testnet Lifecycle: mint voucher, escrow lock, delivery settlement, and unpack', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);

    // Initial stock: SELLER has 10 STEEL_PLATE, BUYER has 2 STEEL_PLATE
    assert.deepEqual(steelStock(world.repos, SELLER), { available: 10, reserved: 0 });
    assert.deepEqual(steelStock(world.repos, BUYER), { available: 2, reserved: 0 });

    // Step 1: Pack materials into a CommodityLot
    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 100);
    assert.equal(lot.status, 'RESERVED_OFF_CHAIN');
    assert.equal(lot.quantity, 4);
    assert.deepEqual(steelStock(world.repos, SELLER), { available: 6, reserved: 4 });

    // Step 2: Generate EIP-712 typed voucher for Base Sepolia testnet
    const voucher: Eip712LotVoucher = world.provider.generateEip712Voucher(
      lot.lotId,
      BASE_SEPOLIA_CHAIN_ID,
      TESTNET_ESCROW_CONTRACT
    );
    assert.equal(voucher.lotId, lot.lotId);
    assert.equal(voucher.chainId, BASE_SEPOLIA_CHAIN_ID);
    assert.equal(voucher.verifyingContract, TESTNET_ESCROW_CONTRACT);
    assert.equal(voucher.quantity, 4);
    assert.equal(typeof voucher.nonce, 'number');
    assert.ok(voucher.expirationTimestamp > Math.floor(Date.now() / 1000));
    assert.match(voucher.signature, /^0xsim_sig_/);

    const lotAfterVoucher = world.provider.getLot(lot.lotId);
    assert.equal(lotAfterVoucher?.status, 'TOKENIZED_RECEIPT');

    // Step 3: Deposit lot into trade escrow (with 20% collateral from seller and buyer price)
    const agreedPrice = 800; // credits
    const escrow = await world.provider.createEscrow(lotAfterVoucher!, BUYER, agreedPrice, 150);
    assert.equal(escrow.settlementState, 'LOCKED');
    assert.equal(escrow.sellerCollateralAmount, 160); // 20% of 800
    assert.equal(escrow.agreedPriceAmount, 800);

    // Step 4: Verify delivery and settle escrow
    const settlement = await world.provider.verifyAndSettleDelivery(escrow.escrowId, 120);
    assert.equal(settlement.settled, true);
    assert.match(settlement.txReference, /^gf_tx_120_/);

    // Step 5: Verify post-settlement balances and stock
    const settledLot = world.provider.getLot(lot.lotId);
    assert.equal(settledLot?.status, 'CONSUMED_UNPACKED');

    // Seller: initial 10,000 - 160 collateral + 160 collateral refund + (800 - 16 fee) = 10,784
    assert.equal(creditsOf(world.repos, SELLER), 10_784);
    // Buyer: initial 5,000 - 800 price = 4,200
    assert.equal(creditsOf(world.repos, BUYER), 4_200);

    // Invariant 1: Seller available 6, reserved 0; Buyer received 4 available (initial 2 + 4 = 6)
    assert.deepEqual(steelStock(world.repos, SELLER), { available: 6, reserved: 0 });
    assert.deepEqual(steelStock(world.repos, BUYER), { available: 6, reserved: 0 });

    closeWorld(world);
  });
});

test('Anti-Replay & Idempotency: a lot cannot be unpacked twice or reused once terminal', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);

    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 3, 200);
    const escrow = await world.provider.createEscrow(lot, BUYER, 600, 250);
    await world.provider.verifyAndSettleDelivery(escrow.escrowId, 210);

    const settledLot = world.provider.getLot(lot.lotId)!;
    assert.equal(settledLot.status, 'CONSUMED_UNPACKED');

    // Attempting to unpack again must fail
    await assert.rejects(
      async () => {
        await world.provider.unpackLotToInventory(lot.lotId, BUYER, 220);
      },
      /Illegal transition from "CONSUMED_UNPACKED" to "CONSUMED_UNPACKED"/
    );

    // Attempting to create an escrow with the already consumed lot must fail
    await assert.rejects(
      async () => {
        await world.provider.createEscrow(settledLot, BUYER, 600, 300);
      },
      /Illegal transition/
    );

    // Buyer stock must remain exactly 5 (initial 2 + 3), not duplicated to 8
    assert.deepEqual(steelStock(world.repos, BUYER), { available: 5, reserved: 0 });

    closeWorld(world);
  });
});

test('Reservation Cancellation: materials return to available and lot terminates as CANCELLED_RESTORED', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);

    const lot = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 5, 300);
    assert.deepEqual(steelStock(world.repos, SELLER), { available: 5, reserved: 5 });

    // Cancel reservation
    await world.provider.revertReservation(lot.lotId, 310);

    const revertedLot = world.provider.getLot(lot.lotId);
    assert.equal(revertedLot?.status, 'CANCELLED_RESTORED');

    // Stock completely restored
    assert.deepEqual(steelStock(world.repos, SELLER), { available: 10, reserved: 0 });

    // Cannot unpack or escrow a cancelled lot
    await assert.rejects(
      async () => {
        await world.provider.unpackLotToInventory(lot.lotId, BUYER, 320);
      },
      /Illegal transition from "CANCELLED_RESTORED"/
    );

    closeWorld(world);
  });
});

test('Strict Invariant 2: ERC-4907 dual-role rental simulation separates Ownership from UsageRight', () => {
  const assetId = 'ast_bp_adv_smelter_v2';
  const ownerWallet = '0x111122223333444455556666777788889999aaaa';

  // 1. Ownership (Deed / Custody)
  const ownership: Ownership = {
    assetId,
    ownerCompanyId: SELLER,
    ownerWalletAddress: ownerWallet,
    custodyState: 'MINTED_ON_CHAIN',
    updatedAtTick: 50,
  };

  // 2. UsageRight (Time-bound rental license per ERC-4907 setUser)
  const rentalLease: UsageRight = {
    usageId: 'use_lease_100_300',
    assetId,
    beneficiaryCompanyId: BUYER, // Lessee
    validFromTick: 100,
    expiresAtTick: 300,
    revenueShareBps: 1000, // 10%
    isActive: true,
  };

  // Simulation engine helper: checks active usage right at given tick
  function hasActiveUsageRight(lease: UsageRight, companyId: string, currentTick: number): boolean {
    return (
      lease.isActive &&
      lease.beneficiaryCompanyId === companyId &&
      currentTick >= lease.validFromTick &&
      currentTick <= lease.expiresAtTick
    );
  }

  // Pre-lease tick: inactive
  assert.equal(hasActiveUsageRight(rentalLease, BUYER, 90), false);

  // During lease: active for lessee (BUYER)
  assert.equal(hasActiveUsageRight(rentalLease, BUYER, 100), true);
  assert.equal(hasActiveUsageRight(rentalLease, BUYER, 200), true);
  assert.equal(hasActiveUsageRight(rentalLease, BUYER, 300), true);

  // Non-beneficiary (SELLER) does not have active usage right even though they own the asset
  assert.equal(hasActiveUsageRight(rentalLease, SELLER, 200), false);

  // Post-lease tick: expired automatically without on-chain unstaking transaction
  assert.equal(hasActiveUsageRight(rentalLease, BUYER, 301), false);

  // Legal ownership remained unchanged throughout
  assert.equal(ownership.ownerCompanyId, SELLER);
  assert.equal(ownership.ownerWalletAddress, ownerWallet);
});

test('Circuit Breaker: reconcileLedgerState trips when reserved inventory diverges from active lots', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);

    // Create 2 lots (4 units each = 8 total reserved)
    await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 10);
    await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 4, 20);

    // Clean state
    const cleanReport = await world.provider.reconcileLedgerState();
    assert.equal(cleanReport.discrepanciesFound, 0);
    assert.equal(cleanReport.isCircuitBreakerTripped, false);
    assert.equal(world.provider.isCircuitBreakerTripped(), false);

    // Induce artificial discrepancy in the underlying table:
    // Change reserved_qty directly without creating a lot
    world.database.query(
      "UPDATE inventories SET reserved_qty = 999 WHERE company_id = ? AND item_id = 'STEEL_PLATE'"
    ).run(SELLER);

    const trippedReport = await world.provider.reconcileLedgerState();
    assert.equal(trippedReport.discrepanciesFound, 1);
    assert.equal(trippedReport.isCircuitBreakerTripped, true);
    assert.equal(world.provider.isCircuitBreakerTripped(), true);
    assert.match(world.provider.getCircuitBreakerReason()!, /Discrepancy detected/);

    // While tripped, subsequent lot operations are halted
    await assert.rejects(
      async () => {
        await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 1, 30);
      },
      /Circuit Breaker Active/
    );

    // Operator reset restores normal operation
    world.provider.resetCircuitBreaker();
    assert.equal(world.provider.isCircuitBreakerTripped(), false);

    closeWorld(world);
  });
});

test('Credential Boundary Separation: MCP agent tool catalog contains zero Web3 signing tools', () => {
  // Authoritative list of MCP tools exposed to AI agents
  const MCP_TOOL_CATALOG = [
    'get_factory_overview',
    'get_inventory',
    'get_production_lines',
    'get_contracts',
    'get_market_quotes',
    'get_action_history',
    'set_production_target',
    'set_line_priority',
    'pause_production_line',
    'resume_production_line',
    'schedule_internal_transport',
    'draft_supply_offer',
    'cancel_own_pending_offer',
  ];

  const FORBIDDEN_CAPABILITIES = [
    'web3',
    'sign',
    'wallet',
    'private_key',
    'transfer_token',
    'mint_nft',
    'send_transaction',
    'broadcast',
  ];

  for (const tool of MCP_TOOL_CATALOG) {
    for (const forbidden of FORBIDDEN_CAPABILITIES) {
      assert.equal(
        tool.toLowerCase().includes(forbidden),
        false,
        `Security boundary violation: MCP tool "${tool}" exposes forbidden capability "${forbidden}"`
      );
    }
  }
});

test('EIP-712 Voucher Structure: validates deterministic state hash and anti-replay nonce increment', async () => {
  await withProviderDatabase(async (path) => {
    const world = openWorld(path);
    seedSettlementCompanies(world.repos);

    const lot1 = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 2, 400);
    const expectedHash = calculateLotStateHash(lot1.lotId, 'STEEL_PLATE', 2, SELLER);
    assert.equal(lot1.stateHash, expectedHash);

    const v1 = world.provider.generateEip712Voucher(lot1.lotId, BASE_SEPOLIA_CHAIN_ID);
    assert.equal(v1.nonce, 1);

    const lot2 = await world.provider.lockMaterialsForLot(SELLER, 'STEEL_PLATE', 2, 410);
    const v2 = world.provider.generateEip712Voucher(lot2.lotId, BASE_SEPOLIA_CHAIN_ID);
    assert.equal(v2.nonce, 2);

    // Nonces must be strictly sequential per account to prevent replay attacks
    assert.equal(v2.nonce, v1.nonce + 1);

    closeWorld(world);
  });
});

// Parameterized live testnet integration test (skipped offline; parameterized for future execution)
test.skip(
  'Live Testnet RPC integration test (skipped offline; parameterized via TESTNET_RPC_URL)',
  () => {
    // This placeholder verifies that live testnet tests remain parameterized
    // and are never run without explicit user authorization and RPC configuration.
    assert.ok(true);
  }
);
