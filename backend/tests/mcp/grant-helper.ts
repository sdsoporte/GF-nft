/**
 * Shared fixtures for the MCP gateway security suite (S4 of issue #10).
 *
 * Every fixture is driven through the gateway's public surface: a real
 * `SimulatorEngine`, `registerGrant`, `invokeTool` and `getAuditLogs`. No
 * production module is stubbed or monkey-patched, so each assertion describes
 * the gateway an MCP client actually hits on this branch.
 *
 * Determinism: timestamps are static ISO strings and the engine uses its
 * documented default seed, so nothing here depends on the wall clock.
 */

import assert from 'node:assert/strict';

import { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import { McpGateway } from '../../src/mcp/McpGateway.ts';
import type {
  McpErrorCode,
  McpErrorResponse,
  McpGrant,
  McpPhaseMode,
  McpQuotas,
  McpResponse,
  McpScope,
  McpSuccessResponse,
} from '../../src/mcp/types.ts';

export const TENANT_A = 'comp_metal_01';
export const TENANT_B = 'comp_metal_02';
export const TENANT_ABSENT = 'comp_absent_09';

export const LINE_A1 = 'comp_metal_01_line_1';
export const LINE_A2 = 'comp_metal_01_line_2';
export const LINE_A3 = 'comp_metal_01_line_3';
export const LINE_B1 = 'comp_metal_02_line_1';

/** Static expiry timestamps keep expiry tests independent of the wall clock. */
export const EXPIRES_FAR_FUTURE = '2099-12-31T23:59:59.000Z';
export const EXPIRED_IN_PAST = '2000-01-01T00:00:00.000Z';

export const ALL_SCOPES: readonly McpScope[] = [
  'factory:read',
  'inventory:read',
  'market:read',
  'production:write',
  'logistics:write',
  'contracts:draft',
];

const DEFAULT_QUOTAS: McpQuotas = {
  maxReadPerMinute: 60,
  maxWritePerMinute: 12,
  maxWritePerMatch: 500,
};

export interface GrantSpec {
  grantId?: string;
  token?: string;
  companyId?: string;
  scopes?: readonly McpScope[];
  phaseMode?: McpPhaseMode;
  resourceAllowlist?: readonly string[];
  expiresAtUtc?: string;
  revoked?: boolean;
  quotas?: Partial<McpQuotas>;
}

/** Build a grant with a safe default and only the overrides the test needs. */
export function makeGrant(spec: GrantSpec = {}): McpGrant {
  const companyId = spec.companyId ?? TENANT_A;
  return {
    grantId: spec.grantId ?? `grant_${companyId}`,
    token: spec.token ?? `gf_mcp_${companyId}_token`,
    playerId: `player_${companyId}`,
    companyId,
    matchId: 'match_qa_s4',
    phaseMode: spec.phaseMode ?? 'PHASE_1B_READ_WRITE',
    scopes: spec.scopes ?? ALL_SCOPES,
    resourceAllowlist: spec.resourceAllowlist ?? [`${companyId}_line_1`, `${companyId}_line_2`],
    quotas: { ...DEFAULT_QUOTAS, ...spec.quotas },
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    expiresAtUtc: spec.expiresAtUtc ?? EXPIRES_FAR_FUTURE,
    revoked: spec.revoked ?? false,
  };
}

export interface GatewayFixture {
  engine: SimulatorEngine;
  gateway: McpGateway;
}

/** Fresh engine (standard 4-company match) plus a gateway with the given grants. */
export function createGatewayFixture(grants: readonly McpGrant[] = []): GatewayFixture {
  const engine = new SimulatorEngine();
  engine.initializeStandardMatch();
  const gateway = new McpGateway(engine, {
    matchId: 'match_qa_s4',
    companyPlayers: {
      [TENANT_A]: `player_${TENANT_A}`,
      [TENANT_B]: `player_${TENANT_B}`,
      comp_manuf_01: 'player_comp_manuf_01',
      comp_manuf_02: 'player_comp_manuf_02',
    },
  });
  for (const grant of grants) {
    gateway.registerGrant(grant);
  }
  return { engine, gateway };
}

/** Number of commands queued for a future tick (0 means nothing was enqueued). */
export function pendingCommandCount(engine: SimulatorEngine): number {
  return engine.getCommandQueue().getPendingCount();
}

export function expectSuccess(response: McpResponse): McpSuccessResponse<unknown> {
  if (!response.success) {
    assert.fail(
      `expected success but the gateway rejected the call: ${response.errorCode} (${response.errorMessage})`
    );
  }
  return response;
}

export function expectError(response: McpResponse, code: McpErrorCode): McpErrorResponse {
  assert.equal(response.success, false, `expected failure ${code} but the gateway succeeded`);
  const failure = response as McpErrorResponse;
  assert.equal(failure.errorCode, code, `unexpected error code (message: ${failure.errorMessage})`);
  return failure;
}

/** Read-tool payload for a company; tenants are supplied per test. */
export function overviewParams(companyId: string): { company_id: string } {
  return { company_id: companyId };
}

/** Minimal valid `set_production_target` payload. */
export function targetParams(
  lineId: string,
  idempotencyKey: string,
  overrides: { recipe_id?: unknown; target_batches?: unknown } = {}
): Record<string, unknown> {
  return {
    line_id: lineId,
    // `in` keeps explicit null/undefined overrides, which `??` would swallow.
    recipe_id: 'recipe_id' in overrides ? overrides.recipe_id : 'R1',
    target_batches: 'target_batches' in overrides ? overrides.target_batches : 1,
    idempotency_key: idempotencyKey,
  };
}

/** Minimal valid `schedule_internal_transport` payload. */
export function transportParams(
  contractId: string,
  idempotencyKey: string
): Record<string, unknown> {
  return { contract_id: contractId, quantity_to_ship: 1, idempotency_key: idempotencyKey };
}

/** Minimal valid `draft_supply_offer` payload. */
export function draftParams(idempotencyKey: string): Record<string, unknown> {
  return {
    item_id: 'STEEL_PLATE',
    quantity: 10,
    unit_price: 10,
    deadline_ticks: 100,
    idempotency_key: idempotencyKey,
  };
}
