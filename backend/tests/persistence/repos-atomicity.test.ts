/**
 * S7 — reservas, pagos y entregas son transacciones ACID.
 *
 * Each case commits a multi-row operation atomically and then induces a failure
 * in the middle of it, asserting that *every* tracked table is byte-identical
 * afterwards (no partial credit debit, no orphan reservation, no half-written
 * lot/escrow state).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { LinePriority } from '../../src/domain/types.ts';
import { withTransaction } from '../../src/persistence/database.ts';
import { runAtomic } from '../../src/persistence/transaction.ts';
import {
  COMPANY_METAL,
  JOURNAL_MATCH_ID,
  countRows,
  fullInventory,
  sampleCompanyState,
  sampleContract,
  sampleCreditMovement,
  sampleCreditOpening,
  sampleEscrow,
  sampleLine,
  sampleLot,
  seedCompanies,
  seedJournalMatch,
  seedLotPair,
  snapshotState,
  withRepositories,
} from './repos-fixtures.ts';

test('a failing line inside saveCompanyState rolls back the company, inventory and line rows', () => {
  withRepositories((repos, database) => {
    repos.saveCompanyState(sampleCompanyState());
    const before = snapshotState(database);

    const brokenLine = {
      ...sampleLine({ lineId: 'line_broken' }),
      priority: 4 as unknown as LinePriority,
    };

    assert.throws(
      () =>
        repos.saveCompanyState(
          sampleCompanyState({
            credits: 1,
            inventory: fullInventory({ RAW_ORE: { available: 999, reserved: 0 } }),
            lines: [sampleLine({ lineId: 'line_new' }), brokenLine],
          }),
        ),
      /CHECK/,
    );

    assert.deepEqual(snapshotState(database), before);
  });
});

test('two reservations composed in one unit of work roll back together', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    const before = snapshotState(database);

    assert.throws(
      () =>
        runAtomic(database, () => {
          repos.reservations.reserve({
            reservationId: 'res_1',
            lotId: 'lot_1',
            companyId: COMPANY_METAL,
            itemId: 'STEEL_PLATE',
            quantity: 2,
            createdAtTick: 10,
          });
          repos.reservations.reserve({
            reservationId: 'res_2',
            lotId: 'lot_2',
            companyId: COMPANY_METAL,
            itemId: 'STEEL_PLATE',
            quantity: 2,
            createdAtTick: 10,
          });
          // Third reservation reuses a lot id: the unique index rejects it after
          // both inventory moves already happened.
          repos.reservations.reserve({
            reservationId: 'res_3',
            lotId: 'lot_2',
            companyId: COMPANY_METAL,
            itemId: 'STEEL_PLATE',
            quantity: 2,
            createdAtTick: 10,
          });
        }),
      /UNIQUE/,
    );

    assert.deepEqual(snapshotState(database), before);
    assert.equal(countRows(database, 'inventory_reservations'), 0);
    assert.deepEqual(repos.inventory.loadStock(COMPANY_METAL, 'STEEL_PLATE'), {
      available: 8,
      reserved: 0,
    });
  });
});

test('an escrow settlement split across lot and escrow rows rolls back as a unit', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    seedLotPair(repos);
    repos.escrows.save(sampleEscrow());
    const before = snapshotState(database);

    assert.throws(
      () =>
        runAtomic(database, () => {
          repos.lots.setStatus('lot_1', 'SETTLED_PENDING_CLAIM');
          repos.escrows.setState('esc_1', 'RELEASED_TO_BUYER', 30);
          throw new Error('induced delivery failure');
        }),
      /induced delivery failure/,
    );

    assert.deepEqual(snapshotState(database), before);
    assert.equal(repos.lots.load('lot_1')?.status, 'RESERVED_OFF_CHAIN');
    assert.equal(repos.escrows.load('esc_1')?.settlementState, 'LOCKED');
  });
});

test('a credits debit and its escrow movement commit or roll back together', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    seedLotPair(repos);
    repos.escrows.save(sampleEscrow());
    const before = snapshotState(database);
    const creditsBefore = repos.companies.load(COMPANY_METAL)?.credits;

    assert.throws(
      () =>
        runAtomic(database, () => {
          database
            .query('UPDATE companies SET credits = credits - 600 WHERE company_id = ?')
            .run(COMPANY_METAL);
          // A zero price violates the escrow CHECK after the balance moved.
          repos.escrows.save(sampleEscrow({ escrowId: 'esc_2', agreedPriceAmount: 0 }));
        }),
      /CHECK/,
    );

    assert.deepEqual(snapshotState(database), before);
    assert.equal(repos.companies.load(COMPANY_METAL)?.credits, creditsBefore);
  });
});

test('a contract write and its lot transition commit atomically on success', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    seedLotPair(repos);
    const contractsBefore = countRows(database, 'b2b_contracts');

    runAtomic(database, () => {
      repos.lots.setStatus('lot_1', 'IN_ESCROW');
      repos.contracts.save(sampleContract());
    });

    assert.equal(countRows(database, 'b2b_contracts'), contractsBefore + 1);
    assert.equal(repos.lots.load('lot_1')?.status, 'IN_ESCROW');
    assert.deepEqual(repos.contracts.load('contract_1'), sampleContract());
  });
});

test('a failure after a successful inner savepoint undoes the whole outer transaction', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    const before = snapshotState(database);

    assert.throws(
      () =>
        withTransaction(database, () => {
          runAtomic(database, () => {
            repos.reservations.reserve({
              reservationId: 'res_outer',
              lotId: 'lot_1',
              companyId: COMPANY_METAL,
              itemId: 'STEEL_PLATE',
              quantity: 1,
              createdAtTick: 10,
            });
          });
          repos.lots.save(sampleLot({ reservationId: 'res_outer' }));
          throw new Error('outer failure after inner commit');
        }),
      /outer failure after inner commit/,
    );

    assert.deepEqual(snapshotState(database), before);
  });
});

test('a journal opening and its movements roll back with the surrounding unit of work', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    seedJournalMatch(repos, 10);
    const before = snapshotState(database);

    assert.throws(
      () =>
        runAtomic(database, () => {
          repos.creditJournal.createOpening(sampleCreditOpening());
          repos.creditJournal.append(JOURNAL_MATCH_ID, [
            sampleCreditMovement({ sequence: 1, eventKey: 'evt_atomic', tick: 5 }),
            sampleCreditMovement({ sequence: 2, eventKey: 'evt_atomic', tick: 6 }),
          ]);
        }),
      /DUPLICATE_EVENT_KEY/,
    );

    assert.deepEqual(snapshotState(database), before);
    assert.equal(countRows(database, 'credit_ledger_openings'), 0);
    assert.equal(countRows(database, 'credit_ledger_opening_balances'), 0);
    assert.equal(countRows(database, 'credit_ledger_movements'), 0);
  });
});

test('runAtomic reuses the open transaction instead of failing on a nested begin', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);

    runAtomic(database, () => {
      assert.equal(database.inTransaction, true);
      runAtomic(database, () => {
        repos.reservations.reserve({
          reservationId: 'res_1',
          lotId: 'lot_1',
          companyId: COMPANY_METAL,
          itemId: 'STEEL_PLATE',
          quantity: 1,
          createdAtTick: 10,
        });
      });
    });

    assert.equal(countRows(database, 'inventory_reservations'), 1);
    assert.equal(database.inTransaction, false);
  });
});
