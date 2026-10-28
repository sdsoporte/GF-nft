# P0 regression matrix — issues #1–#7 (S6/S8 of issue #10)

Every P0 bug of GigaForge has at least one test entry here, either **green**
(the fix landed and the test asserts it) or **pending** (the bug is still open,
so the test encodes the contract the fix must satisfy and stays skipped).
`p0-matrix.test.ts` pins each title and fails if coverage disappears or if a
pending entry silently turns into an assertion without this document following.

- **Green** — the owning test runs on every `bun test` and fails if the fix regresses.
- **Pending** — the owning test is skipped (`skip:`) or `test.todo`, always names
  its issue, and never fails CI. It exists so nobody can claim the bug is covered.

The rule behind the split is assumption **A1** of
[`odd/tasks/qa-test-suite.md`](../../../odd/tasks/qa-test-suite.md): open P0 bugs are
not fixed in the QA suite, so their tests start pending — never green-by-claim,
never red-in-CI.

## Status

Green means the regression is runnable on this branch, not that a remote issue
was automatically closed. Issues #2 and the current server/archive scope of #7 are asserted locally;
publication and remote issue closure remain the maintainer's decisions.

| Issue | Status | Issue title | Files holding its tests | What must change when the fix lands |
| --- | --- | --- | --- | --- |
| #1 | green | [P0][Motor] Impedir creación de recursos sin insumos al reanudar una línea | `backend/tests/engine-material-shortage.test.ts` | Nothing. The regression is asserted; a failure here means the #1 fix regressed. |
| #2 | green | [P0][Seguridad MCP] Aislar lecturas e historial por empresa autenticada | `backend/tests/mcp/isolation.test.ts` | Asserted locally: private reads reject foreign targets and history filters durable ownership after recovery. Remote closure follows publication. |
| #3 | pending | [P0][Contratos] Separar borradores MCP de ofertas publicadas y exigir aprobación humana | `backend/tests/mcp/isolation.test.ts` | Remove the `skip:` from the draft-publication test once `draft_supply_offer` stops publishing a PENDING market contract, then flip this row and its matrix entry to `green`. |
| #4 | pending | [P0][Contratos] Validar comprador destinatario, propiedad y autocontratación | `backend/tests/mcp/isolation.test.ts`, `backend/tests/engine/contracts-lifecycle.test.ts` | Remove the `skip:` from the targeted-offer, seller-self-acceptance and MCP third-company acceptance tests once acceptance validates `targetBuyerId` and self-dealing, then flip this row and its three matrix entries to `green`. |
| #5 | pending | [P0][Economía] Garantizar conservación de créditos en contratos y entregas parciales | `backend/tests/engine/contracts-expiration.test.ts`, `backend/tests/property/credits.test.ts` | Remove the two `skip:` markers in `contracts-expiration.test.ts` and convert the `test.todo` in `property/credits.test.ts` into an asserted test once default settlement pays the delivered units and conserves credits; then flip this row and its three matrix entries to `green`. |
| #6 | green | [P0][Arquitectura] Ejecutar SimulatorEngine en backend autoritativo, no en React | `backend/tests/commands.test.ts`, `backend/tests/http-boundary.test.ts` | Nothing. The backend-owned clock, server-selected company and server-tick batch are asserted; a failure means the authoritative backend regressed. |
| #7 | green | [P0][Credenciales] Eliminar tokens MCP fijos y proteger la emisión/revocación de grants | `backend/tests/mcp-runtime.test.ts`, `backend/tests/owner-grants-http.test.ts`, `tests/integration/repository-boundaries.test.ts` | Asserted current scope: real server refuses fixture registration/demo credentials; grants require owner sessions and one-time delivery; retired web is outside active builds. No claim that the isolated legacy fixture's re-registration behavior was fixed. |

Issue state above was read read-only with `gh issue view <n>` when this matrix was
written: #1 and #6 are closed, #2, #3, #4, #5 and #7 are open.

## How the matrix test works

`p0-matrix.test.ts` is a structural test — it never starts the engine, the MCP
gateway or the clock. For each table entry `{ issue, file, titleFragment, kind }` it:

1. reads the referenced file from disk and finds the `test(...)`/`test.todo(...)`
   declaration whose title contains the fragment,
2. asserts the declaration is a single, exactly-matching title,
3. asserts a `pending` entry still carries a `skip:`/`todo` marker **and** names
   its issue, and that a `green` entry carries no such marker,
4. asserts every P0 issue still has at least one entry, that entry kinds match the
   recorded issue state, and that this README lists the same statuses and files.

Run it alone:

```bash
bun test backend/tests/regressions
```

## Updating an entry

1. Land the fix and assert the owning test (remove its `skip:`/`todo` marker) in
   the file that holds it — that file is not editable from this directory.
2. Change `kind` to `green` for that issue's entries in `p0-matrix.test.ts` and
   update `EXPECTED_KIND` in the same file.
3. Update the status row and the "what must change" column above.
4. Run `bun test backend/tests/regressions`: it fails if any of those three steps is missed.

## Known discrepancies from the original T7 anchors

- The T7 brief expected a skipped default-settlement entry in
  `backend/tests/engine/contracts-lifecycle.test.ts`. That file holds no #5 entries: both
  skipped #5 settlement tests live in `backend/tests/engine/contracts-expiration.test.ts`,
  next to the expiry scenario they exercise. The matrix covers what exists.
- Green coverage for #6 is pinned in the backend suites (`backend/tests/*.test.ts`)
  because #6 moved the `SimulatorEngine` into the backend process; there is no
  separate `backend/tests/engine` regression file for it.

## Retired demo coverage

The user retired the browser application. Its old isolated `registerGrant`
re-registration case remains skipped in `backend/tests/mcp/isolation.test.ts`;
it was not deleted, silently asserted or fixed by this structural migration.
The real server forbids raw registration entirely, so #7 now pins the active
server/HTTP/archive boundary tests instead. This does not close GitHub #7 or
claim that every legacy SDK mode has changed. Other #3–#5 skips/todo remain
outside this migration.
