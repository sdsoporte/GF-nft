/**
 * GigaForge v4.1 - Simulator Engine
 * Authoritative discrete-tick industrial strategy simulation engine.
 *
 * Rules:
 * - Pure integer arithmetic (Number.isSafeInteger enforced)
 * - Deterministic PRNG (Mulberry32)
 * - Deterministic CommandQueue with idempotency validation
 * - 2,700 ticks standard match (45 minutes, 1 tick = 1 second)
 * - Asymmetric industrial classes (Class A Metallurgy vs Class B Manufacturing)
 * - B2B SupplyContract escrow & 20% collateral execution
 * - NetWorth calculation and Megamachine global project evaluation
 */

import {
  calculateEnergyPerTick,
  getRecipe,
  getRecipeProfile,
  getTransportEnergyCost,
  RAW_ORE_EXTRACTION,
  assertSafeInteger,
} from '../domain/recipeCatalog.ts';
import {
  CompanyNetWorthBreakdown,
  CompanyState,
  CommandExecutionResult,
  EnqueueCommandInput,
  GameCommand,
  GlobalProjectState,
  IndustrialClass,
  ItemId,
  LinePriority,
  ProductionBatch,
  ProductionLine,
  RecipeId,
  SimulationSnapshot,
  SupplyContract,
} from '../domain/types.ts';

/**
 * Deterministic PRNG: Mulberry32
 * Generates 32-bit unsigned integers from a reproducible 32-bit seed.
 */
export class Mulberry32PRNG {
  private state: number;

  constructor(seed: number) {
    assertSafeInteger(seed, 'seed');
    this.state = seed >>> 0;
  }

  /**
   * Return unsigned 32-bit integer [0, 4294967295]
   */
  public nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /**
   * Return integer in range [min, max] inclusive
   */
  public nextIntRange(min: number, max: number): number {
    assertSafeInteger(min, 'min');
    assertSafeInteger(max, 'max');
    if (min > max) {
      throw new Error(`[Mulberry32] Invalid range: min ${min} > max ${max}`);
    }
    const span = max - min + 1;
    return min + (this.nextUint32() % span);
  }

  public getSeed(): number {
    return this.state;
  }
}

/**
 * Helper to create initial blank inventory
 */
export function createEmptyInventory(): Record<ItemId, { available: number; reserved: number }> {
  return {
    RAW_ORE: { available: 0, reserved: 0 },
    IRON_INGOT: { available: 0, reserved: 0 },
    STEEL_PLATE: { available: 0, reserved: 0 },
    HEAVY_ALLOY: { available: 0, reserved: 0 },
    MECH_FRAME: { available: 0, reserved: 0 },
    CTRL_CIRCUIT: { available: 0, reserved: 0 },
    POWER_MODULE: { available: 0, reserved: 0 },
    IND_TURBINE: { available: 0, reserved: 0 },
    MEGAMACHINE_PART: { available: 0, reserved: 0 },
  };
}

/**
 * Authoritative Command Queue with tick-based ordering, sequence sorting,
 * and idempotency deduplication.
 */
export class CommandQueue {
  private queue: GameCommand[] = [];
  private processedIdempotencyKeys = new Set<string>();
  private sequenceCounter = 0;

  public enqueue(command: EnqueueCommandInput): boolean {
    if (this.processedIdempotencyKeys.has(command.idempotencyKey)) {
      return false; // Duplicate rejected
    }

    const fullCommand = {
      ...command,
      sequenceNumber: ++this.sequenceCounter,
    } as GameCommand;

    this.queue.push(fullCommand);
    this.processedIdempotencyKeys.add(command.idempotencyKey);

    // Sort queue deterministically: first by scheduledTick, then by arrival sequenceNumber
    this.queue.sort((a, b) => {
      if (a.scheduledTick !== b.scheduledTick) {
        return a.scheduledTick - b.scheduledTick;
      }
      return a.sequenceNumber - b.sequenceNumber;
    });

    return true;
  }

  public dequeueForTick(currentTick: number): GameCommand[] {
    const readyCommands: GameCommand[] = [];
    const remaining: GameCommand[] = [];

    for (const cmd of this.queue) {
      if (cmd.scheduledTick <= currentTick) {
        readyCommands.push(cmd);
      } else {
        remaining.push(cmd);
      }
    }

    this.queue = remaining;
    return readyCommands;
  }

  public isIdempotencyKeyUsed(key: string): boolean {
    return this.processedIdempotencyKeys.has(key);
  }

  public getPendingCount(): number {
    return this.queue.length;
  }
}

/**
 * Authoritative Discrete-Tick Simulator Engine
 */
export class SimulatorEngine {
  public static readonly MATCH_TOTAL_TICKS = 2700;
  public static readonly MAINTENANCE_INTERVAL_TICKS = 300;
  public static readonly MAINTENANCE_COST_PER_LINE = 100;
  public static readonly TURBINE_EXPANSION_UNLOCK_TICK = 900;
  public static readonly MARKET_TRANSACTION_FEE_BPS = 200; // 2% fee (200 bps)

  private currentTick = 0;
  private readonly rng: Mulberry32PRNG;
  private readonly commandQueue: CommandQueue = new CommandQueue();
  private readonly commandResults: CommandExecutionResult[] = [];

  private companies: Map<string, CompanyState> = new Map();
  private contracts: Map<string, SupplyContract> = new Map();
  private globalProject: GlobalProjectState = {
    requiredMegamachineParts: 12,
    deliveredMegamachineParts: 0,
    completedAtTick: null,
    isVictorious: false,
  };

  private contractCounter = 0;

  constructor(seed: number = 42107) {
    this.rng = new Mulberry32PRNG(seed);
  }

  /**
   * Initialize a standard 4-company match as defined in GAME_DESIGN_MVP.md:
   * 2 Class A (Metallurgy) and 2 Class B (Manufacturing).
   */
  public initializeStandardMatch(customCompanies?: Array<{
    id: string;
    name: string;
    industrialClass: IndustrialClass;
    isNPC: boolean;
  }>): void {
    this.currentTick = 0;
    this.companies.clear();
    this.contracts.clear();
    this.globalProject = {
      requiredMegamachineParts: 12,
      deliveredMegamachineParts: 0,
      completedAtTick: null,
      isVictorious: false,
    };

    const companyConfigs = customCompanies ?? [
      {
        id: 'comp_metal_01',
        name: 'AeroMetals Heavy Forge',
        industrialClass: 'CLASS_A_METALLURGY',
        isNPC: false,
      },
      {
        id: 'comp_metal_02',
        name: 'Vulcan Smelting Co (NPC)',
        industrialClass: 'CLASS_A_METALLURGY',
        isNPC: true,
      },
      {
        id: 'comp_manuf_01',
        name: 'Apex Robotics Assembly',
        industrialClass: 'CLASS_B_MANUFACTURING',
        isNPC: false,
      },
      {
        id: 'comp_manuf_02',
        name: 'Vector Dynamics Tech (NPC)',
        industrialClass: 'CLASS_B_MANUFACTURING',
        isNPC: true,
      },
    ];

    for (const config of companyConfigs) {
      const inventory = createEmptyInventory();
      // Starting capital per GAME_DESIGN_MVP.md:
      // 10,000 CREDITS, 200 RAW_ORE, +20 ENERGY/tick base generation (storage 1,000)
      inventory.RAW_ORE.available = 200;

      const lines: ProductionLine[] = [
        {
          lineId: `${config.id}_line_1`,
          companyId: config.id,
          priority: 1,
          status: 'IDLE',
          currentRecipeId: null,
          activeBatch: null,
          totalBatchesProduced: 0,
          lastActionTick: 0,
        },
        {
          lineId: `${config.id}_line_2`,
          companyId: config.id,
          priority: 2,
          status: 'IDLE',
          currentRecipeId: null,
          activeBatch: null,
          totalBatchesProduced: 0,
          lastActionTick: 0,
        },
        {
          lineId: `${config.id}_line_3`,
          companyId: config.id,
          priority: 3,
          status: 'IDLE',
          currentRecipeId: null,
          activeBatch: null,
          totalBatchesProduced: 0,
          lastActionTick: 0,
        },
      ];

      const companyState: CompanyState = {
        companyId: config.id,
        name: config.name,
        industrialClass: config.industrialClass,
        isNPC: config.isNPC,
        credits: 10000,
        energy: 400, // Starting reserve within [0, 1000]
        maxEnergyStorage: 1000,
        energyGenerationPerTick: 20,
        installedTurbinesR7: 0,
        contributedMegamachinePartsR8: 0,
        reputation: 100,
        inventory,
        lines,
        maintenancePaidTicks: 0,
      };

      this.companies.set(config.id, companyState);
    }
  }

  public getCurrentTick(): number {
    return this.currentTick;
  }

  public getCompany(companyId: string): CompanyState | undefined {
    return this.companies.get(companyId);
  }

  public getAllCompanies(): CompanyState[] {
    return Array.from(this.companies.values());
  }

  public getContract(contractId: string): SupplyContract | undefined {
    return this.contracts.get(contractId);
  }

  public getAllContracts(): SupplyContract[] {
    return Array.from(this.contracts.values());
  }

  public getGlobalProject(): GlobalProjectState {
    return { ...this.globalProject };
  }

  public getCommandQueue(): CommandQueue {
    return this.commandQueue;
  }

  public getExecutionHistory(limit?: number): CommandExecutionResult[] {
    if (!limit) return [...this.commandResults];
    return this.commandResults.slice(-limit);
  }

  /**
   * Enqueue command into authoritative queue
   */
  public submitCommand(command: EnqueueCommandInput): boolean {
    return this.commandQueue.enqueue(command);
  }

  /**
   * Advance the simulation by 1 discrete tick.
   * Deterministic execution order:
   * 1. Process and execute queued commands scheduled for this tick
   * 2. Natural Raw Ore extraction cycles
   * 3. Energy generation and distribution across lines strictly by priority
   * 4. Production batch progress advancement and completion
   * 5. Periodic maintenance fee collection every 300 ticks
   * 6. Contract expiration, default checks, and collateral resolution
   * 7. Tick 2700 NetWorth evaluation & global win check
   */
  public processTick(): SimulationSnapshot {
    this.currentTick += 1;
    assertSafeInteger(this.currentTick, 'currentTick');

    // Step 1: Execute queued commands
    const readyCommands = this.commandQueue.dequeueForTick(this.currentTick);
    for (const cmd of readyCommands) {
      const result = this.executeCommand(cmd);
      this.commandResults.push(result);
    }

    // Step 2: Natural raw ore extraction for all companies
    this.processRawOreExtraction();

    // Step 3 & 4: Energy generation & Production line progression by priority
    this.processEnergyAndProduction();

    // Step 5: Maintenance collection every 300 ticks
    if (this.currentTick % SimulatorEngine.MAINTENANCE_INTERVAL_TICKS === 0) {
      this.processMaintenance();
    }

    // Step 6: Contracts lifecycle & collateral execution
    this.processContractsLifecycle();

    // Step 7: Check match conclusion at Tick 2700
    if (this.currentTick === SimulatorEngine.MATCH_TOTAL_TICKS) {
      this.evaluateMatchConclusion();
    }

    return this.createSnapshot();
  }

  /**
   * Step 2: Raw ore extraction
   * 1 extraction line produces 5 RAW_ORE every 10 ticks consuming 15 ENERGY
   */
  private processRawOreExtraction(): void {
    const cycle = RAW_ORE_EXTRACTION.ticksPerCycle;
    if (this.currentTick % cycle === 0) {
      for (const company of this.companies.values()) {
        if (company.energy >= RAW_ORE_EXTRACTION.energyCostPerCycle) {
          company.energy -= RAW_ORE_EXTRACTION.energyCostPerCycle;
          company.inventory.RAW_ORE.available += RAW_ORE_EXTRACTION.outputQuantity;
        }
      }
    }
  }

  /**
   * Step 3 & 4: Energy Generation & Priority-based consumption
   */
  private processEnergyAndProduction(): void {
    for (const company of this.companies.values()) {
      // Generate energy for tick
      company.energy = Math.min(
        company.maxEnergyStorage,
        company.energy + company.energyGenerationPerTick
      );

      // Sort lines by priority (1 is highest, then 2, then 3). Ties broken by lineId
      const sortedLines = [...company.lines].sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }
        return a.lineId.localeCompare(b.lineId);
      });

      for (const line of sortedLines) {
        if (line.status === 'PAUSED' || !line.activeBatch) {
          continue;
        }

        const batch = line.activeBatch;
        // Calculate energy cost for this tick
        const energyRequiredThisTick =
          batch.energyPerTick + (batch.progressTicks < batch.energyRemainder ? 1 : 0);

        if (company.energy >= energyRequiredThisTick) {
          // Allocate energy and advance progress
          company.energy -= energyRequiredThisTick;
          line.status = 'RUNNING';
          batch.progressTicks += 1;

          // Check if batch finished
          if (batch.progressTicks >= batch.totalDurationTicks) {
            this.completeBatch(company, line, batch);
          }
        } else {
          // Insufficient energy: line starves this tick
          line.status = 'NO_ENERGY';
        }
      }
    }
  }

  /**
   * Complete batch and either start next batch or idle
   */
  private completeBatch(
    company: CompanyState,
    line: ProductionLine,
    batch: ProductionBatch
  ): void {
    const recipe = getRecipe(batch.recipeId);
    company.inventory[recipe.outputItem].available += recipe.outputQuantity;
    batch.completedBatches += 1;
    line.totalBatchesProduced += 1;

    if (batch.completedBatches < batch.targetBatches) {
      // Attempt to deduct materials for next batch
      const canStartNext = this.deductRecipeInputs(company, batch.recipeId);
      if (canStartNext) {
        batch.progressTicks = 0;
        line.status = 'RUNNING';
      } else {
        // Material shortage: the next batch never started because its inputs
        // could not be deducted, so no active batch may remain. Retaining the
        // completed batch here let RESUME_PRODUCTION_LINE replay completion
        // and credit output for free (issue #1). The line waits in PAUSED
        // with no active batch; the operator restarts it with
        // SET_PRODUCTION_TARGET, which deducts inputs before creating a batch.
        line.activeBatch = null;
        line.status = 'PAUSED';
      }
    } else {
      // Completed all target batches
      line.activeBatch = null;
      line.status = 'IDLE';
    }
  }

  /**
   * Deduct required recipe inputs from company available inventory
   */
  private deductRecipeInputs(company: CompanyState, recipeId: RecipeId): boolean {
    const recipe = getRecipe(recipeId);

    // Verify all inputs are available
    for (const req of recipe.inputs) {
      if (company.inventory[req.itemId].available < req.quantity) {
        return false;
      }
    }

    // Deduct inputs
    for (const req of recipe.inputs) {
      company.inventory[req.itemId].available -= req.quantity;
      assertSafeInteger(company.inventory[req.itemId].available, 'inventory.available');
    }

    return true;
  }

  /**
   * Step 5: Maintenance collection every 300 ticks
   * Each active line consumes 100 CREDITS. Unpaid lines suffer status pause & reputation penalty.
   */
  private processMaintenance(): void {
    for (const company of this.companies.values()) {
      let activeLineCount = 0;
      for (const line of company.lines) {
        if (line.status === 'RUNNING' || line.status === 'NO_ENERGY') {
          activeLineCount += 1;
        }
      }

      const totalMaintenanceDue = activeLineCount * SimulatorEngine.MAINTENANCE_COST_PER_LINE;
      if (company.credits >= totalMaintenanceDue) {
        company.credits -= totalMaintenanceDue;
        company.maintenancePaidTicks += 1;
      } else {
        // Insufficient credits: deduct remaining credits, pause lines, penalize reputation
        company.credits = Math.max(0, company.credits - totalMaintenanceDue);
        company.reputation = Math.max(0, company.reputation - 5);
        for (const line of company.lines) {
          if (line.status === 'RUNNING') {
            line.status = 'PAUSED';
          }
        }
      }
    }
  }

  /**
   * Step 6: Contracts lifecycle & collateral execution
   */
  private processContractsLifecycle(): void {
    for (const contract of this.contracts.values()) {
      if (contract.status !== 'ACTIVE') {
        continue;
      }

      // Check if expired
      if (this.currentTick > contract.deadlineTick) {
        if (contract.deliveredQuantity < contract.totalQuantity) {
          // DEFAULTED CONTRACT
          contract.status = 'DEFAULTED';
          contract.settledAtTick = this.currentTick;

          const seller = this.companies.get(contract.sellerCompanyId);
          const buyer = this.companies.get(contract.buyerCompanyId);

          const missingUnits = contract.totalQuantity - contract.deliveredQuantity;
          const undeliveredValue = missingUnits * contract.unitPriceCredits;
          const penaltyAmount = missingUnits * contract.penaltyPerMissingUnit;

          if (buyer) {
            // Buyer is refunded undelivered value from locked funds
            buyer.credits += undeliveredValue;
            // Buyer is indemnified using seller collateral
            const indemnity = Math.min(contract.collateralSellerCredits, penaltyAmount);
            buyer.credits += indemnity;
          }

          if (seller) {
            // Seller loses reputation
            seller.reputation = Math.max(0, seller.reputation - 15);
            // Return remaining collateral if indemnity was less than collateral
            const indemnityPaid = Math.min(contract.collateralSellerCredits, penaltyAmount);
            const remainingCollateral = contract.collateralSellerCredits - indemnityPaid;
            if (remainingCollateral > 0) {
              seller.credits += remainingCollateral;
            }
          }
        }
      }
    }
  }

  /**
   * Step 7: Evaluate match conclusion at Tick 2700
   */
  private evaluateMatchConclusion(): void {
    if (this.globalProject.deliveredMegamachineParts >= this.globalProject.requiredMegamachineParts) {
      this.globalProject.isVictorious = true;
      if (this.globalProject.completedAtTick === null) {
        this.globalProject.completedAtTick = this.currentTick;
      }
    }
  }

  /**
   * Calculate final NetWorth for a company according to GAME_DESIGN_MVP.md:
   * NetWorth = CREDITS + (Partes R8 * 6000) + (Turbinas R7 * 2000) + (Reputacion * 50)
   */
  public calculateNetWorth(companyId: string): CompanyNetWorthBreakdown {
    const company = this.companies.get(companyId);
    if (!company) {
      throw new Error(`[GigaForge] Company not found: ${companyId}`);
    }

    const r8Score = company.contributedMegamachinePartsR8 * 6000;
    const r7Score = company.installedTurbinesR7 * 2000;
    const repScore = company.reputation * 50;
    const netWorth = company.credits + r8Score + r7Score + repScore;

    assertSafeInteger(netWorth, 'netWorth');

    return {
      companyId: company.companyId,
      credits: company.credits,
      r8ContributedCredits: r8Score,
      r7InstalledCredits: r7Score,
      reputationCredits: repScore,
      netWorth,
    };
  }

  /**
   * Execute an authoritative command
   */
  private executeCommand(cmd: GameCommand): CommandExecutionResult {
    const company = this.companies.get(cmd.companyId);
    if (!company) {
      return {
        commandId: cmd.commandId,
        idempotencyKey: cmd.idempotencyKey,
        executedAtTick: this.currentTick,
        success: false,
        errorCode: 'ERR_COMPANY_NOT_FOUND',
        errorMessage: `Company ${cmd.companyId} does not exist`,
      };
    }

    switch (cmd.type) {
      case 'SET_PRODUCTION_TARGET': {
        const line = company.lines.find((l) => l.lineId === cmd.lineId);
        if (!line) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_LINE_NOT_FOUND',
            errorMessage: `Line ${cmd.lineId} not found in company`,
          };
        }

        assertSafeInteger(cmd.targetBatches, 'targetBatches');
        if (cmd.targetBatches <= 0) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INVALID_BATCH_COUNT',
            errorMessage: 'Target batches must be positive integer',
          };
        }

        const profile = getRecipeProfile(cmd.recipeId, company.industrialClass);
        const { energyPerTick, energyRemainder } = calculateEnergyPerTick(
          profile.energyCost,
          profile.durationTicks
        );

        // Attempt deduction for first batch
        const canStart = this.deductRecipeInputs(company, cmd.recipeId);
        if (!canStart) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INSUFFICIENT_INVENTORY',
            errorMessage: `Insufficient materials to start recipe ${cmd.recipeId}`,
          };
        }

        line.currentRecipeId = cmd.recipeId;
        line.status = 'RUNNING';
        line.lastActionTick = this.currentTick;
        line.activeBatch = {
          recipeId: cmd.recipeId,
          targetBatches: cmd.targetBatches,
          completedBatches: 0,
          progressTicks: 0,
          totalDurationTicks: profile.durationTicks,
          energyPerTick,
          energyRemainder,
        };

        return {
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          executedAtTick: this.currentTick,
          success: true,
        };
      }

      case 'SET_LINE_PRIORITY': {
        const line = company.lines.find((l) => l.lineId === cmd.lineId);
        if (!line) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_LINE_NOT_FOUND',
            errorMessage: `Line ${cmd.lineId} not found`,
          };
        }
        line.priority = cmd.priority;
        line.lastActionTick = this.currentTick;
        return {
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          executedAtTick: this.currentTick,
          success: true,
        };
      }

      case 'PAUSE_PRODUCTION_LINE': {
        const line = company.lines.find((l) => l.lineId === cmd.lineId);
        if (!line) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_LINE_NOT_FOUND',
            errorMessage: `Line ${cmd.lineId} not found`,
          };
        }
        line.status = 'PAUSED';
        line.lastActionTick = this.currentTick;
        return {
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          executedAtTick: this.currentTick,
          success: true,
        };
      }

      case 'RESUME_PRODUCTION_LINE': {
        const line = company.lines.find((l) => l.lineId === cmd.lineId);
        if (!line) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_LINE_NOT_FOUND',
            errorMessage: `Line ${cmd.lineId} not found`,
          };
        }
        if (line.activeBatch) {
          line.status = 'RUNNING';
        } else {
          line.status = 'IDLE';
        }
        line.lastActionTick = this.currentTick;
        return {
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          executedAtTick: this.currentTick,
          success: true,
        };
      }

      case 'CREATE_SUPPLY_OFFER': {
        assertSafeInteger(cmd.quantity, 'quantity');
        assertSafeInteger(cmd.unitPriceCredits, 'unitPriceCredits');
        assertSafeInteger(cmd.deadlineTicks, 'deadlineTicks');

        if (cmd.quantity <= 0 || cmd.unitPriceCredits <= 0 || cmd.deadlineTicks <= this.currentTick) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INVALID_OFFER_PARAMS',
            errorMessage: 'Offer parameters must be positive integers and deadline in the future',
          };
        }

        const totalValue = cmd.quantity * cmd.unitPriceCredits;
        const collateralSeller = Math.floor((totalValue * 20) / 100); // 20% collateral

        if (company.credits < collateralSeller) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INSUFFICIENT_COLLATERAL',
            errorMessage: `Seller requires ${collateralSeller} CREDITS collateral (20%)`,
          };
        }

        const contractId = `cnt_${this.currentTick}_${++this.contractCounter}`;
        const newContract: SupplyContract = {
          contractId,
          sellerCompanyId: company.companyId,
          buyerCompanyId: cmd.targetBuyerId || '',
          itemId: cmd.itemId,
          totalQuantity: cmd.quantity,
          deliveredQuantity: 0,
          unitPriceCredits: cmd.unitPriceCredits,
          totalValueCredits: totalValue,
          collateralSellerCredits: collateralSeller,
          createdAtTick: this.currentTick,
          deadlineTick: cmd.deadlineTicks,
          penaltyPerMissingUnit: 10,
          status: 'PENDING',
        };

        this.contracts.set(contractId, newContract);

        return {
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          executedAtTick: this.currentTick,
          success: true,
        };
      }

      case 'ACCEPT_SUPPLY_OFFER': {
        const contract = this.contracts.get(cmd.contractId);
        if (!contract || contract.status !== 'PENDING') {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_OFFER_NOT_AVAILABLE',
            errorMessage: 'Offer does not exist or is not pending',
          };
        }

        const seller = this.companies.get(contract.sellerCompanyId);
        if (!seller) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_SELLER_NOT_FOUND',
            errorMessage: 'Seller company does not exist',
          };
        }

        // Verify buyer funds (100% of contract locked in escrow)
        if (company.credits < contract.totalValueCredits) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INSUFFICIENT_BUYER_FUNDS',
            errorMessage: `Buyer requires ${contract.totalValueCredits} CREDITS to accept`,
          };
        }

        // Verify seller collateral (20% locked)
        if (seller.credits < contract.collateralSellerCredits) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INSUFFICIENT_SELLER_COLLATERAL',
            errorMessage: 'Seller lacks required 20% collateral',
          };
        }

        // Lock buyer funds & seller collateral
        company.credits -= contract.totalValueCredits;
        seller.credits -= contract.collateralSellerCredits;

        // Activate contract
        // Re-assign buyer if it was open
        const updatedContract: SupplyContract = {
          ...contract,
          buyerCompanyId: company.companyId,
          status: 'ACTIVE',
        };
        this.contracts.set(contract.contractId, updatedContract);

        return {
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          executedAtTick: this.currentTick,
          success: true,
        };
      }

      case 'CANCEL_PENDING_OFFER': {
        const contract = this.contracts.get(cmd.contractId);
        if (!contract || contract.sellerCompanyId !== company.companyId || contract.status !== 'PENDING') {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_CANNOT_CANCEL',
            errorMessage: 'Only pending offers owned by the company can be cancelled',
          };
        }
        contract.status = 'CANCELLED';
        contract.settledAtTick = this.currentTick;
        return {
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          executedAtTick: this.currentTick,
          success: true,
        };
      }

      case 'SCHEDULE_INTERNAL_TRANSPORT': {
        const contract = this.contracts.get(cmd.contractId);
        if (!contract || contract.status !== 'ACTIVE') {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_CONTRACT_NOT_ACTIVE',
            errorMessage: 'Target contract is not active',
          };
        }

        if (contract.sellerCompanyId !== company.companyId) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_UNAUTHORIZED_DISPATCH',
            errorMessage: 'Only seller can dispatch goods for this contract',
          };
        }

        assertSafeInteger(cmd.quantityToShip, 'quantityToShip');
        if (cmd.quantityToShip <= 0) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INVALID_DISPATCH_QUANTITY',
            errorMessage: 'Dispatch quantity must be positive integer',
          };
        }

        const remainingNeeded = contract.totalQuantity - contract.deliveredQuantity;
        const actualQuantity = Math.min(cmd.quantityToShip, remainingNeeded);

        // Check stock
        if (company.inventory[contract.itemId].available < actualQuantity) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INSUFFICIENT_STOCK',
            errorMessage: `Insufficient stock of ${contract.itemId} to ship`,
          };
        }

        // Check transport energy (Class A pays 2 ENERGY per lot; Class B pays 0)
        const transportEnergy = getTransportEnergyCost(company.industrialClass, actualQuantity);
        if (company.energy < transportEnergy) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INSUFFICIENT_TRANSPORT_ENERGY',
            errorMessage: `Logistics requires ${transportEnergy} ENERGY`,
          };
        }

        // Execute dispatch
        company.energy -= transportEnergy;
        company.inventory[contract.itemId].available -= actualQuantity;

        const buyer = this.companies.get(contract.buyerCompanyId);
        if (buyer) {
          buyer.inventory[contract.itemId].available += actualQuantity;
        }

        contract.deliveredQuantity += actualQuantity;

        // Check fulfillment
        if (contract.deliveredQuantity >= contract.totalQuantity) {
          contract.status = 'FULFILLED';
          contract.settledAtTick = this.currentTick;

          // Return seller collateral
          company.credits += contract.collateralSellerCredits;

          // 2% market transaction fee burned
          const marketFee = Math.floor(
            (contract.totalValueCredits * SimulatorEngine.MARKET_TRANSACTION_FEE_BPS) / 10000
          );
          const netPayment = contract.totalValueCredits - marketFee;
          company.credits += netPayment;

          // Both participants gain reputation for successful contract
          company.reputation += 5;
          if (buyer) {
            buyer.reputation += 5;
          }
        }

        return {
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          executedAtTick: this.currentTick,
          success: true,
        };
      }

      case 'INSTALL_TURBINE_EXPANSION': {
        // Unlocked from tick 900
        if (this.currentTick < SimulatorEngine.TURBINE_EXPANSION_UNLOCK_TICK) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_EXPANSION_LOCKED',
            errorMessage: `Turbine expansion unlocks at Tick ${SimulatorEngine.TURBINE_EXPANSION_UNLOCK_TICK}`,
          };
        }

        if (company.inventory.IND_TURBINE.available < 1) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_MISSING_TURBINE',
            errorMessage: 'Company needs at least 1 IND_TURBINE in inventory',
          };
        }

        // Consume 1 IND_TURBINE
        company.inventory.IND_TURBINE.available -= 1;
        company.installedTurbinesR7 += 1;
        // Expand electric grid: +15 generation, +250 storage
        company.energyGenerationPerTick += 15;
        company.maxEnergyStorage += 250;

        // Add 1 extra configurable line
        const newLineNumber = company.lines.length + 1;
        company.lines.push({
          lineId: `${company.companyId}_line_${newLineNumber}`,
          companyId: company.companyId,
          priority: 2,
          status: 'IDLE',
          currentRecipeId: null,
          activeBatch: null,
          totalBatchesProduced: 0,
          lastActionTick: this.currentTick,
        });

        return {
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          executedAtTick: this.currentTick,
          success: true,
        };
      }

      case 'DELIVER_MEGAMACHINE_PART': {
        assertSafeInteger(cmd.quantity, 'quantity');
        if (cmd.quantity <= 0) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INVALID_DELIVERY_QUANTITY',
            errorMessage: 'Delivery quantity must be positive integer',
          };
        }

        if (company.inventory.MEGAMACHINE_PART.available < cmd.quantity) {
          return {
            commandId: cmd.commandId,
            idempotencyKey: cmd.idempotencyKey,
            executedAtTick: this.currentTick,
            success: false,
            errorCode: 'ERR_INSUFFICIENT_MEGAMACHINE_PARTS',
            errorMessage: `Insufficient MEGAMACHINE_PART in inventory`,
          };
        }

        // Deduct from company inventory
        company.inventory.MEGAMACHINE_PART.available -= cmd.quantity;
        company.contributedMegamachinePartsR8 += cmd.quantity;

        // Deliver to central assembler
        this.globalProject.deliveredMegamachineParts += cmd.quantity;

        // Check if global threshold met
        if (
          this.globalProject.deliveredMegamachineParts >=
          this.globalProject.requiredMegamachineParts
        ) {
          this.globalProject.isVictorious = true;
          if (this.globalProject.completedAtTick === null) {
            this.globalProject.completedAtTick = this.currentTick;
          }
        }

        return {
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          executedAtTick: this.currentTick,
          success: true,
        };
      }
    }
  }

  /**
   * Deterministic state hash for validation and replay testing
   */
  public calculateStateHash(): string {
    let hash = 0x811c9dc5; // FNV-1a 32-bit baseline
    const pushNumber = (n: number) => {
      hash ^= n & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (n >>> 8) & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (n >>> 16) & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (n >>> 24) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    };

    pushNumber(this.currentTick);
    pushNumber(this.globalProject.deliveredMegamachineParts);

    for (const comp of Array.from(this.companies.values()).sort((a, b) =>
      a.companyId.localeCompare(b.companyId)
    )) {
      pushNumber(comp.credits);
      pushNumber(comp.energy);
      pushNumber(comp.reputation);
      pushNumber(comp.installedTurbinesR7);
      pushNumber(comp.contributedMegamachinePartsR8);
      for (const item of Object.keys(comp.inventory) as ItemId[]) {
        pushNumber(comp.inventory[item].available);
        pushNumber(comp.inventory[item].reserved);
      }
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Create deep frozen snapshot of simulation state
   */
  public createSnapshot(): SimulationSnapshot {
    const companiesSnapshot: Record<string, CompanyState> = {};
    for (const [id, comp] of this.companies.entries()) {
      companiesSnapshot[id] = JSON.parse(JSON.stringify(comp));
    }

    const contractsSnapshot: Record<string, SupplyContract> = {};
    for (const [id, cnt] of this.contracts.entries()) {
      contractsSnapshot[id] = JSON.parse(JSON.stringify(cnt));
    }

    return {
      tick: this.currentTick,
      stateHash: this.calculateStateHash(),
      companies: companiesSnapshot,
      contracts: contractsSnapshot,
      globalProject: { ...this.globalProject },
    };
  }
}
