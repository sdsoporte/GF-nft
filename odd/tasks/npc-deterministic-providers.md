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

## Approved Product Decisions (Human Approved)

1. **NPC Sell Price (Decision 1)**: Selling price formula is `costoBase * (1 + margin)` with a fixed margin of 20% (`DEFAULT_NPC_SELL_MARGIN_PERCENT = 20`). Covers the 20% collateral requirement and 2% market burn fee.
2. **Initial Stock Retention (Decision 2)**: NPCs retain exactly 50% of their initial starting stock per item (`NPC_INITIAL_STOCK_RETENTION_RATIO = 0.5`) before releasing surplus to market offers.
3. **Max Buy Price for NPC Buyers (Decision 3)**: NPC buyers pay at most 1.0× recipe base cost (`DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT = 0`). Any offer priced above base cost is rejected by NPC buyers.
4. **Base Energy Generation (Decision 4)**: Maintained at +20 ENERGY/tick in the engine (`BASE_ENERGY_GENERATION_PER_TICK = 20`).

## Tasks

- **T1** [S1,S3] — **done** — NPC domain types and deterministic policy (`backend/src/engine/npc/types.ts`, `backend/src/engine/npc/DeterministicNpcPolicy.ts`). Route: inline. Evidence: unit tests pass, idle line scheduling, surplus offer creation, contract dispatch.
- **T2** [S1,S2,S3] — **done** — NPC Controller and command orchestration (`backend/src/engine/npc/NpcController.ts`). Route: inline. Evidence: registers default NPC companies, steps ticks deterministically, submits valid engine commands.
- **T3** [S1,S3,S4] — **done** — Test-first unit and determinism test suite with fixed seed (`backend/tests/engine/npc/npc-policy.test.ts`, `backend/tests/engine/npc/npc-controller.test.ts`, `backend/tests/engine/npc/npc-determinism.test.ts`). Route: inline. Evidence: byte-identical checkpoint comparison across runs with identical seed, invariants verified over 500 ticks, multi-source supply verified.
- **T4** [S2,S3,S5] — **done** — 2700-tick full match simulation and energy balance evaluation suite (`backend/src/engine/npc/balanceEvaluation.ts`, `backend/tests/engine/npc/npc-balance-evaluation.test.ts`). Route: inline. Evidence: 2700 ticks simulated in ~180ms, trade decisions observable, R7 expansion tested, specialization penalties (+80% to +120%) verified.
- **T5** [S1-S5] — **done** — Final verification (`bun test`, `bun run lint`, `bun run build` in green), Engram findings persistence, and criteria report. Route: inline. Commit: `3e65943`. Evidence: 626 tests passing, lint 0, build 0.
- **T6** [S1,S3,S5] — **done** — Parameterize approved product decisions in `types.ts`, update controllers, and add dedicated verification tests (`backend/tests/engine/npc/npc-policy.test.ts`). Route: inline. Evidence: 628 tests passing, lint 0, build 0.
