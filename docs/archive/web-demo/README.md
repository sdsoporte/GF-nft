# Archived web demo — historical source only

This directory is the retired React/Vite prototype of GigaForge, kept as
**source only** for provenance. It is **not a runnable supported application**:
there is no supported install, dev server, build or test command here, and no
CI job or container reads it.

Why it stays: the read-only browser playground documented pre-T5 security and
settlement behaviour, and its design notes are still useful evidence. The
authoritative product is the Bun backend in [`backend/`](../../../backend) plus
the Godot client. The settlement ledger in this demo was never persistence.

## Reproduction

Reproduce the demo from the **historical commit** that still shipped it, never
from this archive:

```bash
git switch --detach 4a116ec    # last commit with the demo as the active app
bun install
bun run dev                    # historical Vite dev server, port 3000
```

Return with `git switch -` (or your branch name). Do not add the archive back
to the active workspace, lockfile or typecheck scope.

## What is preserved

| Path | Origin | Note |
| --- | --- | --- |
| `package.json`, `bun.lock` | root manifests at `4a116ec` | Original frontend dependency set, byte-identical to the retired root files. Not installed by the active workspace. |
| `index.html` | root | Vite entry document. |
| `vite.config.ts` | root | React + Tailwind plugins and the `@` alias. |
| `metadata.json` | root | AI Studio app metadata. |
| `src/App.tsx`, `src/main.tsx`, `src/index.css` | root `src/` | Demo UI, React root and stylesheet. |
| `src/persistence/InMemorySettlementProvider.ts` | root `src/persistence/` | Frozen browser-only fork; replaced by `backend/src/persistence/SqliteLocalSettlementProvider.ts` as the real ledger. |
| `public/assets/aistudio/` | root `public/` | Design and security notes that shipped with the demo. |

## Intentional historical imports

The archived sources still import `./domain/...`, `./engine/...`, `./mcp/...`
and `./persistence/...` from the layout they had at `4a116ec`. Those active
modules now live under `backend/src/`. The imports are **not** repaired: the
archive is a frozen snapshot, not a buildable tree, and copying the active core
into it would create a second source of truth.

## Issue #12 disposition

[Issue #12](https://github.com/sdsoporte/GF-nft/issues/12) reported that
`handleReset` replaced `engineRef.current` while `engine`, `gateway` and
`settlement` stayed captured from render. It was filed against this directory's
`src/App.tsx`, at a time when that file was still the active app.

| Question | Disposition in current scope |
| --- | --- |
| Applies to the active product? | No. The active product is the Bun backend plus the Godot client; neither runs `handleReset`. |
| Fixed? | Not claimed. No `Reset → Play → Operar → Reset` UI test was written or run for this archive, so none of the four issue criteria is treated as verified. |
| Runnable evidence? | None. This tree has no install, dev server, build or test command, so the criteria cannot be measured here. |
| Remote issue state? | Unchanged. This document does not close, comment on or otherwise modify issue #12. |

The accepted source-only archive supersedes the issue's applicability: the reset
criteria stay historical text until a maintainer either restores a runnable demo
or ports reset semantics into the active backend/Godot path. Reading the
archived `src/App.tsx` is provenance, not a fix.

## Ownership

- Active backend: `backend/` (engine, domain, persistence, MCP gateway, HTTP).
- Active client: `game/` Godot project.
- Archive: this directory. Read-only history; delete only with maintainer
  approval and a replacement provenance link.
