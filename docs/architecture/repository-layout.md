# Product repository layout and migration

GigaForge is one product repository with separate active component owners.
The React/Vite prototype is retained as historical source, not a second app.

## Ownership

| Path | Owner and validation |
| --- | --- |
| `game/` | Godot project, scenes, scripts, UIDs and res:// test fixtures. |
| `backend/src/` | HTTP/CLI, domain, engine, persistence and MCP policies. No browser provider. |
| `backend/tests/` | All backend-owned unit, HTTP, property, golden, persistence and security suites. |
| `contracts/factory-api.md` | Frozen version-1 gameplay wire contract and examples. No business logic. |
| `tests/integration/` | Package/scope regressions and real Godot/backend shell seam. |
| `docs/backend/` | Owner sessions, grant lifecycle, migration and MCP guides. |
| `docs/research/` | Research and proposals, separate from accepted contracts. |
| `docs/archive/web-demo/` | Original frontend sources/assets/manifests, excluded from every active pipeline. |
| `odd/tasks/` | Specifications, decisions, checks and local work-unit evidence. |

There is no active `site/`. The repository name and remote are unchanged.
Do not duplicate the domain/engine to make archived imports resolve. Historical
execution uses the saved commit, not the current archive directory.

## Commands and boundaries

Run root orchestration with Bun 1.4.2:

```bash
bun install --frozen-lockfile
bun run test
bun run lint
bun run build
GODOT_BIN=/path/to/godot bun run test:game
```

- Root `server` remains `bun backend/main.ts`: same CWD, environment loading,
  relative database paths and public CLI. Backend workspace `start` is intended
  for its own directory; prefer root `server` for existing root configuration.
- Root `build` delegates to the backend; artifacts live in `backend/dist/`.
  `bun run clean` removes only that regenerable output.
- Root tests explicitly select backend/tests and tests/integration; TypeScript
  includes active files only and does not load React/Vite/DOM types.
- One active `bun.lock` and the native `backend` workspace own dependencies.
  The archive's original manifest/lock are provenance, not another installation.
- CI retains the protected check name `test, lint, build (headless)` and frozen
  Bun test/typecheck/backend-build gates. Godot headless checks remain a local
  explicit command; this migration adds no third-party CI installer/action.
- Compose selects `backend/Dockerfile` using root context. Docker excludes
  game, docs/archive, tests, local env files and development dependencies.

The real integration runner **mutates its target match by producing one batch**:

```bash
GODOT_BIN=/path/to/godot \
GF_API_TOKEN="$ISOLATED_TEST_TOKEN" \
GF_BACKEND_URL=http://127.0.0.1:18887 \
  bun run test:integration
```

Use a dedicated disposable backend/database, never a production or shared match.
The runner derives game/ from its own path and works from any current directory.
Resources needed by Godot stay inside game/; do not point res:// at contracts/.

## Migration map

| Before | After |
| --- | --- |
| `gf/` | `game/` |
| `src/{domain,engine,mcp,persistence}` | `backend/src/` (except browser-only provider) |
| `backend/test/` and backend-owned `tests/` | `backend/tests/` |
| `gf/tests/run_backend_smoke.sh` | `tests/integration/run_backend_smoke.sh` |
| `docs/factory-api.md` | `contracts/factory-api.md` |
| `docs/mcp-*.md` | `docs/backend/` |
| root React/Vite app, public assets and original manifests | `docs/archive/web-demo/` |
| root `Dockerfile` | `backend/Dockerfile` |

Godot .gd/.uid/.tscn/project/fixture bytes and gameplay wire examples are
preserved. No simulation, protocol version or SQL migration was rewritten.
Existing migration 5 still retires old grants if deployed: plan reissuance
before starting a persistent volume. No live data migration/deployment is part
of this repository move.

## Backup and recovery

The pre-migration baseline is `4a116ecfd5611b465928437b8dadaf1da8ca8f24`.
Local backup ref: `backup/pre-layout-20261028T185136Z-C3ngEm`.
Private backup directory: `.git/backups/pre-layout-20261028T185136Z.C3ngEm/`.

It contains an all-refs Git bundle, snapshots of all three worktrees, path/ref
metadata and SHA256SUMS. Bundle verification, gzip integrity, archive comparison
against live files and unchanged Git statuses passed before source edits. An
independent scratch clone/checkout from the bundle also recovered the baseline.

Dependency/build/Godot/tool caches were excluded as regenerable. In-project
local configuration may be present: **do not commit or publish the backup**.
External databases/volumes and unsaved editor buffers were not repository files
and are not covered. The existing Git metadata/review authority is not reset.

For recovery, inspect README.txt and verify SHA256SUMS first. Clone the bundle
into a deliberately selected recovery directory, check out the baseline and
overlay the intended worktree archive there. Do not extract over active work,
reset branches or restore credentials without an explicit recovery decision.
Old generated mixed web/server dist output was additionally preserved under
`.git/odd-artifacts/retired-root-dist.f6VLFK/`, not left in an active build path.

## Local editor tooling

Open `game/project.godot` after the move. Preserve .uid and import-sidecar source
files; ignore only .godot caches and exports. Optional local Godot AI/Funplay
addons and override.cfg remain untracked. If personal MCP/editor configuration
pinned the old absolute gf/ path, update it locally to game/; no configuration
outside this repository was inspected or modified.
