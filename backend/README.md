# Authoritative factory backend (development slice)

One Bun process owns the match: the clock, the command queue and the inventory.
Godot and the React prototype are clients that read state and send requests; they
never run a second simulation. The wire contract is frozen in
[`../docs/factory-api.md`](../docs/factory-api.md).

This is a first operable slice, not a finished service: one metallurgy factory,
one `R1` batch command, in-memory state, local deployment.

## Quick path

```bash
export GF_API_TOKEN="$(openssl rand -hex 24)"   # 32+ printable characters
bun run server                                  # or: bun backend/main.ts --help
curl -s http://127.0.0.1:8787/health
# {"status":"ok","protocolVersion":1}
curl -s -H "Authorization: Bearer $GF_API_TOKEN" http://127.0.0.1:8787/v1/state
```

Start one batch, then read the command status:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/production \
  -H "Authorization: Bearer $GF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requestId":"demo-1","lineId":"comp_metal_01_line_1","recipeId":"R1"}'
# 202 {"commandId":"cmd_<random>","status":"queued"}

curl -s -H "Authorization: Bearer $GF_API_TOKEN" \
  http://127.0.0.1:8787/v1/commands/cmd_<random>
# {"commandId":"cmd_<random>","status":"executed","executedAtTick":1}
```

## Commands

| Command | Purpose |
| --- | --- |
| `bun run server` | Start the HTTP service with the environment below. |
| `bun backend/main.ts --help` | Print usage, environment and routes; exits without serving. |
| `bun run test:backend` (or `bun test backend`) | Backend HTTP + CLI tests. |
| `bun test` | Full TypeScript suite. |
| `bun run lint` | `tsc --noEmit` over the repository. |
| `docker compose up --build` | Build and run the container, publishing loopback only. |

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `GF_API_TOKEN` | yes | Bearer token for every `/v1/` route. At least 32 printable characters, no spaces. Never logged, committed or baked into the image. |
| `GF_HOST` | no | Bind address, default `127.0.0.1`. The image sets `0.0.0.0` so the published port can reach it. |
| `GF_PORT` | no | Listen port, default `8787`. |
| `GF_PUBLISHED_PORT` | no | Host port published by `compose.yaml`, default `8787`, always on `127.0.0.1`. |

Invalid configuration exits with code `1` and a message that names the variable
without echoing its value. An unknown argument exits with code `2` and prints the
usage text.

## Routes

| Route | Auth | Response |
| --- | --- | --- |
| `GET /health` | no | `{"status":"ok","protocolVersion":1}` |
| `GET /v1/state` | yes | match ID, tick, tick interval, own-company snapshot, `R1` recipe |
| `POST /v1/production` | yes | `202 {"commandId":...,"status":"queued"}` |
| `GET /v1/commands/<id>` | yes | `queued`, `executed` (+`executedAtTick`) or `rejected` (+`errorCode`) |

## Behaviour that the tests pin

| Rule | Backend behaviour |
| --- | --- |
| State authority | The server supplies company identity, `commandId`, scheduled tick, sequence number and idempotency key. Clients cannot set company, tick, sequence or batch count. |
| Command surface | Only `SET_PRODUCTION_TARGET` for exactly one batch of `R1` on a line owned by `comp_metal_01`. |
| Ownership | Any line that is not one of the server company's lines returns `403 FORBIDDEN`, including lines that belong to another company or do not exist, so the response never reveals whether a foreign line exists. |
| Rejections | Invalid input (`400`), foreign lines (`403`), oversized bodies (`413`) and non-JSON bodies (`415`) enqueue nothing, consume no `requestId` and leave the simulation untouched. |
| Retries | An exact retry (same `requestId` and payload) returns the same `202` acknowledgement and does not enqueue a second command. |
| ID reuse | Same `requestId` with a different payload returns `409 REQUEST_ID_REUSED`; the original command is unchanged. |
| Capacity | At most 1024 unique acknowledgements per match. Exact retries still work at the bound; a new `requestId` gets `429 COMMAND_LIMIT`. |
| Body limit | `8192` bytes is accepted, `8193` is rejected with `413`. |
| Ordering | Routing resolves before authentication, so unknown routes answer `404` without credentials and known routes answer `405` for the wrong method. |
| Clock | One tick per second in the real entrypoint. `tickIntervalMs` is reported in state; there is no tick or mutation endpoint. |
| Failures | A queued engine rejection is reported as `rejected` with the engine's `errorCode`; it is never reported as successful production. |

The engine's shared rules are untouched: this service imports `SimulatorEngine`,
`submitCommand`, `processTick`, `getCompany`, `getExecutionHistory` and the recipe
catalog read-only, and reuses `submitCommand`/`processTick` sequencing and integer
inventory accounting.

`500 INTERNAL_ERROR` exists only as a defensive guard for unexpected faults; it is
not part of the frozen contract.

## Tests

`bun test backend` runs Node's `node:test`/`node:assert` suites through Bun. Every
test builds its own match and injects a `ManualTickClock`, so ticks advance only
when the test says so and no test observes another test's state. Each test listens
on an ephemeral loopback port and asserts exact public response bodies, unchanged
state and counters on rejection, two clients on the same match, and the
request-to-tick production loop over HTTP. The CLI tests spawn the real entrypoint
for `--help`, a missing token and a rejected token, and assert that no token value
is ever printed.

## Docker

```bash
export GF_API_TOKEN="$(openssl rand -hex 24)"
docker compose up --build
curl -s http://127.0.0.1:8787/health
```

- Image: official pinned `oven/bun:1.4.2`, running as the non-root `bun` user.
- Contents: `backend/`, `src/domain/`, `src/engine/`, `package.json`. No UI, no
  Godot project, no `.env`, no `node_modules`, no lockfile and no dependency
  install: the service only needs Bun built-ins.
- Binds `0.0.0.0:8787` inside the container; Compose publishes
  `127.0.0.1:${GF_PUBLISHED_PORT:-8787}`.
- Healthcheck calls the unauthenticated `/health` route.
- `compose.yaml` refuses to start without `GF_API_TOKEN`.

## Limits of this slice

- State is in memory: restarting the process or container starts a new match with
  a new match ID. Docker is deployment, not persistence.
- One factory, one recipe, one batch per request. Contracts, wallets, NPC
  automation, multi-tenant grants, SQLite durability and the external game MCP
  stay in the issue backlog; this slice does not close issues #6, #7 or #8.
- Loopback bind and a shared bearer token are development conveniences, not
  production authentication. Do not expose the published port to the internet.

## Next step

- Wire the Godot client: [`../gf/README.md`](../gf/README.md).
- Re-read the contract before any protocol change: [`../docs/factory-api.md`](../docs/factory-api.md).
