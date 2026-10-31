# Local factory art: reuse first, create only the gaps

Use the downloaded Mythryl packs locally for the small isometric production
view. Keep the public source runnable without them. This is a representation
of existing server state, not a construction or conveyor simulation.

## Quick path

From the repository root, using ZIPs obtained by each contributor:

```sh
ASSET_ZIP_DIR=/path/to/godot_assets
mkdir -p game/local_assets/mythryl/factory game/local_assets/mythryl/terrain
unzip -q -n "$ASSET_ZIP_DIR/pixel-factory-free-godot.zip" '32px/*' \
  -d game/local_assets/mythryl/factory
unzip -q -n "$ASSET_ZIP_DIR/pixel-terrain-free-godot.zip" '32px/*' \
  -d game/local_assets/mythryl/terrain
git check-ignore game/local_assets/mythryl/factory/32px/LICENSE.txt
```

Keep the included licenses and folder structure. Open `game/` in Godot to
import resources. Use only one size family: the initial view uses the 32px
pack (32 × 16 isometric ground diamonds), integer scaling and nearest-neighbor
filtering. The files are Godot 4 resources; artwork quality and final sprite
mapping still require human visual approval.

The setup commands do not overwrite existing files. No ZIP, sprite, generated
import cache or reusable third-party resource belongs in a commit.

## Minimal catalogue

| ID | Gameplay purpose | Reuse or create | Priority |
| --- | --- | --- | --- |
| W1 | Existing ore extractor | Candidate: factory `mining/burner-drill.tscn` | Initial view |
| W2 | Existing R1 production line | Candidate: factory `smelting/stone-furnace.tscn` | Initial view |
| W3 | Ground beneath logical line slots | Candidate: factory `floors/concrete.tscn`; simple independent fallback | Initial view |
| W4 | Background terrain | Free terrain grass/dirt; water, cliffs and nature only if useful | Optional |
| U1 | RAW_ORE, IRON_INGOT, energy and credits | Independent labelled UI glyphs; verify any pack-item mapping with a human | Initial readable UI |
| U2 | IDLE, RUNNING, PAUSED and NO_ENERGY | Independent badges with text, not color alone | Initial state feedback |
| U3 | DRAFT, PENDING, ACTIVE, FULFILLED, DEFAULTED and CANCELLED | Independent labelled status marks | Selling UI |
| U4 | Draft, publish, cancel, dispatch and human confirmation | Existing controls with clear labels; custom glyphs are optional | Selling UI |
| U5 | Escrow, collateral, fee and default consequences | Independent symbols beside authoritative numeric terms | Confirmation UI |
| U6 | Selected line and seller/buyer identity | Independent outline plus line/company labels | Initial selection |

The free factory edition has 14 pieces and one palette; full-edition coverage
is not assumed. Free terrain is summer only. No additional purchase is needed
to prove this slice.

Belts, inserters, chests and poles do **not** represent functioning logistics
in the current simulator. Do not add them as apparently interactive systems
or animate transfers that the server has not reported.

## Brief for a missing original

Before commissioning or independently creating a missing asset, record:

| Field | Required information |
| --- | --- |
| Identity | Catalogue ID, gameplay entity/action, visible text and owner |
| Purpose | What the player must recognize; where the art appears |
| Geometry | UI size or isometric footprint, pivot, orientation and scale |
| States | Exact server states and required variants; no invented mechanics |
| Motion | Static or frame count/rate; what starts/stops the animation |
| Delivery | File format, transparency, source files and stable filename |
| Rights | Creator, source URL, license, redistribution and AI-use permissions |
| Acceptance | Human visual check plus programmatic identity/state checks |

Use the original brief to request only what is missing. A human artist on the
project can work within the pack's team-sharing terms. Do not feed these packs
or their visual style to an AI generator; independently created work must not
use them as input or reference.

Defer bespoke R2–R8 machines/items, construction previews, conveyor routing,
seasonal terrain, portraits and large decorative sets. Audio and custom fonts
are later polish, not prerequisites for the first trading loop.

## License and repository boundary

The bundled Mythryl Studio v1.0 terms permit commercial/non-commercial finished
projects and modifications, but restrict redistribution for separate reuse.
These are **not CC0 assets**. The repository is public, so raw pack files stay
under ignored `game/local_assets/`, obtained separately by each contributor.
Do not silently add them to CI artifacts, source archives, templates or tools.

The license also prohibits AI training/testing, datasets, and use as AI input,
reference or style source. Do not open pack images, resource bodies or rendered
screenshots containing the art in AI tools. Mechanical filesystem copying and
normal Godot loading must not emit those contents into an AI transcript.
AI-assisted coding must work from generic interface metadata and independent
fallbacks, without receiving the licensed art.

No aesthetic assessment is claimed here: this catalogue is based on filenames,
README metadata, license text and implemented gameplay. Visual approval belongs
to a human. License interpretation beyond these operational restrictions needs
confirmation from the author, not an assumed grant.

Sources: [Pixel Factory](https://mythrylstudio.itch.io/pixel-factory),
[Pixel Terrain](https://mythrylstudio.itch.io/pixel-terrain), and each ZIP's
`LICENSE.txt`. Suggested optional credit: Art by Mythryl Studio
([mythryl.com](https://mythryl.com)).
