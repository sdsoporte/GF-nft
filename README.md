# GigaForge — authoritative factory slice

The GigaForge simulation now has an independently runnable backend in
[`backend/`](backend/README.md): one Bun process owns the match clock, the
command queue and the inventory. The Godot game in [`gf/`](gf/README.md) is its
client. The existing React prototype keeps its own local simulation and is not
connected to this backend. Start the backend in Docker or locally, then
connect Godot.

The wire contract is frozen in [`docs/factory-api.md`](docs/factory-api.md).

> Scope: this is a single-factory, in-memory development slice (one metallurgy
> company, one `R1` batch command). It does not complete issues #6, #7 or #8 and
> it is not a public production authentication story.

## Quick path

### With Docker (recommended)

```bash
export GF_API_TOKEN="$(openssl rand -hex 24)"
docker compose up --build --detach --wait
curl -s http://127.0.0.1:8787/health        # {"status":"ok","protocolVersion":1}
```

Compose publishes the port on `127.0.0.1` only and refuses to start without
`GF_API_TOKEN`.

### Without Docker

```bash
export GF_API_TOKEN="$(openssl rand -hex 24)"
bun run server                              # defaults: 127.0.0.1:8787
```

`bun backend/main.ts --help` prints every command, environment variable and
route.

### Clients

- Godot: [`gf/README.md`](gf/README.md).
- React prototype: `bun run dev` (unchanged; it still runs its own local
  simulation and is not wired to the backend in this slice).

## What runs where

| Area | Path | Role |
| --- | --- | --- |
| Authoritative backend | `backend/` | Owns clock, commands and state; HTTP + CLI entrypoint and tests. |
| Frozen protocol | `docs/factory-api.md` | Health, authenticated own-company state, one `R1` batch request, command status. |
| Godot client | `gf/` | Renders server snapshots and sends production requests. |
| React prototype | `src/` | Pre-existing local prototype; unchanged by this slice. |

## Verification

```bash
bun test              # full TypeScript suite (HTTP boundary, CLI)
bun run lint          # tsc --noEmit
bun run build         # Vite build of the prototype
GF_API_TOKEN=... docker compose config --quiet
```

CI runs the same three commands on every pull request, headless (no UI), from
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). A red run marks the PR;
making that check merge-blocking is a branch-protection setting on GitHub.

## Limits

- In-memory state: restarting the process or container starts a new match.
- One server-selected factory and one recipe; contracts, wallets, NPC
  automation, multi-process durability and the external game MCP remain backlog.
- A shared bearer token on a loopback port is a development convenience, not
  internet-ready authentication.

## Next step

Read [`backend/README.md`](backend/README.md) for the behaviour the tests pin, or
[`docs/factory-api.md`](docs/factory-api.md) before changing the protocol.
