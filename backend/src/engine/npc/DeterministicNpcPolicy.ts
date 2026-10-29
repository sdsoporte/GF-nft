/**
 * GigaForge v4.1 - Deterministic NPC Policy
 * Autonomous, rule-compliant decision engine for NPC market providers.
 */

import {
  CompanyState,
  EnqueueCommandInput,
  ItemId,
  RecipeId,
  SupplyContract,
} from '../../domain/types.ts';
import {
  getRecipe,
  getTransportEnergyCost,
  RECIPE_CATALOG,
} from '../../domain/recipeCatalog.ts';
import { Mulberry32PRNG } from '../SimulatorEngine.ts';
import { NpcCompanyConfig } from './types.ts';

export class DeterministicNpcPolicy {
  private commandSequence = 0;

  constructor(public readonly config: NpcCompanyConfig) {}

  /**
   * Evaluate all deterministic actions for this NPC company on the given tick.
   */
  public evaluateDecisions(
    company: CompanyState,
    contracts: readonly SupplyContract[],
    currentTick: number,
    _rng: Mulberry32PRNG
  ): EnqueueCommandInput[] {
    const decisions: EnqueueCommandInput[] = [];

    // Local simulated state to prevent over-allocation during this tick's planning
    let simulatedCredits = company.credits;
    let simulatedEnergy = company.energy;
    const simulatedInventory: Record<ItemId, number> = {
      RAW_ORE: company.inventory.RAW_ORE.available,
      IRON_INGOT: company.inventory.IRON_INGOT.available,
      STEEL_PLATE: company.inventory.STEEL_PLATE.available,
      HEAVY_ALLOY: company.inventory.HEAVY_ALLOY.available,
      MECH_FRAME: company.inventory.MECH_FRAME.available,
      CTRL_CIRCUIT: company.inventory.CTRL_CIRCUIT.available,
      POWER_MODULE: company.inventory.POWER_MODULE.available,
      IND_TURBINE: company.inventory.IND_TURBINE.available,
      MEGAMACHINE_PART: company.inventory.MEGAMACHINE_PART.available,
    };

    // 1. Fulfill active contracts (SCHEDULE_INTERNAL_TRANSPORT)
    // Fulfilling obligations has top priority to avoid default and penalties.
    const activeContracts = contracts.filter(
      (c) =>
        c.sellerCompanyId === company.companyId &&
        c.status === 'ACTIVE' &&
        currentTick <= c.deadlineTick &&
        c.deliveredQuantity < c.totalQuantity
    );

    for (const contract of activeContracts) {
      const remainingNeeded = contract.totalQuantity - contract.deliveredQuantity;
      const availableStock = simulatedInventory[contract.itemId];
      if (availableStock <= 0) continue;

      const quantityToShip = Math.min(availableStock, remainingNeeded);
      const transportEnergy = getTransportEnergyCost(company.industrialClass, quantityToShip);

      if (simulatedEnergy >= transportEnergy && quantityToShip > 0) {
        simulatedInventory[contract.itemId] -= quantityToShip;
        simulatedEnergy -= transportEnergy;

        decisions.push({
          type: 'SCHEDULE_INTERNAL_TRANSPORT',
          commandId: this.nextCommandId(currentTick),
          companyId: company.companyId,
          scheduledTick: currentTick,
          idempotencyKey: `npc_ship_${contract.contractId}_${currentTick}_${quantityToShip}`,
          contractId: contract.contractId,
          quantityToShip,
        });
      }
    }

    // 2. Install Turbine R7 Expansion at tick >= 900
    if (
      this.config.autoInstallTurbine &&
      currentTick >= 900 &&
      company.installedTurbinesR7 === 0 &&
      simulatedInventory.IND_TURBINE >= 1
    ) {
      simulatedInventory.IND_TURBINE -= 1;
      decisions.push({
        type: 'INSTALL_TURBINE_EXPANSION',
        commandId: this.nextCommandId(currentTick),
        companyId: company.companyId,
        scheduledTick: currentTick,
        idempotencyKey: `npc_turbine_${company.companyId}_${currentTick}`,
      });
    }

    // 3. Deliver Megamachine Parts (R8) if any
    if (simulatedInventory.MEGAMACHINE_PART >= 1) {
      const qty = simulatedInventory.MEGAMACHINE_PART;
      simulatedInventory.MEGAMACHINE_PART = 0;
      decisions.push({
        type: 'DELIVER_MEGAMACHINE_PART',
        commandId: this.nextCommandId(currentTick),
        companyId: company.companyId,
        scheduledTick: currentTick,
        idempotencyKey: `npc_r8_${company.companyId}_${currentTick}`,
        quantity: qty,
      });
    }

    // 4. Accept pending supply offers for needed inputs
    const pendingOffers = contracts.filter(
      (c) =>
        c.status === 'PENDING' &&
        c.sellerCompanyId !== company.companyId &&
        (!c.buyerCompanyId || c.buyerCompanyId === company.companyId) &&
        c.deadlineTick > currentTick
    );

    for (const offer of pendingOffers) {
      const currentStock = simulatedInventory[offer.itemId];
      const targetBuffer = this.config.targetBuffer[offer.itemId] ?? 0;

      // Check if we need this item for our preferred recipes and stock is low
      const isNeededInput = this.isInputForPreferredRecipes(offer.itemId);
      if (isNeededInput && currentStock < targetBuffer) {
        // Evaluate price
        const maxUnitPrice = this.calculateMaxBuyPrice(offer.itemId);
        if (offer.unitPriceCredits <= maxUnitPrice) {
          if (simulatedCredits - offer.totalValueCredits >= this.config.minCreditReserve) {
            simulatedCredits -= offer.totalValueCredits;
            decisions.push({
              type: 'ACCEPT_SUPPLY_OFFER',
              commandId: this.nextCommandId(currentTick),
              companyId: company.companyId,
              scheduledTick: currentTick,
              idempotencyKey: `npc_accept_${offer.contractId}_${currentTick}`,
              contractId: offer.contractId,
            });
          }
        }
      }
    }

    // 5. Post supply offers for surplus goods (CREATE_SUPPLY_OFFER)
    const currentActiveOffers = contracts.filter(
      (c) =>
        c.sellerCompanyId === company.companyId &&
        (c.status === 'PENDING' || c.status === 'DRAFT')
    ).length;

    let availableOfferSlots = this.config.maxActiveOffers - currentActiveOffers;

    if (availableOfferSlots > 0) {
      // Check each item for surplus above buffer
      for (const [itemIdKey, batchSize] of Object.entries(this.config.offerBatchSizes)) {
        if (availableOfferSlots <= 0) break;
        const itemId = itemIdKey as ItemId;
        const targetBuffer = this.config.targetBuffer[itemId] ?? 0;
        const availableStock = simulatedInventory[itemId];
        const surplus = availableStock - targetBuffer;

        if (batchSize && surplus >= batchSize) {
          const unitPrice = this.calculateSellPrice(itemId);
          const totalValue = batchSize * unitPrice;
          const collateral = Math.floor((totalValue * 20) / 100);

          if (simulatedCredits - collateral >= this.config.minCreditReserve) {
            simulatedCredits -= collateral;
            availableOfferSlots -= 1;

            decisions.push({
              type: 'CREATE_SUPPLY_OFFER',
              commandId: this.nextCommandId(currentTick),
              companyId: company.companyId,
              scheduledTick: currentTick,
              idempotencyKey: `npc_offer_${company.companyId}_${itemId}_${currentTick}`,
              itemId,
              quantity: batchSize,
              unitPriceCredits: unitPrice,
              deadlineTicks: currentTick + this.config.offerDurationTicks,
            });
          }
        }
      }
    }

    // 6. Schedule production on IDLE lines
    const idleLines = company.lines.filter(
      (line) => line.status === 'IDLE' && line.activeBatch === null
    );

    for (const line of idleLines) {
      const recipeToRun = this.selectRecipeForLine(simulatedInventory);
      if (recipeToRun) {
        const recipeDef = getRecipe(recipeToRun);
        // Deduct simulated inputs
        let canAfford = true;
        for (const input of recipeDef.inputs) {
          if (simulatedInventory[input.itemId] < input.quantity) {
            canAfford = false;
            break;
          }
        }

        if (canAfford) {
          for (const input of recipeDef.inputs) {
            simulatedInventory[input.itemId] -= input.quantity;
          }

          decisions.push({
            type: 'SET_PRODUCTION_TARGET',
            commandId: this.nextCommandId(currentTick),
            companyId: company.companyId,
            scheduledTick: currentTick,
            idempotencyKey: `npc_prod_${line.lineId}_${recipeToRun}_${currentTick}`,
            lineId: line.lineId,
            recipeId: recipeToRun,
            targetBatches: 1,
          });
        }
      }
    }

    return decisions;
  }

  private isInputForPreferredRecipes(itemId: ItemId): boolean {
    for (const recipeId of this.config.preferredRecipes) {
      const recipe = getRecipe(recipeId);
      if (recipe.inputs.some((input) => input.itemId === itemId)) {
        return true;
      }
    }
    return false;
  }

  public calculateSellPrice(itemId: ItemId): number {
    const recipe = Object.values(RECIPE_CATALOG).find((r) => r.outputItem === itemId);
    const baseCost = recipe ? recipe.estimatedBaseCostCredits : 50;
    const outputQty = recipe ? recipe.outputQuantity : 1;
    const baseUnitCost = baseCost / outputQty;
    return Math.max(1, Math.round(baseUnitCost * (1 + this.config.priceMarginPercent / 100)));
  }

  public calculateMaxBuyPrice(itemId: ItemId): number {
    const recipe = Object.values(RECIPE_CATALOG).find((r) => r.outputItem === itemId);
    const baseCost = recipe ? recipe.estimatedBaseCostCredits : 50;
    const outputQty = recipe ? recipe.outputQuantity : 1;
    const baseUnitCost = baseCost / outputQty;
    return Math.max(1, Math.round(baseUnitCost * (1 + this.config.maxBuyPriceMarginPercent / 100)));
  }

  private selectRecipeForLine(simulatedInventory: Record<ItemId, number>): RecipeId | null {
    // Sort preferred recipes by priority: recipes where output is lowest compared to buffer
    for (const recipeId of this.config.preferredRecipes) {
      const recipe = getRecipe(recipeId);
      const hasInputs = recipe.inputs.every(
        (input) => simulatedInventory[input.itemId] >= input.quantity
      );
      if (hasInputs) {
        return recipeId;
      }
    }
    return null;
  }

  private nextCommandId(tick: number): string {
    this.commandSequence += 1;
    return `cmd_npc_${this.config.companyId}_${tick}_${this.commandSequence}`;
  }
}
