# GigaForge

One product repository: an authoritative Bun backend and a Godot client. The
initial React/Vite demo is a **historical source archive**, not a supported
application or part of the active build.

## Components

| Area | Location | Responsibility |
| --- | --- | --- |
| Godot client | [`gf/`](gf/README.md) | Render server snapshots and submit production commands. |
| Backend | [`backend/`](backend/README.md) | HTTP/CLI, simulation, domain, MCP policies and SQLite persistence. |
| Backend tests | `backend/tests/` | Engine, persistence, authorization, HTTP and regression suites. |
| Repository integration | `tests/integration/` | Validate active package/build boundaries. |
| Wire contract | [`docs/factory-api.md`](docs/factory-api.md) | Frozen version-1 client/server protocol. |
| Archived web demo | [`docs/archive/web-demo/`](docs/archive/web-demo/README.md) | Historical UI/assets/manifests; never an active workspace or deployment. |
| Work evidence | [`odd/tasks/`](odd/tasks/) | Specifications, migration tasks and verification history. |

The staged repository migration is tracked in
[`odd/tasks/product-layout.md`](odd/tasks/product-layout.md). Godot and contract
paths above are updated in the next coherent migration unit.

## Local backend

Run these commands **from the repository root**:

```bash
bun install --frozen-lockfile
bun run test
bun run lint
bun run build
export GF_API_TOKEN="$(openssl rand -hex 24)"
bun run server
```

`server` retains `bun backend/main.ts` and the repository-root working directory;
relative `GF_SQLITE_PATH` and environment loading keep their original meaning.
`bun backend/main.ts --help` lists the supported options, routes and environment
variables. The server defaults to `127.0.0.1:8787`.

- `test` explicitly selects active backend and repository integration suites.
- `lint` typechecks active TypeScript only, without React/Vite client types.
- `build` produces the backend artifact under `backend/dist/`, not a web bundle.
- `test:backend` runs the backend suites alone.

Godot instructions and isolated headless checks are in its component README.
There is no active website and no `site/` workspace. To reproduce the retired
web prototype, use the historical commit documented in its archive README;
do not wire archived sources back into the current backend.

## Persistence and credentials

State stays in memory unless `GF_SQLITE_PATH` is configured. Compose uses a
named SQLite volume and publishes HTTP on loopback only. Before starting an
existing volume on this branch, read the
[credential migration notes](docs/mcp-grant-storage.md): migration 5 retires
legacy grants and requires reissuance. Repository restructuring itself does
not migrate a live database or deploy a service.

Optional `GF_OWNER_ID` enables the configured single-owner administration
mode. The root bearer establishes an expiring owner session; only owner
sessions administer grants. Secrets are issued once; stored grants are hash-only.
There is no public signup, external identity provider or external MCP transport
in this scope. Never use historical demo credentials for a real match.

## Containers and CI

Compose builds `backend/Dockerfile` with repository-root context. Runtime
images contain backend source and its runtime dependency, not the archive,
Godot project, tests, dev tooling or local env files.

CI runs the scoped test, typecheck and backend build commands using frozen
installation. The required check name remains **`test, lint, build (headless)`**;
no branch-protection changes or publishing are part of this migration.
