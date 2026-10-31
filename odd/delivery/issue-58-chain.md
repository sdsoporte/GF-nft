# Issue #58-B delivery chain

Integrate the verified sell-first journey and local isometric view through a feature-branch chain.
Refs #58. Player purchasing remains outside this delivery; the issue stays open.

## Integration order

| Slice | Source endpoint | Deliverable |
|---|---|---|
| 01 | `6ee626a` | Reject expired acceptance before mutations |
| 02 | `63595ae` | Keep licensed assets local and document gaps |
| 03 | `e4a161a` | Authenticated owner selling API (includes `434271f`) |
| 04 | `acb7eaf` | Snapshot-driven local isometric view |
| 05 | `880b22e` | Approved five-ingot demand for `comp_metal_02` only |
| 06 | `b09324a` | Owner selling inventory and server consequences |
| 07 | `c4e32f9` | Confirmed owner selling UI (includes `e7a6c5e`) |
| 08 | `dd923b0` | Real R1 selling, rejection and restart smoke |
| 09 | evidence branch | Complete requirements and observed verification |

## Gates

- Keep the tracker PR draft/no-merge until every child is verified and integrated in order.
- Each child starts against its immediate predecessor; retarget to the tracker after that predecessor integrates, then verify the focused diff.
- Preserve original source SHAs through normal merge commits; no squash, rebase, force push, branch deletion or protection bypass.
- Require the actual `test, lint, build (headless)` CI result before every merge and the final tracker merge.
- Functional/independent proof: backend 716 pass, two known skips, zero failures; Godot nine suites/1,151 checks without packs; real produced-R1 sale, NPC purchase, dispatch, settlement, rejection and restart passed.
- Native T3 receipt `review-d0e3ae40710a1027` and U4 receipt `review-e658561386cfaec5` are approved, exactly acknowledged and burned. U1/U2/U3 review was not due; documentation is assessed separately.
- Shellcheck is unavailable, not passed. The separate copied Gentle Pi full suite remains non-green (7,657 pass / 37 fail / 75 skip); focused parser checks passed 2/2.
- No licensed artwork, archives or artwork screenshots belong in public Git or AI inputs.
