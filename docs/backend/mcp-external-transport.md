# External MCP transport (issue #9)

The backend exposes the MCP gateway over a **stateless JSON-RPC 2.0** HTTP
endpoint, implementing the "Stateless Core" profile pinned by the project's
MCP security spec (`MCP_SECURITY_SPEC`, protocol `2026-07-28`): there is no
transport-session trust, every call authenticates independently, and all
writes go through the authoritative engine command queue.

- Endpoint: `POST /mcp` (any other method answers `405`).
- Framing: JSON-RPC 2.0, one request per POST. Batches are rejected with
  HTTP 400 (`-32600`), as are malformed bodies (`-32700`).
- The endpoint is available when owner administration is configured
  (`GF_OWNER_ID`); without it the route answers 404 because there are no
  grants to authenticate.

## Methods

| Method | Auth | Behavior |
| --- | --- | --- |
| `initialize` | none | Returns `protocolVersion` (the server's `2026-07-28` unless the client requests exactly that version), `capabilities.tools` and `serverInfo`. |
| `tools/list` | none | The full 13-tool catalog with one-line descriptions and JSON Schema `inputSchema` per tool. No secrets. |
| `ping` | none | Empty result. |
| `tools/call` | **required** | Delegates to the gateway: durable grants, scopes, resource allowlist, per-line cooldowns, per-minute rate limits, per-match write quotas, audit and the engine command queue. |

## Authentication

`tools/call` requires `Authorization: Bearer <token>` where the token is an
issued MCP grant (`gf_mcp_...`, hash-only at rest). A missing, malformed or
unresolvable token answers HTTP 401 with a JSON-RPC error. Expired and
revoked grants are policy outcomes, not transport failures: they answer
HTTP 200 with `isError: true` and the typed `ERR_AUTH_*` code.

## Tool results

Tool and policy failures are **results**, never HTTP errors:

```json
{
  "jsonrpc": "2.0", "id": 6,
  "result": {
    "content": [{ "type": "text", "text": "ERR_SCOPE_UNAUTHORIZED: ..." }],
    "isError": true,
    "errorCode": "ERR_SCOPE_UNAUTHORIZED"
  }
}
```

Successful calls return `isError: false` with the JSON payload serialized as
the single text content. Rejections keep their typed `ERR_*` code in
`result.errorCode`.

## Example session

```bash
# 1) Start the server with owner administration enabled
export GF_API_TOKEN="$(openssl rand -hex 32)"
export GF_OWNER_ID="owner_main"
bun run server

# 2) Create an owner session and issue a read/write grant
SESSION=$(curl -s -X POST http://127.0.0.1:8787/v1/owner/sessions \
  -H "Authorization: Bearer $GF_API_TOKEN" | jq -r .token)
GRANT=$(curl -s -X POST http://127.0.0.1:8787/v1/owner/grants \
  -H "Authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"phaseMode":"PHASE_1B_READ_WRITE","scopes":["factory:read","inventory:read","market:read","production:write","contracts:draft","contracts:read","transport:write"]}')
TOKEN=$(printf '%s' "$GRANT" | jq -r .token)

# 3) Discover the catalog
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'

# 4) Read (scoped to the grant's company)
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_inventory","arguments":{"company_id":"comp_metal_01"}}}'

# 5) Write through the engine queue (executes on the next server tick)
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"set_production_target","arguments":{"line_id":"comp_metal_01_line_1","recipe_id":"R1","target_batches":1,"idempotency_key":"idem_external_001"}}}'

# 6) Revoke; every later call answers isError with ERR_AUTH_REVOKED
curl -s -X DELETE "http://127.0.0.1:8787/v1/owner/grants/$(printf '%s' "$GRANT" | jq -r .grantId)" \
  -H "Authorization: Bearer $SESSION"
```

Isolation: the owner API binds every grant to the server-selected company,
so a client can never read another company's inventory (`ERR_RESOURCE_NOT_ALLOWED`)
and writes stay inside the grant's resource allowlist. No tool signs
blockchain transactions or moves assets; `draft_supply_offer` only creates
non-binding drafts that a human publishes.
