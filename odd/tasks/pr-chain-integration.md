# PR chain integration
Integrate the existing reviewed chain into the verified default branch without bypassing required CI.
Branch: `chore/pr-chain-integration` (local preparation) | Delivery: existing feature-branch chain, merge commits, no force pushes | Checks: `bun test`, `bun run lint`, `bun run build`, Godot headless checks.

## Specs

- **S1** — Accepted recommendation (verbatim): "Mi recomendación: primero cerrar la integración de la cadena; después seguir con **#2, aislamiento por empresa**, y **#7, credenciales**." User authorization (verbatim): "ok procede". This document covers integration only; #2 and #7 retain their own issue requirements and follow afterward.
- **S2** — Reported integration prerequisite (verbatim): "El **#16 todavía no muestra el check obligatorio**; hay que resolverlo antes de integrarlo." Check: exact tracker head receives a successful `test, lint, build (headless)` check before merging #16; do not bypass branch protection.

## Tasks

- **T1** [S1] — **done** — Merge child PRs #21 → #20 → #19 → #18 with pinned head SHAs and successful applicable CI. Route: inline (authorized remote integration, no writer trigger). Commits: #21 `6361e0c`, #20 `159dcad`, #19 `7462321`, #18 `9af684f`; every exact-head CI passed before its merge (L5).
- **T2** [S1,S2] — **in_progress** — Bring the integrated backend branch and current main/workflow into the tracker, preserve existing reviewed behavior, and merge #16 only after required CI passes. Route: inline (Git graph integration, no new behavior). Commit: pending. Risk: item 5 (delivery integration and CI).
- **T3** [S1,S2] — **pending** — Verify integrated main equals the functionally checked tracker candidate, record full test/lint/build and Godot evidence, PR states and limitations, then proceed to #2 and #7. Route: inline functional checks during T2 plus one independent integration verifier before final merge. Commit: pending closure evidence.

## Log

- **L1 — Original request (verbatim)**: "ok procede".
- **L2 — Accepted context**: the immediately preceding recommendation is quoted in S1. Authorized target is the existing `origin`: `https://github.com/sdsoporte/GF-nft.git`; operations are integration of the existing chain and in-scope local implementation of #2/#7. No new fix PR, release, force push, branch deletion or protection change is authorized here.
- **L3 — Read-only evidence**: remote fetch completed; #17 already MERGED by the user. #21/#20 CI green; #19/#18 have no checks yet; #16 has no workflow in its head tree. Main is protected by `test, lint, build (headless)` (admins exempt, no force push/deletion); workflow on main is byte-identical to the QA branch workflow. RDD is on globally. New aggregate review is not applicable to already-dispositioned commits; #19's exact candidate remains explicitly unreviewed by user decision.
- **L4 — Forecast**: integration should add only this tracking document and merge commits (under ~150 authored lines); existing code/CI is reused, not rewritten. Existing feature-branch-chain structure is retained. If conflict resolution needs new behavior or policy changes, stop and scope that separately. Issue #7's owner-authentication architecture is being mapped read-only, not assumed.
- **L5 — T1 complete**: job-3 exited 0. PR #21 merged as `6361e0c9e4cf26fecd5db6248ce8f5a756c68b48`, #20 as `159dcad387388657c3bdb4369b0786496cd68f3e`, #19 as `746232140c3657e0ee6704ebd3facb281e64b38d`, #18 as `9af684fb6bdcb00e8f90f60566ee5f20d4bb64ef`. Each operation pinned its head SHA and observed the named exact-head CI SUCCESS; no bypass, force push or branch deletion. The tracking-only commit is `50ea148`; its read-only native assessment returned `package-local-binary-missing` / unassessable, so no native review was started or retried. Normal verification remains required.

