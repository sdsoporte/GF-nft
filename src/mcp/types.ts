/**
 * GigaForge v4.1 - MCP Protocol Types & Grant Policies
 * Specification reference: MCP 2026-07-28 (Stateless Protocol Core)
 */

export type McpPhaseMode = 'PHASE_1_READ_ONLY' | 'PHASE_1B_READ_WRITE';

export type McpScope =
  | 'factory:read'
  | 'inventory:read'
  | 'market:read'
  | 'production:write'
  | 'logistics:write'
  | 'contracts:draft';

export interface McpQuotas {
  readonly maxReadPerMinute: number; // default: 60
  readonly maxWritePerMinute: number; // default: 12
  readonly maxWritePerMatch: number; // default: 500
}

export interface McpGrant {
  readonly grantId: string;
  readonly token: string; // "gf_mcp_..."
  readonly playerId: string;
  readonly companyId: string;
  readonly matchId: string;
  phaseMode: McpPhaseMode;
  readonly scopes: readonly McpScope[];
  readonly resourceAllowlist: readonly string[]; // e.g. ["comp_metal_01_line_1", "comp_metal_01_line_2"]
  readonly quotas: McpQuotas;
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
  revoked: boolean;
}

export type McpReadToolName =
  | 'get_factory_overview'
  | 'get_inventory'
  | 'get_production_lines'
  | 'get_contracts'
  | 'get_market_quotes'
  | 'get_action_history';

export type McpWriteToolName =
  | 'set_production_target'
  | 'set_line_priority'
  | 'pause_production_line'
  | 'resume_production_line'
  | 'schedule_internal_transport'
  | 'draft_supply_offer'
  | 'cancel_own_pending_offer';

export type McpToolName = McpReadToolName | McpWriteToolName;

export type McpErrorCode =
  | 'ERR_AUTH_MISSING'
  | 'ERR_AUTH_INVALID'
  | 'ERR_AUTH_EXPIRED'
  | 'ERR_AUTH_REVOKED'
  | 'ERR_SCOPE_UNAUTHORIZED'
  | 'ERR_SCOPE_DISABLED_IN_PHASE_1'
  | 'ERR_RESOURCE_NOT_ALLOWED'
  | 'ERR_RATE_LIMIT_EXCEEDED'
  | 'ERR_COOLDOWN_ACTIVE'
  | 'ERR_DUPLICATE_IDEMPOTENCY_KEY'
  | 'ERR_INVALID_PAYLOAD'
  | 'ERR_INSUFFICIENT_INVENTORY'
  | 'ERR_INSUFFICIENT_ENERGY'
  | 'ERR_INSUFFICIENT_CREDITS'
  | 'ERR_MAX_DRAFTS_REACHED'
  | 'ERR_UNKNOWN_TOOL'
  | 'ERR_INTERNAL';

export interface McpSuccessResponse<T = unknown> {
  readonly success: true;
  readonly tick: number;
  readonly tool: McpToolName;
  readonly data: T;
  readonly latencyMs: number;
}

export interface McpErrorResponse {
  readonly success: false;
  readonly tick: number;
  readonly tool: string;
  readonly errorCode: McpErrorCode;
  readonly errorMessage: string;
  readonly latencyMs: number;
}

export type McpResponse<T = unknown> = McpSuccessResponse<T> | McpErrorResponse;

export interface McpAuditLogEntry {
  readonly id: string;
  readonly timestampUtc: string;
  readonly tick: number;
  readonly grantId: string;
  readonly companyId: string;
  readonly toolName: string;
  readonly payloadHash: string;
  readonly idempotencyKey?: string;
  readonly resultCode: string; // 'SUCCESS' or McpErrorCode
  readonly executionTimeMs: number;
}
