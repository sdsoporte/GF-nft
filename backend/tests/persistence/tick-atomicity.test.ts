/**
 * Failed-tick atomicity and deterministic retry (S4, risk item 4).
 *
 * `FactoryMatch.advanceTicks` mutates the engine first and persists the tick
 * second. The database side is already atomic (`commitExecutions` +
 * `persistEngineSnapshot` inside one `runAtomic`), but until U10A the engine
 * itself had no rollback: when the durable write threw, the in-memory match kept
 * the advanced tick, the dequeued command, the debited credits and the
 * half-applied contract, so the retry ran against a state the database had
 * refused.
 *
 * These tests drive the real public path — `FactoryMatch` + `advanceTicks` on a
 * disposable SQLite database — and inject a genuine transaction failure with a
 * temporary SQLite trigger, so the failure is the same class of event a
 * constraint, a disk or a trigger would produce. Every assertion reads public
 * API or repository rows; no engine private map is touched.
 *
 * Comparable state comes from the existing recovery oracle
 * (`recovery-oracle.ts`): tick, PRNG, companies/lines/inventory, contracts,
 * queue + permanent dedupe + sequence counter, execution history, and the stored
 * `matches` counters and row counts. Comparing that JSON before and after the
 * failed tick is what proves nothing moved.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from 'bun:sqlite';

import { Mulberry32PRNG, SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import { NpcController } from '../../src/engine/npc/NpcController.ts';
import { DEFAULT_MATCH_SEED, FactoryMatch } from '../../src/match.ts';
import type { MatchStore } from '../../src/persistence/matchStore.ts';
import type { CommandExecutionResult, EnqueueCommandInput } from '../../src/domain/types.ts';
import { snapshotState } from './repos-fixtures.ts';
import { MATCH_ID, productionPayload, withMatchStore } from './queue-fixtures.ts';
import { admitThroughStore } from './recovery-fixtures.ts';
import { buildRecoveryOracle, canonicalJson } from './recovery-oracle.ts';

const SELLER = 'comp_metal_01';
const BUYER = 'comp_manuf_01';
const OTHER_BUYER = 'comp_manuf_02';
const FAULT_MESSAGE = 'gf-induced tick failure';

/** The NPC companies an authoritative match tick drives (issue #55). */
const NPC_COMPANY_IDS = new Set(new NpcController().getRegisteredCompanyIds());

/**
 * Issue #55: an NPC command id embeds the policy's own submission counter, so a
 * manually driven oracle that builds its controller late numbers the very same
 * commands differently. The parity comparison therefore keeps every other field
 * and collapses an NPC id to the tick it executed on; the engine snapshot stays
 * the byte-level oracle for the NPC state those commands produce.
 */
function normalizeNpcCommandIds(
  results: readonly CommandExecutionResult[],
): CommandExecutionResult[] {
  return results.map((result) =>
    result.companyId !== undefined && NPC_COMPANY_IDS.has(result.companyId)
      ? { ...result, commandId: `<npc@tick:${result.executedAtTick}>` }
      : result,
  );
}

interface Harness {
  readonly store: MatchStore;
  readonly database: Database;
  readonly match: FactoryMatch;
}

function withHarness(work: (harness: Harness) => void): void {
  withMatchStore((store, database) => {
    work({ store, database, match: new FactoryMatch({ store, matchId: MATCH_ID }) });
  });
}

/** Canonical, byte-comparable view of everything a tick can move. */
function stateOf(harness: Harness, observedCommandIds: readonly string[] = []): string {
  return canonicalJson({
    simulation: buildRecoveryOracle(harness.match, harness.store, observedCommandIds),
    stored: snapshotState(harness.database),
  });
}

/** Fail every execution-history insert of the next tick. */
function failResultInsert(database: Database, atTick?: number): void {
  database.exec(
    'CREATE TRIGGER gf_fail_result BEFORE INSERT ON match_command_results ' +
      (atTick === undefined ? '' : `WHEN NEW.executed_at_tick = ${atTick} `) +
      `BEGIN SELECT RAISE(ABORT, '${FAULT_MESSAGE}'); END;`,
  );
}

/** Fail the engine snapshot write that ends every tick, even a commandless one. */
function failSnapshotWrite(database: Database): void {
  database.exec(
    'CREATE TRIGGER gf_fail_snapshot BEFORE INSERT ON companies ' +
      `BEGIN SELECT RAISE(ABORT, '${FAULT_MESSAGE}'); END;`,
  );
}

function clearFaults(database: Database): void {
  database.exec('DROP TRIGGER IF EXISTS gf_fail_result');
  database.exec('DROP TRIGGER IF EXISTS gf_fail_snapshot');
}

let labelCounter = 0;

/** Admit an offer through the store seam and run the tick that publishes it. */
function createPendingOffer(
  harness: Harness,
  options: {
    readonly quantity?: number;
    readonly unitPrice?: number;
    readonly deadlineTicks?: number;
    readonly targetBuyerId?: string;
  } = {},
): string {
  labelCounter += 1;
  admitThroughStore(
    harness.match,
    harness.store,
    {
      commandId: `cmd_offer_${labelCounter}`,
      companyId: SELLER,
      scheduledTick: harness.match.engine.getCurrentTick() + 1,
      idempotencyKey: `engine:${MATCH_ID}:offer-${labelCounter}`,
      type: 'CREATE_SUPPLY_OFFER',
      targetBuyerId: options.targetBuyerId ?? '',
      itemId: 'IRON_INGOT',
      quantity: options.quantity ?? 10,
      unitPriceCredits: options.unitPrice ?? 10,
      deadlineTicks: options.deadlineTicks ?? 1000,
    },
    `offer-${labelCounter}`,
  );
  const before = harness.match.engine.getAllContracts().length;
  harness.match.advanceTicks(1);
  const contracts = harness.match.engine.getAllContracts();
  assert.equal(contracts.length, before + 1, 'the offer must exist after its tick');
  const created = contracts[contracts.length - 1];
  assert.ok(created, 'the created contract must be readable');
  return created.contractId;
}

/** Queue one accept for `buyerCompanyId` on the next tick. */
function admitAccept(
  harness: Harness,
  contractId: string,
  buyerCompanyId: string,
  scheduledTick: number,
  label: string,
): string {
  const commandId = `cmd_accept_${label}`;
  admitThroughStore(
    harness.match,
    harness.store,
    {
      commandId,
      companyId: buyerCompanyId,
      scheduledTick,
      idempotencyKey: `engine:${MATCH_ID}:accept-${label}`,
      type: 'ACCEPT_SUPPLY_OFFER',
      contractId,
    },
    `accept-${label}`,
  );
  return commandId;
}

function creditsOf(harness: Harness, companyId: string): number {
  const company = harness.match.engine.getCompany(companyId);
  assert.ok(company, `company ${companyId} must exist`);
  return company.credits;
}

test('a failed tick leaves the engine, the rows and the counters unchanged', () => {
  withHarness((harness) => {
    const contractId = createPendingOffer(harness);
    admitAccept(harness, contractId, BUYER, 2, 'atomic');

    failResultInsert(harness.database);
    const before = stateOf(harness);

    assert.throws(() => harness.match.advanceTicks(1), new RegExp(FAULT_MESSAGE));

    assert.equal(stateOf(harness), before, 'no observable state may move on a failed tick');
    const contract = harness.match.engine.getContract(contractId);
    assert.equal(contract?.status, 'PENDING', 'the refused acceptance must not activate the offer');
    assert.equal(creditsOf(harness, BUYER), 10000, 'buyer escrow must not be debited');
    assert.equal(creditsOf(harness, SELLER), 10000, 'seller collateral must not be debited');
    assert.equal(harness.match.engine.getCurrentTick(), 1, 'the failed tick must not advance the clock');
    assert.equal(harness.match.engine.getCommandQueue().getPendingCount(), 1);
    // Issue #55: the published offer and the three NPC opening production
    // targets of tick 1 stay committed; the refused acceptance adds nothing.
    assert.equal(harness.match.engine.getExecutionHistory().length, 4);
    assert.equal(harness.store.repositories.commandResults.count(MATCH_ID), 4);
    assert.equal(harness.store.repositories.queue.countPending(MATCH_ID), 1);
    assert.equal(harness.store.repositories.matches.load(MATCH_ID)?.currentTick, 1);
  });
});

test('the NPC dedupe keys of a failed tick roll back with its rows (issue #55)', () => {
  withHarness((harness) => {
    // Tick 1 is the first tick the NPC policies act on: they enqueue three
    // opening production targets whose permanent keys are written inside the
    // same unit of work as the tick. The snapshot fault is raised after those
    // rows exist, so this pins the ordering the durable-key write introduced.
    const before = stateOf(harness);
    failSnapshotWrite(harness.database);
    assert.throws(() => harness.match.advanceTicks(1), new RegExp(FAULT_MESSAGE));

    assert.equal(stateOf(harness), before, 'the failed tick leaves every row where it was');
    assert.equal(
      harness.store.repositories.queue.countProcessed(MATCH_ID),
      0,
      'no durable NPC key survives a refused tick',
    );
    assert.deepEqual(
      harness.match.engine.getCommandQueue().listProcessedIdempotencyKeys(),
      [],
      'no in-memory NPC key survives a refused tick',
    );

    // The retry commits the same three keys exactly once and they are durable.
    clearFaults(harness.database);
    harness.match.advanceTicks(1);
    assert.equal(harness.store.repositories.queue.countProcessed(MATCH_ID), 3);
    assert.equal(harness.match.engine.getCommandQueue().listProcessedIdempotencyKeys().length, 3);
    assert.equal(harness.store.repositories.commandResults.count(MATCH_ID), 3);
  });
});

test('a tick whose engine snapshot write fails rolls back like any other tick', () => {
  withHarness((harness) => {
    // No command executes this tick: the only durable writes are the match
    // counters and the engine snapshot, so the snapshot failure is the fault.
    harness.match.advanceTicks(1);
    const creditsBefore = creditsOf(harness, SELLER);
    const energyBefore = harness.match.engine.getCompany(SELLER)?.energy;
    const before = stateOf(harness);

    failSnapshotWrite(harness.database);
    assert.throws(() => harness.match.advanceTicks(1), new RegExp(FAULT_MESSAGE));

    assert.equal(stateOf(harness), before);
    assert.equal(harness.match.engine.getCurrentTick(), 1);
    assert.equal(creditsOf(harness, SELLER), creditsBefore);
    assert.equal(harness.match.engine.getCompany(SELLER)?.energy, energyBefore);
    assert.equal(harness.store.repositories.matches.load(MATCH_ID)?.currentTick, 1);
  });
});

test('retrying a failed tick commits exactly one acceptance and one escrow movement', () => {
  withHarness((harness) => {
    const contractId = createPendingOffer(harness);
    admitAccept(harness, contractId, BUYER, 2, 'retry');

    failResultInsert(harness.database);
    assert.throws(() => harness.match.advanceTicks(1), new RegExp(FAULT_MESSAGE));
    clearFaults(harness.database);

    harness.match.advanceTicks(1);

    const contract = harness.match.engine.getContract(contractId);
    assert.equal(contract?.status, 'ACTIVE');
    assert.equal(creditsOf(harness, BUYER), 9900, 'one escrow debit, not two');
    assert.equal(creditsOf(harness, SELLER), 9980, 'one collateral debit, not two');

    const history = harness.match.engine.getExecutionHistory();
    // Issue #55: tick 1 committed the offer plus three NPC production targets,
    // and the retried tick 2 adds exactly one human acceptance.
    assert.equal(history.length, 5, 'the retried tick executes its command once');
    const accepted = history.filter((result) => result.commandId.startsWith('cmd_accept_'));
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.success, true);
    assert.equal(harness.match.engine.getCurrentTick(), 2);
    assert.equal(harness.store.repositories.commandResults.count(MATCH_ID), 5);
    assert.equal(harness.store.repositories.queue.countPending(MATCH_ID), 0);
    assert.equal(harness.store.repositories.matches.load(MATCH_ID)?.currentTick, 2);

    // A further tick proves the retry neither replayed nor lost the movement.
    harness.match.advanceTicks(1);
    assert.equal(creditsOf(harness, BUYER), 9900);
    assert.equal(creditsOf(harness, SELLER), 9980);
    assert.equal(harness.match.engine.getExecutionHistory().length, 5);
  });
});

test('two competing accepts in a failed tick still commit exactly one acceptance', () => {
  withHarness((harness) => {
    const contractId = createPendingOffer(harness);
    admitAccept(harness, contractId, BUYER, 2, 'first');
    admitAccept(harness, contractId, OTHER_BUYER, 2, 'second');
    const before = stateOf(harness);

    failResultInsert(harness.database);
    assert.throws(() => harness.match.advanceTicks(1), new RegExp(FAULT_MESSAGE));
    assert.equal(stateOf(harness), before, 'both queued accepts must survive the failed tick');
    clearFaults(harness.database);

    harness.match.advanceTicks(1);

    const accepted = harness
      .match.engine.getExecutionHistory()
      .filter((result) => result.commandId.startsWith('cmd_accept_'));
    assert.equal(accepted.length, 2, 'both admissions are executed by the retried tick');
    assert.equal(accepted.filter((result) => result.success).length, 1, 'only one accept wins');
    assert.equal(
      accepted.filter((result) => result.errorCode === 'ERR_OFFER_NOT_AVAILABLE').length,
      1,
    );

    const contract = harness.match.engine.getContract(contractId);
    assert.equal(contract?.status, 'ACTIVE');
    const winningBuyer = contract?.buyerCompanyId;
    assert.ok(winningBuyer === BUYER || winningBuyer === OTHER_BUYER);
    const losingBuyer = winningBuyer === BUYER ? OTHER_BUYER : BUYER;
    assert.equal(creditsOf(harness, winningBuyer), 9900, 'the winner pays the escrow once');
    assert.equal(creditsOf(harness, losingBuyer), 10000, 'the loser never pays');
    assert.equal(creditsOf(harness, SELLER), 9980, 'the seller locks collateral once');
  });
});

test('a failed contract creation does not skip contract ids on retry', () => {
  withHarness((harness) => {
    // Tick 1 creates the first contract; the tick fails after the engine already
    // consumed contract id 1.
    labelCounter += 1;
    admitThroughStore(
      harness.match,
      harness.store,
      {
        commandId: `cmd_offer_${labelCounter}`,
        companyId: SELLER,
        scheduledTick: 1,
        idempotencyKey: `engine:${MATCH_ID}:offer-${labelCounter}`,
        type: 'CREATE_SUPPLY_OFFER',
        targetBuyerId: '',
        itemId: 'IRON_INGOT',
        quantity: 10,
        unitPriceCredits: 10,
        deadlineTicks: 1000,
      },
      `offer-${labelCounter}`,
    );

    failResultInsert(harness.database);
    assert.throws(() => harness.match.advanceTicks(1), new RegExp(FAULT_MESSAGE));
    assert.equal(harness.match.engine.getAllContracts().length, 0, 'the refused creation is undone');
    clearFaults(harness.database);

    harness.match.advanceTicks(1);
    const contracts = harness.match.engine.getAllContracts();
    assert.equal(contracts.length, 1);
    assert.equal(contracts[0]?.contractId, 'cnt_1_1', 'the retried creation reuses contract id 1');

    // A later creation must continue from 2, not from a skipped 2 or 3.
    const second = createPendingOffer(harness);
    assert.equal(second, 'cnt_2_2');
  });
});

test('a multi-tick call keeps the earlier committed ticks when a later tick fails', () => {
  withHarness((harness) => {
    const first = harness.match.requestProduction(productionPayload({ requestId: 'multi-1' }));
    assert.equal(first.kind, 'queued');
    if (first.kind !== 'queued') return;

    // Trusted store admission supports future ticks. The MCP seam deliberately
    // overwrites a caller tick, so using it here would schedule both at tick 1.
    const second = admitThroughStore(
      harness.match,
      harness.store,
      {
        commandId: 'cmd_multi_second',
        companyId: SELLER,
        scheduledTick: 2,
        idempotencyKey: `engine:${MATCH_ID}:multi-second`,
        type: 'SET_LINE_PRIORITY',
        lineId: 'comp_metal_01_line_1',
        priority: 3,
      },
      'multi-second',
    );
    const active = {
      ...harness,
      match: new FactoryMatch({ store: harness.store, matchId: MATCH_ID }),
    };

    failResultInsert(harness.database, 2);
    assert.throws(() => active.match.advanceTicks(2), new RegExp(FAULT_MESSAGE));

    assert.equal(active.match.engine.getCurrentTick(), 1, 'only the failed tick is rolled back');
    assert.equal(harness.store.repositories.matches.load(MATCH_ID)?.currentTick, 1);
    // Issue #55: the committed tick 1 ran the human command plus the three NPC
    // opening production targets, so four rows survive the failed tick 2.
    assert.equal(harness.store.repositories.commandResults.count(MATCH_ID), 4);
    const history = active.match.engine.getExecutionHistory();
    assert.equal(history.length, 4);
    const committed = history.filter((result) => result.commandId === first.commandId);
    assert.equal(committed.length, 1, 'tick 1 stays committed');
    assert.equal(committed[0]?.executedAtTick, 1);

    const pending = active.match.engine.getCommandQueue().listPending();
    assert.deepEqual(
      pending.map((command) => command.commandId),
      [second],
      'the failed tick puts its command back at the head of the queue',
    );
    assert.equal(active.match.getCommandStatus(second)?.status, 'queued');
    assert.equal(
      active.match.engine.getCompany(SELLER)?.lines.find((line) => line.lineId === 'comp_metal_01_line_1')
        ?.priority,
      1,
      'the rolled-back priority change is undone',
    );

    clearFaults(harness.database);
    active.match.advanceTicks(1);
    assert.equal(active.match.engine.getCurrentTick(), 2);
    assert.equal(active.match.getCommandStatus(second)?.status, 'executed');
    assert.equal(
      active.match.engine.getCompany(SELLER)?.lines.find((line) => line.lineId === 'comp_metal_01_line_1')
        ?.priority,
      3,
    );
  });
});

test('the public engine checkpoint is a detached deep copy', () => {
  const engine = new SimulatorEngine(42107);
  engine.initializeStandardMatch();
  engine.processTick();
  const checkpoint = engine.createCheckpoint();

  // Engine -> checkpoint: later ticks and admissions must not rewrite it.
  engine.processTick();
  engine.submitCommand({
    commandId: 'cmd_after_checkpoint',
    companyId: SELLER,
    scheduledTick: engine.getCurrentTick() + 1,
    idempotencyKey: 'engine:after-checkpoint',
    type: 'SET_LINE_PRIORITY',
    lineId: 'comp_metal_01_line_1',
    priority: 3,
  });
  assert.equal(checkpoint.currentTick, 1);
  assert.equal(checkpoint.queue.commands.length, 0);
  assert.equal(checkpoint.commandResults.length, 0);

  engine.restoreCheckpoint(checkpoint);
  assert.equal(engine.getCurrentTick(), 1);
  assert.equal(engine.getCompany(SELLER)?.credits, 10000);
  assert.equal(engine.getCommandQueue().getPendingCount(), 0);
  assert.equal(engine.getExecutionHistory().length, 0);
  assert.equal(engine.createSnapshot().tick, 1);

  // Checkpoint -> engine: the restore hydrated a clone, so mutating the
  // checkpoint afterwards must not reach the engine.
  const snapshotCompany = checkpoint.companies.find((company) => company.companyId === SELLER);
  assert.ok(snapshotCompany);
  snapshotCompany.credits = 1;
  assert.equal(engine.getCompany(SELLER)?.credits, 10000);
});

test('a checkpointed PRNG state replays the same numbers', () => {
  const prng = new Mulberry32PRNG(2026);
  const state = prng.getSeed();
  const first = prng.nextUint32();
  prng.nextUint32();

  prng.restoreState(state);
  assert.equal(prng.getSeed(), state);
  assert.equal(prng.nextUint32(), first, 'the same state must produce the same sequence');
});


const legacyBase = {
  commandId: 'cmd_compat',
  companyId: SELLER,
  scheduledTick: 1,
  idempotencyKey: 'engine:compat',
};
const legacyCommands: readonly EnqueueCommandInput[] = [
  { ...legacyBase, type: 'SET_PRODUCTION_TARGET', lineId: `${SELLER}_line_1`, recipeId: 'R1', targetBatches: 1 },
  { ...legacyBase, type: 'SET_LINE_PRIORITY', lineId: `${SELLER}_line_1`, priority: 3 },
  { ...legacyBase, type: 'PAUSE_PRODUCTION_LINE', lineId: `${SELLER}_line_1` },
  { ...legacyBase, type: 'RESUME_PRODUCTION_LINE', lineId: `${SELLER}_line_1` },
  { ...legacyBase, type: 'INSTALL_TURBINE_EXPANSION' },
  { ...legacyBase, type: 'DELIVER_MEGAMACHINE_PART', quantity: 12 },
];

function prepareLegacy(harness: Harness, type: EnqueueCommandInput['type']): void {
  const company = harness.match.engine.getCompany(SELLER)!;
  if (type === 'INSTALL_TURBINE_EXPANSION') {
    harness.match.engine.hydrate({ currentTick: 899 });
    company.inventory.IND_TURBINE.available = 1;
    harness.match.advanceTicks(1);
  } else if (type === 'DELIVER_MEGAMACHINE_PART') {
    company.inventory.MEGAMACHINE_PART.available = 12;
    harness.match.advanceTicks(1);
  } else if (type === 'RESUME_PRODUCTION_LINE') {
    for (const command of [
      { ...legacyCommands[0]!, commandId: 'cmd_prepare_start', idempotencyKey: 'engine:prepare-start' },
      { ...legacyCommands[2]!, commandId: 'cmd_prepare_pause', idempotencyKey: 'engine:prepare-pause' },
    ]) {
      admitThroughStore(harness.match, harness.store, {
        ...command, scheduledTick: harness.match.engine.getCurrentTick() + 1,
      }, command.commandId);
      harness.match.advanceTicks(1);
    }
  }
}

for (const input of legacyCommands) {
  test(`normal shared tick preserves ${input.type} engine behavior`, () => {
    withHarness((harness) => {
      prepareLegacy(harness, input.type);
      const snapshot = harness.match.engine.createSnapshot();
      const queue = harness.match.engine.getCommandQueue();
      const expected = new SimulatorEngine(harness.match.engine.getPrngState());
      expected.initializeStandardMatch();
      expected.hydrate({
        currentTick: snapshot.tick,
        companies: Object.values(snapshot.companies),
        contracts: Object.values(snapshot.contracts),
        globalProject: snapshot.globalProject,
        commandResults: harness.match.engine.getExecutionHistory(),
        queue: {
          commands: queue.listPending(),
          processedIdempotencyKeys: queue.listProcessedIdempotencyKeys(),
          sequenceCounter: queue.getSequenceCounter(),
        },
      });
      const command = { ...input, scheduledTick: snapshot.tick + 1 };
      admitThroughStore(harness.match, harness.store, command, input.type);
      assert.equal(expected.submitCommand(command), true);
      // Issue #55: the authoritative tick drives the NPC policies before the
      // engine tick, so the oracle has to do the same or it diverges on every
      // NPC company the tick advances.
      new NpcController({ seed: DEFAULT_MATCH_SEED }).stepTick(expected);
      const expectedSnapshot = expected.processTick();
      harness.match.advanceTicks(1);
      assert.deepEqual(harness.match.engine.createSnapshot(), expectedSnapshot);
      assert.deepEqual(
        normalizeNpcCommandIds(harness.match.engine.getExecutionHistory()),
        normalizeNpcCommandIds(expected.getExecutionHistory()),
      );
      assert.equal(expected.getExecutionHistory().at(-1)?.success, true);
      assert.deepEqual(queue.listPending(), expected.getCommandQueue().listPending());
      assert.deepEqual(queue.listProcessedIdempotencyKeys(), expected.getCommandQueue().listProcessedIdempotencyKeys());
      assert.equal(queue.getSequenceCounter(), expected.getCommandQueue().getSequenceCounter());
      assert.equal(harness.store.repositories.matches.load(MATCH_ID)?.currentTick, expectedSnapshot.tick);
      assert.equal(harness.store.repositories.commandResults.count(MATCH_ID), expected.getExecutionHistory().length);
      assert.equal(harness.store.repositories.queue.countPending(MATCH_ID), 0);
    });
  });

  test(`failed shared tick restores all ${input.type} effects`, () => {
    withHarness((harness) => {
      prepareLegacy(harness, input.type);
      admitThroughStore(harness.match, harness.store, {
        ...input, scheduledTick: harness.match.engine.getCurrentTick() + 1,
      }, input.type);
      const before = stateOf(harness);
      failSnapshotWrite(harness.database);
      assert.throws(() => harness.match.advanceTicks(1), new RegExp(FAULT_MESSAGE));
      assert.equal(stateOf(harness), before);
    });
  });
}
