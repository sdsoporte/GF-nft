# MCP authorization boundaries

Private reads use the authenticated grant company, not a client-selected tenant.
A foreign `company_id` returns `ERR_RESOURCE_NOT_ALLOWED`; a missing tool scope
returns `ERR_SCOPE_UNAUTHORIZED`. Both read-only and read/write grants follow
the same boundary, before quota consumption. Denials are audited and never
return private data or enqueue commands.

## Trusted identity context

Construct `McpGateway` with a server-owned `McpAuthorizationContext`: the match
ID and a company-to-player mapping. These bindings must come from the server's
match/owner configuration, never from the grant or request being validated.
The gateway copies them on construction. An unbound gateway, mismatched match,
wrong player or missing company fails closed.

The existing `company_id` inputs remain supported for compatibility; they must
match the grant. `get_market_quotes` remains the explicit public-data exception:
a valid grant with `market:read` can see the existing sanitized pending quotes
from other companies. This does not waive token, scope or identity validation.
Line allowlists and cooldowns retain their existing write-only behavior.

## Private action history

Every newly executed or rejected command carries its submitting company as
provenance. Migration 4 stores this additive `company_id` metadata with command
results; restart recovery preserves it. `get_action_history` filters ownership
before applying its existing result limit, so another company's recent commands
cannot displace the caller's history. Global engine history retains its existing
ordering and limit behavior.

Legacy results have unknown ownership (NULL/absent), are retained globally and
are excluded from all private histories. No tenant is guessed from a command ID
or idempotency key. The migration does not change inventories, credits or queue
counters. `schema.sql` remains the version-1 baseline; versioned migrations own
subsequent schema additions.

## Work in progress

Issue #2 is asserted locally, pending independent final verification/publication.
Server-side owner sessions, hash-only credentials and isolated browser mocks
follow in issue #7; the local browser gateway is not a real credential boundary.
