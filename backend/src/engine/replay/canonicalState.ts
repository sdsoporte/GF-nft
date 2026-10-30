/**
 * GigaForge v4.1 - Canonical Simulation State & Robust SHA-256 Checksum
 * Provides deterministic state normalization and cryptographically strong checksums.
 */

import { createHash } from 'node:crypto';
import type {
  CompanyState,
  GlobalProjectState,
  ItemId,
  ProductionLine,
  SupplyContract,
} from '../../domain/types.ts';
import type { SimulatorEngine } from '../SimulatorEngine.ts';

export interface CanonicalCompanyState {
  readonly companyId: string;
  readonly name: string;
  readonly industrialClass: string;
  readonly isNPC: boolean;
  readonly credits: number;
  readonly energy: number;
  readonly maxEnergyStorage: number;
  readonly energyGenerationPerTick: number;
  readonly installedTurbinesR7: number;
  readonly contributedMegamachinePartsR8: number;
  readonly reputation: number;
  readonly maintenancePaidTicks: number;
  readonly inventory: Record<ItemId, { readonly available: number; readonly reserved: number }>;
  readonly lines: readonly ProductionLine[];
}

export interface CanonicalSimulationState {
  readonly tick: number;
  readonly ruleVersion: string;
  readonly globalProject: GlobalProjectState;
  readonly companies: readonly CanonicalCompanyState[];
  readonly contracts: readonly SupplyContract[];
}

/**
 * Deterministically serialize any object into canonical JSON:
 * - Object keys recursively sorted alphabetically.
 * - Negative zero `-0` folded to `0`.
 * - Pure integer / safe number handling.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return 'null';
  }
  if (typeof obj === 'number') {
    // Fold -0 to 0
    return Object.is(obj, -0) ? '0' : obj.toString();
  }
  if (typeof obj === 'boolean' || typeof obj === 'string') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    const items = obj.map((item) => canonicalJsonStringify(item));
    return `[${items.join(',')}]`;
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));

    const serializedEntries = entries.map(
      ([key, val]) => `${JSON.stringify(key)}:${canonicalJsonStringify(val)}`
    );
    return `{${serializedEntries.join(',')}}`;
  }
  return JSON.stringify(obj);
}

/**
 * Compute robust SHA-256 checksum over the canonically sorted state.
 */
export function computeStateChecksumSha256(state: unknown): string {
  const canonicalJson = canonicalJsonStringify(state);
  return createHash('sha256').update(canonicalJson).digest('hex');
}

/**
 * Extract an immutable, normalized CanonicalSimulationState from an active SimulatorEngine.
 */
export function extractCanonicalSimulationState(
  engine: SimulatorEngine,
  ruleVersion: string = '4.1'
): CanonicalSimulationState {
  const tick = engine.getCurrentTick();
  const globalProject = { ...engine.getGlobalProject() };

  // Sort companies canonically by companyId
  const rawCompanies = engine.getAllCompanies();
  const sortedCompanies = [...rawCompanies].sort((a, b) =>
    a.companyId.localeCompare(b.companyId)
  );

  const canonicalCompanies: CanonicalCompanyState[] = sortedCompanies.map((c) => {
    // Clone lines sorted by lineId
    const sortedLines = [...c.lines].sort((a, b) => a.lineId.localeCompare(b.lineId));

    // Sort inventory keys alphabetically
    const inventoryKeys = Object.keys(c.inventory) as ItemId[];
    inventoryKeys.sort((a, b) => a.localeCompare(b));

    const sortedInventory: Record<ItemId, { available: number; reserved: number }> = {} as any;
    for (const item of inventoryKeys) {
      sortedInventory[item] = {
        available: c.inventory[item].available,
        reserved: c.inventory[item].reserved,
      };
    }

    return {
      companyId: c.companyId,
      name: c.name,
      industrialClass: c.industrialClass,
      isNPC: c.isNPC,
      credits: c.credits,
      energy: c.energy,
      maxEnergyStorage: c.maxEnergyStorage,
      energyGenerationPerTick: c.energyGenerationPerTick,
      installedTurbinesR7: c.installedTurbinesR7,
      contributedMegamachinePartsR8: c.contributedMegamachinePartsR8,
      reputation: c.reputation,
      maintenancePaidTicks: c.maintenancePaidTicks,
      inventory: sortedInventory,
      lines: sortedLines.map((l) => JSON.parse(JSON.stringify(l))),
    };
  });

  // Sort contracts canonically by contractId
  const rawContracts = engine.getAllContracts();
  const sortedContracts = [...rawContracts].sort((a, b) =>
    a.contractId.localeCompare(b.contractId)
  );

  return {
    tick,
    ruleVersion,
    globalProject,
    companies: canonicalCompanies,
    contracts: sortedContracts.map((c) => JSON.parse(JSON.stringify(c))),
  };
}
