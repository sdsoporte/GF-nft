/**
 * GigaForge v4.1 - MCP Zod Schemas & Sanitization
 * Specification: Strict validation against indirect prompt injection and illegal operations.
 */

import { z } from 'zod';

/**
 * Sanitized identifier regex:
 * Only uppercase alphanumeric and underscores permitted (e.g. COMP_METAL_01).
 * Completely mitigates prompt injection via free-text entity names.
 */
export const SANITIZED_ID_REGEX = /^[A-Z0-9_]{3,32}$/;
export const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;

export const CompanyIdSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(
    /^[a-zA-Z0-9_]{3,32}$/,
    'Company ID must be alphanumeric/underscores only'
  );

export const LineIdSchema = z
  .string()
  .min(3)
  .max(48)
  .regex(
    /^[a-zA-Z0-9_]{3,48}$/,
    'Line ID must be alphanumeric/underscores only'
  );

export const RecipeIdEnum = z.enum(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']);

export const ItemIdEnum = z.enum([
  'RAW_ORE',
  'IRON_INGOT',
  'STEEL_PLATE',
  'HEAVY_ALLOY',
  'MECH_FRAME',
  'CTRL_CIRCUIT',
  'POWER_MODULE',
  'IND_TURBINE',
  'MEGAMACHINE_PART',
]);

export const ContractStatusEnum = z.enum([
  'DRAFT',
  'PENDING',
  'ACTIVE',
  'FULFILLED',
  'DEFAULTED',
  'CANCELLED',
]);

export const LinePrioritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(64)
  .regex(
    IDEMPOTENCY_KEY_REGEX,
    'idempotency_key must be 8-64 alphanumeric chars, dashes or underscores'
  );

// --- READ TOOL SCHEMAS ---

export const GetFactoryOverviewSchema = z.object({
  company_id: CompanyIdSchema,
});

export const GetInventorySchema = z.object({
  company_id: CompanyIdSchema,
});

export const GetProductionLinesSchema = z.object({
  company_id: CompanyIdSchema,
});

export const GetContractsSchema = z.object({
  company_id: CompanyIdSchema,
  status: ContractStatusEnum.optional(),
});

export const GetMarketQuotesSchema = z.object({
  item_id: ItemIdEnum.optional(),
  limit: z.number().int().min(1).max(25).default(25),
});

export const GetActionHistorySchema = z.object({
  company_id: CompanyIdSchema,
  last_n_ticks: z.number().int().min(1).max(300).default(50),
});

// --- WRITE TOOL SCHEMAS (FASE 1B) ---

export const SetProductionTargetSchema = z.object({
  line_id: LineIdSchema,
  recipe_id: RecipeIdEnum,
  target_batches: z.number().int().min(1).max(100),
  idempotency_key: IdempotencyKeySchema,
});

export const SetLinePrioritySchema = z.object({
  line_id: LineIdSchema,
  priority: LinePrioritySchema,
  idempotency_key: IdempotencyKeySchema,
});

export const PauseProductionLineSchema = z.object({
  line_id: LineIdSchema,
  idempotency_key: IdempotencyKeySchema,
});

export const ResumeProductionLineSchema = z.object({
  line_id: LineIdSchema,
  idempotency_key: IdempotencyKeySchema,
});

export const ScheduleInternalTransportSchema = z.object({
  contract_id: z.string().min(5).max(48),
  quantity_to_ship: z.number().int().min(1).max(1000),
  idempotency_key: IdempotencyKeySchema,
});

export const DraftSupplyOfferSchema = z.object({
  target_buyer_id: CompanyIdSchema.optional(),
  item_id: ItemIdEnum,
  quantity: z.number().int().min(1).max(5000),
  unit_price: z.number().int().min(1).max(100000),
  deadline_ticks: z.number().int().min(10).max(2700),
  idempotency_key: IdempotencyKeySchema,
});

export const CancelOwnPendingOfferSchema = z.object({
  offer_id: z.string().min(5).max(48),
  idempotency_key: IdempotencyKeySchema,
});

/**
 * Sanitization helper for entity names exposed over MCP
 * Replaces non-permitted characters with underscores and forces uppercase.
 */
export function sanitizeMcpIdentifier(rawName: string): string {
  const sanitized = rawName
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 32);
  return sanitized.length >= 3 ? sanitized : `COMP_${sanitized}`;
}
