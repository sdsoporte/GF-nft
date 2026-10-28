/**
 * Transactional repositories (S2): every entity named by issue #8 writes and
 * reads back through SQLite without losing a column.
 *
 * Each case is a write -> read -> deep-equal round trip (or a filtered list),
 * because S2 is satisfied by repositories that can also feed T4's exact
 * hydration, not just by tables that happen to exist.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ITEM_IDS } from '../../src/persistence/rows.ts';
import { hashMcpToken } from '../../src/mcp/credentials.ts';
import {
  COMPANY_FACTORY,
  COMPANY_METAL,
  companyColumns,
  fullInventory,
  sampleAudit,
  sampleCompanyState,
  sampleContract,
  sampleEscrow,
  sampleGrant,
  sampleLine,
  sampleLot,
  sampleStoredGrant,
  seedCompanies,
  seedLotPair,
  withRepositories,
} from './repos-fixtures.ts';

// --- companies + inventory + lines (the aggregate T4 hydrates) ---------------

test('a company aggregate round-trips its rows, inventory and production lines', () => {
  withRepositories((repos) => {
    const state = sampleCompanyState();
    repos.saveCompanyState(state);

    assert.equal(repos.companies.exists(COMPANY_METAL), true);
    assert.deepEqual(repos.loadCompanyState(COMPANY_METAL), state);
    assert.deepEqual(repos.loadCompanyState('comp_missing'), null);
    assert.deepEqual(repos.companies.load('comp_missing'), null);
    assert.deepEqual(repos.loadCompanyState(COMPANY_FACTORY), null);
  });
});

test('companies.save keeps the original created_at_utc and stores maintenance_paid_ticks', () => {
  withRepositories((repos) => {
    repos.saveCompanyState(sampleCompanyState());

    repos.companies.save({
      ...companyColumns(),
      credits: 4321,
      energy: 77,
      installedTurbinesR7: 3,
      contributedMegamachinePartsR8: 2,
      reputation: 130,
      maintenancePaidTicks: 42,
      createdAtUtc: '2030-01-01T00:00:00.000Z',
      updatedAtUtc: '2026-01-02T00:00:00.000Z',
    });

    const record = repos.companies.load(COMPANY_METAL);
    assert.equal(record?.credits, 4321);
    assert.equal(record?.energy, 77);
    assert.equal(record?.installedTurbinesR7, 3);
    assert.equal(record?.contributedMegamachinePartsR8, 2);
    assert.equal(record?.reputation, 130);
    assert.equal(record?.maintenancePaidTicks, 42);
    assert.equal(record?.createdAtUtc, '2026-01-01T00:00:00.000Z');
    assert.equal(record?.updatedAtUtc, '2026-01-02T00:00:00.000Z');
    assert.equal(record?.name, 'Metal One');
    assert.equal(record?.isNPC, false);
    assert.equal(record?.industrialClass, 'CLASS_A_METALLURGY');
  });
});

test('companies.loadAll returns every company ordered by id', () => {
  withRepositories((repos) => {
    seedCompanies(repos);
    assert.deepEqual(
      repos.companies.loadAll().map((company) => company.companyId),
      [COMPANY_FACTORY, COMPANY_METAL],
    );
  });
});

test('inventory round-trips available and reserved quantities per item', () => {
  withRepositories((repos) => {
    repos.companies.save(companyColumns());
    const inventory = fullInventory({
      RAW_ORE: { available: 120, reserved: 20 },
      MEGAMACHINE_PART: { available: 3, reserved: 1 },
    });
    repos.inventory.save(COMPANY_METAL, inventory);

    assert.deepEqual(repos.inventory.load(COMPANY_METAL), inventory);
    assert.deepEqual(repos.inventory.loadStock(COMPANY_METAL, 'RAW_ORE'), {
      available: 120,
      reserved: 20,
    });
  });
});

test('inventory.load reports zero balances for a company with no rows', () => {
  withRepositories((repos) => {
    repos.companies.save(companyColumns());
    const empty = repos.inventory.load(COMPANY_METAL);
    assert.deepEqual(Object.keys(empty).sort(), [...ITEM_IDS].sort());
    for (const itemId of ITEM_IDS) {
      assert.deepEqual(empty[itemId], { available: 0, reserved: 0 });
    }
  });
});

test('production lines round-trip activeBatch and remove stale rows on replace', () => {
  withRepositories((repos) => {
    repos.saveCompanyState(sampleCompanyState());

    assert.deepEqual(
      repos.lines.listForCompany(COMPANY_METAL).map((line) => line.lineId),
      ['line_1', 'line_2'],
    );
    assert.deepEqual(repos.lines.load('line_1'), sampleLine());

    repos.lines.saveMany(COMPANY_METAL, [
      sampleLine({ lineId: 'line_3', activeBatch: null, currentRecipeId: null, status: 'PAUSED' }),
    ]);

    assert.deepEqual(
      repos.lines.listForCompany(COMPANY_METAL).map((line) => line.lineId),
      ['line_3'],
    );
    assert.deepEqual(repos.lines.load('line_1'), null);
    assert.deepEqual(repos.lines.listForCompany(COMPANY_FACTORY), []);
  });
});

// --- contracts, lots, escrows, reservations ----------------------------------

test('supply contracts round-trip with and without a settlement tick', () => {
  withRepositories((repos) => {
    seedCompanies(repos);

    const active = sampleContract();
    const settled = sampleContract({
      contractId: 'contract_2',
      status: 'FULFILLED',
      deliveredQuantity: 10,
      settledAtTick: 33,
    });
    repos.contracts.save(active);
    repos.contracts.save(settled);

    assert.deepEqual(repos.contracts.load('contract_1'), active);
    assert.deepEqual(repos.contracts.load('contract_2'), settled);
    assert.deepEqual(repos.contracts.load('contract_missing'), null);
    assert.deepEqual(
      repos.contracts.list().map((contract) => contract.contractId),
      ['contract_1', 'contract_2'],
    );
    assert.deepEqual(
      repos.contracts.list({ status: 'FULFILLED' }).map((contract) => contract.contractId),
      ['contract_2'],
    );
  });
});

test('commodity lots round-trip every column and filter by holder', () => {
  withRepositories((repos) => {
    seedCompanies(repos);
    seedLotPair(repos);
    const held = sampleLot({
      lotId: 'lot_2',
      reservationId: 'res_2',
      currentHolderCompanyId: COMPANY_FACTORY,
      status: 'SETTLED_PENDING_CLAIM',
      settledAtTick: 21,
    });
    repos.reservations.reserve({
      reservationId: 'res_2',
      lotId: 'lot_2',
      companyId: COMPANY_METAL,
      itemId: 'STEEL_PLATE',
      quantity: 1,
      createdAtTick: 20,
    });
    repos.lots.save(held);

    assert.deepEqual(repos.lots.load('lot_1'), sampleLot());
    assert.deepEqual(repos.lots.load('lot_2'), held);
    assert.deepEqual(repos.lots.load('lot_missing'), null);
    assert.deepEqual(
      repos.lots.list({ holderCompanyId: COMPANY_FACTORY }).map((lot) => lot.lotId),
      ['lot_2'],
    );
    assert.deepEqual(
      repos.lots.list({ status: 'RESERVED_OFF_CHAIN' }).map((lot) => lot.lotId),
      ['lot_1'],
    );

    repos.lots.setStatus('lot_1', 'TOKENIZED_RECEIPT');
    assert.equal(repos.lots.load('lot_1')?.status, 'TOKENIZED_RECEIPT');
    repos.lots.setStatus('lot_1', 'CONSUMED_UNPACKED', 44);
    assert.deepEqual(repos.lots.load('lot_1'), {
      ...sampleLot(),
      status: 'CONSUMED_UNPACKED',
      settledAtTick: 44,
    });
  });
});

test('trade escrows round-trip every column and filter by state', () => {
  withRepositories((repos) => {
    seedCompanies(repos);
    seedLotPair(repos);

    const locked = sampleEscrow();
    const released = sampleEscrow({
      escrowId: 'esc_2',
      settlementState: 'RELEASED_TO_BUYER',
      externalTxHash: '0xabc',
      settledAtTick: 61,
    });
    repos.escrows.save(locked);
    repos.escrows.save(released);

    assert.deepEqual(repos.escrows.load('esc_1'), locked);
    assert.deepEqual(repos.escrows.load('esc_2'), released);
    assert.deepEqual(repos.escrows.load('esc_missing'), null);
    assert.deepEqual(
      repos.escrows.list({ settlementState: 'LOCKED' }).map((escrow) => escrow.escrowId),
      ['esc_1'],
    );
    assert.deepEqual(
      repos.escrows.list({ lotId: 'lot_1' }).map((escrow) => escrow.escrowId),
      ['esc_1', 'esc_2'],
    );

    repos.escrows.setState('esc_1', 'REFUNDED', 70);
    assert.deepEqual(repos.escrows.load('esc_1'), {
      ...sampleEscrow(),
      settlementState: 'REFUNDED',
      settledAtTick: 70,
    });
  });
});

test('a reservation moves stock from available to reserved and round-trips', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);

    const reservation = repos.reservations.reserve({
      reservationId: 'res_1',
      lotId: 'lot_1',
      companyId: COMPANY_METAL,
      itemId: 'STEEL_PLATE',
      quantity: 5,
      createdAtTick: 10,
    });
    assert.deepEqual(reservation, {
      reservationId: 'res_1',
      companyId: COMPANY_METAL,
      itemId: 'STEEL_PLATE',
      quantity: 5,
      lotId: 'lot_1',
      status: 'ACTIVE',
      createdAtTick: 10,
    });
    assert.deepEqual(repos.inventory.loadStock(COMPANY_METAL, 'STEEL_PLATE'), {
      available: 3,
      reserved: 5,
    });
    assert.equal(
      database
        .query<{ updated_at_tick: number }>(
          'SELECT updated_at_tick FROM inventories WHERE company_id = ? AND item_id = ?',
        )
        .get(COMPANY_METAL, 'STEEL_PLATE')?.updated_at_tick,
      10,
    );
    assert.deepEqual(repos.reservations.load('res_1'), reservation);
    assert.deepEqual(repos.reservations.loadByLot('lot_1'), reservation);
    assert.deepEqual(repos.reservations.load('res_missing'), null);
    assert.deepEqual(
      repos.reservations.list({ companyId: COMPANY_METAL }).map((row) => row.reservationId),
      ['res_1'],
    );

    const released = repos.reservations.release({
      reservationId: 'res_1',
      status: 'REVERTED',
      atTick: 25,
    });
    assert.equal(released.status, 'REVERTED');
    assert.deepEqual(repos.inventory.loadStock(COMPANY_METAL, 'STEEL_PLATE'), {
      available: 8,
      reserved: 0,
    });
    assert.equal(
      database
        .query<{ updated_at_tick: number }>(
          'SELECT updated_at_tick FROM inventories WHERE company_id = ? AND item_id = ?',
        )
        .get(COMPANY_METAL, 'STEEL_PLATE')?.updated_at_tick,
      25,
    );
  });
});

test('releasing an unpacked reservation credits the recipient company', () => {
  withRepositories((repos) => {
    seedCompanies(repos);
    repos.reservations.reserve({
      reservationId: 'res_1',
      lotId: 'lot_1',
      companyId: COMPANY_METAL,
      itemId: 'STEEL_PLATE',
      quantity: 5,
      createdAtTick: 10,
    });

    const released = repos.reservations.release({
      reservationId: 'res_1',
      status: 'UNPACKED',
      recipientCompanyId: COMPANY_FACTORY,
    });

    assert.equal(released.status, 'UNPACKED');
    assert.deepEqual(repos.inventory.loadStock(COMPANY_METAL, 'STEEL_PLATE'), {
      available: 3,
      reserved: 0,
    });
    assert.deepEqual(repos.inventory.loadStock(COMPANY_FACTORY, 'STEEL_PLATE'), {
      available: 7,
      reserved: 0,
    });
  });
});

// --- MCP grants + audit logs (A5: repository layer only) ---------------------

test('mcp grants round-trip scopes, allowlist and quotas, and revoke in place', () => {
  withRepositories((repos) => {
    seedCompanies(repos);

    const grant = sampleGrant();
    repos.grants.save(grant);
    const stored = repos.grants.load('grant_1');
    assert.deepEqual(stored, sampleStoredGrant());
    assert.equal(stored?.tokenHash, hashMcpToken('gf_mcp_token_1'));
    assert.equal(JSON.stringify(stored).includes(grant.token), false);
    assert.deepEqual(
      repos.grants.loadByTokenHash(hashMcpToken('gf_mcp_token_1')),
      sampleStoredGrant(),
    );
    assert.deepEqual(repos.grants.loadByTokenHash(hashMcpToken('gf_mcp_token_2')), null);
    assert.deepEqual(repos.grants.load('grant_missing'), null);

    // The hash column refuses anything that is not a sha256 digest.
    assert.throws(
      () =>
        repos.grants.saveStored({ ...sampleStoredGrant(), grantId: 'grant_plain', tokenHash: 'gf_mcp_token_9' }),
      /sha256 hex digest/,
    );
    assert.deepEqual(repos.grants.load('grant_plain'), null);

    repos.grants.save(
      sampleGrant({
        scopes: ['inventory:read'],
        resourceAllowlist: ['line_9'],
        quotas: { maxReadPerMinute: 10, maxWritePerMinute: 1, maxWritePerMatch: 2 },
        revoked: true,
      }),
    );
    const updated = repos.grants.load('grant_1');
    assert.deepEqual(updated?.scopes, ['inventory:read']);
    assert.deepEqual(updated?.resourceAllowlist, ['line_9']);
    assert.deepEqual(updated?.quotas, {
      maxReadPerMinute: 10,
      maxWritePerMinute: 1,
      maxWritePerMatch: 2,
    });
    assert.equal(updated?.revoked, true);

    const second = sampleGrant({
      grantId: 'grant_2',
      token: 'gf_mcp_token_2',
      matchId: 'match_other',
      revoked: false,
    });
    repos.grants.save(second);
    assert.deepEqual(
      repos.grants.list({ matchId: 'match_other' }).map((row) => row.grantId),
      ['grant_2'],
    );
    assert.deepEqual(
      repos.grants.list().map((row) => row.grantId),
      ['grant_1', 'grant_2'],
    );
    // No read API can hand back the plaintext secret that seeded the row.
    for (const token of ['gf_mcp_token_1', 'gf_mcp_token_2']) {
      assert.equal(JSON.stringify(repos.grants.list()).includes(token), false);
    }

    repos.grants.revoke('grant_2');
    assert.equal(repos.grants.load('grant_2')?.revoked, true);
    assert.deepEqual(
      repos.grants.list({ revoked: false }).map((row) => row.grantId),
      [],
    );
    assert.deepEqual(
      repos.grants.list({ revoked: true }).map((row) => row.grantId),
      ['grant_1', 'grant_2'],
    );
  });
});

test('mcp audit logs append and read back in timestamp order', () => {
  withRepositories((repos) => {
    seedCompanies(repos);
    repos.grants.save(sampleGrant());

    repos.grants.appendAudit(
      sampleAudit({ id: 'audit_2', timestampUtc: '2026-01-01T00:02:00.000Z', tick: 6 }),
    );
    repos.grants.appendAudit(sampleAudit());
    repos.grants.appendAudit(
      sampleAudit({
        id: 'audit_3',
        timestampUtc: '2026-01-01T00:03:00.000Z',
        grantId: 'grant_other',
        idempotencyKey: 'http:match_test:req-1',
        resultCode: 'ERR_SCOPE_UNAUTHORIZED',
      }),
    );

    assert.deepEqual(
      repos.grants.listAudit().map((entry) => entry.id),
      ['audit_1', 'audit_2', 'audit_3'],
    );
    assert.deepEqual(repos.grants.listAudit()[0], sampleAudit());
    assert.equal(repos.grants.listAudit()[0].idempotencyKey, undefined);
    assert.deepEqual(
      repos.grants.listAudit({ grantId: 'grant_1' }).map((entry) => entry.id),
      ['audit_1', 'audit_2'],
    );
    assert.deepEqual(
      repos.grants.listAudit({ tick: 6 }).map((entry) => entry.id),
      ['audit_2'],
    );
  });
});
