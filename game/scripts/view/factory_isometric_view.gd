class_name FactoryIsometricView
extends Control
## Compact isometric rendering of the production the server already reported.
##
## The view is a renderer only. It projects the last `FactorySnapshot` into a
## small framed layer of isometric tiles, one per server production line plus one
## for the ore supply the company already holds. It never ticks, never advances a
## batch, never routes transport and never shows a machine the server did not
## report: every label is copied from the snapshot, so an empty or disconnected
## state shows no live activity.
##
## Optional local art is loaded from the ignored `res://local_assets/` pack when a
## piece exists there. Otherwise the view draws independently authored geometric
## placeholders, so the public project and its headless checks run without any
## licensed file. Pack archives, previews and images are never read here.

## Emitted when the player picks a production line in the view. The main scene
## mirrors that choice into the existing line list, so pause/resume/priority keep
## using the existing handlers.
signal line_selected(line_id: String)

const KIND_ORE_SOURCE := "ore_source"
const KIND_FURNACE := "furnace"
const KIND_FLOOR := "floor"

## States this view can draw. Line states come from the protocol; the ore source
## is a stockpile, not a machine, so it has its own static state.
const STATE_SOURCE := "SOURCE"
const STATE_UNKNOWN := "UNKNOWN"
const LINE_STATES := ["IDLE", "RUNNING", "PAUSED", "NO_ENERGY"]

## Known local pack filenames. These are the only licensed paths this view knows,
## and they are resolved at runtime with `ResourceLoader.exists`, never shipped.
const LOCAL_ASSET_PATHS := {
	"ore_source": "res://local_assets/mythryl/factory/32px/godot/pieces/mining/burner-drill.tscn",
	"furnace": "res://local_assets/mythryl/factory/32px/godot/pieces/smelting/stone-furnace.tscn",
	"floor": "res://local_assets/mythryl/factory/32px/godot/pieces/floors/concrete.tscn",
}

const ORE_ITEM_ID := "RAW_ORE"
const NO_DATA_TEXT := "No server snapshot: nothing is running here yet."
const FALLBACK_NOTE := "Local art pack not installed: geometric placeholders stand in."
const ASSET_NOTE := "Local art pack pieces are loaded for this view."
const CAPTION_TEXT := "Isometric production view (server snapshots only)"

const TILE_HALF_WIDTH := 44.0
const TILE_HALF_HEIGHT := 22.0
const SLOT_PITCH := 140.0
const SLOT_ORIGIN := Vector2(88.0, 96.0)
const BADGE_HEIGHT := 20.0
const BADGE_WIDTH := 132.0
const ROW_HEIGHT := 58.0
const ANIMATION_SPEED := 5.0
const PULSE_FLOOR := 0.72


var _initialized: bool = false
var _snapshot: FactorySnapshot
var _slots: Array[Dictionary] = []
var _selected_line_id: String = ""
var _pulse_phase: float = 0.0
var _layer: Node2D
var _placeholder: Label
var _asset_note: Label

## Piece scenes keyed by asset kind. A registered scene replaces the filesystem
## lookup for that kind, so the loaded-piece branch can run without any licensed
## file on disk. The local pack itself is only ever reached through
## `ResourceLoader`, never inspected here.
var piece_scenes: Dictionary = {}


## Builds the frame and the empty layer. Idempotent so a scene instance and a
## headless check can both call it.
func setup() -> void:
	if _initialized:
		return
	_initialized = true
	custom_minimum_size = Vector2(640.0, 230.0)
	clip_contents = true

	var backdrop := ColorRect.new()
	backdrop.name = "Backdrop"
	backdrop.color = Color(0.09, 0.10, 0.13, 1.0)
	backdrop.mouse_filter = Control.MOUSE_FILTER_IGNORE
	backdrop.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(backdrop)

	_layer = Node2D.new()
	_layer.name = "IsometricLayer"
	_layer.position = SLOT_ORIGIN
	_layer.visible = false
	add_child(_layer)

	var caption := Label.new()
	caption.name = "Caption"
	caption.text = CAPTION_TEXT
	caption.position = Vector2(12.0, 6.0)
	caption.add_theme_font_size_override("font_size", 12)
	caption.add_theme_color_override("font_color", Color(0.68, 0.72, 0.78, 1.0))
	add_child(caption)

	_placeholder = Label.new()
	_placeholder.name = "Placeholder"
	_placeholder.text = NO_DATA_TEXT
	_placeholder.position = Vector2(14.0, 74.0)
	_placeholder.size = Vector2(560.0, 60.0)
	_placeholder.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_placeholder.add_theme_font_size_override("font_size", 13)
	_placeholder.add_theme_color_override("font_color", Color(0.74, 0.77, 0.82, 1.0))
	add_child(_placeholder)

	_asset_note = Label.new()
	_asset_note.name = "AssetNote"
	_asset_note.position = Vector2(12.0, 206.0)
	_asset_note.size = Vector2(600.0, 18.0)
	_asset_note.add_theme_font_size_override("font_size", 11)
	_asset_note.add_theme_color_override("font_color", Color(0.58, 0.62, 0.68, 1.0))
	add_child(_asset_note)

	set_process(false)
	_refresh_asset_note()


func is_setup() -> bool:
	return _initialized


## Registers a piece scene for one asset kind. Passing `null` removes it again.
func set_piece_scene(kind: String, scene: PackedScene) -> void:
	if scene == null:
		piece_scenes.erase(kind)
		return
	piece_scenes[kind] = scene


## Colour per state. The four line states must stay visually distinct so a
## stopped line never looks like a running one.
static func state_color(state: String) -> Color:
	match state:
		"RUNNING":
			return Color(0.36, 0.78, 0.46)
		"IDLE":
			return Color(0.55, 0.59, 0.66)
		"PAUSED":
			return Color(0.88, 0.72, 0.34)
		"NO_ENERGY":
			return Color(0.86, 0.38, 0.36)
		STATE_SOURCE:
			return Color(0.42, 0.58, 0.86)
		_:
			return Color(0.42, 0.45, 0.52)


## True only when the optional local pack provides the piece for `kind`.
static func uses_local_assets(kind: String) -> bool:
	if not LOCAL_ASSET_PATHS.has(kind):
		return false
	var path := String(LOCAL_ASSET_PATHS[kind])
	if path.is_empty():
		return false
	return ResourceLoader.exists(path)


## Projects the last server snapshot. `null` means "no data": every tile is
## removed so no disconnected or empty state can look alive.
func apply_snapshot(snapshot: FactorySnapshot) -> void:
	setup()
	_snapshot = snapshot
	_clear_slots()
	if snapshot == null:
		_pulse_phase = 0.0
		_selected_line_id = ""
		_layer.visible = false
		_placeholder.visible = true
		_placeholder.text = NO_DATA_TEXT
		set_process(false)
		_refresh_asset_note()
		return

	_layer.visible = true
	_placeholder.visible = false
	_placeholder.text = ""
	_build_ore_source_slot(snapshot)
	var rows := FactoryViewModel.line_rows(snapshot)
	for index in snapshot.lines.size():
		var line: Dictionary = snapshot.lines[index]
		var line_id := String(line.get("lineId", ""))
		var badge := String(rows[index]) if index < rows.size() else line_id
		var produced := int(line.get("totalBatchesProduced", 0))
		if produced > 0:
			badge += " | produced %d" % produced
		_add_slot(
			"line",
			line_id,
			String(line.get("status", STATE_UNKNOWN)),
			badge,
			_line_asset_kind(line)
		)
	if not _selected_line_id.is_empty() and _slot_by_id(_selected_line_id).is_empty():
		_selected_line_id = ""
	_apply_selection_visuals()
	_refresh_asset_note()
	_refresh_animation_processing()


## Selects one reported line. Returns false and keeps the previous choice when
## the line is not in the current snapshot. An empty id clears the highlight
## without emitting a player selection.
func select_line(line_id: String) -> bool:
	setup()
	if line_id.is_empty():
		_selected_line_id = ""
		_apply_selection_visuals()
		return true
	var slot := _slot_by_id(line_id)
	if slot.is_empty() or String(slot["kind"]) != "line":
		return false
	_selected_line_id = line_id
	_apply_selection_visuals()
	line_selected.emit(line_id)
	return true


func get_selected_line_id() -> String:
	return _selected_line_id


## Flat, node-free description of what is currently drawn. Checks use this
## instead of reading a rendered image.
func slot_summary() -> Array:
	var summary: Array = []
	for slot in _slots:
		var slot_id := String(slot["id"])
		var sprite_states := {}
		for sprite in slot["sprites"]:
			sprite_states[String(sprite.name)] = (sprite as AnimatedSprite2D).is_playing()
		summary.append({
			"kind": String(slot["kind"]),
			"id": slot_id,
			"state": String(slot["state"]),
			"badge": String(slot["badge"]),
			"tint": slot["tint"],
			"asset_kind": String(slot["asset_kind"]),
			"animating": bool(slot["animating"]),
			"piece_loaded": bool(slot["piece_loaded"]),
			"sprite_playing": _any_sprite_playing(slot),
			"sprite_states": sprite_states,
			"using_fallback": bool(slot["using_fallback"]),
			"selected": String(slot["kind"]) == "line" and slot_id == _selected_line_id,
		})
	return summary


func slot_origins() -> PackedVector2Array:
	var origins := PackedVector2Array()
	for slot in _slots:
		origins.append((slot["root"] as Node2D).position)
	return origins


## Ids of the tiles whose state animates. Only a RUNNING line animates; PAUSED,
## NO_ENERGY and IDLE stay still so the view never implies progress the server
## did not report.
func animating_slot_ids() -> PackedStringArray:
	var ids := PackedStringArray()
	for slot in _slots:
		if bool(slot["animating"]):
			ids.append(String(slot["id"]))
	return ids


func is_placeholder_visible() -> bool:
	return _placeholder != null and _placeholder.visible


func placeholder_text() -> String:
	return _placeholder.text if _placeholder != null else ""


func asset_note_text() -> String:
	return _asset_note.text if _asset_note != null else ""


## Advances only the decorative pulse of running tiles. It touches no label and
## no snapshot value, so it can never age the server state.
func advance_activity_animation(delta: float) -> void:
	if _snapshot == null or _slots.is_empty():
		return
	if animating_slot_ids().is_empty():
		_reset_piece_modulation()
		return
	_pulse_phase = fmod(_pulse_phase + delta * ANIMATION_SPEED, TAU)
	var level := PULSE_FLOOR + (1.0 - PULSE_FLOOR) * (0.5 + 0.5 * sin(_pulse_phase))
	for slot in _slots:
		if not bool(slot["animating"]):
			continue
		var piece: Node = slot["piece"]
		if piece is CanvasItem:
			(piece as CanvasItem).modulate = Color(level, level, level, 1.0)


func _process(delta: float) -> void:
	advance_activity_animation(delta)


func _gui_input(event: InputEvent) -> void:
	if not (event is InputEventMouseButton):
		return
	var mouse := event as InputEventMouseButton
	if not mouse.pressed or mouse.button_index != MOUSE_BUTTON_LEFT:
		return
	var picked := _slot_at_layer_point(mouse.position - _layer.position)
	if picked.is_empty():
		return
	if String(picked["kind"]) != "line":
		return
	select_line(String(picked["id"]))
	accept_event()


func _build_ore_source_slot(snapshot: FactorySnapshot) -> void:
	var badge := "Ore source: %s not reported" % ORE_ITEM_ID
	if snapshot.inventory.has(ORE_ITEM_ID):
		badge = "Ore source: %s %s available" % [
			ORE_ITEM_ID, FactoryViewModel.format_integer(snapshot.inventory_available(ORE_ITEM_ID))
		]
	_add_slot("ore_source", ORE_ITEM_ID, STATE_SOURCE, badge, KIND_ORE_SOURCE)


## R1 runs in the furnace the packs model; a line without a recipe only shows the
## floor tile it stands on.
func _line_asset_kind(line: Dictionary) -> String:
	var recipe_id := String(line.get("currentRecipeId", ""))
	var active: Variant = line.get("activeBatch", {})
	if typeof(active) == TYPE_DICTIONARY and not (active as Dictionary).is_empty():
		var active_recipe := String((active as Dictionary).get("recipeId", recipe_id))
		if not active_recipe.is_empty():
			recipe_id = active_recipe
	if recipe_id == FactoryProtocol.PRODUCTION_RECIPE_ID:
		return KIND_FURNACE
	return KIND_FLOOR


func _add_slot(kind: String, id: String, state: String, badge: String, asset_kind: String) -> void:
	var tint := state_color(state)
	var slot_root := Node2D.new()
	slot_root.name = "Slot%d" % _slots.size()
	slot_root.position = Vector2(float(_slots.size()) * SLOT_PITCH, 0.0)
	_layer.add_child(slot_root)

	var tile_fallback := _add_tile(slot_root, tint)
	var piece := _instantiate_local_piece(asset_kind)
	var piece_fallback := piece == null
	if piece == null:
		piece = _make_fallback_piece(asset_kind, tint)
	piece.name = "Piece"
	slot_root.add_child(piece)

	var body_sprites := _piece_sprites(piece)
	_apply_piece_playback(body_sprites, state)

	var badge_label := _make_label(badge, tint, ROW_HEIGHT)
	badge_label.name = "Row"
	badge_label.position = Vector2(-BADGE_WIDTH * 0.5, TILE_HALF_HEIGHT + 8.0)
	slot_root.add_child(badge_label)

	var state_label := _make_label(state, tint, BADGE_HEIGHT)
	state_label.name = "State"
	state_label.position = Vector2(-BADGE_WIDTH * 0.5, -TILE_HALF_HEIGHT - BADGE_HEIGHT - 26.0)
	slot_root.add_child(state_label)

	var ring := Line2D.new()
	ring.name = "SelectionRing"
	ring.points = _closed_diamond(TILE_HALF_WIDTH + 3.0, TILE_HALF_HEIGHT + 3.0)
	ring.width = 2.5
	ring.default_color = Color(0.96, 0.97, 0.99, 0.95)
	ring.visible = false
	slot_root.add_child(ring)

	_slots.append({
		"kind": kind,
		"id": id,
		"state": state,
		"badge": badge,
		"tint": tint,
		"asset_kind": asset_kind,
		"animating": state == "RUNNING",
		"piece_loaded": not piece_fallback,
		"using_fallback": tile_fallback or piece_fallback,
		"root": slot_root,
		"piece": piece,
		"sprites": body_sprites,
		"badge_label": badge_label,
		"state_label": state_label,
		"ring": ring,
	})


## Returns true when the geometric floor diamond stands in for the pack tile.
func _add_tile(slot_root: Node2D, tint: Color) -> bool:
	var local_floor := _instantiate_local_piece(KIND_FLOOR)
	if local_floor != null:
		local_floor.name = "Tile"
		slot_root.add_child(local_floor)
		return false
	var diamond := Polygon2D.new()
	diamond.name = "TileFallback"
	diamond.polygon = _diamond_points(TILE_HALF_WIDTH, TILE_HALF_HEIGHT)
	diamond.color = tint.darkened(0.55)
	slot_root.add_child(diamond)
	return true


## Loads a registered or packed piece scene. The lookup is guarded so a missing
## pack is an ordinary state, not an error.
func _instantiate_local_piece(kind: String) -> Node2D:
	var scene: PackedScene = null
	if piece_scenes.has(kind):
		scene = piece_scenes[kind] as PackedScene
	elif uses_local_assets(kind):
		var resource := ResourceLoader.load(String(LOCAL_ASSET_PATHS[kind]))
		if resource is PackedScene:
			scene = resource as PackedScene
	if scene == null:
		return null
	var instance := scene.instantiate()
	if instance is Node2D:
		return instance as Node2D
	if instance != null:
		instance.free()
	return null


## Independently authored placeholder so the view works without licensed art.
func _make_fallback_piece(asset_kind: String, tint: Color) -> Node2D:
	var piece := Node2D.new()
	if asset_kind == KIND_FURNACE:
		var body := Polygon2D.new()
		body.name = "BlockFallback"
		body.polygon = _block_points(18.0, 30.0)
		body.color = tint
		piece.add_child(body)
		var mouth := Polygon2D.new()
		mouth.name = "MouthFallback"
		mouth.polygon = _diamond_points(7.0, 4.0)
		mouth.position = Vector2(0.0, -12.0)
		mouth.color = tint.lightened(0.45)
		piece.add_child(mouth)
	elif asset_kind == KIND_ORE_SOURCE:
		var mound := Polygon2D.new()
		mound.name = "MoundFallback"
		mound.polygon = _block_points(16.0, 20.0)
		mound.color = tint.darkened(0.15)
		piece.add_child(mound)
		var spark := Polygon2D.new()
		spark.name = "SparkFallback"
		spark.polygon = _diamond_points(6.0, 3.0)
		spark.position = Vector2(0.0, -22.0)
		spark.color = tint.lightened(0.5)
		piece.add_child(spark)
	else:
		# A bare floor tile carries no machine, so it draws no volume at all.
		var pad := Polygon2D.new()
		pad.name = "PadFallback"
		pad.polygon = _diamond_points(TILE_HALF_WIDTH * 0.6, TILE_HALF_HEIGHT * 0.6)
		pad.color = tint.darkened(0.2)
		piece.add_child(pad)
	piece.position = Vector2(0.0, 0.0)
	return piece


## Every AnimatedSprite2D inside a loaded piece. Packs ship `Body` and `Shadow`
## sprites, and both must follow the authoritative state, so this does not assume
## a single child name.
func _piece_sprites(piece: Node) -> Array:
	var sprites: Array = []
	for child in piece.find_children("*", "AnimatedSprite2D", true, false):
		sprites.append(child as AnimatedSprite2D)
	return sprites


func _any_sprite_playing(slot: Dictionary) -> bool:
	for sprite in slot["sprites"]:
		if (sprite as AnimatedSprite2D).is_playing():
			return true
	return false


## Applies playback through the AnimatedSprite2D API. `play()` drives a RUNNING
## line, `pause()` freezes a line whose work stopped mid-batch (PAUSED,
## NO_ENERGY) and `stop()` returns an IDLE line to its rest frame. Only toggles the
## frame set the piece already assigns: no animation name is invented, no frame
## is advanced by this view and the snapshot is never touched.
func _apply_piece_playback(sprites: Array, state: String) -> void:
	for entry in sprites:
		var sprite := entry as AnimatedSprite2D
		if not _sprite_has_frames(sprite):
			continue
		match state:
			"RUNNING":
				sprite.play()
			"PAUSED", "NO_ENERGY":
				sprite.pause()
			_:
				sprite.stop()


func _sprite_has_frames(sprite: AnimatedSprite2D) -> bool:
	if sprite == null or sprite.sprite_frames == null:
		return false
	return sprite.sprite_frames.has_animation(sprite.animation)


func _make_label(text: String, tint: Color, height: float) -> Label:
	var label := Label.new()
	label.text = text
	label.size = Vector2(BADGE_WIDTH, height)
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 11)
	label.add_theme_color_override("font_color", tint)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return label


func _apply_selection_visuals() -> void:
	for slot in _slots:
		var ring: Line2D = slot["ring"]
		ring.visible = String(slot["kind"]) == "line" and String(slot["id"]) == _selected_line_id


func _refresh_animation_processing() -> void:
	set_process(not animating_slot_ids().is_empty())


func _reset_piece_modulation() -> void:
	for slot in _slots:
		var piece: Node = slot["piece"]
		if piece is CanvasItem:
			(piece as CanvasItem).modulate = Color(1, 1, 1, 1)


func _refresh_asset_note() -> void:
	if _asset_note == null:
		return
	var missing := false
	for kind in [KIND_ORE_SOURCE, KIND_FURNACE, KIND_FLOOR]:
		if not uses_local_assets(String(kind)):
			missing = true
	_asset_note.text = FALLBACK_NOTE if missing else ASSET_NOTE


func _slot_by_id(line_id: String) -> Dictionary:
	for slot in _slots:
		if String(slot["kind"]) != "line":
			continue
		if String(slot["id"]) == line_id:
			return slot
	return {}


func _slot_at_layer_point(point: Vector2) -> Dictionary:
	for slot in _slots:
		var origin: Vector2 = (slot["root"] as Node2D).position
		if absf(point.x - origin.x) <= TILE_HALF_WIDTH and absf(point.y - origin.y) <= TILE_HALF_HEIGHT:
			return slot
	return {}


func _clear_slots() -> void:
	for slot in _slots:
		var slot_root: Node = slot["root"]
		_layer.remove_child(slot_root)
		slot_root.free()
	_slots.clear()


func _diamond_points(half_width: float, half_height: float) -> PackedVector2Array:
	return PackedVector2Array([
		Vector2(0.0, -half_height),
		Vector2(half_width, 0.0),
		Vector2(0.0, half_height),
		Vector2(-half_width, 0.0),
	])


func _closed_diamond(half_width: float, half_height: float) -> PackedVector2Array:
	var points := _diamond_points(half_width, half_height)
	points.append(points[0])
	return points


## Small isometric prism: top diamond plus two visible side faces.
func _block_points(half_width: float, height: float) -> PackedVector2Array:
	var top := _diamond_points(half_width, half_width * 0.5)
	var left := top[3]
	var bottom := top[2]
	var right := top[1]
	return PackedVector2Array([
		left,
		top[0],
		right,
		Vector2(right.x, right.y + height),
		Vector2(bottom.x, bottom.y + height),
		Vector2(left.x, left.y + height),
	])
