# Product layout and MCP delivery
Publish the verified local security/layout units through protected-main PRs; keep runtime bytes and unrelated backlog untouched.
Target: `github.com/sdsoporte/GF-nft` | Actor: `sdsoporte` ADMIN | Default: `main` | Strategy: `auto-chain` / `feature-branch-chain` | Source: `f24e151` plus delivery records.

## Specs

- **S1** — User request (verbatim): "ok, integra todo para qeu quede formalmente completo, push, pr , merge segun necesario." Check: verified changes are actually on protected main with exact-head required CI, not merely prepared locally.
- **S2** — Human metadata choice (verbatim): "Autorizar issue y etiquetas (recomendado)". Bound scope: this target/session only; create organization issue and exact `status:approved`, `type:bug`, `type:feature`, `type:breaking-change`, `type:refactor`, `type:chore`; approve issues #2/#7/new organization issue and select one type per PR at creation. Scoped `/tmp/gf-nft-delivery-issue` may hold private body/readback and is deleted after use.
- **S3** — Human closing choice (verbatim): "Cerrar #2, #7 y el issue de organización". Check: only evidenced acceptance criteria updated and covered issues closed after integration and main CI; #12 untouched. No claim that legacy isolated re-registration was fixed.

### Delivery constraints

- Required context is exactly `test, lint, build (headless)` from GitHub Actions. No admin bypass, protection/required-check changes, force pushes, branch deletion or live deploy/migration.
- Keep cached tracker strategy; one honest slicing pass already verified every base is an ancestor. Preserve code/tests/docs instead of shrinking natural units. No target size-exception policy exists; do not create its label.
- Native switch on(global), native assessment unavailable/package-local-binary-missing; independent full-spec verification PASS. This is not native approval and metadata grants create no review consent.
- Push only explicit intended branch refs through the authenticated GitHub CLI credential session; never push all refs/private backup. Tracker stays draft/no-merge until all children integrate. Merge children backward, checking the current head/check before each action.
- Stop on denied/unknown mutation or required-check failure; no blind network retries. One create attempt followed by exact target readback for issue/PR publication. Remote issue #12 and #3–#5 remain untouched.
- Local prior checks547 pass/7skip/1todo/0fail, lint/build/frozen0, Godot388+boot0, real game and explicitly authorized corrected owner-restart proof PASS. CI must independently confirm hosted candidates; local results are not remote green evidence.

### Planned child boundaries

| Child | Head / branch | Immediate base | Focus / target type |
| --- | --- | --- | --- |
| 1 | `b5ca36c` / `fix/mcp-read-isolation` | `chore/mcp-security` at95bba2c | tenant reads / type:bug |
| 2 | `158587b` / `fix/mcp-tenant-history` | child1 | durable private history / type:bug |
| 3 | `5fc0455` / `fix/mcp-grant-storage-core` | child2 | hash storage +retirement migration / type:breaking-change |
| 4 | `aa5a9a3` / `fix/mcp-grant-issuance-core` | child3 | one-time grant issuer / type:feature |
| 5 | `3bf3fa7` / `feat/mcp-owner-core-integration` | child4 | independent owner session core / type:feature |
| 6 | `4a116ec` / `fix/mcp-credential-integration` | child5 | protected HTTP/runtime/Docker wiring / type:feature |
| 7 | `d56c72a` / `refactor/backend-workspace` | child6 | backend workspace +archived demo / type:refactor |
| 8 | `7e797e9` / `refactor/game-layout` | child7 | Godot/contracts/integration paths / type:refactor |
| 9 | final delivery head / `refactor/product-layout` | child8 | scope/coverage/evidence / type:chore |

Tracker `chore/mcp-security` targets main and carries final closing references. Observed raw diff budgets239/314/712/1056/558/892/2291(includes archived/generated metadata)/314/95+delivery docs. Natural >400 units retain cohesive tests/docs with explicit review notes.

## Tasks

- **D1** [S1-S3] — **done** — Verify target/actor/default/protection/issues and slice ancestry. Route: parent read-only GitHub discovery. Evidence: target-bound logs in `.git/odd-logs/delivery/`, admin, required context, no open PR/template/forms, blank issues explicitly enabled, no layout duplicate. Commit: `b33c0b6f5f97e546cce561db5437f21ca1ad18d3`.
- **D2** [S1-S3] — **done** — Record delivery, materialize approved labels/issue and branches. Route: parent bounded remote actions, exact pre/post readback. Commit: `e375119b11e0ff50d5f525cceaf33cfa9907b0cb`. Risk: item5 (remote delivery metadata).
- **D3** [S1-S3] — **in_progress** — Push intended refs, publish draft tracker and9 linked child PRs with exact one type and dependency diagrams. Route: parent. Evidence: pending remote IDs/heads. Risk: item5.
- **D4** [S1] — **pending** — Observe exact-head required CI; merge9→1 then ready/merge tracker without bypass. Route: bounded background GitHub watcher, no source writer. Evidence: pending. Risk: item5.
- **D5** [S1-S3] — **pending** — Verify main tree/postmerge CI, mark evidenced issue criteria/closures, sync local main and document final remote results. Route: parent. Evidence: pending. Risk: item5.

## Log

- **L1 — Original request (verbatim)**: "ok, integra todo para qeu quede formalmente completo, push, pr , merge segun necesario."
- **L2 — Human choices (verbatim)**: metadata="Autorizar issue y etiquetas (recomendado)"; closures="Cerrar #2, #7 y el issue de organización". Selected preview: "El tracker usa referencias de cierre para #2, #7 y el nuevo issue. Solo se marcan criterios sustentados por las pruebas. No se declara corregido el modo SDK legacy ni se cierran #3–#5." #12 not included.
- **L3 — Preflight**: root cleanf24e151; main/origin c24e719, remote HTTPS github.com/sdsoporte/GF-nft; GH actorsdsoporte ADMIN. Required Actions context as above, no required reviews. Existing labels only stock GitHub;#2/#7 open/unlabeled, explicit blank issue support and duplicate search returned none. Remote contribution paths empty. Nine ancestor edges verified; no rewriting needed. Role/native review approval not invented. Shellcheck binary unavailable; prior shell help/error/Bash+Godot behavior checks passed, no new production scripts changed here.

- **L4 — D2 confirmed**: six exact labels created/confirmed under direct human authority;#2/#7 approved with post-readback, new organization#22 confirmed by exact title/body/labels at https://github.com/sdsoporte/GF-nft/issues/22. Actor ADMIN/target bound, no duplicate/template ambiguity; privacy scan PASS and owner-only granted temporary directory removed. Branch aliases match the nine verified ancestor tips; no existing branch rewritten. No protected-label exception invented. Publishing tracker+9children next; only tracker closes#2/#7/#22, #12 untouched.

- **L5 — Delivery credential blocker**: job22 failed at the initial atomic push; every intended ref was remotely rejected. Exact cause: OAuth App cannot create/update `.github/workflows/ci.yml` without `workflow` scope. Repository ADMIN does not imply that OAuth scope. No tracker/child PR creation executed. Read-only ref reconciliation job23, no automatic retry. D3 waits for human to refresh the SAME GitHub session with workflow permission; do not switch identity, weaken/revert CI, disable RDD or change protection. Suggested human command `gh auth refresh -h github.com -s workflow`; no token values should enter chat. Metadata labels6/#22 creation and#2/#7 approvals are confirmed and retained. Current delivery remains incomplete; D4/D5 pending.

- **L6 — Reconciliation / safe stop**: read-only job23 confirmed0 of the10 intended remote refs exist after rejection. Push outcome is authoritative no_write; no tracker/child PR exists, no merge/checks/issue closure occurred. #22 and6 authorized labels remain confirmed. Preserve the blocked local checkpoint; resume only after the human renews the active credential's workflow permission, fresh target/scopes/ref validation, then the already authorized push/PR/merge plan. No alternate identity, CI edit to evade scope, force operation or automatic retry.

- **L7 — Credential precondition resolved**: human reports (verbatim) "✓ Authentication complete." Fresh read-only job24 confirms active workflow OAuth scope, same target/actorsdsoporte ADMIN/defaultmain, approved#2/#7/#22,0 existing chain refs/PRs and unchangedmainc24e719. The previous atomic push remains reconciled no_write; preserve that receipt. Resume the already authorized publication with fresh final head, not an automatic retry of unknown/denied state. No deployment/native-consent/protection changes.
