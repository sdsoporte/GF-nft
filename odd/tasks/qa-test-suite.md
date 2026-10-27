# QA test suite (issue #10)
Tests-only hardening: unit, property, security, golden and regression suites plus a headless CI workflow.
Branch: `feature/qa-test-suite` stacked on `fix/engine-material-shortage` (8475520) | Delivery: local work-unit commits, no push/PR until the user authorizes | Checks: `bun test`, `bun run lint`, `bun run build`.

## Specs

Source: GitHub issue #10 "[P1][QA] Crear suite de pruebas para simulación, economía, contratos y permisos". Requirement strings are quoted verbatim (Spanish preserved).

- **S1** — Issue #10 scope: "Configurar test runner y workflow CI." Check: a workflow under `.github/workflows/` runs the repository's documented test, lint and build commands with no UI.
- **S2** — Issue #10 scope: "Unit tests: recetas R1–R8, prioridades, energía, mantenimiento, pausa/reanudación, contratos y vencimientos." Check: deterministic unit tests cover each named behavior through public engine APIs and pass under `bun test`.
- **S3** — Issue #10 scope: "Property-based/escenarios aleatorios: conservación de materiales, inventarios no negativos, créditos y colaterales." Check: seeded scenario corpora assert conservation and non-negativity invariants over a fixed seed list; no wall-clock or unseeded randomness.
- **S4** — Issue #10 scope: "Seguridad: grants expirados/revocados, cross-tenant, allowlists y solicitudes malformadas." Check: tests exercise McpGateway grant expiry/revocation, allowlists and malformed requests against current behavior; cross-tenant isolation is asserted where implemented and recorded as a pending test linked to open issue #2 where it is not.
- **S5** — Issue #10 scope: "Golden fixtures para simulación determinista y replay." Check: committed fixture files capture full expected engine state for a fixed seed and command script; the runner fails on any divergence.
- **S6** — Issue #10 scope: "Probar explícitamente regresiones de #1–#5." Check: #1 has a passing regression test; each of #2–#5 has an explicit pending regression test linked to its issue, flipped to asserted behavior when that issue's fix lands. No failing test in CI and no silent claim of coverage.
- **S7** — Issue #10 acceptance: "`test`, `lint` y `build` documentados y ejecutables en CI." Check: the CI workflow executes all three and the README documents the local equivalents.
- **S8** — Issue #10 acceptance: "Cada bug P0 cuenta con test de regresión." Check: every P0 issue (#1–#7) maps to at least one test entry, green or explicitly pending with the issue number.
- **S9** — Issue #10 acceptance: "Mismas entradas/semillas producen idéntico estado completo." Check: running the same seed and command script twice yields byte-identical serialized state.
- **S10** — Issue #10 acceptance: "Los fallos de pruebas bloquean merge." Check: the workflow fails the PR check on any test failure; enabling GitHub branch protection to require that check is a repository-admin step recorded for the user, not automated.
- **S11** — Issue #10 acceptance: "CI ejecuta tests sin UI gráfica." Check: CI runs only `bun test`, `bun run lint` and `bun run build`; Godot/visual checks stay local.

### Bounded assumptions

- **A1**: Tests-only scope. Open P0 bugs #2–#5 are not fixed here; their tests start as pending (never green-by-claim, never red-in-CI) until their own issues land fixes.
- **A2**: The branch stacks on chain tip `fix/engine-material-shortage` (8475520) because `main` lacks the #1 fix, backend and client; the QA work rebases or retargets when the chain merges.
- **A3**: The engine is deterministic behind `Mulberry32PRNG` (default seed 42107); `McpGateway` uses `Date.now()` in generated command ids, so golden fixtures target engine state, not gateway ids.
- **A4**: CI uses GitHub Actions + Bun with no secrets; branch protection remains a user decision.
- **A5**: Issue #10 references `src/engine`, `src/mcp`, `src/persistence`; the existing backend HTTP and Godot suites are invoked by the runner, not rewritten.
- **A6**: Test-only deliverable: the new suites assert existing documented behavior; the recorded RED/GREEN from issue #1's fix remains the code-fix proof. Proportionate verification = per-file runs plus the full suite green.

## Tasks

- **T1** [S1,S7,S11] — pending — CI workflow plus test/lint/build documentation. Route: inline (one workflow file + README section). Commit: pending.
- **T2** [S2] — pending — Engine unit tests: recipes R1–R8, priorities, energy, maintenance, pause/resume. Route: writer, wave 1, surface `tests/engine/core*`. Commit: pending.
- **T3** [S2] — pending — Contract lifecycle tests: creation, acceptance, partial delivery, expiration, default. Route: writer, wave 1, surface `tests/engine/contracts*`. Commit: pending.
- **T4** [S3] — pending — Seeded property/scenario tests for conservation invariants. Route: writer, wave 1, surface `tests/property/*`. Commit: pending.
- **T5** [S4] — pending — MCP security tests: expired/revoked grants, allowlists, malformed requests, cross-tenant pending for #2. Route: writer, wave 1, surface `tests/mcp/*`. Commit: pending.
- **T6** [S5,S9] — pending — Golden fixtures and byte-identical determinism/replay runner. Route: after wave 1, surface `tests/golden/*`. Commit: pending.
- **T7** [S6,S8] — pending — P0 regression matrix for #1–#7: green #1, pending #2–#5 linked, coverage documented. Route: inline after wave 1, surface `tests/regressions/*` + matrix note. Commit: pending.
- **T8** [S7,S10,S11] — pending — Final CI wiring: verify workflow commands against final suites and document the branch-protection step for the user. Route: inline closure. Commit: pending.

## Log

- **L1 — Original request (verbatim)**:
  > 1, 2 y 3 en orden d de prioridades.
  Priority 1 was "Reparar conflicto del PR #17", priority 2 this QA suite (issue #10), priority 3 SQLite (issue #8).
- **L2 — PR17 repaired (priority 1)**: merged `feat/factory-authoritative-backend` into `feature/godot-authoritative-factory` with `-X ours`; result tree byte-identical to the pre-merge tracker tree (`78a96e2c…`), pushed as `f17773d`. REST API reports PR #17 `mergeable: true, mergeable_state: clean`; PRs #16, #18, #19 also MERGEABLE/CLEAN. No PR merged; merges remain the user's decision.
- **L3 — Issue #10 and P0 landscape read**: issue #10 body quoted verbatim into S1–S11. Issues #2–#5 read: all four are open P0 defects with unfixed behavior (cross-tenant isolation, draft/publish separation, buyer/target validation, credit ledger), which forces assumption A1.
- **L4 — Landscape**: current tests = 1 engine file + 5 backend files + 7 Godot files; no `.github/workflows` exists; `SimulatorEngine` uses seeded `Mulberry32PRNG` (constructor default 42107); `src/mcp/McpGateway.ts` (899 lines) has grant register/revoke/phase/allowlist machinery; `src/persistence` holds `schema.sql` and `SqliteLocalSettlementProvider.ts` (421 lines). Full suite green on the chain tip: 46/46 plus typecheck.
