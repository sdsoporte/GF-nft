# MCP tenant isolation and credentials
Fix issues #2 and #7 in order, with one configured server-side owner and expiring sessions; no public signup.
Tracker: `chore/mcp-security` | Children: local work-unit branches only | Delivery: `auto-chain` / `feature-branch-chain`, no new push/PR/merge authorization | Checks: Bun focused tests + suite, lint/build, active LSP, differential compatibility, one independent final verifier.

## Specs

Issue #2 requirements, quoted verbatim:
- **S1** — "Derivar identidad y empresa exclusivamente de la autorización del servidor."
- **S2** — "Permitir excepciones solo para datos públicos expresamente definidos (p. ej. cotizaciones)."
- **S3** — "Filtrar historial, contratos privados, inventario y líneas por empresa."
- **S4** — "Validar de forma independiente cada scope y vínculo entre usuario, empresa y partida."
- **S5** — "Grant de empresa A no puede leer información privada de empresa B, aunque cambie parámetros."
- **S6** — "Historial MCP expone solamente acciones autorizadas."
- **S7** — "Test negativo para cada herramienta de lectura y cada tipo de grant."
- **S8** — "Retornos `ERR_SCOPE_UNAUTHORIZED` / `ERR_RESOURCE_NOT_ALLOWED` según corresponda."

Issue #7 requirements, quoted verbatim:
- **S9** — "El backend genera tokens opacos criptográficamente aleatorios, guarda solo hash del secreto y los muestra una única vez."
- **S10** — "Crear/consultar/revocar grants solo mediante sesión autenticada del propietario."
- **S11** — "Aplicar TTL, scopes, empresa/partida y allowlist desde almacenamiento servidor."
- **S12** — "No incluir tokens reales, claves ni credenciales reutilizables en el bundle React."
- **S13** — "Proveer credenciales mock únicamente dentro de un modo de pruebas aislado."
- **S14** — "Ningún grant sensible se expone al navegador salvo durante su entrega explícita al titular."
- **S15** — "Grantes expirados o revocados rechazan todas las operaciones."
- **S16** — "Tests cubren filtración, revocación, expiración y autorización de propiedad."
- **S17** — "Tokens de demostración no otorgan acceso a partidas reales."

Human choices (verbatim):
- **S18** — "Un propietario local (recomendado para el MVP)" — selected option description: "Identidad única configurada en el servidor, con sesión y vencimiento; sin registro público."
- **S19** — "Cadena con rama tracker (recomendada)" — selected option description: "Mantener unidades revisables con sus pruebas y documentación, como en la cadena recién integrada."

### Bounded implementation assumptions
- Preserve existing read input schemas: an explicitly foreign `company_id` is rejected, not silently redirected; actual reads use authenticated grant identity. Missing scope is `ERR_SCOPE_UNAUTHORIZED`, foreign/missing resource or invalid match/company binding is `ERR_RESOURCE_NOT_ALLOWED`. Keep unrelated write allowlist/cooldown error behavior intact.
- Only `get_market_quotes` is the existing public-data exception. Do not change public quote fields, draft/publish rules (#3), contract acceptance (#4), settlement math (#5), or build the external MCP transport/catalog (#9).
- Tenant history attribution is additive and durable; legacy results with unknown ownership fail closed for private history while global engine history remains backward compatible.
- The chosen local owner is configured by the server, never taken from a request body. Bind grants to existing match/company/player relationships on the server. No public registration, external identity provider, or credentials in client build variables.
- Tests use isolated databases/state. Do not rewrite a live database or rotate real credentials during development. A migration must be tested on fresh and legacy populated databases, including rollback/failure.

## Tasks

- **T1** [S1-S5,S7-S8] — **in_progress** — Enforce private read ownership and scope/match/player binding with RED→GREEN tests, preserving own-company reads and public quotes. Route: inline (sequential gateway changes; no independent parallel writer units). Commit: pending. Risk: item 2 (authorization).
- **T2** [S3,S6-S8] — **pending** — Persist command-result tenant attribution and filter private history, keeping global history compatibility and unknown legacy ownership private. Route: inline, dependent on T1; tests and docs in the same work unit. Commit: pending. Risk: items 1/2/3 (stored metadata, authorization, shared history helpers).
- **T3** [S10,S16,S18] — **pending** — Add configured single-owner expiring sessions and owner-only administrative boundaries, with no public signup and no raw owner/session secret leakage. Route: inline, sequential server work. Commit: pending. Risk: item 2 (authentication).
- **T4** [S9-S11,S14-S17] — **pending** — Hash-only durable grants, one-time opaque issuance, stored policy enforcement and immediate expiry/revocation; migrate/test legacy grants safely. Route: inline, dependent on owner sessions; shared gateway invariants preserved. Commit: pending. Risk: items 1/2 (migration and credentials).
- **T5** [S12-S14,S17] — **pending** — Remove bundled/browser grants and isolate optional mock credentials so they cannot reach real matches; update UI-facing docs without redesigning UI. Route: inline, same credential behavior; no visual-design task. Commit: pending. Risk: item 2 (credential exposure).
- **T6** [S1-S19] — **pending** — Full functional/LSP/build and differential checks, one final independent verifier across all specs, native assessment per work unit if available, and record local chain delivery evidence. Route: inline checks plus independent gentle-ai-verify (named risk items). Commit: pending closure. Risk: items 1/2/3.

## Log

- **L1 — Original request (verbatim)**: "ok procede" in response to "Mi recomendación: primero cerrar la integración de la cadena; después seguir con **#2, aislamiento por empresa**, y **#7, credenciales**." Integration is complete on main `c24e719`; its local-only closure document is commit `378619c`.
- **L2 — Human decisions (verbatim)**: authentication = "Un propietario local (recomendado para el MVP)"; delivery = "Cadena con rama tracker (recomendada)". The question explicitly stated "Esto no autoriza nuevos pushes, PRs ni merges." New local work-unit commits and branch preparation only.
- **L3 — Exploration**: read-only map `mvs73kxe-1-2x80`: McpGateway trusts supplied company IDs, global history lacks company attribution, grant records contain plaintext tokens, App.tsx embeds fixed tokens, no owner accounts/session substrate or backend MCP wiring. Parent confirmed history DTO and handler. Existing suite = 380 pass/12 skip/1 todo/0 fail; this is not proof that open security bugs are fixed.
- **L4 — Forecast / route**: approximately 1,500–2,400 authored lines including negative tests, migrations, server session/credential boundaries and client removal. Accepted feature-branch chain; preserve cohesive units with tests/docs, report any naturally >400-line unit instead of cosmetic splitting. T1/T2 are #2 and precede #7; later tasks depend on earlier auth/storage boundaries, so no independent parallel writer trigger. One independent verifier at the end of this inline feature; native assessment is currently unavailable (`package-local-binary-missing`), never treated as approval. Existing grant helpers/rate-limit/scope/audit ordering and repository transaction/migration mechanisms must be reused.
