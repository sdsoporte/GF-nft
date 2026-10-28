/**
 * Golden scenarios for specs S5 and S9 of issue #10.
 *
 * Every scenario is a fixed literal recipe for one replay:
 * - a literal 32-bit seed handed to `SimulatorEngine` (assumption A3),
 * - a two-company match (one Class A metallurgy company and one Class B
 *   manufacturing company, both declared here so the fixture stays compact and
 *   reviewable while still covering both industrial classes and cross-company
 *   contracts),
 * - fixed literal preconditions (`setup`) applied through the public
 *   `getCompany` accessor before tick 1,
 * - a fixed tick -> command script (`steps`). Commands are submitted at the
 *   start of the declared tick and executed by that tick's `processTick()`,
 *   which is exactly how a client replays a match.
 *
 * Command and idempotency ids are derived from the scenario name plus the
 * submission ordinal (`cmd_<scenario>_<n>`), never from `Date.now()`, so a
 * replay is byte-stable. Engine-generated contract ids (`cnt_<tick>_<n>`) are
 * deterministic for the same reason, which lets later steps address contracts
 * created by earlier steps.
 *
 * Changing a scenario changes its expected state: regenerate the fixture with
 *     GOLDEN_UPDATE=1 bun test tests/golden
 * and review the resulting diff before committing.
 */

import { setGrid, setInventory, type Scenario } from './golden-helpers.ts';

const FORGE = {
  id: 'gf_forge',
  name: 'GigaForge Metallurgy',
  industrialClass: 'CLASS_A_METALLURGY',
  isNPC: false,
} as const;

const ASSEMBLY = {
  id: 'gf_assembly',
  name: 'Assembly Works',
  industrialClass: 'CLASS_B_MANUFACTURING',
  isNPC: false,
} as const;

const COMPANIES = [FORGE, ASSEMBLY] as const;

/** Line ids of a company in the standard three-line layout. */
const line = (companyId: string, index: number): string => `${companyId}_line_${index}`;

/**
 * S5 scenario 1 — steady Class A chain: extraction, R1 batches, then an R2
 * batch that consumes the ingots produced earlier, while the Class B company
 * runs an optimal R4 chain from a seeded stock.
 */
const classAMetallurgyChain: Scenario = {
  name: 'class-a-metallurgy-chain',
  note: 'Class A runs 3x R1 then 1x R2 while Class B runs 2x R4 from a seeded stock.',
  seed: 42107,
  totalTicks: 90,
  checkpoints: [1, 12, 46, 90],
  companies: COMPANIES,
  setup(engine) {
    setInventory(engine, ASSEMBLY.id, { STEEL_PLATE: 8, IRON_INGOT: 6 });
  },
  steps: [
    {
      tick: 1,
      label: 'forge R1 x3, assembly R4 x2',
      commands: [
        { type: 'SET_PRODUCTION_TARGET', companyId: FORGE.id, lineId: line(FORGE.id, 1), recipeId: 'R1', targetBatches: 3 },
        { type: 'SET_PRODUCTION_TARGET', companyId: ASSEMBLY.id, lineId: line(ASSEMBLY.id, 1), recipeId: 'R4', targetBatches: 2 },
      ],
    },
    {
      tick: 45,
      label: 'forge R2 x1 on the second line',
      commands: [
        { type: 'SET_PRODUCTION_TARGET', companyId: FORGE.id, lineId: line(FORGE.id, 2), recipeId: 'R2', targetBatches: 1 },
      ],
    },
  ],
};

/**
 * S5 scenario 2 — energy starvation and operator control: the Class B grid is
 * pinned low so two competing lines trade `NO_ENERGY` ticks, then the operator
 * pauses, resumes and re-prioritises them, and a line runs out of inputs mid
 * target and parks without an active batch (issue #1 behaviour).
 */
const classBStarvationAndPriority: Scenario = {
  name: 'class-b-starvation-and-priority',
  note: 'Pinned Class B grid: NO_ENERGY starvation, pause/resume, priority swap, input shortage.',
  seed: 9001,
  totalTicks: 41,
  checkpoints: [1, 13, 17, 31, 41],
  companies: COMPANIES,
  setup(engine) {
    setGrid(engine, ASSEMBLY.id, 30, 3);
    setInventory(engine, ASSEMBLY.id, { STEEL_PLATE: 10, IRON_INGOT: 12, RAW_ORE: 20 });
  },
  steps: [
    {
      tick: 1,
      label: 'assembly R4 x3 (inputs for 2) and R5 x2',
      commands: [
        { type: 'SET_PRODUCTION_TARGET', companyId: ASSEMBLY.id, lineId: line(ASSEMBLY.id, 1), recipeId: 'R4', targetBatches: 3 },
        { type: 'SET_PRODUCTION_TARGET', companyId: ASSEMBLY.id, lineId: line(ASSEMBLY.id, 2), recipeId: 'R5', targetBatches: 2 },
      ],
    },
    {
      tick: 12,
      label: 'pause the circuit line while the grid starves',
      commands: [{ type: 'PAUSE_PRODUCTION_LINE', companyId: ASSEMBLY.id, lineId: line(ASSEMBLY.id, 2) }],
    },
    {
      tick: 14,
      label: 'resume the circuit line',
      commands: [{ type: 'RESUME_PRODUCTION_LINE', companyId: ASSEMBLY.id, lineId: line(ASSEMBLY.id, 2) }],
    },
    {
      tick: 16,
      label: 'swap priorities: line 2 first, line 1 last',
      commands: [
        { type: 'SET_LINE_PRIORITY', companyId: ASSEMBLY.id, lineId: line(ASSEMBLY.id, 2), priority: 1 },
        { type: 'SET_LINE_PRIORITY', companyId: ASSEMBLY.id, lineId: line(ASSEMBLY.id, 1), priority: 3 },
      ],
    },
  ],
};

/**
 * S5 scenario 3 — the full contract lifecycle in one replay: a targeted offer
 * that is accepted, shipped and fulfilled (2% burn, collateral return, +5
 * reputation), a second contract that defaults on its deadline (buyer refund,
 * collateral indemnity, seller -15 reputation), a cancelled open offer and a
 * deliberately rejected production command.
 */
const contractLifecycle: Scenario = {
  name: 'contract-lifecycle',
  note: 'Targeted offer fulfilled, second contract defaulted at its deadline, open offer cancelled.',
  seed: 42107,
  totalTicks: 45,
  checkpoints: [1, 12, 22, 45],
  companies: COMPANIES,
  setup(engine) {
    setInventory(engine, FORGE.id, { IRON_INGOT: 20, RAW_ORE: 60 });
    setInventory(engine, ASSEMBLY.id, {});
  },
  steps: [
    {
      tick: 1,
      label: 'forge offers 4 IRON_INGOT @100 to assembly (cnt_1_1)',
      commands: [
        {
          type: 'CREATE_SUPPLY_OFFER', companyId: FORGE.id, targetBuyerId: ASSEMBLY.id,
          itemId: 'IRON_INGOT', quantity: 4, unitPriceCredits: 100, deadlineTicks: 40,
        },
      ],
    },
    {
      tick: 2,
      label: 'assembly accepts cnt_1_1',
      commands: [{ type: 'ACCEPT_SUPPLY_OFFER', companyId: ASSEMBLY.id, contractId: 'cnt_1_1' }],
    },
    {
      tick: 4,
      label: 'forge ships all 4 units of cnt_1_1',
      commands: [
        { type: 'SCHEDULE_INTERNAL_TRANSPORT', companyId: FORGE.id, contractId: 'cnt_1_1', quantityToShip: 4 },
      ],
    },
    {
      tick: 8,
      label: 'forge offers 5 IRON_INGOT @50, deadline tick 20 (cnt_8_2)',
      commands: [
        {
          type: 'CREATE_SUPPLY_OFFER', companyId: FORGE.id, targetBuyerId: ASSEMBLY.id,
          itemId: 'IRON_INGOT', quantity: 5, unitPriceCredits: 50, deadlineTicks: 20,
        },
      ],
    },
    {
      tick: 9,
      label: 'assembly accepts cnt_8_2 and never receives goods',
      commands: [{ type: 'ACCEPT_SUPPLY_OFFER', companyId: ASSEMBLY.id, contractId: 'cnt_8_2' }],
    },
    {
      tick: 10,
      label: 'forge opens an untargeted offer (cnt_10_3)',
      commands: [
        {
          type: 'CREATE_SUPPLY_OFFER', companyId: FORGE.id,
          itemId: 'IRON_INGOT', quantity: 2, unitPriceCredits: 10, deadlineTicks: 40,
        },
      ],
    },
    {
      tick: 11,
      label: 'forge cancels its own open offer',
      commands: [{ type: 'CANCEL_PENDING_OFFER', companyId: FORGE.id, contractId: 'cnt_10_3' }],
    },
    {
      tick: 12,
      label: 'forge keeps producing 2x R1',
      commands: [
        { type: 'SET_PRODUCTION_TARGET', companyId: FORGE.id, lineId: line(FORGE.id, 1), recipeId: 'R1', targetBatches: 2 },
      ],
    },
    {
      tick: 14,
      label: 'forge tries R3 without STEEL_PLATE (expected rejection, recorded in history)',
      commands: [
        { type: 'SET_PRODUCTION_TARGET', companyId: FORGE.id, lineId: line(FORGE.id, 3), recipeId: 'R3', targetBatches: 1 },
      ],
    },
    {
      tick: 21,
      label: 'cnt_8_2 passes its deadline without delivery (default lands on this tick)',
    },
  ],
};

/**
 * S5 scenario 4 — the long replay: periodic maintenance at ticks 300/600/900,
 * the tick-900 turbine expansion (unlock gate, +15 generation, +250 storage,
 * fourth configurable line) and a megamachine delivery that wins the match.
 * A long R1 target also exhausts RAW_ORE, so the input-shortage parking path is
 * part of the expected state.
 */
const turbineAndMegamachine: Scenario = {
  name: 'turbine-and-megamachine',
  note: 'Ticks to 906: maintenance x3, turbine expansion at 901, victorious delivery at 905.',
  seed: 777,
  totalTicks: 906,
  checkpoints: [1, 300, 901, 906],
  companies: COMPANIES,
  setup(engine) {
    setInventory(engine, FORGE.id, { RAW_ORE: 200, IND_TURBINE: 1, MEGAMACHINE_PART: 12 });
  },
  steps: [
    {
      tick: 1,
      label: 'forge R1 x100 (runs the grid, later starves for ore)',
      commands: [
        { type: 'SET_PRODUCTION_TARGET', companyId: FORGE.id, lineId: line(FORGE.id, 1), recipeId: 'R1', targetBatches: 100 },
      ],
    },
    {
      tick: 901,
      label: 'forge installs its turbine expansion (4th line)',
      commands: [{ type: 'INSTALL_TURBINE_EXPANSION', companyId: FORGE.id }],
    },
    {
      tick: 905,
      label: 'forge delivers 12 megamachine parts (match victory)',
      commands: [{ type: 'DELIVER_MEGAMACHINE_PART', companyId: FORGE.id, quantity: 12 }],
    },
  ],
};

export const SCENARIOS: readonly Scenario[] = [
  classAMetallurgyChain,
  classBStarvationAndPriority,
  contractLifecycle,
  turbineAndMegamachine,
];
