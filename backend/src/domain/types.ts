/**
 * GigaForge v4.1 - Domain Types
 * Strict integer-only domain models for authoritative discrete-tick industrial simulation.
 */

export type IndustrialClass = 'CLASS_A_METALLURGY' | 'CLASS_B_MANUFACTURING';

export type ItemId =
  | 'RAW_ORE'
  | 'IRON_INGOT'
  | 'STEEL_PLATE'
  | 'HEAVY_ALLOY'
  | 'MECH_FRAME'
  | 'CTRL_CIRCUIT'
  | 'POWER_MODULE'
  | 'IND_TURBINE'
  | 'MEGAMACHINE_PART';

export type RecipeId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';

export type LinePriority = 1 | 2 | 3;

export type LineStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'NO_ENERGY';

export type ContractStatus = 'DRAFT' | 'PENDING' | 'ACTIVE' | 'FULFILLED' | 'DEFAULTED' | 'CANCELLED';

export interface RecipeRequirement {
  readonly itemId: ItemId;
  readonly quantity: number; // Strict positive safe integer
}

export interface RecipeProfile {
  readonly durationTicks: number; // Strict positive integer
  readonly energyCost: number; // Strict positive integer total per batch
}

export interface RecipeDefinition {
  readonly id: RecipeId;
  readonly outputItem: ItemId;
  readonly outputQuantity: number;
  readonly inputs: readonly RecipeRequirement[];
  readonly classA: RecipeProfile;
  readonly classB: RecipeProfile;
  readonly estimatedBaseCostCredits: number;
  readonly name: string;
}

export interface RawOreExtractionSpec {
  readonly ticksPerCycle: number; // 10 ticks
  readonly outputQuantity: number; // 5 RAW_ORE
  readonly energyCostPerCycle: number; // 15 ENERGY
}

export interface InventoryStock {
  available: number; // Safe integer >= 0
  reserved: number; // Safe integer >= 0 (locked for active contracts or escrow)
}

export type InventoryMap = Record<ItemId, InventoryStock>;

export interface ProductionBatch {
  readonly recipeId: RecipeId;
  readonly targetBatches: number; // Total batches requested
  completedBatches: number;
  progressTicks: number; // Progress in current batch [0, durationTicks]
  totalDurationTicks: number; // Recipe duration for this company class
  energyPerTick: number; // Integer energy consumed each tick
  energyRemainder: number; // Remainder to distribute deterministically
}

export interface ProductionLine {
  readonly lineId: string;
  readonly companyId: string;
  priority: LinePriority;
  status: LineStatus;
  currentRecipeId: RecipeId | null;
  activeBatch: ProductionBatch | null;
  totalBatchesProduced: number;
  lastActionTick: number;
}

export interface SupplyContract {
  readonly contractId: string;
  readonly sellerCompanyId: string;
  readonly buyerCompanyId: string;
  readonly itemId: ItemId;
  readonly totalQuantity: number;
  deliveredQuantity: number;
  readonly unitPriceCredits: number;
  readonly totalValueCredits: number;
  readonly collateralSellerCredits: number; // 20% of totalValueCredits
  readonly createdAtTick: number;
  readonly deadlineTick: number;
  readonly penaltyPerMissingUnit: number; // 10 CREDITS per missing unit
  status: ContractStatus;
  settledAtTick?: number;
}

export interface CompanyState {
  readonly companyId: string;
  readonly name: string;
  readonly industrialClass: IndustrialClass;
  readonly isNPC: boolean;
  credits: number; // Safe integer
  energy: number; // Safe integer [0, maxEnergyStorage]
  maxEnergyStorage: number; // Default 1000, can expand
  energyGenerationPerTick: number; // Default 20, can expand (+15 per turbine)
  installedTurbinesR7: number; // Sunk into electric grid
  contributedMegamachinePartsR8: number; // Sunk into central assembler
  reputation: number; // Baseline 100
  inventory: InventoryMap;
  lines: ProductionLine[];
  maintenancePaidTicks: number;
}

export interface GlobalProjectState {
  readonly requiredMegamachineParts: number; // 12
  deliveredMegamachineParts: number;
  completedAtTick: number | null;
  isVictorious: boolean;
}

export type CommandType =
  | 'SET_PRODUCTION_TARGET'
  | 'SET_LINE_PRIORITY'
  | 'PAUSE_PRODUCTION_LINE'
  | 'RESUME_PRODUCTION_LINE'
  | 'SCHEDULE_INTERNAL_TRANSPORT'
  | 'CREATE_SUPPLY_OFFER'
  | 'ACCEPT_SUPPLY_OFFER'
  | 'CANCEL_PENDING_OFFER'
  | 'INSTALL_TURBINE_EXPANSION'
  | 'DELIVER_MEGAMACHINE_PART';

export interface BaseCommand {
  readonly commandId: string;
  readonly companyId: string;
  readonly scheduledTick: number;
  readonly sequenceNumber: number;
  readonly idempotencyKey: string;
  readonly type: CommandType;
}

export interface SetProductionTargetCommand extends BaseCommand {
  readonly type: 'SET_PRODUCTION_TARGET';
  readonly lineId: string;
  readonly recipeId: RecipeId;
  readonly targetBatches: number;
}

export interface SetLinePriorityCommand extends BaseCommand {
  readonly type: 'SET_LINE_PRIORITY';
  readonly lineId: string;
  readonly priority: LinePriority;
}

export interface PauseProductionLineCommand extends BaseCommand {
  readonly type: 'PAUSE_PRODUCTION_LINE';
  readonly lineId: string;
}

export interface ResumeProductionLineCommand extends BaseCommand {
  readonly type: 'RESUME_PRODUCTION_LINE';
  readonly lineId: string;
}

export interface ScheduleInternalTransportCommand extends BaseCommand {
  readonly type: 'SCHEDULE_INTERNAL_TRANSPORT';
  readonly contractId: string;
  readonly quantityToShip: number;
}

export interface CreateSupplyOfferCommand extends BaseCommand {
  readonly type: 'CREATE_SUPPLY_OFFER';
  readonly targetBuyerId?: string;
  readonly itemId: ItemId;
  readonly quantity: number;
  readonly unitPriceCredits: number;
  readonly deadlineTicks: number;
}

export interface AcceptSupplyOfferCommand extends BaseCommand {
  readonly type: 'ACCEPT_SUPPLY_OFFER';
  readonly contractId: string;
}

export interface CancelPendingOfferCommand extends BaseCommand {
  readonly type: 'CANCEL_PENDING_OFFER';
  readonly contractId: string;
}

export interface InstallTurbineExpansionCommand extends BaseCommand {
  readonly type: 'INSTALL_TURBINE_EXPANSION';
}

export interface DeliverMegamachinePartCommand extends BaseCommand {
  readonly type: 'DELIVER_MEGAMACHINE_PART';
  readonly quantity: number;
}

export type GameCommand =
  | SetProductionTargetCommand
  | SetLinePriorityCommand
  | PauseProductionLineCommand
  | ResumeProductionLineCommand
  | ScheduleInternalTransportCommand
  | CreateSupplyOfferCommand
  | AcceptSupplyOfferCommand
  | CancelPendingOfferCommand
  | InstallTurbineExpansionCommand
  | DeliverMegamachinePartCommand;

export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
export type EnqueueCommandInput = DistributiveOmit<GameCommand, 'sequenceNumber'>;

export interface CommandExecutionResult {
  /** Absent only on legacy history whose owner cannot be established safely. */
  readonly companyId?: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly executedAtTick: number;
  readonly success: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface SimulationSnapshot {
  readonly tick: number;
  readonly stateHash: string;
  readonly companies: Record<string, CompanyState>;
  readonly contracts: Record<string, SupplyContract>;
  readonly globalProject: GlobalProjectState;
}

export interface CompanyNetWorthBreakdown {
  readonly companyId: string;
  readonly credits: number;
  readonly r8ContributedCredits: number; // parts * 6000
  readonly r7InstalledCredits: number; // turbines * 2000
  readonly reputationCredits: number; // reputation * 50
  readonly netWorth: number;
}
