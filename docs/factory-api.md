# Authoritative factory API — first playable slice

Godot is a client. One backend process owns the match, its clock and all mutations. This development slice exposes one metallurgy factory and one R1 batch command; it is not the finished multiplayer/authentication system.

## Quick path

From the repository root, choose one backend mode and keep the same token for
Godot:

```bash
export GF_API_TOKEN="$(openssl rand -hex 32)"
bun run server
```

Or use `docker compose up --build --detach --wait` instead of `bun run server`.
Open `gf/project.godot`, run its main scene and connect to
`http://127.0.0.1:8787` with that token. The complete startup and check commands
are in [`../README.md`](../README.md) and [`../gf/README.md`](../gf/README.md).

## Run boundary

- Bun 1.4.2 runs the TypeScript service independently of React and Godot.
- Native defaults: `GF_HOST=127.0.0.1`, `GF_PORT=8787`; the server advances one tick per second.
- `GF_API_TOKEN` is required, at least 32 characters, supplied through the environment. Do not log, commit or bake it into an image.
- The token selects `comp_metal_01` on the server. Request parameters cannot select a company or match.
- A new process creates a new match ID and in-memory match. Restart is not recovery; SQLite durability remains out of scope.
- The image binds `0.0.0.0` internally; Compose publishes to `127.0.0.1` by default. This is a local development deployment, not an internet-ready service.

## Authentication

All `/v1/` routes require `Authorization: Bearer <token>`. Health does not require credentials. Errors must not echo credentials or request bodies. Godot keeps credentials in memory/environment only, refuses plaintext HTTP to non-loopback hosts and does not follow redirects with a bearer token.

## Endpoints

### `GET /health`

`200` with `{"status":"ok","protocolVersion":1}`. No company state or credentials.

### `GET /v1/state`

`200` with these fields:

| Field | Meaning |
| --- | --- |
| `protocolVersion` | `1` |
| `matchId` | Server-generated ID, stable for this process |
| `tick` | Current integer simulation tick |
| `tickIntervalMs` | Server clock interval, `1000` in the normal entrypoint |
| `company` | A detached JSON-safe snapshot of `comp_metal_01`, using existing `CompanyState` field names |
| `recipes` | Array containing the R1 definition projected as below |

`company` includes its own `companyId`, name, class, credits, energy, inventory and production lines. It does not include another company's state, contracts or global execution history. Each recipe has `id`, `name`, `inputs`, `outputItem`, `outputQuantity`, `durationTicks` and `energyCost`; derive values from the existing recipe catalog and the company's class, not a duplicate rule table.

### `POST /v1/production`

Requires `Content-Type: application/json` and exactly this request shape:

```json
{
  "requestId": "client-generated-unique-request-1",
  "lineId": "comp_metal_01_line_1",
  "recipeId": "R1"
}
```

- `requestId` is 1–64 ASCII letters, digits, `_` or `-`.
- Only an owned production line and recipe `R1` are accepted in this slice.
- The server creates a `SET_PRODUCTION_TARGET` command for exactly one batch, schedules it for the next server tick, assigns a random command ID, and calls `SimulatorEngine.submitCommand`.
- Never accept client company IDs, ticks, sequence numbers, batch counts or inventory changes.
- `202` means queued, not executed: `{"commandId":"<server-generated-id>","status":"queued"}`.
- An exact retry with the same request ID and payload returns the same `202` acknowledgement without another command. Reusing an ID with a different valid payload returns `409 REQUEST_ID_REUSED` and does not change the original command.
- Input/ownership rejection must not enqueue a command, consume a request ID or change simulation state. Clock advancement is independent of requests.
- Bound JSON bodies to 8 KiB. Retain at most 1024 unique command acknowledgements per match; exact retries still work at that bound, while a new ID receives `429 COMMAND_LIMIT`.

### `GET /v1/commands/<commandId>`

`200` with `commandId` and `status`: `queued`, `executed` or `rejected`. A final result includes `executedAtTick`; a rejection also includes the engine's `errorCode`. A queued acknowledgement is not a business-success notification. Unknown IDs return `404 NOT_FOUND` without exposing any global history.

## Errors

```json
{"error":{"code":"UNAUTHORIZED","message":"A valid bearer token is required."}}
```

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Malformed JSON, wrong/extra fields, invalid ID or unsupported recipe |
| 401 | `UNAUTHORIZED` | Missing or incorrect bearer token |
| 403 | `FORBIDDEN` | Line is not owned by the server-selected company |
| 404 | `NOT_FOUND` | Unknown route or command |
| 405 | `METHOD_NOT_ALLOWED` | Known route, unsupported method |
| 409 | `REQUEST_ID_REUSED` | Same ID, different command payload |
| 413 | `REQUEST_TOO_LARGE` | Body exceeds 8 KiB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Production request is not JSON |
| 429 | `COMMAND_LIMIT` | Match acknowledgement capacity reached |

Except for the explicitly fixed unauthorized message, use short English messages and pin exact responses in public HTTP tests. Never turn an engine rejection into a successful production display.

## Godot behavior

The main scene has connection controls (URL and password-masked token), a visible connection/error state, server match/tick, credits/energy, inventory and production lines. The player starts an R1 batch and sees progress and resulting inventory from subsequent server snapshots. Do not run a simulation or increment resources in GDScript. Polling must avoid overlapping requests; reconnect, HTTP errors and malformed responses must not crash or leave an old connection acting on a new one.

## Verification and exclusions

Test the HTTP boundary: two clients see the same match; authentication/ownership/malformed input reject without side effects; exact retries enqueue once; queued business failures become rejected; production consumes inputs and creates the catalog output on server ticks. Use isolated state for each test and a controllable server-side clock, never a public tick endpoint.

Test the Godot parser/view behavior against fixtures, then run a headless Godot smoke against the actual service and inspect the running scene through Funplay when available. Build the image and verify health/authenticated state through its published port. Test the tracked Godot project without local Funplay files.

Known prototype defects outside the exposed single-batch path remain in the backlog. This slice does not close contracts, multi-tenant grants, concurrent multi-process durability, NPC, replay completeness, external game MCP or Web3 issues.
