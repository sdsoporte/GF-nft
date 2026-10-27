/**
 * GigaForge v4.1 - MCP Gateway Implementation
 * Standard: Model Context Protocol (Spec 2026-07-28 — Stateless Core)
 *
 * Enforces:
 * - Bearer Token Authentication (gf_mcp_...)
 * - Scope Verification
 * - Phase Mode Policy (PHASE_1_READ_ONLY vs PHASE_1B_READ_WRITE)
 * - Resource Allowlist (Lines allowed for script/agent)
 * - Rate Limiting (minute and match quotas)
 * - Line Cooldowns (3 to 5 ticks)
 * - Idempotency Key validation
 * - Prompt Injection Mitigation (Zero free text, strict sanitized enums/IDs)
 * - Immutable Audit Logging
 */

import { SimulatorEngine } from '../engine/SimulatorEngine.ts';
import {
  McpAuditLogEntry,
  McpErrorCode,
  McpGrant,
  McpResponse,
  McpScope,
  McpToolName,
} from './types.ts';
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
  sanitizeMcpIdentifier,
} from './schemas.ts';
import { ItemId, RecipeId, LinePriority } from '../domain/types.ts';

/**
 * Hash utility for payload auditing (FNV-1a 32-bit hex)
 */
function hashPayload(payload: unknown): string {
  const str = JSON.stringify(payload ?? {});
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Tool scope mappings
 */
const TOOL_SCOPE_MAP: Record<McpToolName, McpScope> = {
  get_factory_overview: 'factory:read',
  get_inventory: 'inventory:read',
  get_production_lines: 'factory:read',
  get_contracts: 'market:read',
  get_market_quotes: 'market:read',
  get_action_history: 'factory:read',
  set_production_target: 'production:write',
  set_line_priority: 'production:write',
  pause_production_line: 'production:write',
  resume_production_line: 'production:write',
  schedule_internal_transport: 'logistics:write',
  draft_supply_offer: 'contracts:draft',
  cancel_own_pending_offer: 'contracts:draft',
};

const WRITE_TOOLS: ReadonlySet<McpToolName> = new Set([
  'set_production_target',
  'set_line_priority',
  'pause_production_line',
  'resume_production_line',
  'schedule_internal_transport',
  'draft_supply_offer',
  'cancel_own_pending_offer',
]);

/**
 * Line cooldown requirements (in ticks)
 */
const LINE_COOLDOWNS_TICKS: Record<string, number> = {
  set_production_target: 5,
  set_line_priority: 3,
  pause_production_line: 5,
  resume_production_line: 5,
};

export class McpGateway {
  private grants: Map<string, McpGrant> = new Map();
  private tokenToGrantId: Map<string, string> = new Map();

  // Rate limit tracking: grantId -> timestamp history
  private readTimestamps: Map<string, number[]> = new Map();
  private writeTimestamps: Map<string, number[]> = new Map();
  private matchWriteCounts: Map<string, number> = new Map();

  // Cooldown tracking: "companyId:lineId:action" -> lastUsedTick
  private lineCooldowns: Map<string, number> = new Map();

  // Audit logs
  private auditLogs: McpAuditLogEntry[] = [];
  private logCounter = 0;

  constructor(private readonly engine: SimulatorEngine) {}

  /**
   * Register or provision a grant
   */
  public registerGrant(grant: McpGrant): void {
    this.grants.set(grant.grantId, grant);
    this.tokenToGrantId.set(grant.token, grant.grantId);
  }

  public getGrant(grantId: string): McpGrant | undefined {
    return this.grants.get(grantId);
  }

  public getAllGrants(): McpGrant[] {
    return Array.from(this.grants.values());
  }

  /**
   * Emergency Panic Disconnect: Revoke token immediately
   */
  public revokeGrant(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    grant.revoked = true;
    return true;
  }

  public setGrantPhaseMode(grantId: string, phase: 'PHASE_1_READ_ONLY' | 'PHASE_1B_READ_WRITE'): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    grant.phaseMode = phase;
    return true;
  }

  public getAuditLogs(limit?: number): McpAuditLogEntry[] {
    if (!limit) return [...this.auditLogs];
    return this.auditLogs.slice(-limit);
  }

  /**
   * Main entrypoint for MCP Tool Invocation
   */
  public async invokeTool(
    token: string,
    toolName: string,
    rawParams: unknown
  ): Promise<McpResponse> {
    const startTime = performance.now();
    const currentTick = this.engine.getCurrentTick();
    const payloadHash = hashPayload(rawParams);

    // Step 1: Validate Token & Grant
    if (!token || !token.startsWith('gf_mcp_')) {
      return this.recordFailure(
        startTime,
        currentTick,
        'unknown',
        'unknown',
        toolName,
        payloadHash,
        'ERR_AUTH_INVALID',
        'Invalid or missing Bearer token. Format must be gf_mcp_...'
      );
    }

    const grantId = this.tokenToGrantId.get(token);
    const grant = grantId ? this.grants.get(grantId) : undefined;
    if (!grant) {
      return this.recordFailure(
        startTime,
        currentTick,
        'unknown',
        'unknown',
        toolName,
        payloadHash,
        'ERR_AUTH_INVALID',
        'Token not found or unauthorized'
      );
    }

    if (grant.revoked) {
      return this.recordFailure(
        startTime,
        currentTick,
        grant.grantId,
        grant.companyId,
        toolName,
        payloadHash,
        'ERR_AUTH_REVOKED',
        'Emergency disconnect is active: grant revoked by human operator'
      );
    }

    const nowIso = new Date().toISOString();
    if (grant.expiresAtUtc < nowIso) {
      return this.recordFailure(
        startTime,
        currentTick,
        grant.grantId,
        grant.companyId,
        toolName,
        payloadHash,
        'ERR_AUTH_EXPIRED',
        'MCP grant has expired'
      );
    }

    // Step 2: Tool existence & Scope check
    if (!(toolName in TOOL_SCOPE_MAP)) {
      return this.recordFailure(
        startTime,
        currentTick,
        grant.grantId,
        grant.companyId,
        toolName,
        payloadHash,
        'ERR_UNKNOWN_TOOL',
        `Tool "${toolName}" is not part of GigaForge MCP catalog`
      );
    }

    const typedTool = toolName as McpToolName;
    const requiredScope = TOOL_SCOPE_MAP[typedTool];
    if (!grant.scopes.includes(requiredScope)) {
      return this.recordFailure(
        startTime,
        currentTick,
        grant.grantId,
        grant.companyId,
        toolName,
        payloadHash,
        'ERR_SCOPE_UNAUTHORIZED',
        `Missing required scope: ${requiredScope}`
      );
    }

    const isWriteTool = WRITE_TOOLS.has(typedTool);

    // Step 3: Phase Mode Enforcement
    if (isWriteTool && grant.phaseMode === 'PHASE_1_READ_ONLY') {
      return this.recordFailure(
        startTime,
        currentTick,
        grant.grantId,
        grant.companyId,
        toolName,
        payloadHash,
        'ERR_SCOPE_DISABLED_IN_PHASE_1',
        'Write tools are disabled in Phase 1 (Read-Only). Upgrade grant to Phase 1B.'
      );
    }

    // Step 4: Rate Limiting
    const rateLimitError = this.checkRateLimits(grant, isWriteTool);
    if (rateLimitError) {
      return this.recordFailure(
        startTime,
        currentTick,
        grant.grantId,
        grant.companyId,
        toolName,
        payloadHash,
        'ERR_RATE_LIMIT_EXCEEDED',
        rateLimitError
      );
    }

    // Step 5: Execute Tool with Zod Validation
    try {
      if (!isWriteTool) {
        return await this.executeReadTool(
          grant,
          typedTool,
          rawParams,
          startTime,
          currentTick,
          payloadHash
        );
      } else {
        return await this.executeWriteTool(
          grant,
          typedTool,
          rawParams,
          startTime,
          currentTick,
          payloadHash
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.recordFailure(
        startTime,
        currentTick,
        grant.grantId,
        grant.companyId,
        toolName,
        payloadHash,
        'ERR_INVALID_PAYLOAD',
        msg
      );
    }
  }

  /**
   * Read Tools Execution
   */
  private async executeReadTool(
    grant: McpGrant,
    tool: McpToolName,
    rawParams: unknown,
    startTime: number,
    currentTick: number,
    payloadHash: string
  ): Promise<McpResponse> {
    switch (tool) {
      case 'get_factory_overview': {
        const parsed = GetFactoryOverviewSchema.parse(rawParams);
        const company = this.engine.getCompany(parsed.company_id);
        if (!company) {
          throw new Error(`Company not found: ${parsed.company_id}`);
        }

        const bottlenecks: string[] = [];
        if (company.energy < 30) bottlenecks.push('CRITICAL_ENERGY_DEFICIT');
        if (company.inventory.RAW_ORE.available < 10) bottlenecks.push('RAW_ORE_SHORTAGE');
        if (company.lines.some((l) => l.status === 'NO_ENERGY')) bottlenecks.push('LINES_STARVING_ENERGY');

        const data = {
          current_tick: currentTick,
          company_id: sanitizeMcpIdentifier(company.companyId),
          industrial_class: company.industrialClass,
          credits: company.credits,
          energy: {
            current: company.energy,
            max: company.maxEnergyStorage,
            generation_per_tick: company.energyGenerationPerTick,
          },
          reputation: company.reputation,
          bottleneck_alerts: bottlenecks,
          installed_turbines_r7: company.installedTurbinesR7,
          contributed_megamachine_parts_r8: company.contributedMegamachinePartsR8,
        };

        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, data);
      }

      case 'get_inventory': {
        const parsed = GetInventorySchema.parse(rawParams);
        const company = this.engine.getCompany(parsed.company_id);
        if (!company) {
          throw new Error(`Company not found: ${parsed.company_id}`);
        }

        const items = Object.entries(company.inventory).map(([itemId, stock]) => ({
          item_id: itemId,
          available_qty: stock.available,
          reserved_qty: stock.reserved,
        }));

        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, { items });
      }

      case 'get_production_lines': {
        const parsed = GetProductionLinesSchema.parse(rawParams);
        const company = this.engine.getCompany(parsed.company_id);
        if (!company) {
          throw new Error(`Company not found: ${parsed.company_id}`);
        }

        const lines = company.lines.map((l) => ({
          line_id: l.lineId,
          priority: l.priority,
          status: l.status,
          current_recipe_id: l.currentRecipeId,
          progress_ticks: l.activeBatch?.progressTicks ?? 0,
          total_duration_ticks: l.activeBatch?.totalDurationTicks ?? 0,
          completed_batches: l.activeBatch?.completedBatches ?? 0,
          target_batches: l.activeBatch?.targetBatches ?? 0,
        }));

        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, { lines });
      }

      case 'get_contracts': {
        const parsed = GetContractsSchema.parse(rawParams);
        const allContracts = this.engine.getAllContracts();

        const filtered = allContracts
          .filter(
            (c) =>
              (c.sellerCompanyId === parsed.company_id || c.buyerCompanyId === parsed.company_id) &&
              (!parsed.status || c.status === parsed.status)
          )
          .map((c) => ({
            contract_id: c.contractId,
            seller_company_id: sanitizeMcpIdentifier(c.sellerCompanyId),
            buyer_company_id: sanitizeMcpIdentifier(c.buyerCompanyId),
            item_id: c.itemId,
            total_quantity: c.totalQuantity,
            delivered_quantity: c.deliveredQuantity,
            unit_price_credits: c.unitPriceCredits,
            total_value_credits: c.totalValueCredits,
            collateral_seller_credits: c.collateralSellerCredits,
            deadline_tick: c.deadlineTick,
            status: c.status,
          }));

        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, {
          contracts: filtered,
        });
      }

      case 'get_market_quotes': {
        const parsed = GetMarketQuotesSchema.parse(rawParams);
        const allContracts = this.engine.getAllContracts();

        // Public pending/active quotes sanitized against prompt injection
        const quotes = allContracts
          .filter((c) => c.status === 'PENDING' && (!parsed.item_id || c.itemId === parsed.item_id))
          .slice(0, parsed.limit)
          .map((c) => ({
            offer_id: c.contractId,
            seller_company_id: sanitizeMcpIdentifier(c.sellerCompanyId),
            item_id: c.itemId,
            quantity: c.totalQuantity,
            unit_price_credits: c.unitPriceCredits,
            total_value_credits: c.totalValueCredits,
            deadline_tick: c.deadlineTick,
          }));

        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, { quotes });
      }

      case 'get_action_history': {
        const parsed = GetActionHistorySchema.parse(rawParams);
        const history = this.engine.getExecutionHistory(parsed.last_n_ticks);

        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, {
          history: history.map((h) => ({
            command_id: h.commandId,
            idempotency_key: h.idempotencyKey,
            executed_at_tick: h.executedAtTick,
            success: h.success,
            error_code: h.errorCode,
          })),
        });
      }

      default:
        throw new Error(`Unhandled read tool: ${tool}`);
    }
  }

  /**
   * Write Tools Execution (Fase 1B)
   */
  private async executeWriteTool(
    grant: McpGrant,
    tool: McpToolName,
    rawParams: unknown,
    startTime: number,
    currentTick: number,
    payloadHash: string
  ): Promise<McpResponse> {
    const nextTick = currentTick + 1;

    switch (tool) {
      case 'set_production_target': {
        const p = SetProductionTargetSchema.parse(rawParams);
        this.verifyResourceAllowlist(grant, p.line_id);
        this.checkLineCooldown(grant.companyId, p.line_id, tool, currentTick);

        const enqueued = this.engine.submitCommand({
          commandId: `mcp_target_${Date.now()}`,
          companyId: grant.companyId,
          scheduledTick: nextTick,
          idempotencyKey: p.idempotency_key,
          type: 'SET_PRODUCTION_TARGET',
          lineId: p.line_id,
          recipeId: p.recipe_id as RecipeId,
          targetBatches: p.target_batches,
        });

        if (!enqueued) {
          return this.recordFailure(
            startTime,
            currentTick,
            grant.grantId,
            grant.companyId,
            tool,
            payloadHash,
            'ERR_DUPLICATE_IDEMPOTENCY_KEY',
            `idempotency_key "${p.idempotency_key}" was already consumed`
          );
        }

        this.updateLineCooldown(grant.companyId, p.line_id, tool, currentTick);
        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, {
          status: 'ENQUEUED_FOR_NEXT_TICK',
          scheduled_tick: nextTick,
          line_id: p.line_id,
          recipe_id: p.recipe_id,
          target_batches: p.target_batches,
        });
      }

      case 'set_line_priority': {
        const p = SetLinePrioritySchema.parse(rawParams);
        this.verifyResourceAllowlist(grant, p.line_id);
        this.checkLineCooldown(grant.companyId, p.line_id, tool, currentTick);

        const enqueued = this.engine.submitCommand({
          commandId: `mcp_prio_${Date.now()}`,
          companyId: grant.companyId,
          scheduledTick: nextTick,
          idempotencyKey: p.idempotency_key,
          type: 'SET_LINE_PRIORITY',
          lineId: p.line_id,
          priority: p.priority as LinePriority,
        });

        if (!enqueued) {
          return this.recordFailure(
            startTime,
            currentTick,
            grant.grantId,
            grant.companyId,
            tool,
            payloadHash,
            'ERR_DUPLICATE_IDEMPOTENCY_KEY',
            `idempotency_key "${p.idempotency_key}" duplicate`
          );
        }

        this.updateLineCooldown(grant.companyId, p.line_id, tool, currentTick);
        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, {
          status: 'ENQUEUED_FOR_NEXT_TICK',
          scheduled_tick: nextTick,
          line_id: p.line_id,
          priority: p.priority,
        });
      }

      case 'pause_production_line': {
        const p = PauseProductionLineSchema.parse(rawParams);
        this.verifyResourceAllowlist(grant, p.line_id);
        this.checkLineCooldown(grant.companyId, p.line_id, tool, currentTick);

        const enqueued = this.engine.submitCommand({
          commandId: `mcp_pause_${Date.now()}`,
          companyId: grant.companyId,
          scheduledTick: nextTick,
          idempotencyKey: p.idempotency_key,
          type: 'PAUSE_PRODUCTION_LINE',
          lineId: p.line_id,
        });

        if (!enqueued) {
          return this.recordFailure(
            startTime,
            currentTick,
            grant.grantId,
            grant.companyId,
            tool,
            payloadHash,
            'ERR_DUPLICATE_IDEMPOTENCY_KEY',
            `idempotency_key duplicate`
          );
        }

        this.updateLineCooldown(grant.companyId, p.line_id, tool, currentTick);
        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, {
          status: 'ENQUEUED_FOR_NEXT_TICK',
          scheduled_tick: nextTick,
          line_id: p.line_id,
        });
      }

      case 'resume_production_line': {
        const p = ResumeProductionLineSchema.parse(rawParams);
        this.verifyResourceAllowlist(grant, p.line_id);
        this.checkLineCooldown(grant.companyId, p.line_id, tool, currentTick);

        const enqueued = this.engine.submitCommand({
          commandId: `mcp_resume_${Date.now()}`,
          companyId: grant.companyId,
          scheduledTick: nextTick,
          idempotencyKey: p.idempotency_key,
          type: 'RESUME_PRODUCTION_LINE',
          lineId: p.line_id,
        });

        if (!enqueued) {
          return this.recordFailure(
            startTime,
            currentTick,
            grant.grantId,
            grant.companyId,
            tool,
            payloadHash,
            'ERR_DUPLICATE_IDEMPOTENCY_KEY',
            `idempotency_key duplicate`
          );
        }

        this.updateLineCooldown(grant.companyId, p.line_id, tool, currentTick);
        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, {
          status: 'ENQUEUED_FOR_NEXT_TICK',
          scheduled_tick: nextTick,
          line_id: p.line_id,
        });
      }

      case 'schedule_internal_transport': {
        const p = ScheduleInternalTransportSchema.parse(rawParams);

        const enqueued = this.engine.submitCommand({
          commandId: `mcp_ship_${Date.now()}`,
          companyId: grant.companyId,
          scheduledTick: nextTick,
          idempotencyKey: p.idempotency_key,
          type: 'SCHEDULE_INTERNAL_TRANSPORT',
          contractId: p.contract_id,
          quantityToShip: p.quantity_to_ship,
        });

        if (!enqueued) {
          return this.recordFailure(
            startTime,
            currentTick,
            grant.grantId,
            grant.companyId,
            tool,
            payloadHash,
            'ERR_DUPLICATE_IDEMPOTENCY_KEY',
            `idempotency_key duplicate`
          );
        }

        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, {
          status: 'ENQUEUED_FOR_NEXT_TICK',
          scheduled_tick: nextTick,
          contract_id: p.contract_id,
          quantity_to_ship: p.quantity_to_ship,
        });
      }

      case 'draft_supply_offer': {
        const p = DraftSupplyOfferSchema.parse(rawParams);

        // Max 5 open drafts enforcement
        const activeDrafts = this.engine
          .getAllContracts()
          .filter((c) => c.sellerCompanyId === grant.companyId && c.status === 'PENDING').length;

        if (activeDrafts >= 5) {
          return this.recordFailure(
            startTime,
            currentTick,
            grant.grantId,
            grant.companyId,
            tool,
            payloadHash,
            'ERR_MAX_DRAFTS_REACHED',
            'Maximum 5 open draft offers per company'
          );
        }

        const enqueued = this.engine.submitCommand({
          commandId: `mcp_draft_${Date.now()}`,
          companyId: grant.companyId,
          scheduledTick: nextTick,
          idempotencyKey: p.idempotency_key,
          type: 'CREATE_SUPPLY_OFFER',
          targetBuyerId: p.target_buyer_id,
          itemId: p.item_id as ItemId,
          quantity: p.quantity,
          unitPriceCredits: p.unit_price,
          deadlineTicks: currentTick + p.deadline_ticks,
        });

        if (!enqueued) {
          return this.recordFailure(
            startTime,
            currentTick,
            grant.grantId,
            grant.companyId,
            tool,
            payloadHash,
            'ERR_DUPLICATE_IDEMPOTENCY_KEY',
            `idempotency_key duplicate`
          );
        }

        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, {
          status: 'DRAFT_OFFER_ENQUEUED',
          scheduled_tick: nextTick,
          item_id: p.item_id,
          quantity: p.quantity,
          unit_price: p.unit_price,
        });
      }

      case 'cancel_own_pending_offer': {
        const p = CancelOwnPendingOfferSchema.parse(rawParams);

        const enqueued = this.engine.submitCommand({
          commandId: `mcp_cancel_${Date.now()}`,
          companyId: grant.companyId,
          scheduledTick: nextTick,
          idempotencyKey: p.idempotency_key,
          type: 'CANCEL_PENDING_OFFER',
          contractId: p.offer_id,
        });

        if (!enqueued) {
          return this.recordFailure(
            startTime,
            currentTick,
            grant.grantId,
            grant.companyId,
            tool,
            payloadHash,
            'ERR_DUPLICATE_IDEMPOTENCY_KEY',
            `idempotency_key duplicate`
          );
        }

        return this.recordSuccess(startTime, currentTick, grant, tool, payloadHash, {
          status: 'OFFER_CANCELLATION_ENQUEUED',
          scheduled_tick: nextTick,
          offer_id: p.offer_id,
        });
      }

      default:
        throw new Error(`Unhandled write tool: ${tool}`);
    }
  }

  // --- INTERNAL SAFETY & VALIDATION METHODS ---

  private verifyResourceAllowlist(grant: McpGrant, lineId: string): void {
    if (!grant.resourceAllowlist.includes(lineId)) {
      throw new Error(
        `ERR_RESOURCE_NOT_ALLOWED: Line ${lineId} is not in grant resource_allowlist [${grant.resourceAllowlist.join(
          ', '
        )}]`
      );
    }
  }

  private checkRateLimits(grant: McpGrant, isWriteTool: boolean): string | null {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    if (!isWriteTool) {
      let timestamps = this.readTimestamps.get(grant.grantId);
      if (!timestamps) {
        timestamps = [];
        this.readTimestamps.set(grant.grantId, timestamps);
      }
      // prune older than 1 minute
      const recent = timestamps.filter((t) => t > oneMinuteAgo);
      if (recent.length >= grant.quotas.maxReadPerMinute) {
        return `Read rate limit exceeded (${grant.quotas.maxReadPerMinute}/min)`;
      }
      recent.push(now);
      this.readTimestamps.set(grant.grantId, recent);
      return null;
    } else {
      let timestamps = this.writeTimestamps.get(grant.grantId);
      if (!timestamps) {
        timestamps = [];
        this.writeTimestamps.set(grant.grantId, timestamps);
      }
      const recent = timestamps.filter((t) => t > oneMinuteAgo);
      if (recent.length >= grant.quotas.maxWritePerMinute) {
        return `Write rate limit exceeded (${grant.quotas.maxWritePerMinute}/min)`;
      }

      const matchCount = (this.matchWriteCounts.get(grant.grantId) ?? 0) + 1;
      if (matchCount > grant.quotas.maxWritePerMatch) {
        return `Match write quota exceeded (${grant.quotas.maxWritePerMatch}/match)`;
      }

      recent.push(now);
      this.writeTimestamps.set(grant.grantId, recent);
      this.matchWriteCounts.set(grant.grantId, matchCount);
      return null;
    }
  }

  private checkLineCooldown(
    companyId: string,
    lineId: string,
    tool: string,
    currentTick: number
  ): void {
    const cooldownReq = LINE_COOLDOWNS_TICKS[tool] ?? 3;
    const key = `${companyId}:${lineId}:${tool}`;
    const lastTick = this.lineCooldowns.get(key);
    if (lastTick !== undefined) {
      const elapsed = currentTick - lastTick;
      if (elapsed < cooldownReq) {
        throw new Error(
          `ERR_COOLDOWN_ACTIVE: Action ${tool} on line ${lineId} is in cooldown for ${cooldownReq - elapsed} more ticks`
        );
      }
    }
  }

  private updateLineCooldown(
    companyId: string,
    lineId: string,
    tool: string,
    currentTick: number
  ): void {
    const key = `${companyId}:${lineId}:${tool}`;
    this.lineCooldowns.set(key, currentTick);
  }

  private recordSuccess<T>(
    startTime: number,
    currentTick: number,
    grant: McpGrant,
    tool: McpToolName,
    payloadHash: string,
    data: T
  ): McpResponse<T> {
    const latencyMs = Math.round(performance.now() - startTime);

    this.auditLogs.push({
      id: `audit_${++this.logCounter}`,
      timestampUtc: new Date().toISOString(),
      tick: currentTick,
      grantId: grant.grantId,
      companyId: grant.companyId,
      toolName: tool,
      payloadHash,
      resultCode: 'SUCCESS',
      executionTimeMs: latencyMs,
    });

    return {
      success: true,
      tick: currentTick,
      tool,
      data,
      latencyMs,
    };
  }

  private recordFailure(
    startTime: number,
    currentTick: number,
    grantId: string,
    companyId: string,
    toolName: string,
    payloadHash: string,
    errorCode: McpErrorCode,
    errorMessage: string
  ): McpResponse {
    const latencyMs = Math.round(performance.now() - startTime);

    this.auditLogs.push({
      id: `audit_${++this.logCounter}`,
      timestampUtc: new Date().toISOString(),
      tick: currentTick,
      grantId,
      companyId,
      toolName,
      payloadHash,
      resultCode: errorCode,
      executionTimeMs: latencyMs,
    });

    return {
      success: false,
      tick: currentTick,
      tool: toolName,
      errorCode,
      errorMessage,
      latencyMs,
    };
  }
}
