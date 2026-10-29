/**
 * GigaForge v4.1 - State Difference Reporter
 * Structured comparison between two simulation states, reporting divergences by entity and field.
 */

import type { ItemId } from '../../domain/types.ts';
import type { CanonicalCompanyState, CanonicalSimulationState } from './canonicalState.ts';

export type DifferenceEntityType =
  | 'global'
  | 'company'
  | 'inventory'
  | 'line'
  | 'batch'
  | 'contract';

export interface StateDifference {
  readonly entityType: DifferenceEntityType;
  readonly entityId: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * Compare two canonical states and return all pinpointed field-level differences.
 */
export function diffCanonicalStates(
  expected: CanonicalSimulationState,
  actual: CanonicalSimulationState
): StateDifference[] {
  const diffs: StateDifference[] = [];

  // 1. Root / Global differences
  if (expected.tick !== actual.tick) {
    diffs.push({
      entityType: 'global',
      entityId: 'simulation',
      field: 'tick',
      expected: expected.tick,
      actual: actual.tick,
    });
  }

  if (expected.ruleVersion !== actual.ruleVersion) {
    diffs.push({
      entityType: 'global',
      entityId: 'simulation',
      field: 'ruleVersion',
      expected: expected.ruleVersion,
      actual: actual.ruleVersion,
    });
  }

  // Global Project
  for (const [key, expVal] of Object.entries(expected.globalProject)) {
    const actVal = (actual.globalProject as any)[key];
    if (expVal !== actVal) {
      diffs.push({
        entityType: 'global',
        entityId: 'globalProject',
        field: key,
        expected: expVal,
        actual: actVal,
      });
    }
  }

  // 2. Company differences
  const expectedCompanyMap = new Map<string, CanonicalCompanyState>(
    expected.companies.map((c) => [c.companyId, c])
  );
  const actualCompanyMap = new Map<string, CanonicalCompanyState>(
    actual.companies.map((c) => [c.companyId, c])
  );

  // Check missing or extra companies
  for (const [id, expComp] of expectedCompanyMap.entries()) {
    const actComp = actualCompanyMap.get(id);
    if (!actComp) {
      diffs.push({
        entityType: 'company',
        entityId: id,
        field: 'presence',
        expected: 'present',
        actual: 'missing',
      });
      continue;
    }

    // Scalar company fields
    const companyFields: (keyof CanonicalCompanyState)[] = [
      'name',
      'industrialClass',
      'isNPC',
      'credits',
      'energy',
      'maxEnergyStorage',
      'energyGenerationPerTick',
      'installedTurbinesR7',
      'contributedMegamachinePartsR8',
      'reputation',
      'maintenancePaidTicks',
    ];

    for (const field of companyFields) {
      if (expComp[field] !== actComp[field]) {
        diffs.push({
          entityType: 'company',
          entityId: id,
          field,
          expected: expComp[field],
          actual: actComp[field],
        });
      }
    }

    // Inventory differences
    const allItems = new Set<ItemId>([
      ...(Object.keys(expComp.inventory) as ItemId[]),
      ...(Object.keys(actComp.inventory) as ItemId[]),
    ]);

    for (const item of allItems) {
      const expSlot = expComp.inventory[item] ?? { available: 0, reserved: 0 };
      const actSlot = actComp.inventory[item] ?? { available: 0, reserved: 0 };

      if (expSlot.available !== actSlot.available) {
        diffs.push({
          entityType: 'inventory',
          entityId: `${id}:${item}`,
          field: 'available',
          expected: expSlot.available,
          actual: actSlot.available,
        });
      }
      if (expSlot.reserved !== actSlot.reserved) {
        diffs.push({
          entityType: 'inventory',
          entityId: `${id}:${item}`,
          field: 'reserved',
          expected: expSlot.reserved,
          actual: actSlot.reserved,
        });
      }
    }

    // Lines differences
    const expLineMap = new Map(expComp.lines.map((l) => [l.lineId, l]));
    const actLineMap = new Map(actComp.lines.map((l) => [l.lineId, l]));

    for (const [lineId, expLine] of expLineMap.entries()) {
      const actLine = actLineMap.get(lineId);
      if (!actLine) {
        diffs.push({
          entityType: 'line',
          entityId: lineId,
          field: 'presence',
          expected: 'present',
          actual: 'missing',
        });
        continue;
      }

      if (expLine.priority !== actLine.priority) {
        diffs.push({
          entityType: 'line',
          entityId: lineId,
          field: 'priority',
          expected: expLine.priority,
          actual: actLine.priority,
        });
      }
      if (expLine.status !== actLine.status) {
        diffs.push({
          entityType: 'line',
          entityId: lineId,
          field: 'status',
          expected: expLine.status,
          actual: actLine.status,
        });
      }
      if (expLine.currentRecipeId !== actLine.currentRecipeId) {
        diffs.push({
          entityType: 'line',
          entityId: lineId,
          field: 'currentRecipeId',
          expected: expLine.currentRecipeId,
          actual: actLine.currentRecipeId,
        });
      }
      if (expLine.totalBatchesProduced !== actLine.totalBatchesProduced) {
        diffs.push({
          entityType: 'line',
          entityId: lineId,
          field: 'totalBatchesProduced',
          expected: expLine.totalBatchesProduced,
          actual: actLine.totalBatchesProduced,
        });
      }

      // Active batch comparison
      if (!expLine.activeBatch && actLine.activeBatch) {
        diffs.push({
          entityType: 'batch',
          entityId: lineId,
          field: 'activeBatch',
          expected: null,
          actual: actLine.activeBatch,
        });
      } else if (expLine.activeBatch && !actLine.activeBatch) {
        diffs.push({
          entityType: 'batch',
          entityId: lineId,
          field: 'activeBatch',
          expected: expLine.activeBatch,
          actual: null,
        });
      } else if (expLine.activeBatch && actLine.activeBatch) {
        for (const [bField, bExpVal] of Object.entries(expLine.activeBatch)) {
          const bActVal = (actLine.activeBatch as any)[bField];
          if (bExpVal !== bActVal) {
            diffs.push({
              entityType: 'batch',
              entityId: lineId,
              field: bField,
              expected: bExpVal,
              actual: bActVal,
            });
          }
        }
      }
    }
  }

  // 3. Contracts differences
  const expContractMap = new Map(expected.contracts.map((c) => [c.contractId, c]));
  const actContractMap = new Map(actual.contracts.map((c) => [c.contractId, c]));

  const allContractIds = new Set<string>([
    ...expContractMap.keys(),
    ...actContractMap.keys(),
  ]);

  for (const contractId of allContractIds) {
    const expContract = expContractMap.get(contractId);
    const actContract = actContractMap.get(contractId);

    if (!expContract) {
      diffs.push({
        entityType: 'contract',
        entityId: contractId,
        field: 'presence',
        expected: 'missing',
        actual: 'present',
      });
      continue;
    }
    if (!actContract) {
      diffs.push({
        entityType: 'contract',
        entityId: contractId,
        field: 'presence',
        expected: 'present',
        actual: 'missing',
      });
      continue;
    }

    for (const [cField, cExpVal] of Object.entries(expContract)) {
      const cActVal = (actContract as any)[cField];
      if (cExpVal !== cActVal) {
        diffs.push({
          entityType: 'contract',
          entityId: contractId,
          field: cField,
          expected: cExpVal,
          actual: cActVal,
        });
      }
    }
  }

  return diffs;
}
