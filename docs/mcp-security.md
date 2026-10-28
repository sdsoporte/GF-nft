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

## Work in progress

Tenant filtering of history results is the next work unit (issue #2); matching
its request company alone does not prevent global history exposure. Server-side
owner sessions, hash-only credentials and isolated browser mocks follow in
issue #7. This first slice does not claim either issue fully fixed.
