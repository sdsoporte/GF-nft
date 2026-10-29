# GigaForge Godot client (first authoritative slice)

This Godot 4.7 project is a **client**. A separate TypeScript backend owns the
match, its tick clock and every mutation. The screen reads snapshots, shows the
metal factory that the server selected, and asks the server to start one R1
batch. Nothing in GDScript ticks, spends or produces resources.

The contract is frozen in [`../contracts/factory-api.md`](../contracts/factory-api.md).
Read that file before changing request or response shapes.

## Quick path

1. Start the backend from the repository root with a real token (32+ characters):

   ```bash
   export GF_API_TOKEN="$(openssl rand -hex 32)"
   # run the backend entrypoint documented in contracts/factory-api.md
   ```

   Native development listens on `http://127.0.0.1:8787`. The Docker path
   publishes the same loopback port with `docker compose up --build`.
   There is **no built-in token**: the server refuses to start without
   `GF_API_TOKEN`, and this client ships no default credential.

2. Open this folder (`game/`) in Godot 4.7 and run the main scene, or launch it with
   the environment already set:

   ```bash
   GF_BACKEND_URL=http://127.0.0.1:8787 \
   GF_API_TOKEN="$GF_API_TOKEN" \
     /path/to/Godot_v4.7.2 --path game
   ```

3. Press **Connect**, then **Start one R1 batch**. Watch the tick advance and the
   inventory change only in later server snapshots.

## Connection rules the client enforces

| Rule | Behavior |
| --- | --- |
| Credential storage | Token stays in memory and the environment; the field is masked and is cleared on disconnect. It is never written to disk, a label or a log. |
| Transport | `http://` is accepted only for `127.0.0.1`, `localhost` and `[::1]`. Remote backends must use `https://`. |
| Redirects | Redirects are disabled (`max_redirects = 0`); a 3xx answer ends the session instead of replaying the bearer token. |
| Request overlap | One `HTTPRequest` and an in-flight guard: polling and a production request can never overlap. |
| Lost command status | A non-fatal status-read error clears the stale view and resumes state polling. The command remains unknown; production is never automatically retried. Start waits for a fresh server snapshot. |
| Busy line | A line running a batch owns that work: the server rejects a second production request with `ERR_LINE_BUSY` instead of replacing the batch. The screen shows the rejection; it never retries automatically. |
| Session identity | Closing or failing a session bumps a generation counter, and payloads from the old generation are discarded. |
| Server authority | The client never sends a company id, tick, sequence number or batch count, and never mutates inventory. |

## Files

| Path | Role |
| --- | --- |
| `scenes/main.tscn` | Visible factory screen: connection controls, status, match/tick, credits/energy, inventory, lines, recipes, R1 action. |
| `scripts/main.gd` | Scene wiring; renders snapshots and forwards the two user actions. |
| `scripts/protocol/endpoint_policy.gd` | URL and token policy (plaintext loopback only, no credentials in URLs). |
| `scripts/protocol/factory_protocol.gd` | Validating parser for `/health`, `/v1/state`, `/v1/production`, `/v1/commands/<id>` and errors; builds the R1 request. |
| `scripts/protocol/factory_snapshot.gd` | Detached snapshot data object (no behavior, no mutation). |
| `scripts/net/factory_api_client.gd` | Bearer HTTP session: health preflight, polling, production, command status, error redaction. |
| `scripts/view/factory_view_model.gd` | Pure snapshot → screen text projection. |
| `scripts/dev/factory_smoke.gd` | Optional `--smoke` runner that drives the visible scene against a real backend. |
| `tests/` | Headless Godot suites with contract fixtures. |

## Checks

Fixture and UI checks (no backend needed):

```bash
GODOT_BIN=/path/to/Godot_v4.7.2-stable_linux.x86_64 bash tests/run_checks.sh
```

`run_checks.sh` copies the project into a fresh `mktemp -d` directory that
excludes `.godot/`, `override.cfg` and `addons/funplay_mcp/`, points the XDG
directories inside that copy, imports it and runs every `tests/test_*.gd`
suite plus a headless boot of the main scene. The scratch copy is kept so a
failure can be inspected. Run `bash tests/run_checks.sh --help` for options.

Real backend seam (parent-owned integration step):

```bash
GODOT_BIN=/path/to/Godot_v4.7.2-stable_linux.x86_64 \
GF_API_TOKEN="$GF_API_TOKEN" \
GF_BACKEND_URL=http://127.0.0.1:8787 \
  bash ../tests/integration/run_backend_smoke.sh
```

The smoke opens the visible scene, starts one R1 batch, waits for the command to
be executed, then waits for the selected line's own server-reported completion
(`totalBatchesProduced` grew and the batch left the line). It fails unless the
server snapshots then show the R1 output and the visible inventory shows it,
with a finite timeout. Input stock is checked as a lower bound only: the
independent ore extractor can replenish `RAW_ORE` while the batch runs, so the
smoke fails only when input dropped deeper than the recipe allows.

## Optional editor tooling

`addons/funplay_mcp/` and `override.cfg` are installed per machine and are
ignored by Git. The tracked `project.godot` does not reference them, so a clean
checkout runs without Funplay. To keep the plugin available locally, create
`override.cfg` with the autoload and editor-plugin entries your install needs.

## Limits of this slice

- One metallurgy company and one recipe (R1) on an idle line.
- The visible slice does not expose contracts, wallets or NPC automation.
- An unconfigured backend is in memory; with `GF_SQLITE_PATH` (the Compose
  default), SQLite re-adopts the match after restart. See the backend guide.
- Loopback deployment only; this is not an internet-ready authentication story.
- Server identity: `https://` relies on the platform CA store, and the token
  proves the client to the server, not the server to the client. `/health` is
  unauthenticated, so a hostile proxy on a non-loopback host could answer it.
  There is no certificate pinning in this slice; keep the backend on loopback.
