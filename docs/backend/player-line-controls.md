# Player line controls (issue #57)

Pause, resume and priority are now exposed to the player over three additive HTTP
routes. The frozen v1 contract in `contracts/factory-api.md` is untouched: no
existing route changed, no new command-status enum, no broadening of
`POST /v1/production`, no `produced` status. These routes reuse the production
request-id ledger, acknowledgement shape and error table.

## Routes

All three are `POST`, require `Content-Type: application/json`, the same bearer
token as every other authenticated route, and a body bounded to 8 KiB.

| Route | Body |
| --- | --- |
| `POST /v1/lines/{lineId}/pause` | `{"requestId":"..."}` |
| `POST /v1/lines/{lineId}/resume` | `{"requestId":"..."}` |
| `POST /v1/lines/{lineId}/priority` | `{"requestId":"...","priority":1}` |

- `requestId` is 1–64 ASCII letters, digits, `_` or `-`, exactly as on `/v1/production`.
- `priority` is an integer `1`, `2` or `3`. A value outside that range, a string,
  a float or a missing key is a `400`, never a coercion.
- Any extra field is refused by construction, so a client can never send a
  company ID, tick, sequence number, batch count or inventory change. The
  company is always `comp_metal_01` and the tick is always the next server tick.
- Only lines owned by the server-selected company are addressable; a foreign,
  unknown or percent-encoded foreign `lineId` is a `403`.

Accepted responses are `202` with the production acknowledgement shape and
nothing else:

```json
{"commandId":"cmd_<24 hex>","status":"queued"}
```

`202` means the command is durably queued. It is not a claim that the control was
applied; `GET /v1/commands/<commandId>` reports the final engine result.

## Admission path

`FactoryMatch.requestLineControl` and `FactoryMatch.requestProduction` share one
private durable admission path (`admitPlayerCommand`). An admission is one ledger
entry plus one queued command; durably the queue row, the permanent dedupe key
and the acknowledgement commit in a single transaction before the engine observes
the command. The lines control route therefore behaves identically to production:

- An exact retry (same `requestId`, same line, same action, same priority)
  returns the original `commandId` without queueing a second command, before or
  after it executes.
- Reusing a `requestId` with any different payload — another action, another
  line, another priority, or a production request — is `409 REQUEST_ID_REUSED`
  and leaves the original command untouched. The ledger is shared, so request
  IDs are unique across all player write routes.
- Validation and ownership rejections (`400`, `403`, `413`, `415`) enqueue
  nothing, consume no request ID and never advance the simulation.
- At 1024 retained acknowledgements a new request ID gets `429 COMMAND_LIMIT`;
  exact retries still work at that bound.

Fingerprints are `${lineId}\n${action}` for pause/resume and
`${lineId}\n${action}\n${priority}` for priority. The production fingerprint stays
`${lineId}\n${recipeId}` so acknowledgement rows persisted by earlier releases
still match a retry after a restart.

## Engine behavior

The routes add no engine semantics. They map to the existing command types
`PAUSE_PRODUCTION_LINE`, `RESUME_PRODUCTION_LINE` and `SET_LINE_PRIORITY` and are
executed by the engine queue on the next tick, like any other queued command.

- Pause sets the line to `PAUSED` and keeps `activeBatch`; the tick then skips
  the line, so batch progress is frozen and no energy or inputs are consumed.
- Resume restores `RUNNING` when a batch is still active (progress continues from
  the frozen tick) and `IDLE` otherwise. Resuming never deducts inputs again and
  never replays a completed batch.
- Priority assigns the line priority for the engine's energy distribution order.
- A pause does not authorize replacing an active batch. The issue #48 guard lives
  in `SET_PRODUCTION_TARGET`, which still refuses a line holding `activeBatch`
  with `errorCode: "ERR_LINE_BUSY"`. The production admission stays a `202` and
  the refusal is visible as `status: "rejected"` on `GET /v1/commands/<commandId>`.

## Errors

Same table and same codes as `/v1/production`; only the human-readable message
names the line route family.

| HTTP | Code | Cause |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Malformed JSON, wrong/extra fields, invalid `requestId`, priority not 1–3 |
| 401 | `UNAUTHORIZED` | Missing or incorrect bearer token |
| 403 | `FORBIDDEN` | Line not owned by the server-selected company |
| 404 | `NOT_FOUND` | Unknown action (for example `/cancel`) or unknown route |
| 405 | `METHOD_NOT_ALLOWED` | Known line route with a non-`POST` method |
| 409 | `REQUEST_ID_REUSED` | Same request ID, different payload |
| 413 | `REQUEST_TOO_LARGE` | Body exceeds 8 KiB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Body is not JSON |
| 429 | `COMMAND_LIMIT` | Match acknowledgement capacity reached |

## Out of scope

Cancellation, batch replacement and any energy rebalance are not part of this
slice. Godot controls are a separate follow-up built on this interface; the game
client must not simulate or predict these transitions locally.

## Verification

```sh
bun test backend/tests/player-controls.test.ts
bun run test
bun run lint
bun run build
```

`backend/tests/player-controls.test.ts` covers the pause → advance → resume →
batch-completion flow, frozen progress and single input charge, ownership `403`,
strict payload and priority range `400` without side effects, exact-retry dedupe,
reused-ID `409` (including reuse across routes and lines), `ERR_LINE_BUSY` after a
pause, server-side scheduling (no state change before the tick) and execution
through the engine queue. Every test owns an isolated in-memory match with a
manual clock; no test depends on wall-clock time.
