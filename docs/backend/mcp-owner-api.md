# Manage MCP grants through an authenticated owner session

Set `GF_OWNER_ID` to enable one local owner. The root `GF_API_TOKEN` can establish
that owner's session, but **cannot create, list or revoke grants by itself**.
There is no public signup or browser-bundled credential. Keep the development
service on loopback; this is not a public multi-user identity system.

## Quick path

```bash
export GF_API_TOKEN="$(openssl rand -hex 24)"
export GF_OWNER_ID=local_owner
export GF_SQLITE_PATH=./data/factory.db
bun backend/main.ts
```

In another terminal, using the same root credential:

```bash
session="$(curl -fsS -X POST http://127.0.0.1:8787/v1/owner/sessions \
  -H "Authorization: Bearer $GF_API_TOKEN" | jq -r .token)"
curl -fsS -X POST http://127.0.0.1:8787/v1/owner/grants \
  -H "Authorization: Bearer $session" -H 'Content-Type: application/json' \
  -d '{"phaseMode":"PHASE_1_READ_ONLY","scopes":["factory:read","inventory:read","market:read"]}'
```

The second response delivers `{ token, grant }` exactly once. Transfer that token
to its intended holder without logging it. Later list/get responses contain
metadata only, never a token or digest. The owner session lasts 15 minutes and
expires at its exact deadline. Use the root credential again to establish a new
session; it does not bypass the grant-administration session check.

## HTTP contract

| Method and path | Authentication | Result |
| --- | --- | --- |
| `POST /v1/owner/sessions` | Root bearer | 201: one-time session token, configured ownerId, expiresAtUtc. |
| `DELETE /v1/owner/sessions/current` | Owner-session bearer | 200: `{ revoked: true }`; session immediately unusable. |
| `GET /v1/owner/grants` | Owner-session bearer | 200: `{ grants: [...] }`, safe metadata. |
| `POST /v1/owner/grants` | Owner-session bearer | 201: one-time `{ token, grant }`. |
| `GET /v1/owner/grants/<id>` | Owner-session bearer | 200: `{ grant }`, or generic 404. |
| `DELETE /v1/owner/grants/<id>` | Owner-session bearer | 200: `{ revoked: true }`, or generic 404. |
| `POST /v1/owner/contracts/<id>/publish` | Owner-session bearer | 202: enqueue publication of an owned DRAFT on the next tick. |

Missing, expired, revoked or wrong session bearers return the existing fixed 401
`UNAUTHORIZED` response. A root bearer alone is also rejected by grant routes.
JSON issue requests are limited to 8192 bytes; wrong media type is 415, oversized
input 413, malformed JSON 400. Invalid/smuggled policy fields return 400
`ERR_INVALID_PAYLOAD` / `Invalid grant policy.` without echoing values. All JSON
responses use `Cache-Control: no-store`; session authentication uses bearer
headers, not cookies or request-selected identities.

`GF_OWNER_ID` accepts 1–64 ASCII letters, digits, underscores or dashes. Empty or
unset disables these routes and preserves the previous backend API/config
shape. Compose forwards it optionally. Existing game endpoints retain the root
bearer contract. See [issuance policy](mcp-grant-issuance.md) for TTL milliseconds,
scopes, phase, quota and allowlist bounds.

## Publish a proposed offer

After inspecting an owned DRAFT proposal, the human uses the owner session, not
an MCP grant or the root bearer directly:

```bash
draft_id=cnt_1_1 # Replace with the owned DRAFT ID.
curl -fsS -X POST "http://127.0.0.1:8787/v1/owner/contracts/$draft_id/publish" \
  -H "Authorization: Bearer $session" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"publish_offer_0001"}'
```

The JSON body contains only `idempotency_key` (8–64 alphanumeric, underscore or
dash characters). Client-supplied company, command type or other fields are
rejected. The 202 body is `{ status: "ENQUEUED_FOR_NEXT_TICK", scheduledTick,
contractId }`. It acknowledges command admission (durable when match
persistence is configured), not completed publication.
At the next tick, the engine rechecks ownership, future deadline and available
collateral, then changes DRAFT to PENDING without locking funds.

- Missing/root/grant/expired/logged-out bearers: fixed 401 `UNAUTHORIZED`.
- Unknown, foreign or non-DRAFT offer: generic 404, without queue/sequence changes.
- Invalid body fields/key: 400 `ERR_INVALID_PAYLOAD` / `Invalid publication request.`
- Wrong media type: 415 `UNSUPPORTED_MEDIA_TYPE` /
  `The publication request must be application/json.`
- Bodies over 8192 bytes: 413; malformed JSON: existing fixed 400 response.
- A reused command key: 409 `ERR_DUPLICATE_IDEMPOTENCY_KEY` /
  `idempotency_key duplicate`; no second admission.

Both drafts and queued publication survive an isolated persisted restart; owner
sessions do not. See [draft rules](supply-contracts.md) and the
[version-6 storage upgrade](contract-draft-storage.md). MCP has no publication
or acceptance tool; `contracts:draft` is not financial approval.

## Server enforcement and recovery

The configured owner can issue grants only for the existing server-selected
company/match and may only narrow that company's line allowlist. The gateway
reads policy from SQLite for every invocation; it never registers/caches a raw
real token. Revocation denies immediately and expiry denies at the exact
boundary, before scope, payload or quota side effects.

Embedding callers obtain the server-owned gateway as `handle.mcp` when owner
mode is enabled. Accepted commands go through the authoritative match/store
transaction before acknowledgement, preserving queue/idempotency across a
restart without consuming the HTTP request-ack limit. Backend-selected command
IDs avoid clock-based collisions. This is **not** the external MCP transport or
tool catalog: that remains issue #9.

With `GF_SQLITE_PATH`, grants and match state survive restart; owner sessions do
not and require login again. Without it, the configured owner runtime uses an
isolated in-memory SQLite database, so closing the process removes its grants.
A changed configured owner cannot read, revoke or use another owner's records.

**Before deployment:** migration 5 revokes/scrubs every legacy plaintext grant.
Read [the retirement and reissuance plan](mcp-grant-storage.md). This work does not
deploy, migrate a live volume, or create/push/merge a new PR.
