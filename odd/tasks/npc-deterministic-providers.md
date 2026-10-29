# Deterministic NPC Providers and Energy Balance Evaluation (issue #13)

Autonomous deterministic NPC supplier policy, two-sided market generation, 2700-tick full simulation and energy balance evaluation.
Branch: `feat/issue-13-npc-providers` from `origin/main` (`05825d0`) | Delivery: local work-unit commits, no push/PR/merge | Checks: `bun test`, `bun run lint`, `bun run build`.

## Specs

Source: GitHub issue #13 "[P2][NPC/Economía] Implementar proveedores NPC deterministas y evaluar balance energético".

- **S1** — Deterministic NPC policy: define deterministic behavior for specialized production, target buffer stock, supply offer posting, deterministic pricing, and contract fulfillment.
- **S2** — Multi-source market coverage: in a 4-company match (2 human + 2 NPC), ensure at least two sources of supply for key materials (e.g. `IRON_INGOT`, `STEEL_PLATE`, `MECH_FRAME`, `CTRL_CIRCUIT`).
- **S3** — Rule-compliant execution: NPCs produce and trade strictly through standard engine commands and rules without fabricating items or credits out of thin air.
- **S4** — Determinism and reproducibility: all NPC actions, prices, and match trajectories repeat byte-for-byte across runs given the same fixed PRNG seed.
- **S5** — 2700-tick simulation & energy balance: simulate 2700 ticks, observe economic decisions, measure energy utilization across 3 lines vs 4 lines (R7 installation), and evaluate the strategic return of installing R7 turbines.

## Product Questions (Open Decisions for Human Review)

Per task constraints, product decisions are not invented; they are captured here for the human:
1. **NPC Pricing Formula**: Currently defaults to recipe unit base cost plus a deterministic margin (`unitBaseCost * (1 + priceMarginPercent / 100)`). Question for product: Should NPC offer pricing be fixed margin over base cost, or should price dynamically respond to remaining tick duration and inventory scarcity?
2. **Target Buffer Reserve**: Currently defaults to 30 RAW_ORE, 10 IRON_INGOT, 8 STEEL_PLATE for Class A; 10 IRON_INGOT, 10 STEEL_PLATE, 4 MECH_FRAME, 4 CTRL_CIRCUIT for Class B. Question for product: What safety stock buffer should NPCs hold for their own production before offering surplus to the market?
3. **NPC Purchase Willingness**: Currently allows buying required inputs up to +25% markup over base cost. Question for product: What maximum price multiplier should NPCs pay human suppliers?
4. **Turbine R7 Strategy**: Currently installs R7 automatically at tick >= 900 if in inventory. Question for product: Should NPCs prioritize installing R7 immediately, selling it for credits, or contributing it to R8 megamachine assembly?
5. **Base Energy Balance (+20 vs +10/12)**: Simulation shows that with +20 base generation and 3 lines, energy rarely starves on basic recipes (~8-10 energy/tick spent). Question for game balance: Should base energy generation be reduced to +10 or +12/tick to make R7 turbines vital earlier, rather than only under heavy 4-line manufacturing?

## Tasks

- **T1** [S1,S3] — **done** — NPC domain types and deterministic policy (`backend/src/engine/npc/types.ts`, `backend/src/engine/npc/DeterministicNpcPolicy.ts`). Route: inline. Evidence: unit tests pass, idle line scheduling, surplus offer creation, contract dispatch.
- **T2** [S1,S2,S3] — **done** — NPC Controller and command orchestration (`backend/src/engine/npc/NpcController.ts`). Route: inline. Evidence: registers default NPC companies, steps ticks deterministically, submits valid engine commands.
- **T3** [S1,S3,S4] — **done** — Test-first unit and determinism test suite with fixed seed (`backend/tests/engine/npc/npc-policy.test.ts`, `backend/tests/engine/npc/npc-controller.test.ts`, `backend/tests/engine/npc/npc-determinism.test.ts`). Route: inline. Evidence: byte-identical checkpoint comparison across runs with identical seed, invariants verified over 500 ticks, multi-source supply verified.
- **T4** [S2,S3,S5] — **done** — 2700-tick full match simulation and energy balance evaluation suite (`backend/src/engine/npc/balanceEvaluation.ts`, `backend/tests/engine/npc/npc-balance-evaluation.test.ts`). Route: inline. Evidence: 2700 ticks simulated in ~180ms, trade decisions observable, R7 expansion tested, specialization penalties (+80% to +120%) verified.
- **T5** [S1-S5] — **done** — Final verification (`bun test`, `bun run lint`, `bun run build` in green), Engram findings persistence, and criteria report. Route: inline. Evidence: 626 tests passing, lint 0, build 0.
