# Server-issued MCP grants

`GrantService` issues a secret once and returns metadata only afterward. The
trusted constructor binds one owner, match, company and allowed line set; a
request cannot choose identity or a token. HTTP session enforcement is T4.

## Quick path

```ts
const grants = new GrantService({
  repositories, ownerId, matchId, companyId, allowedLineIds,
});
const issued = grants.issue({
  phaseMode: 'PHASE_1_READ_ONLY',
  scopes: ['factory:read', 'inventory:read', 'market:read'],
});
// Deliver issued.token once to the authenticated owner. Never log it.
```

## Contract

| Method | Boundary |
| --- | --- |
| `issue(input)` | Returns `{ token, grant }`; only this response carries a secret. |
| `list()`, `get(id)` | Safe policy metadata: no token and no token hash. |
| `revoke(id)` | Only the configured owner's company/match; unknown/foreign IDs return false. |
| `resolve(token)` | Fresh `{ grant, expired, revoked }` from storage; not an authorization verdict. |

Inputs allow only `phaseMode`, `scopes`, `ttlMs`, `resourceAllowlist` and `quotas`.
Unknown keys, including owner/player/company/match/token/grant ID or revoked
state, are rejected before writing. `GrantIssueError` uses `ERR_INVALID_PAYLOAD`.
The gateway must enforce revoked/expired flags, scopes, phase and resources;
`resolve` deliberately preserves flags so it can emit exact denial codes.

## Policy

| Setting | Default and accepted values |
| --- | --- |
| TTL | 24 h; integer milliseconds greater than zero, at most 30 d. |
| Quotas | 60 reads/min, 12 writes/min, 500 writes/match; maxima 600/120/1000. |
| Scope/phase | Known unique scopes; read-only phase cannot carry write scopes. |
| Allowlist | All server-allowed lines by default; supplied unique IDs must be a subset. |
| Expiry | Denies at `now >= expiresAtUtc`; malformed dates fail closed. |

`resolve` rejects malformed/mock credentials and other owner/company/match
contexts. Its returned policy omits both the secret and digest; the envelope
still is not authorization and must pass the gateway's checks. Its injected
`now` callback returns a `Date` (owner sessions use epoch milliseconds). See [storage and retirement](mcp-grant-storage.md)
for migration 5's forced reissuance requirement before any future deployment.

## Checks and remaining integration

Run `bun test backend/tests/grant-service.test.ts`. The suite covers one-time
issuance, no secret/hash in metadata, rejected-input no-write behavior,
allowlist/identity isolation, revocation, expiry flags, restart and legacy-token
rejection. The primitive is not a complete #7 fix until T4 owner-only HTTP and
T5 browser credential isolation are in place.
