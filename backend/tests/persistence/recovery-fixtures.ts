/**
 * Shared mid-game script for the S5/S9 recovery tests.
 *
 * Kept out of the test file so the oracle can be pointed at the same scenario
 * from more than one harness (the test itself, and ad-hoc debugging). Not a
 * test file, so `bun test` does not collect it.
 *
 * The script drives the match through its public API only: `FactoryMatch` +
 * `requestProduction` + `advanceTicks` (the match has no wall-clock dependency,
 * so `advanceTicks` is the injected clock here). Contract traffic has no match
 * API entry point yet, so those commands are admitted through the store seam
 * exactly the way the match admits its own: queue row, permanent key,
 * acknowledgement and the engine call, all in one transaction.
 */

import assert from 'node:assert/strict';

import {
  FactoryMatch,
  MAX_ACKNOWLEDGED_REQUESTS,
  SERVER_COMPANY_ID,
} from '../../src/match.ts';
import type { EnqueueCommandInput, GameCommand } from '../../src/domain/types.ts';
import type { MatchStore } from '../../src/persistence/matchStore.ts';
import { productionPayload } from './queue-fixtures.ts';

export const LINE_1 = 'comp_metal_01_line_1';
export const LINE_2 = 'comp_metal_01_line_2';
export const BUYER_COMPANY = 'comp_manuf_01';
/** Tick the script stops at: past maintenance (300) and past the default (41). */
export const MID_GAME_TICK = 314;

export interface MidGameScript {
  /** Command ids the match API returned, in submission order. */
  readonly notifiedCommandIds: readonly string[];
}

/** Submit one production request through the public match API. */
export function requestProduction(
  match: FactoryMatch,
  requestId: string,
  lineId: string,
): string {
  const decision = match.requestProduction(productionPayload({ requestId, lineId }));
  assert.equal(decision.kind, 'queued', `request "${requestId}" was not accepted`);
  if (decision.kind !== 'queued') throw new Error('unreachable');
  return decision.commandId;
}

/**
 * Admit one command through the store seam so it becomes durable exactly like a
 * match-level command (queue row, permanent key, acknowledgement) and reaches
 * the engine inside the same transaction.
 */
export function admitThroughStore(
  match: FactoryMatch,
  store: MatchStore,
  input: EnqueueCommandInput,
  label: string,
): string {
  const sequenceNumber = match.engine.getCommandQueue().getSequenceCounter() + 1;
  const command = { ...input, sequenceNumber } as GameCommand;
  const metadata = store.repositories.matches.load(match.matchId);
  if (metadata === null) throw new Error('the match row is missing before a seam command');

  store.commitCommand({
    metadata: {
      matchId: metadata.matchId,
      seed: metadata.seed,
      currentTick: match.engine.getCurrentTick(),
      sequenceCounter: sequenceNumber,
      historyCursor: metadata.historyCursor,
      tickIntervalMs: metadata.tickIntervalMs,
    },
    command: {
      commandId: command.commandId,
      matchId: match.matchId,
      companyId: command.companyId,
      sequenceNumber,
      scheduledTick: command.scheduledTick,
      idempotencyKey: command.idempotencyKey,
      commandType: command.type,
      payloadJson: JSON.stringify(command),
    },
    processed: {
      matchId: match.matchId,
      idempotencyKey: command.idempotencyKey,
      commandId: command.commandId,
    },
    acknowledgement: {
      matchId: match.matchId,
      requestId: `seam:${label}`,
      fingerprint: `engine:${command.type}`,
      commandId: command.commandId,
      capacity: MAX_ACKNOWLEDGED_REQUESTS,
    },
    apply: () => match.engine.submitCommand(command),
  });
  return command.commandId;
}

/**
 * The scripted mid-game: production lines at different stages, a maintenance
 * charge, a defaulted contract, an active contract, one rejected execution, and
 * two commands still pending when the process dies (one of them due right after
 * the restart).
 */
export function driveMidGame(match: FactoryMatch, store: MatchStore): MidGameScript {
  const notified: string[] = [];

  // Staggered production so the lines are never in the same batch phase.
  notified.push(requestProduction(match, 'mid-game-1', LINE_1));
  match.advanceTicks(5); // tick 5: line 1 mid-batch
  notified.push(requestProduction(match, 'mid-game-2', LINE_2));
  match.advanceTicks(5); // tick 10: line 1 has completed one batch

  const matchId = match.matchId;
  admitThroughStore(
    match,
    store,
    {
      commandId: 'cmd_seam_offer_default',
      companyId: SERVER_COMPANY_ID,
      scheduledTick: 11,
      idempotencyKey: `engine:${matchId}:offer-default`,
      type: 'CREATE_SUPPLY_OFFER',
      targetBuyerId: '',
      itemId: 'IRON_INGOT',
      quantity: 10,
      unitPriceCredits: 10,
      deadlineTicks: 40,
    },
    'offer-default',
  );
  admitThroughStore(
    match,
    store,
    {
      commandId: 'cmd_seam_offer_active',
      companyId: SERVER_COMPANY_ID,
      scheduledTick: 11,
      idempotencyKey: `engine:${matchId}:offer-active`,
      type: 'CREATE_SUPPLY_OFFER',
      targetBuyerId: BUYER_COMPANY,
      itemId: 'IRON_INGOT',
      quantity: 5,
      unitPriceCredits: 10,
      deadlineTicks: 3000,
    },
    'offer-active',
  );
  match.advanceTicks(1); // tick 11: both offers are PENDING

  const offers = match.engine.getAllContracts();
  const expiringOffer = offers.find((contract) => contract.deadlineTick === 40);
  // Issue #55: NPC companies publish surplus offers of their own, and their
  // IRON_INGOT batch size is 5 too, so quantity alone no longer identifies the
  // script's targeted offer. Ownership keeps the script on its own contract.
  const activeOffer = offers.find(
    (contract) =>
      contract.sellerCompanyId === SERVER_COMPANY_ID && contract.totalQuantity === 5,
  );
  assert.ok(expiringOffer, 'the expiring offer must exist before it is accepted');
  assert.ok(activeOffer, 'the accepted offer must exist before it is accepted');
  for (const [label, contractId] of [
    ['accept-default', expiringOffer.contractId],
    ['accept-active', activeOffer.contractId],
  ] as const) {
    admitThroughStore(
      match,
      store,
      {
        commandId: `cmd_seam_${label}`,
        companyId: BUYER_COMPANY,
        scheduledTick: 12,
        idempotencyKey: `engine:${matchId}:${label}`,
        type: 'ACCEPT_SUPPLY_OFFER',
        contractId,
      },
      label,
    );
  }
  // A second accept of the same offer is refused by the engine: this is the
  // rejected execution the comparison has to reproduce.
  admitThroughStore(
    match,
    store,
    {
      commandId: 'cmd_seam_accept_repeat',
      companyId: BUYER_COMPANY,
      scheduledTick: 12,
      idempotencyKey: `engine:${matchId}:accept-repeat`,
      type: 'ACCEPT_SUPPLY_OFFER',
      contractId: activeOffer.contractId,
    },
    'accept-repeat',
  );
  match.advanceTicks(1); // tick 12: both offers ACTIVE, the repeat refused

  // Long run: contract default at tick 41, maintenance at tick 300, and by then
  // the lines have starved for raw ore (the material-shortage path).
  match.advanceTicks(MID_GAME_TICK - 12 - 4); // tick 310
  notified.push(requestProduction(match, 'mid-game-4', LINE_1));
  match.advanceTicks(4); // tick 314, line 1 mid-batch again
  notified.push(requestProduction(match, 'mid-game-5', LINE_2)); // pending, due at 315

  return { notifiedCommandIds: notified };
}
