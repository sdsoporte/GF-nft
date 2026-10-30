# Isometric production view

The game screen now has a small isometric layer that shows the factory the server
already owns: one ore-supply tile plus one tile per production line. It is a
renderer, not a game. Nothing in the view ticks, moves cargo, builds machines or
advances a batch, so a stopped or disconnected backend can never look alive.

Use it to read production state at a glance while the existing inventory, line
controls and market panels keep working exactly as before.

## Quick path

1. Start the backend and press **Connect** in the Godot client (see `game/README.md`).
2. Watch the framed row under the tick/credits/energy summary: each line's tile
   shows its server status, its R1 progress and produced count.
3. Click a tile to select that line. The production-line list selects the same
   row, so **Pause**, **Resume**, **Priority** and **Start one R1 batch** target
   the line you clicked.
4. Check the bottom-left note of the frame: it names whether local pack art or
   geometric placeholders are in use.

## Files

| Path | Role |
| --- | --- |
| `game/scenes/factory_isometric_view.tscn` | Framed view scene instanced inside the main scene. |
| `game/scripts/view/factory_isometric_view.gd` | Snapshot → tiles, labels, state tint, selection and fallback art. |
| `game/scenes/main.tscn` | Hosts the view in `Root/Column/ViewRow/ProductionViewFrame`. |
| `game/scripts/main.gd` | Feeds snapshots to the view and mirrors selection with the line list. |
| `game/tests/test_isometric_view.gd` | Deterministic view checks (no rendering, no backend). |
| `game/tests/test_main_scene.gd` | Pins the embedded view and its selection round trip. |

## State mapping

| Snapshot value | View behavior |
| --- | --- |
| No snapshot yet, or a closed session | Every tile is removed, the layer is hidden and the frame says `No server snapshot: nothing is running here yet.` |
| `lines[].lineId` | Tile identity and selection id; the badge repeats the line id. |
| `lines[].status` | Tile state label, tint, and whether the tile animates. |
| `status = RUNNING` | Green tint and a decorative pulse; the only animating state. |
| `status = PAUSED` | Amber tint, no pulse. |
| `status = NO_ENERGY` | Red tint, no pulse. |
| `status = IDLE` | Grey tint, no pulse. |
| `lines[].activeBatch` | Badge reuses the existing `FactoryViewModel` line row, so progress `4/10` and `batch 1/1` are worded exactly like the line list. |
| `lines[].totalBatchesProduced > 0` | Badge appends `produced N`, the same field the #56 completion feedback reads. |
| `inventory.RAW_ORE` | Ore-source badge shows the available stock; a missing entry says `not reported`. |

The ore source has its own `SOURCE` state: it is a stockpile the server reports,
not a machine, so it never animates.

Animation is decoration only. `advance_activity_animation(delta)` moves a pulse
phase and a modulate value; it never edits the snapshot, a label or a batch
counter, and a check pins that (`the server tick`, `progressTicks` and the badge
text stay identical after animation frames).

## Selection contract

`FactoryIsometricView.select_line(line_id) -> bool` accepts only line ids present
in the current snapshot, keeps the previous choice and returns `false` for an
unknown id, and emits `line_selected(line_id)` for a real player choice.
Clearing with `select_line("")` emits nothing.

`main.gd` keeps the existing line list authoritative: a view selection selects the
matching list row, and a list selection is mirrored back into the view under a
re-entrancy guard, so one click produces exactly one signal. The existing
handlers still decide what to send; a view click can never start production on
its own.

## Local art and fallbacks

The view resolves these known pack filenames at runtime and loads nothing else:

```text
res://local_assets/mythryl/factory/32px/godot/pieces/mining/burner-drill.tscn
res://local_assets/mythryl/factory/32px/godot/pieces/smelting/stone-furnace.tscn
res://local_assets/mythryl/factory/32px/godot/pieces/floors/concrete.tscn
```

| Situation | Behavior |
| --- | --- |
| Path exists | The piece scene is instanced and every `AnimatedSprite2D` it contains (`Body` and `Shadow` in the packs) gets playback from the authoritative state: `play()` for `RUNNING`, `pause()` for `PAUSED`/`NO_ENERGY`, `stop()` for `IDLE`. No animation name is invented and no frame is advanced locally. |
| Path missing | An independently authored geometric tile and piece are drawn instead. |
| Pack partially installed | Each tile falls back on its own; the frame note still warns that art is incomplete. |
| Pack installed at all | `ASSET_NOTE` replaces `FALLBACK_NOTE` under the frame. |

Playback uses the documented `AnimatedSprite2D` API only (`play`, `pause`, `stop`,
`is_playing`); there is no `playing` property to read or assign. `pause()` keeps the
frame the machine stopped on, which is why `PAUSED`/`NO_ENERGY` freeze instead of
resetting, while `stop()` returns an `IDLE` machine to its rest frame.

`ResourceLoader.exists` guards every lookup, so the public project and all headless
checks pass with no licensed file present. `set_piece_scene(kind, scene)` registers a
piece scene for one kind and is the seam the checks use: they build a
`Body`+`Shadow` `AnimatedSprite2D` scene in memory and run it through the same
renderer, so the loaded-piece branch is covered on a machine with no packs at all.
The pack is local-only: it must stay out of Git and out of AI inputs. Do not open
the pack archives, PNGs, screenshots or `.tres`/`.tscn` bodies of licensed art in an
AI tool, and do not generate derivative imagery from them. Only the filenames above
and the pack README conventions are used as knowledge.

## Out of scope

- No construction, placement, belts, cargo routing, terrain or camera controls.
- No local prediction: a badge only changes when a new snapshot arrives.
- No bespoke art or machine model for recipes beyond R1.
- No screenshot-based verification; checks read scene and render state instead.
- Selling UI for #58 is added later on top of this integration.

## Checks

```bash
GODOT_BIN=/opt/godot/Godot_v4.7.2-stable_linux.x86_64 bun run test:game
```

`game/tests/run_checks.sh` discovers every `game/tests/test_*.gd` suite, prints the
suite list it will run, and boots the main scene headless. The view checks cover:
the no-data state, one tile per reported line, all four line states, the
RUNNING-only animation rule, unchanged server progress across animation frames,
line identity and the selection signal, the fallback behavior for a missing local
pack, and the loaded-piece playback branch through a generated in-memory sprite
scene, so a machine with no packs covers the same code the real pieces use.

## Checklist

- [ ] `test_isometric_view` and `test_main_scene` pass with no local pack installed.
- [ ] A disconnected scene shows the no-data frame, not tiles.
- [ ] Clicking a tile selects the same row the control buttons act on.
- [ ] A `PAUSED`, `NO_ENERGY` or `IDLE` tile never pulses.
- [ ] The frame note matches the real state of `game/local_assets/`.
