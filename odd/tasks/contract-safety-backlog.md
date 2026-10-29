# Contract safety and economic backlog
Resolve the active contract backlog by impact and dependency priority; preserve the retired web archive boundary.
Branch: `fix/contract-safety-backlog` from `3f2224e` | Delivery: local work-unit commits, cached `auto-chain / feature-branch-chain`; no new publishing/deploy authority | Checks: focused Bun RED/GREEN, active suite, lint/build, compatibility and independent security verification.

## Specs

- **S1 — Original user request (verbatim)**:

```text
ok, tenemos que seguir con #3–#5 y #12 ?
si es asi sigue en orden de prioridad.
```

- **S2 — Issue #4**: https://github.com/sdsoporte/GF-nft/issues/4

```markdown
[P0][Contratos] Validar comprador destinatario, propiedad y autocontratación

## Problema
En `ACCEPT_SUPPLY_OFFER`, un comando puede aceptar ofertas destinadas a otra empresa: el motor reemplaza `buyerCompanyId` por la empresa que acepta sin verificar el destinatario original. Tampoco hay política explícita para contratos con la misma empresa como compradora y vendedora.

## Criterios de aceptación
- [ ] Oferta dirigida solo puede aceptarla el `targetBuyerId` designado.
- [ ] Oferta abierta puede aceptarla cualquier empresa válida excepto el propio vendedor (salvo regla documentada).
- [ ] El contrato preserva las partes y condiciones firmadas.
- [ ] Intentos no autorizados no modifican balances, inventarios ni estados.
- [ ] Tests incluyen comprador incorrecto, misma empresa y aceptación concurrente.

Referencia: [SimulatorEngine.ts](https://github.com/sdsoporte/GF-nft/blob/main/src/engine/SimulatorEngine.ts).
```

- **S3 — Issue #3**: https://github.com/sdsoporte/GF-nft/issues/3

```markdown
[P0][Contratos] Separar borradores MCP de ofertas publicadas y exigir aprobación humana

## Problema
La herramienta `draft_supply_offer` encola `CREATE_SUPPLY_OFFER`; el motor crea una oferta `PENDING` visible y aceptable. La especificación [MCP_SECURITY_SPEC](https://github.com/sdsoporte/GF-nft/tree/main/public/assets/aistudio) exige que los agentes creen borradores no vinculantes, sujetos a confirmación del jugador.

## Solución
- Introducir estado `DRAFT` real (o entidad separada) que no aparezca en el libro de órdenes.
- Agregar comando manual `PUBLISH_SUPPLY_OFFER` que autentique al titular.
- Separar scopes `contracts:draft` de aceptación/publicación de compromisos financieros.
- Aplicar límites de borradores y auditoría a su creación y cancelación.

## Criterios de aceptación
- [ ] Un borrador creado por MCP no bloquea fondos ni colateral.
- [ ] No aparece en cotizaciones públicas ni se puede aceptar.
- [ ] Publicarlo exige acción humana autenticada.
- [ ] Tests impiden que un agente cree un compromiso vinculante sin autorización.

Referencias: `src/mcp/McpGateway.ts`, `src/engine/SimulatorEngine.ts`, `src/domain/types.ts`.
```

- **S4 — Issue #5**: https://github.com/sdsoporte/GF-nft/issues/5

```markdown
[P0][Economía] Garantizar conservación de créditos en contratos y entregas parciales

## Problema
La liquidación en `src/engine/SimulatorEngine.ts` retiene el pago total del comprador y el colateral del vendedor al activar un contrato. En caso de entrega parcial y vencimiento, el comprador recibe reembolso solo de la porción no entregada, pero no se observa una liquidación explícita al vendedor de las unidades efectivamente entregadas. Esto puede dejar créditos retenidos sin destino contable claro.

## Solución
- Definir libro mayor para cuentas disponibles, retenidas, tasas y penalidades.
- Especificar reglas para entrega parcial, incumplimiento, cancelación y vencimiento.
- Ejecutar cada transición de forma atómica; nunca crear o perder créditos salvo fuentes/sumideros declarados.
- Emitir eventos de auditoría por cada movimiento económico.

## Criterios de aceptación
- [ ] Toda unidad entregada tiene una liquidación o devolución definida.
- [ ] Saldo inicial + emisiones - sumideros = suma de saldos disponibles y retenidos.
- [ ] Tests de entrega total, parcial, tardía, sin entrega y reintentos.
- [ ] Dos aceptaciones concurrentes de la misma oferta no duplican compromisos.

Referencia: [SimulatorEngine.ts](https://github.com/sdsoporte/GF-nft/blob/main/src/engine/SimulatorEngine.ts).
```

- **S5 — Issue #12**: https://github.com/sdsoporte/GF-nft/issues/12

```markdown
[P1][Frontend] Corregir reinicio de partida y sincronización de referencias React

## Problema
`handleReset` reemplaza `engineRef.current`, pero `engine`, `gateway` y `settlement` son referencias capturadas durante render. Las rutas de acción/timer pueden seguir utilizando instancias anteriores y `syncState()` no recompone todas las dependencias.

## Alcance
- Como solución definitiva, hacer que UI dependa de snapshots/comandos del backend (issue #6).
- Mientras exista modo demo local, mantener instancia y dependencias coherentes tras Reset.
- Evitar que timers activos sobrevivan o actúen sobre motor antiguo.
- Limpiar grants, escrows y UI vinculados a la partida reiniciada.

## Criterios de aceptación
- [ ] Reiniciar después de avanzar ticks produce estado inicial coherente.
- [ ] Tras Reset, Play y acciones manuales afectan únicamente a la nueva partida.
- [ ] MCP y lotes se vinculan al motor nuevo, nunca al anterior.
- [ ] Prueba de UI cubre Reset → Play → Operar → Reset.

Referencia: `src/App.tsx`.
```

- **S6 — Existing Agy delegation suggestion (verbatim)**:

```text
en otra session tenemos  Agy sobre el mismo repo, si quieres probar enviarle task para resolver.
```

- **S7 — Agy permission configuration request (verbatim)**: "puedes configurar para que no solicite autorizacion ?" Superseding scope S12-S13: the human updated CLI permissions; parent tests exactly one git-status operation, not broad configuration or all MCP/test permissions.
- **S8 — Permission scope choice (verbatim)**: "Solo esta sesión (recomendado)". Selected description: "Autorizar inspección y pruebas rutinarias durante este trabajo, sin tocar configuración global."
- **S9 — Agy Engram instruction (verbatim)**: "Agy tiene accesoa engram asi que puedes pedirle que registre los cambios tambien."
- **S10 — Partial-default fee choice (verbatim)**: "Sí, 2% sobre lo entregado (recomendado)". Selected description: "Ejemplo: 4 unidades × 50 = 200; comisión 4 y pago neto 196 al vendedor." Selected preview: "Las unidades no entregadas se reembolsan según la regla vigente. La comisión se registra como sumidero explícito: saldos disponibles + retenidos + comisión = créditos iniciales."
- **S11 — Session command-grant choice (verbatim)**: "Reglas por comando, solo sesión (recomendado)". Selected description: "Responderé sus avisos de lectura y pruebas dentro del alcance indicado, sin reglas permanentes." Selected preview:

```text
Solo esta conversación y este repo:
- `git status`, `git diff`, `git log`, `git show`, `git grep`, `git ls-files`.
- `bun test`, `bun run lint`, `bun run build`.

Usaré «always allow in this conversation» únicamente para esos comandos. No incluye publicación, borrados, red ni archivos externos.
```

- **S12 — Fresh Agy permission probe request (verbatim)**: "actualice permisos dentro de cli de agy, revisa enviar ahora, para ver si acepta o sigue solicitando permisos."

- **S13 — Minimal probe choice (verbatim)**: "Autorizar una nueva prueba mínima". Selected description: "Una sola operación: `git status --short --branch`, manteniendo abierta la misma conversación de Agy y sin interactuar con ella durante la prueba."

## Tasks

- **T1** [S1-S6,S9] — **done** — Reconciled exact snapshots, order #4 -> #3 -> #5, archived #12 scope and existing economic rules. Route: existing Agy read-only map; parent partial-default expectation spot check. Commit: `37b60165d8d024b17dc042370d4197e10744939b`. Evidence: Agy Engram #6628 read back, baseline 547/7skip/1todo/0fail, concrete partial-default fee ambiguity identified; no source changes.
- **T7** [S6-S9,S11-S13] — **done** — The latest authorized minimal probe executed exactly one git status --short --branch in current Agy, exit0, empty stderr, no approval requested. Actual visible command/result captured after job11, revision24 before/after; no parent approval keys or config writes. Scope is ONLY git status; tests/Engram permissions remain untested. Earlier multi-operation attempt remains UNVERIFIABLE history. Route: bounded native probe under fresh S13. Commit: next evidence slice. Risk: item 2 (tool permissions; no safeguard removed).
- **T2** [S1,S2] — **done** — Fix buyer targeting, ownership/self-dealing and immutable acceptance; activate the issue #4 regressions with rejection-state and repeated/concurrent admission checks. Route: inline (one bounded dependent guard fix; no writer trigger). Commit: `7af77200a396ef655ea4e0295cbddf38b97cad77`. Evidence: focused RED 24pass/2skip/3fail -> GREEN 27pass/2skip/0fail; matrix/docs updated; full suite552pass/4skip/1todo/0fail, lint/build0, active diagnostics with only2 unchanged snapshot-clone AST findings. Native ASSESS: medium / reviewDue=false (under_budget); independent verifier mvsvfseo-1-34dj PASS all five S2 criteria; parent focused spot check52pass/2skip/0fail. No native approval claimed. Risk: item 2 (contract authorization).
- **T3** [S1,S3] — **pending** — Separate non-binding MCP drafts from authenticated human publication, scope authority, draft limits and audit. Route: inline, dependent on verified acceptance baseline; shared engine/types preclude concurrent writers. Commit: pending. Evidence: behavioral RED10pass/1skip/6fail observed before production edits; max5 is also bypassed by same-tick queuing, so enforce at execution. Risk: item 2 (financial action authorization).
- **T8** [S3] — **in_progress** — Append atomic migration6 admitting DRAFT while preserving all legacy contract rows, schema constraints and indices; prove fresh/v5 upgrade, idempotence and induced-failure rollback through public APIs. Route: inline migration work unit before dependent T3; preserve baseline schema/migration1, no live databases. Commit: pending. Evidence: actual migration RED0pass/3fail -> focused GREEN3pass/0fail; first isolated candidate focused16/0 but full suite failed3old migration5 latest-version assertions; corrected only those expectations to derive the registry's latest version. New isolated candidate checks pending. Risk: item 1 (stored-contract schema migration). Separate commit, assessment and independent verification.
- **T4** [S1,S4,S10] — **pending** — Implement credit-conserving settlement/ledger rules with the human-selected 2% fee on delivered value in partial default; activate #5 delivery/default/retry invariants and update the obsolete gross-payout expectations. Route: inline after authorization/draft units. Commit: pending. Risk: finalize against actual diff; independent final verification also covers inherited security interactions.
- **T5** [S1,S5] — **pending** — Resolve issue #12 applicability against the accepted source-only archive and active Godot/backend lifecycle; do not reactivate the obsolete demo or claim its old UI test passed. Route: parent structural readback/documented disposition; remote closure is not authorized. Commit: pending.
- **T6** [S1-S6] — **pending** — Run final active functional/compatibility checks and aggregate per-unit independent verdicts into full-spec coverage; assess/review only bounded work-unit candidates when reviewDue=true and under native consent, reconcile mirrors and close local tracking. Route: parent checks plus the risk-required gentle-ai-verify run for each completed security unit (Risk: item 2); future/unrelated specs are out of scope in an earlier unit, and no redundant final full-sweep verifier is added. Commit: pending.

## Log

- **L1 — Original request (verbatim)**:

```text
ok, tenemos que seguir con #3–#5 y #12 ?
si es asi sigue en orden de prioridad.
```

- **L2 — Delegation suggestion (verbatim)**:

```text
en otra session tenemos  Agy sobre el mismo repo, si quieres probar enviarle task para resolver.
```

- **L3 — Read-only preflight / boundaries**: local main and origin/main both `3f2224e`, clean before creating this feature branch. Exact current issue bodies preserved in `.git/odd-logs/backlog-priority.GsVxcD/issue-{3,4,5,12}.json`. All four are OPEN. Active repository README explicitly retires React/Vite and owns backend/game separately; #12 points to archived App.tsx, not an active frontend. Existing approved layout/archive decision is not reversed by this backlog request. Provisional order #4 -> #3 -> #5, followed by honest #12 disposition; no remote issue edits/closures, push/PR/merge, live migration or deploy are implied.

- **L4 — Route / forecast**: large because external issue specifications, cross-session handoff and coupled authorization/economic rules must survive interruption beyond the original short issue-reference request and diff alone. Expect roughly 1000–1600 authored changed lines across natural behavior units (forecast, not a cap); reuse the repository's already selected auto-chain / feature-branch-chain shape, keep local commit slices cohesive, and ask only if a real missing policy/authority decision appears. Agy map is read-only; no parallel shared-worktree writers. Parent does not duplicate Agy's source exploration; one map spot check precedes scoped implementation. Additional discovery that prepares an inline write stays inline.

- **L5 — Baseline / Agy permission**: baseline `bun run test` exit 0, 547 pass/7 skip/1 todo/0 fail (46 files). Logs: `baseline-test.stdout` and `baseline-test.stderr` in the issue evidence directory. Agy initially paused at one `git grep -n "web-demo" tests/` permission; human selected "Autorizar solo este comando" (`approve_once`). Fresh UI read showed it had already resumed, so the safety guard sent NO keys and did not reuse permission for a different command. A single native settled-state wait tracks the ongoing map; no polling or duplicate prompt.

- **L6 — Permission configuration request (verbatim)**: "puedes configurar para que no solicite autorizacion ?" Agy paused again on the focused Bun regression command. No inherited one-command grant was reused. Installed CLI exposes an unrestricted skip-permissions flag, but official CLI docs also support project-scoped allow/ask/deny rules through /permissions and sandboxed auto mode. Prefer bounded project rules rather than removing all safeguards; no global/non-workspace config has been read or changed. T1 waits on this external authorization/policy condition; T7 is the only active task. Mirror comparison differs only by Engram trimming the final newline, not by requirements or task content.

- **L7 — Scoped permission decision**: human selected exactly "Solo esta sesión (recomendado)"; selected description is preserved in S8. No permanent/global config access or unrestricted bypass was granted. A fresh Bun approval UI check found Agy already running different read-only commands, so the parent again sent NO keys; the one-time and session decisions were not replayed against a different prompt. Configure only routine conversation-scoped rules through the live permissions manager once available, then read them back. No native review consent is implied.

- **L8 — Agy map and memory verified**: user instruction (verbatim) "Agy tiene accesoa engram asi que puedes pedirle que registre los cambios tambien." Agy saved observation #6628 (project gf-nft, topic contract-safety-backlog/discovery-map); parent read it back and received the compact source/test map. No implementation or task-mirror change by Agy. Order #4 -> #3 -> #5; all share engine/types/matrix surfaces, so no parallel writers. Parent spot check of contracts-expiration.test.ts:169-205 confirms the pending partial-default assertions pay gross 200 CREDITS with no fee; full fulfillment charges 2%. Active cancellation is unsupported, not an invitation to add a new command. #12 is superseded by accepted archive boundaries. T1 done; T4 requires the one economic policy decision.

- **L9 — Permission manager scope evidence**: opened the documented live /permissions manager. Installed Agy 1.4.9 presents only Project, Shared with Antigravity, and Global scopes, not a Conversation scope. No rule was added or changed: permanent Project/Global edits would violate S8. Close this picker unchanged and inspect supported current-session execution mode / native prompt grants; do not silently broaden scope. Parent has still sent no approval keystrokes because both old dialogs drifted before admission.

- **L10 — Current-session auto unavailable**: official modes guide documents Shift+Tab as a per-session control. Observed cycle was default -> accept-edits -> plan, skipping auto. The one bounded auto-mode verification guard exited 1 before submitting any command because auto was not confirmed. No retry, sandbox/security weakening, restart, project/global setting write or permission grant occurred. Restored original default with one cleanup Shift+Tab. This proves auto is not offered under the current configuration, not why; do not assert unsupported kernel/sandbox without evidence. T7 requires one explicit fallback choice; T4 separately requires the partial-default fee choice. Runtime code remains untouched.

- **L11 — Two explicit human decisions**: permissions="Reglas por comando, solo sesión (recomendado)" with exact scope in S11; economics="Sí, 2% sobre lo entregado (recomendado)" with exact example/preview in S10. Both prior external conditions are resolved; do not change persistent scope or silently keep the old fee-free pending assertion. Proceed with the new on-demand session policy and #4 -> #3 -> #5 implementation, no repeated auto-mode probe or broad bypass. Agy may record these decisions in Engram; its original map remains #6628.

- **L12 — Separate Agy identity incident**: terminal readback after job7 shows the old conversation exited (resume id 1869d9c6-d636-463f-a05d-5878c746709a), then a human/independent ‘agy’ launch before the follow-up; Herdr revision changed 14 -> 16. Parent did not request/perform the restart and cannot infer scope continuity from the pane ID. New-instance status command returned exit0/no approval, but no Engram tools were exposed there, so no decision memory ID was produced. Parent's decision #6631 already preserves the fee policy, and Agy's original map #6628 was independently read back. Do not retry memory discovery or scan home, restart again, or grant old authority in a replacement conversation. T7 waits for fresh target-bound human scope; it does not prevent inline #4/#3/#5 work. Only task document is currently changed; no implementation source was touched before this incident was diagnosed.

- **L13 — Issue #4 RED/GREEN**: activated the three pinned #4 regressions, strengthened exact rejection/error-message/economic/offer-state assertions and added designated-buyer term preservation plus same-tick/retry single-escrow checks. Before production edits, focused public suites exited1:24pass/2skip/3fail (all three requested ownership failures reproduced). Added only two authorization guards within ACCEPT_SUPPLY_OFFER, before escrow movement. Focused GREEN exited0:27pass/2skip/0fail. Updated matrix/README #4 to locally green and documented exact messages in docs/backend/supply-contracts.md. Remaining skips are explicit #3 and isolated legacy #7; #5 pending elsewhere. Full suite/lint/build, active diagnostics and high-risk independent/native outside views are not yet complete. Shared production helpers/parsers/options were not changed, so no sibling-command differential script is applicable to this guard-only unit.

- **L14 — Issue #4 full local checks**: job8 passed focused suites+matrix, full active suite552pass/4skip/1todo/0fail (557 tests,46 files), lint0 and backend build0. git diff --check PASS. Active diagnostics checked4 files:3 clean, engine had only2 auxiliary unchecked-throwing-call AST findings at createSnapshot JSON clone expressions; direct read plus the guard-only engine diff proves those expressions pre-existed and are unchanged. No TypeScript compiler errors; tsc from lint is authoritative. read_enclosing helper could not return those bodies, so direct bounded read was used, not a false clean claim. No UI/game path changed. RDD mode read-only status: on(global). Commit tracking separately, then this authorization work unit alone before native assessment; independent check required for Risk item2.

- **L15 — Bounded committed assessment / verify route**: tracking commit `37b60165d8d024b17dc042370d4197e10744939b`; #4 authorization commit `7af77200a396ef655ea4e0295cbddf38b97cad77` (170 additions/40 deletions,210 authored lines,7 paths). Native ASSESS over exactly that committed range returned nativeRisk=medium, escalated risk=high only for named security item2; reviewDue=false / under_budget, candidate.consumed=false, outcome unknown. Followed its plan: self-verification already passed, dispatch ONE independent verifier for T2/S2 now; do not INSPECT/START an unnecessary native review. Remaining work-unit risks are assessed separately; T6 aggregates their spec verdicts rather than adding a redundant full-sweep verifier. No publish, issue closure or receipt approval.

- **L16 — Live independent check / continuation**: verifier task `mvsvfseo-1-34dj` is running in background for exact commit7af7720 vs37b6016, T2/S2 only, isolated scratch; consume its automatic completion, never poll/relaunch. Source is committed; only this evidence record is newer. On PASS, run the parent focused spot check once, finish T2 and start T3; on candidate-caused blockers use the one bounded correction/recheck plan, not a new full sweep. T3 orientation only: MCP gateway executeWriteTool/executeReadTool, owner HTTP handleOwnerRequest, domain command/status unions; archived specification docs/archive/web-demo/public/assets/aistudio/MCP_SECURITY_SPEC_c4e8d000.md. Module reports have current syntax but cached-reference warnings from8235e0c: read fresh bodies before edits, do not rely on cached call edges. T7 remains externally blocked on a new stable Agy conversation authorization; #3/#5 product work is authorized and continues independently of that optional sibling session.

- **L17 — T2 independently complete / T3 starts**: verifier mvsvfseo-1-34dj PASS on isolated exact7af7720, all5 S2 criteria, no blockers; focused52pass/2skip/0fail, full552pass/4skip/1todo/0fail, lint0 and independent public probe0. Parent required focused spot check then exit0:52pass/2skip/0fail, same3files. Verifier had no memory tools; parent saved verdict in #6633 without retrying discovery. T2 done locally, remotely still OPEN; native reviewDue=false is not a receipt approval. Start T3 draft/publication boundary next. User updated Agy MCP panel reports all5servers connected (funplay recovered), with duplicate Engram entries; this read-only inspection creates no permission/config/identity-continuity grant and does not unblock T7. No MCP config changed.

- **L18 — Fresh current-instance authorization (verbatim)**: "actualice permisos dentro de cli de agy, revisa enviar ahora, para ver si acepta o sigue solicitando permisos." Resume T7 with this fresh human-selected target/scope; pause T3 at read-only preparation (no #3 source/test edit yet). One bounded probe observes routine git/test plus canonical engram MCP read/save, without parent approval keystrokes, restarts, config writes or alternative tool-discovery shell commands. No claim that user-modified policy is proven until readback. Archived security spec already identified the existing #3 rule: DRAFT non-binding, at most5 open drafts; do not invent a different cap.

- **L19 — Probe admission is not proof**: job9 exit0 after43s, target agy/GF-nft/revision18 before and after, native lifecycle returned idle. One normal and one larger terminal read captured only35lines/4321bytes showing an unrelated `mcp` turn interrupted; neither the original probe prompt nor command/MCP results are recoverable there. Project-scoped discovery search "permission probe" returned no matches. These facts prove neither success nor a missing permission, and do not prove a restart during this probe. No approval keys or retry were sent. Use the Herdr skill's ONE fallback to write only an already-existing report to a repository-local temporary log path; if no historical execution is visible, require NOT_OBSERVED and do not rerun any operation. Any remaining unavailable proof becomes one Needs your decision result, not another verification loop.

- **L20 — Result capture completed / proof unavailable**: job10 exit0 after30s, final Herdr revision24. Read the actual repository-local report: conversation e5ea75a8-d255-4aa9-adef-e989220603f1, Git/Test/Engram outcomes and approval status all NOT_OBSERVED; it explicitly records no prior operations or memory IDs and infers none. The report file itself is the only new observed artifact, not proof of command/MCP permissions. Do not infer the cause from revision drift alone or claim a successful probe. T7 blocked for one explicit human disposition; no more tests/retries/capture loops. Current product facts unchanged: T2 independently complete at7af7720, T3/T4 not implemented, #12 accepted archive scope, no publish/deploy/live migration. Parent memory #6635 holds the final unavailable-proof record.

- **L21 — New explicit minimal-probe authorization**: human selected "Autorizar una nueva prueba mínima" with exact single-operation/stable-conversation scope in S13. This is a new human-owned bounded attempt, not an automatic repeat of job9 or a further capture loop. Send a short prompt requesting exactly git status --short --branch and observed stdout/stderr/exit/approval status; no MCP, tests, memory or source/config edits by Agy. Parent will not approve prompts and cannot infer success from admission/idle. Keep previous NOT_OBSERVED evidence intact.

- **L22 — Minimal probe observed / product continuation**: job11 exit0 after12s, Agy revision24 before/after; terminal shows the exact short prompt, one Ran(git status --short --branch), then exit0, empty stderr and Approval Requested:No. This proves only that operation in that conversation; no Bun/Engram or blanket permission claim. T7 complete under superseding S12-S13 scope, no more probes. Stdout also newly shows M game/project.godot; parent did not edit it and will preserve/exclude that concurrent, unattributed change from staging and commit scope. T3 resumes: existing spec requires non-binding DRAFT and max5 open drafts; parent has read fresh domain/MCP/owner HTTP bodies and durable admission helper. No #3 implementation source edit yet.

- **L23 — T3 behavioral RED / implementation boundary**: design #6637: real DRAFT, separate internal DRAFT/PUBLISH commands, MCP retains contracts:draft only, manual HTTP publication uses existing owner sessions and durable FactoryMatch.submitMcpCommand. Archived referenced spec explicitly caps5 open drafts; core must enforce at execution, not just gateway pre-enqueue counting. Added2public MCP tests +3owner HTTP/restart tests and unskipped existing issue3 market test. Two initial test-only enum diagnostics were fixed before running behavioral RED. Focused3files exit1:10pass/1skip/6fail, demonstrating PENDING/public leak,6queued offers over cap and absent owner publication route. No production edits preceded this RED. Preserve game/project.godot external change; new source changes stay in backend/contracts docs. Reuse durable admission and existing session/body/idempotency helpers; update owner API/help and perform one differential compatibility script because extending shared owner-route dispatch also touches existing session/grant paths.

- **L24 — T3 partial implementation / required schema unit**: added DRAFT/PUBLISH domain commands and guarded core transitions, owner-session-only HTTP publication, DRAFT-only MCP creation/filtering and max5 execution-time enforcement. New in-memory draft/cap tests PASS, but first combined check still exit1:10pass/1skip/6fail:3owner/restart cases hit SQLite CHECK rejecting DRAFT;3old isolation fixtures require explicit manual publication instead of old draft=PENDING assumptions. Do not call this GREEN. Baseline schema has a closed status CHECK; no SQL FK references b2b_contracts found. Add T8 as an ordered prerequisite (T3 pending, not blocked): atomic migration6 plus public preservation/rollback tests, own Risk item1 commit; stage only DRAFT status enum from the currently broader domain patch for that unit. Keep other #3 changes unstaged until coherent. No schema1 edits, live DB migration, destructive user data operation or game/project.godot staging.

- **L25 — T8 test-first / storage-only slice**: initial migration-test fixture mistakenly omitted createAcceptedContract's required options; fixed after reading its public helper, and do NOT count that setup TypeError as RED. Actual behavioral RED then exit1:0pass/3fail (fresh DRAFT CHECK rejection, current version5 instead of6, missing sixth migration). Added append-only006 table replacement/14column copy/3index recreation plus registry entry; focused GREEN3pass/0fail proves fresh round-trip, all5legacy statuses unchanged, checks/FK denial without row changes, repeat no-op and injected post-DDL rollback of schema+bookkeeping before clean migration. Baseline schema1 unchanged. Stage only the DRAFT status enum line,006, registry, storage tests/guide and tracking; leave all DRAFT/PUBLISH command/HTTP/MCP code, new app tests and human game edit unstaged. Verify an isolated archive of that staged tree so unfinished T3 does not contaminate this Risk1 candidate. Never claim the still-failing combined T3 suite is green.

- **L26 — Isolated storage compatibility correction**: staged tree aca507d7 focused16pass/0fail, but whole isolated suite552pass/4skip/1todo/3fail: exactly3existing grant-credential tests hard-coded latest version5/[5] after migrate(all), while6 is now correct. Grant rows, audits and retirement semantics were not failing. Read owning tests, changed only latest-version/applied-range expectations to derive MIGRATIONS; retained v4 and explicit failing-migration5 assertions and all security checks unchanged. Stage that compatibility-only test update, make a new immutable tree, and run its checks once; no retry of unchanged failed candidate. Four active diagnostic paths were clean. T8 still in_progress; no commit or full-green claim yet.
