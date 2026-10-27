# Godot authoritative factory slice
Start the new Godot game as a client of an independently runnable TypeScript backend, including Docker packaging.
Branch: `feature/godot-authoritative-factory` | Delivery: `ask-on-risk`, cached `chain_strategy=feature-branch-chain` (forecast 1,000–1,400 authored changed lines; no publishing) | Checks: Bun tests, Godot 4.7.2 headless/client smoke, Docker build/health.

## Specs

- **S1** — User selection: "si vamos por el 2." Selected option context: "Godot como cliente de un backend autoritativo: más trabajo inicial, pero alineado con el diseño multijugador y el issue #6." Check: the backend alone owns simulation state, ticks and command execution; Godot consumes state and sends requests, rather than running a second simulation.
- **S2** — User authorization: "Si necesitas reestructurar el repo tienes permiso." Check: make only the restructuring needed for this first slice; preserve the existing web prototype and local editor setup.
- **S3** — User request: "el backend lo podemos crear para pode meterlo en un contenedor de docker ?" Check: provide an independently runnable backend, Dockerfile and Compose configuration, and observe a container build and health/client request.
- **S4** — User clarification:
  > el juego en godot esta en blanco, solo para aclarar.
  > se debe iniciar.
  Check: add a runnable Godot main scene with a usable factory screen and verify the server-driven production loop.

### Bounded implementation assumptions

- **A1**: This is the first operable factory slice: authenticated state reads, inventory/line display, and starting one R1 batch for the server-selected metallurgy company. Contracts, wallets, external game MCP, NPC automation and durable SQLite are not part of this slice; the 15 issues remain a backlog, not blanket authorization to implement them.
- **A2**: Reuse the existing `SimulatorEngine`, `submitCommand`, `processTick`, `getExecutionHistory`, `getCompany`, and the recipe catalog without changing their shared rules. The server supplies company identity, tick, sequence and command IDs; clients cannot set these or mutate inventories. Restrict the initial command surface instead of exposing known unsafe prototype actions.
- **A3**: Freeze the HTTP contract in `docs/factory-api.md` before launching independent backend and Godot writers. Keep their edit surfaces disjoint. The backend is tested through HTTP; the client can be tested against contract fixtures independently, followed by a real-server seam check.
- **A4**: Runtime credentials are required environment/user input, not committed defaults. Bind native development to loopback, expose Docker on loopback by default, avoid client credential redirects and do not claim internet-production authentication. Container restart loses in-memory match state; Docker is not persistence.
- **A5**: Preserve the existing local Funplay installation without vendoring thousands of third-party lines or making game runtime depend on editor tooling. Use Godot's supported local `override.cfg` for Funplay autoload/plugin settings, leave that file and the installed addon ignored, and verify that a clean checkout runs without Funplay. Official 4.7 `ProjectSettings.xml` documents that any project setting can be overridden this way.

## Tasks

- **T1** [S1,S2,S3,S4] — **in_progress** — Freeze API, verify tool/bootstrap assumptions, and record delivery boundaries. Route: inline; parent owns the contract and scope. Commit: pending. Evidence: Bun imports the existing engine; Docker daemon is available; Godot binary located through Funplay.
- **T2** [S1,S2,S3,S4] — **pending** — Implement the backend/Docker unit and the Godot client unit with their own tests/docs. Route: two parallel `gentle-ai-worker` runs after T1, each several files/100+ lines, independently against the frozen contract and disjoint paths. Commits: backend pending; client pending. Risk: item 2 (server authority and client credentials), item 5 (container/environment packaging).
- **T3** [S1,S2,S3,S4] — **pending** — Run the full client/server/container seam, independent risk verification, and native review for each work-unit candidate under the enabled RDD switch. Route: parent functional checks plus bounded `gentle-ai-verify` for the named risks; provider-owned review only. Commits/evidence: pending.
- **T4** [S1,S2,S3,S4] — **pending** — Finish startup guidance and record verified outcomes, limitations and work-unit commits. Route: inline closure; no publishing. Commit/evidence: pending.

## Log

- **L1 — Original implementation authorization (verbatim)**:
  > si vamos por el 2.
  > Si necesitas reestructurar el repo tienes permiso.
- **L2 — Godot clarification (verbatim)**:
  > el juego en godot esta en blanco, solo para aclarar.
  > se debe iniciar.
- **L3 — Container request (verbatim)**:
  > el backend lo podemos crear para pode meterlo en un contenedor de docker ?
- **L4 — Baseline**: branch point `a45823d437ecfae8de929a5759c741ee8a9d0a08`; the web prototype is tracked and `gf/` is a pre-existing untracked user scaffold. No source files have been changed. The prior read-only review read all 15 issue bodies but was not an exhaustive handler audit or functional validation.
- **L5 — Tool evidence**: Bun 1.4.2 imports `src/engine/SimulatorEngine.ts` without frontend dependencies and initializes four companies. Node v24.21.0, Docker 29.8.2 and Compose v5.5.1 are installed; daemon 29.8.2 is reachable. Running editor reports `/home/s/dev/App/Godot_v4.7.2-stable_linux.x86_64`. Native RDD is on by global choice; no review authority has been created for this feature.
- **L6 — Review workload forecast**: 1,000–1,400 authored changed lines across protocol/bootstrap, backend+tests+Docker, client+tests, and startup documentation. Keep coherent work units; 400 lines is guidance, not a reason to omit tests or compress code. Delivery shape needs the ordered menu before the first work-unit commit. No push, PR creation or merge is authorized.
- **L7 — Pending authorization**: T1 waits for the user's ordered delivery-shape choice; implementation has not started. Docker daemon access passed. The Markdown checker reported incomplete marksman coverage and spelling/style advisories, not a blocking source finding.
- **L8 — Delivery choice**: User selected "Cadena sobre rama de funcionalidad (recomendado)" (`feature-branch-chain`). Cache this choice for the feature, keep backend/container and Godot as coherent separate slices, and do not publish anything.
- **L9 — Frozen contract**: `docs/factory-api.md` defines v1 health, authenticated own-company state, a single-batch R1 request and final command status. No client-provided identity/ticks, redirects with credentials, live token defaults or public tick endpoint. Parallel writers consume this exact file, not each other's implementations. Docker deployment is loopback-published and in-memory. The optional Funplay override is supported by the official Godot 4.7 class documentation. Existing locked frontend dependencies are being installed for baseline and final type/build checks; no dependency versions are being changed.
- **L10 — Environment and blocker**: `bun install --frozen-lockfile` passed (185 packages; package.json and bun.lock unchanged). The first planning/API commit was refused with `fatal: no es posible auto-detectar la dirección de correo (se obtuvo 's@sd.(none)')`; Git reports unknown author identity, and no repository-local user.name/user.email is configured. No commit was created; HEAD remains the branch point and only the planning/API documents are staged. Do not infer or copy an author's identity. T1 waits for the human's exact name/email to configure in this repository only. No backend or Godot gameplay source has been written, and no workers/review lineage have been launched.
- **L11 — Identity authorization (verbatim)**:
  > ysa las credenciales de gh ssh configurada
  The user authorizes deriving the local commit author from the authenticated GitHub account. Query `gh api user`, use that account's verified profile/login and privacy-preserving GitHub noreply address if needed, and configure this repository only. Do not change SSH keys, remote URLs or global Git configuration. T1 resumes while the profile query runs.
- **L12 — Identity resolved**: Authenticated GitHub account `sdsoporte` has ID `211432262` and no public name/email. With the user's authorization, configured repository-local author `sdsoporte <211432262+sdsoporte@users.noreply.github.com>`. Global configuration, SSH keys and origin URL were not changed. The first-commit blocker is resolved.
