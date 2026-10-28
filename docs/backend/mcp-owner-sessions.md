# Owner sessions

`backend/src/ownerSessions.ts` lets the single configured owner exchange the
server root credential for a short-lived opaque session. Only SHA-256 digests of
the root secret and of each session token are kept, every session expires on its
deadline, and no read API returns a token or secret. The owner identity comes
from server configuration, never from a request body, and there is no public
signup.

This is the primitive only. HTTP owner-only routes, configuration wiring and the
grant gateway stay in separate work units (parent T4).

## Quick path

1. Construct once at boot with the configured owner:
   `OwnerSessions({ ownerId, ownerSecret, now? , sessionTtlMs? })`.
2. `create(providedSecret)` → `{ token, ownerId, expiresAtUtc }` or `undefined`.
3. `authenticate(token)` → `{ ownerId, expiresAtUtc }` or `undefined`.
4. `revoke(token)` → `true` only when a live session was ended.

```ts
const sessions = OwnerSessions({ ownerId: config.ownerId, ownerSecret: config.token });
const issued = sessions.create(providedSecret);
if (!issued) return unauthorized();
// The one and only place the token is available:
res.json(issued);

const principal = sessions.authenticate(bearerToken);
if (!principal) return unauthorized();
```

## Details

| Topic | Decision |
| --- | --- |
| Owner identity | One configured owner per server (`ownerId`); sessions carry that identity, not a client choice. |
| Root credential | The existing server root secret, validated at `MIN_TOKEN_LENGTH`; only its SHA-256 digest is retained. |
| Secret comparison | SHA-256 both sides, then `timingSafeEqual`; digests are always 32 bytes, so lengths never leak. |
| Session token | `gf_owner_` + 32 CSPRNG bytes as lowercase hex (256 bits of entropy). |
| Storage | In-memory `Map` keyed by the hex SHA-256 of the token; the token and the root secret plaintext are never stored. |
| Lifetime | `sessionTtlMs`, default 15 minutes (`DEFAULT_SESSION_TTL_MS`), measured from issuance. |
| Expiry | Valid while `now() < expiresAt`; `now() >= expiresAt` denies, so the deadline millisecond itself is already expired. |
| Revocation | By session bearer; unknown, malformed or already-expired tokens return `false` and leave other sessions untouched. |
| Restart/logout | Sessions are memory-only, so a new process authenticates none of the old tokens. No persistence, no signup. |
| Exposed metadata | `ownerId` and `expiresAtUtc` (ISO 8601). Never the token, its digest, or the root secret. |
| Invalid input | A refused secret or token yields `undefined`/`false` and creates nothing; earlier sessions stay valid. |
| Invalid configuration | The constructor throws an `Error` naming the field. Messages never contain the rejected value. |
| Time source | `now` is injected for deterministic tests and defaults to `Date.now`; an unusable clock fails closed. |

## Checklist

- [ ] Sessions are created only by a caller that presents the configured root secret.
- [ ] No non-issuance response includes `token`, a token digest, or the root secret.
- [ ] Expiry is tested at the deadline boundary and afterwards.
- [ ] `revoke` is tested for live, repeated, unknown and expired tokens.
- [ ] A fresh instance cannot authenticate an old token.
- [ ] Owner-only HTTP routes and gateway policy resolution are still tracked in T4.

## Next step

Wire the primitive into owner-only administration routes and the stored-policy
gateway resolver (T4), then remove bundled browser credentials (T5).
