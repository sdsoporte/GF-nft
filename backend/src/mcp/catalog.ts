/**
 * External MCP tool catalog (issue #9): the public descriptor list served by
 * `tools/list`. Names and validation stay owned by the gateway and the Zod
 * schemas; this file only projects them, with one-line English descriptions,
 * into JSON Schema so external clients can discover the surface. No secrets
 * and no behavioral logic live here.
 */

import { z } from 'zod';

import {
  CancelOwnPendingOfferSchema,
  DraftSupplyOfferSchema,
  GetActionHistorySchema,
  GetContractsSchema,
  GetFactoryOverviewSchema,
  GetInventorySchema,
  GetMarketQuotesSchema,
  GetProductionLinesSchema,
  PauseProductionLineSchema,
  ResumeProductionLineSchema,
  ScheduleInternalTransportSchema,
  SetLinePrioritySchema,
  SetProductionTargetSchema,
} from './schemas.ts';

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const DESCRIPTIONS = {
  get_factory_overview: 'Read the caller company overview: credits, energy, lines and inventory summary.',
  get_inventory: 'Read the inventory of the caller company (or another company when explicitly scoped).',
  get_production_lines: 'Read production lines with status, recipe and batch progress.',
  get_contracts: 'Read contracts visible to the caller company, optionally filtered by status.',
  get_market_quotes: 'Read the public supply offers book; drafts are never included.',
  get_action_history: 'Read the caller company recent command history with outcomes.',
  set_production_target: 'Queue a production batch on one of the caller company lines; executes on the next server tick.',
  set_line_priority: 'Queue a priority change for one of the caller company lines.',
  pause_production_line: 'Queue a pause for one of the caller company lines, freezing its active batch.',
  resume_production_line: 'Queue a resume for one of the caller company paused lines.',
  schedule_internal_transport: 'Queue an internal transport dispatch for an active contract.',
  draft_supply_offer: 'Create a non-binding supply offer draft; it never locks funds until a human publishes it.',
  cancel_own_pending_offer: 'Queue a cancellation of one of the caller company pending offers or drafts.',
} as const;

const SCHEMAS = {
  get_factory_overview: GetFactoryOverviewSchema,
  get_inventory: GetInventorySchema,
  get_production_lines: GetProductionLinesSchema,
  get_contracts: GetContractsSchema,
  get_market_quotes: GetMarketQuotesSchema,
  get_action_history: GetActionHistorySchema,
  set_production_target: SetProductionTargetSchema,
  set_line_priority: SetLinePrioritySchema,
  pause_production_line: PauseProductionLineSchema,
  resume_production_line: ResumeProductionLineSchema,
  schedule_internal_transport: ScheduleInternalTransportSchema,
  draft_supply_offer: DraftSupplyOfferSchema,
  cancel_own_pending_offer: CancelOwnPendingOfferSchema,
} as const;

export const MCP_TOOL_NAMES = Object.keys(SCHEMAS) as Array<keyof typeof SCHEMAS>;

export function toolDescriptor(name: keyof typeof SCHEMAS): McpToolDescriptor {
  return {
    name,
    description: DESCRIPTIONS[name],
    inputSchema: z.toJSONSchema(SCHEMAS[name], { io: 'input' }) as Record<string, unknown>,
  };
}

export function toolCatalog(): McpToolDescriptor[] {
  return MCP_TOOL_NAMES.map((name) => toolDescriptor(name));
}
