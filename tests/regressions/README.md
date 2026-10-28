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
[`odd/tasks/qa-test-suite.md`](../../odd/tasks/qa-test-suite.md): open P0 bugs are
not fixed in the QA suite, so their tests start pending — never green-by-claim,
never red-in-CI.

## Status

| Issue | Status | Issue title | Files holding its tests | What must change when the fix lands |
| --- | --- | --- | --- | --- |
| #1 | green | [P0][Motor] Impedir creación de recursos sin insumos al reanudar una línea | `tests/engine-material-shortage.test.ts` | Nothing. The regression is asserted; a failure here means the #1 fix regressed. |
| #2 | pending | [P0][Seguridad MCP] Aislar lecturas e historial por empresa autenticada | `tests/mcp/isolation.test.ts` | Delete `skip: issue2` from the five read-tool tests (`get_factory_overview`, `get_inventory`, `get_production_lines`, `get_contracts`, `get_action_history`), confirm the exact denial error code issue #2 decides, then flip this row and the five entries in `p0-matrix.test.ts` to `green`. |
| #3 | pending | [P0][Contratos] Separar borradores MCP de ofertas publicadas y exigir aprobación humana | `tests/mcp/isolation.test.ts` | Remove the `skip:` from the draft-publication test once `draft_supply_offer` stops publishing a PENDING market contract, then flip this row and its matrix entry to `green`. |
| #4 | pending | [P0][Contratos] Validar comprador destinatario, propiedad y autocontratación | `tests/mcp/isolation.test.ts`, `tests/engine/contracts-lifecycle.test.ts` | Remove the `skip:` from the targeted-offer, seller-self-acceptance and MCP third-company acceptance tests once acceptance validates `targetBuyerId` and self-dealing, then flip this row and its three matrix entries to `green`. |
| #5 | pending | [P0][Economía] Garantizar conservación de créditos en contratos y entregas parciales | `tests/engine/contracts-expiration.test.ts`, `tests/property/credits.test.ts` | Remove the two `skip:` markers in `contracts-expiration.test.ts` and convert the `test.todo` in `property/credits.test.ts` into an asserted test once default settlement pays the delivered units and conserves credits; then flip this row and its three matrix entries to `green`. |
| #6 | green | [P0][Arquitectura] Ejecutar SimulatorEngine en backend autoritativo, no en React | `backend/test/commands.test.ts`, `backend/test/http-boundary.test.ts` | Nothing. The backend-owned clock, server-selected company and server-tick batch are asserted; a failure means the authoritative backend regressed. |
| #7 | pending | [P0][Credenciales] Eliminar tokens MCP fijos y proteger la emisión/revocación de grants | `tests/mcp/isolation.test.ts` | Remove the `skip:` from the re-registration test once fixed-token issuance is gone and `registerGrant` retires the previous token mapping, then flip this row and its matrix entry to `green`. |

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
bun test tests/regressions
```

## Updating an entry

1. Land the fix and assert the owning test (remove its `skip:`/`todo` marker) in
   the file that holds it — that file is not editable from this directory.
2. Change `kind` to `green` for that issue's entries in `p0-matrix.test.ts` and
   update `EXPECTED_KIND` in the same file.
3. Update the status row and the "what must change" column above.
4. Run `bun test tests/regressions`: it fails if any of those three steps is missed.

## Known discrepancies from the original T7 anchors

- The T7 brief expected a skipped default-settlement entry in
  `tests/engine/contracts-lifecycle.test.ts`. That file holds no #5 entries: both
  skipped #5 settlement tests live in `tests/engine/contracts-expiration.test.ts`,
  next to the expiry scenario they exercise. The matrix covers what exists.
- Green coverage for #6 is pinned in the backend suites (`backend/test/*.test.ts`)
  because #6 moved the `SimulatorEngine` into the backend process; there is no
  separate `tests/engine` regression file for it.
