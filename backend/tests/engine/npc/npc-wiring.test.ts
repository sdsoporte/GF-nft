/**
 * Issue #55: the NPC policies delivered in #13 must run inside the
 * authoritative tick loop itself. Before this wiring, `NpcController` existed
 * only as a manually driven test component: real matches never invoked it, so
 * NPCs never acted.
 *
 * These tests drive the engine exclusively through `processTick` — no manual
 * controller — and assert NPC market activity, determinism across seeds/runs,
 * and that checkpoint rollback + replay neither duplicates nor changes NPC
 * outcomes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SimulatorEngine } from '../../../src/engine/SimulatorEngine.ts';
import { FactoryMatch } from '../../../src/match.ts';
import type { SupplyContract } from '../../../src/domain/types.ts';
import { withMatchStore } from '../../persistence/queue-fixtures.ts';

function npcCompanyIds(engine: SimulatorEngine): string[] {
  return engine.getAllCompanies().filter((company) => company.isNPC).map((company) => company.companyId);
}

function pendingNpcOffers(engine: SimulatorEngine): SupplyContract[] {
  const npc = new Set(npcCompanyIds(engine));
  return engine.getAllContracts().filter(
    (contract) => contract.status === 'PENDING' && npc.has(contract.sellerCompanyId),
  );
}

test('a standard match drives NPC offers automatically through advanceTicks (issue #55)', () => {
  withMatchStore((store) => {
    const match = new FactoryMatch({ store, matchId: 'match_npc_wiring' });
    assert.ok(npcCompanyIds(match.engine).length >= 2, 'standard match seeds NPC companies');

    match.advanceTicks(60);

    const offers = pendingNpcOffers(match.engine);
    assert.ok(
      offers.length >= 2,
      `expected at least two NPC offers after 60 ticks, saw ${offers.length}`,
    );
    for (const offer of offers) {
      assert.equal(offer.buyerCompanyId, '', 'an unaccepted offer has no buyer');
      assert.ok(offer.deadlineTick > match.engine.getCurrentTick(), 'visible offers are not expired');
    }
  });
});

test('NPC wiring is deterministic: same seed, same offers (issue #55)', () => {
  const run = (): Array<[string, string, number, number]> => {
    let result: Array<[string, string, number, number]> = [];
    withMatchStore((store) => {
      const match = new FactoryMatch({ store, matchId: 'match_npc_determinism' });
      match.advanceTicks(60);
      result = pendingNpcOffers(match.engine).map((offer) => [
        offer.sellerCompanyId, offer.itemId, offer.unitPriceCredits, offer.totalQuantity,
      ]);
    });
    return result;
  };
  const first = run();
  const second = run();
  assert.deepEqual(second, first, 'identical seeds must produce identical NPC offers');
});

test('checkpoint rollback does not duplicate or alter NPC outcomes (issue #55)', () => {
  const engine = new SimulatorEngine(1001);
  engine.initializeStandardMatch();
  for (let tick = 0; tick < 20; tick += 1) engine.processTick();
  const offersAtCheckpoint = pendingNpcOffers(engine).map((offer) => [offer.contractId, offer.unitPriceCredits]);
  const checkpoint = engine.createCheckpoint();

  for (let tick = 0; tick < 20; tick += 1) engine.processTick();
  const offersAfterRollbackTarget = pendingNpcOffers(engine).map((offer) => [
    offer.contractId, offer.sellerCompanyId, offer.itemId, offer.unitPriceCredits, offer.totalQuantity, offer.createdAtTick,
  ]);
  engine.restoreCheckpoint(checkpoint);
  // Rollback rewinds to the checkpoint state exactly: offers created before it
  // remain, offers created after it vanish, no duplicates.
  assert.deepEqual(
    pendingNpcOffers(engine).map((offer) => [offer.contractId, offer.unitPriceCredits]),
    offersAtCheckpoint,
    'rollback rewinds NPC-created offers to the checkpoint state',
  );

  for (let tick = 0; tick < 20; tick += 1) engine.processTick();
  const offersReplayed = pendingNpcOffers(engine).map((offer) => [
    offer.contractId, offer.sellerCompanyId, offer.itemId, offer.unitPriceCredits, offer.totalQuantity, offer.createdAtTick,
  ]);
  assert.deepEqual(
    offersReplayed,
    offersAfterRollbackTarget,
    'replayed ticks reproduce the same NPC offers the discarded run produced',
  );
});
