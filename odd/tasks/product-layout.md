# Product repository layout
Archive the obsolete web demo and separate active Godot, backend, contract and integration ownership without changing runtime behavior.
Branch: `refactor/product-layout` from `4a116ec` | Delivery: local reviewable units on the established feature-branch chain, no new remote delivery | Checks: Bun/backend, Godot headless, integration, Docker, static path/scope checks and independent verification.

## Specs

- **S1** — User authorization (verbatim): "ok genera un backup del estado actual y luego procede con esa estructura. documenta el cambio." Check: verified, private recovery snapshot precedes any source/config migration.
- **S2** — User context (verbatim): "necesitamos organizar el repositorio. ya que queda obsoleto el demo inicial web. y organizar el juego (/gf) y el backend (/backend)". Check: active game/backend have explicit ownership; the web demo is historical, not an active application.
- **S3** — User destination (verbatim): "mover el sitio viejo a (/docs)". Accepted proposal destination: `docs/archive/web-demo/`, versioned SOURCE ONLY, excluded from active dependency/build/test/typecheck/Docker scope.
- **S4** — User scope (verbatim): "Corregit de forma correcta el gitignore y demas." Check: ignore generated/dependency/local-secret/local-data artifacts without hiding game source, .uid files or the archive; update dependent configuration and paths.
- **S5** — User documentation requirement (verbatim): "documenta el cambio." Check: repository entry guide, structure/migration/recovery notes and component documentation describe the actual layout and commands.
- **S6** — User preference (verbatim): "puedes proponer la estructura que menos problemas genera pero nos mantega el repo organizado". Check: reuse existing Bun/Godot tooling, one repo/active core, explicit validation scope, no new framework or speculative site.

### Accepted layout referenced by "esa estructura"

- `game/` replaces `gf/`; all Godot resources, UIDs and component tests stay within the project.
- `backend/src/{domain,engine,persistence,mcp}` owns the active core now mixed with root web sources; existing backend server files remain there.
- `backend/tests/` unifies backend-owned tests from `backend/test/` and root `tests/`; `tests/integration/` is for cross-component/public-boundary validation.
- `contracts/` owns wire-protocol documentation/examples, not business logic. Keep Godot resource fixtures within `game/` where res:// requires it.
- `docs/{backend,architecture,research,archive/web-demo}`, existing `odd/tasks`, root `.github/workflows`, Compose, minimal Bun orchestration/one active lockfile, gitignore and README.

### Bounded implementation constraints

- Pure ownership/path/tooling migration: preserve HTTP behavior, simulation/economy, SQL migration bytes/order, supported CLI/env semantics and persisted data. Do not run migrations on a live volume, close an unsaved editor, rename the GitHub repo or publish code.
- Archive only legacy frontend source/assets/config/manifests, not the active core, actual env secrets, dependencies, generated output or copied backend logic. Historical execution uses the saved commit; the archive is not maintained as a second app.
- Root server command retains its working-directory/env behavior. Component configurations and CI explicitly exclude the archive; preserve the existing required check name.
- Existing MCP feature is preserved. Its old frontend T5 becomes dropped by this accepted scope and is replaced by archive-boundary proof here; final full security verification remains required, never green-by-claim.
- Mechanical relocation has no behavior-change RED requirement. Observe baseline and post-move equivalence; add RED for newly asserted public repository/validation boundaries where meaningful. Tests never read Git history as a committed oracle.

## Tasks

- **R1** [S1] — **done** — Private Git/all-worktree backup. Route: parent inline. Evidence: `backup/pre-layout-20261028T185136Z-C3ngEm`, `.git/backups/pre-layout-20261028T185136Z.C3ngEm`, bundle/gzip/SHA256/tar byte-compare/unchanged status PASS,3 worktrees,2.3MB. Source baseline `4a116ec`.
- **R2** [S1-S6] — **in_progress** — Map dependent paths and establish the migration/spec + MCP reconciliation before source changes. Route: one read-only explorer (evidence budget: repository-wide scripts/imports/configs), parent map spot check. Commit: pending tracking evidence.
- **R3** [S2-S4,S6] — **pending** — Archive legacy web sources; move the active backend core/tests; establish backend package/typecheck/build and root orchestration; update coupled Docker/CI paths in the same coherent unit so checks stay runnable. Route: inline mechanical migration (one coupled structural behavior, not independent behavior writers). Commit: pending. Risk: items3/5 (consumed paths, dependency/build graph).
- **R4** [S2,S4,S6] — **pending** — Rename Godot to game; centralize the frozen wire document; relocate cross-component runner and update paths/links without changing res:// resources or protocol. Route: inline, dependent on R3. Commit: pending. Risk: items3/5 (tool/resource and invocation paths).
- **R5** [S3-S6] — **pending** — Finalize ignore rules, guides, archive provenance and ownership-boundary regressions; reconcile obsolete MCP frontend coverage truthfully. Route: inline; tests/docs remain with each behavior/path unit, not separate writers. Commit: pending.
- **R6** [S1-S6] — **pending** — Full active backend/Godot/integration/container/scope checks and one independent verifier over both this document and the reconciled MCP specs. Route: parent functional checks + gentle-ai-verify, known risk items3/5 and security inherited from unchanged MCP feature. Commit: pending evidence. No native authority invented if assessment remains unavailable.
- **R7** [S1-S6] — **pending** — Close tracking/mirrors and record work-unit commits, verified structure, backup recovery locator and remaining limitations. Route: parent inline. Commit: pending closure.

## Log

- **L1 — Original current request (verbatim)**: "ok genera un backup del estado actual y luego procede con esa estructura. documenta el cambio."
- **L2 — Prior request (verbatim)**:
  > necesitamos organizar el repositorio. ya que queda obsoleto el demo inicial web. y organizar el juego (/gf) y el backend (/backend)
  > tenemos que organizar de forma correcta el repositorio. mover el sitio viejo a (/docs)
  >
  > algo asi:
  > gigaforge/                    # Repositorio del producto
  >    ├── game/                     # Godot
  >    ├── backend/                  # Motor, dominio y persistencia
  >    ├── site/                     # Web, si pertenece al mismo producto
  >    ├── contracts/                # Contrato cliente–servidor
  >    ├── docs/
  >    │   └── research/
  >    └── tests/
  >        └── integration/
  >
  > Que piesas, de lo contrario seguiremos arrastrando problemas de validacion  y revision contra los pr.
  > Corregit de forma correcta el gitignore y demas.
- **L3 — Proposal request (verbatim)**: "puedes proponer la estructura que menos problemas genera pero nos mantega el repo organizado". Proposed single repo/source-only archive (Engram6577) is accepted by S1. No site/ or repo split; no new remote publishing consent.
- **L4 — Backup before source changes**: root clean at `4a116ecfd5611b465928437b8dadaf1da8ca8f24`; all refs plus3 worktrees privately snapshotted/verified before this document existed. External live DB/volumes and unsaved buffers are outside repository snapshot. No running Godot process found in preflight. Only local database candidate was generated CodeGraph cache. Baseline `bun test`:522 pass/7 skip/1 todo/0 fail; lint0. Godot baseline job-14 pending.
- **L5 — Forecast / route**: most source moves should retain rename identity; forecast roughly500–900 authored import/config/doc/test lines plus mechanical renames and generated lock changes. Preserve the established local feature-branch-chain delivery choice and coherent separately checked migration units. Do not duplicate code, compress tests or add compatibility scaffolding for a line heuristic. Explorer `mvsh43to-5-dkdo` maps the broad dependency surface; no writer trigger is inferred merely from file count. All real-data formats and runtime behavior stay unchanged.
