extends SceneTree
## Observable rules for the isometric production view.
##
## The view is a renderer of the last server snapshot: it never ticks, never
## advances a batch and never invents a machine the server did not report. These
## checks pin the projection (ore source + one tile per line), the authoritative
## state labels, the RUNNING-versus-stopped animation rule, the line identity and
## selection signal, the geometric fallback used when the optional local art pack
## is not installed, and the sprite playback of a loaded piece scene through a
## generated in-memory fixture that needs no licensed file.

const TestSupport = preload("res://tests/test_support.gd")
const IsometricView = preload("res://scripts/view/factory_isometric_view.gd")
const VIEW_SCENE_PATH := "res://scenes/factory_isometric_view.tscn"

var _started: bool = false


func _process(_delta: float) -> bool:
	if _started:
		return true
	_started = true
	var t := TestSupport.new()
	_test_scene_boots_without_snapshot(t)
	_test_snapshot_projection(t)
	_test_four_line_states(t)
	_test_animation_never_advances_progress(t)
	_test_line_selection_identity(t)
	_test_local_asset_fallbacks(t)
	_test_loaded_piece_playback(t)
	quit(t.finish("test_isometric_view"))
	return true


func _view() -> Node:
	var scene: PackedScene = load(VIEW_SCENE_PATH)
	if scene == null:
		return null
	var view: Node = scene.instantiate()
	get_root().add_child(view)
	view.setup()
	return view


func _drop(view: Node) -> void:
	if view == null:
		return
	get_root().remove_child(view)
	view.free()


func _parse_snapshot(t: TestSupport, data: Dictionary, label: String) -> FactorySnapshot:
	var parsed: Dictionary = FactoryProtocol.parse_state(JSON.stringify(data))
	if not t.check(bool(parsed["ok"]), "%s parses: %s" % [label, String(parsed.get("error", ""))]):
		return null
	return parsed["snapshot"]


func _fixture_data(t: TestSupport, name: String) -> Dictionary:
	return JSON.parse_string(t.fixture(name))


## Packs a piece scene in memory with `Body` and `Shadow` AnimatedSprite2D nodes,
## so the loaded-piece branch runs even when no local art pack exists. The frames
## are built-in placeholder textures: no pack art is read, copied or derived.
func _make_sprite_piece_scene() -> PackedScene:
	var frames := SpriteFrames.new()
	frames.add_animation(&"turn_0")
	frames.set_animation_speed(&"turn_0", 10.0)
	frames.set_animation_loop(&"turn_0", true)
	for _index in 2:
		var placeholder := PlaceholderTexture2D.new()
		placeholder.size = Vector2(32, 32)
		frames.add_frame(&"turn_0", placeholder)

	var root := Node2D.new()
	root.name = "GeneratedPiece"
	for sprite_name in ["Body", "Shadow"]:
		var sprite := AnimatedSprite2D.new()
		sprite.name = sprite_name
		sprite.sprite_frames = frames
		sprite.animation = &"turn_0"
		root.add_child(sprite)
		sprite.owner = root

	var scene := PackedScene.new()
	var packed := scene.pack(root)
	root.free()
	return scene if packed == OK else null


func _test_scene_boots_without_snapshot(t: TestSupport) -> void:
	var view := _view()
	if not t.check(view != null, "isometric view scene can be instantiated"):
		return
	t.check(view.is_setup(), "the view reports a completed setup")
	t.check(view.is_placeholder_visible(), "the view shows its no-data placeholder before any snapshot")
	t.contains(view.placeholder_text().to_lower(), "no server snapshot", "the placeholder explains why nothing is drawn")
	t.equal(view.slot_summary().size(), 0, "no tiles are invented before the first snapshot")
	t.equal(view.animating_slot_ids().size(), 0, "nothing animates before the first snapshot")
	var layer: Node = view.get_node_or_null("IsometricLayer")
	t.check(layer != null, "the view owns a dedicated isometric layer")
	if layer != null:
		t.check(not (layer as Node2D).visible, "the isometric layer stays hidden while there is no data")
	t.equal(view.get_selected_line_id(), "", "no line is selected before a snapshot")
	t.check(view.asset_note_text().length() > 0, "the view states whether local art is in use")
	_drop(view)


func _test_snapshot_projection(t: TestSupport) -> void:
	var view := _view()
	if not t.check(view != null, "isometric view scene can be instantiated for projection"):
		return
	var snapshot := _parse_snapshot(t, _fixture_data(t, "state_ok.json"), "projection fixture")
	if snapshot == null:
		_drop(view)
		return
	view.apply_snapshot(snapshot)

	t.check(not view.is_placeholder_visible(), "a real snapshot hides the no-data placeholder")
	var slots: Array = view.slot_summary()
	t.equal(slots.size(), snapshot.lines.size() + 1, "the view draws one ore-source tile plus one tile per server line")

	var ore: Dictionary = slots[0]
	t.equal(String(ore["kind"]), "ore_source", "the first tile is the ore source")
	t.equal(String(ore["state"]), IsometricView.STATE_SOURCE, "the ore source has its own non-machine state")
	t.contains(String(ore["badge"]), "RAW_ORE", "the ore tile names the item the server reports")
	t.contains(String(ore["badge"]), "200", "the ore tile shows the authoritative RAW_ORE stock")
	t.check(bool(ore["using_fallback"]) == (not IsometricView.uses_local_assets("ore_source")), "the ore tile reports its real art source")
	t.check(not bool(ore["animating"]), "the ore source never animates: the server reports no extractor run")

	for index in snapshot.lines.size():
		var slot: Dictionary = slots[index + 1]
		var line: Dictionary = snapshot.lines[index]
		t.equal(String(slot["kind"]), "line", "line %d tile is a production-line slot" % (index + 1))
		t.equal(String(slot["id"]), String(line["lineId"]), "tile identity matches server line %d" % (index + 1))
		t.equal(String(slot["state"]), String(line["status"]), "tile state matches server status for line %d" % (index + 1))
		t.contains(String(slot["badge"]), String(line["lineId"]), "the badge repeats the authoritative line id for line %d" % (index + 1))
		t.contains(String(slot["badge"]), String(line["status"]), "the badge repeats the authoritative status for line %d" % (index + 1))

	t.equal(String(slots[1]["asset_kind"]), IsometricView.KIND_FURNACE, "an R1 line renders the furnace piece slot")
	t.equal(String(slots[2]["asset_kind"]), IsometricView.KIND_FLOOR, "a line with no recipe renders a bare floor tile")
	t.contains(String(slots[1]["badge"]), "4/10", "the running tile badge shows the server progress it received")

	var origins: PackedVector2Array = view.slot_origins()
	t.equal(origins.size(), slots.size(), "every tile reports the position it was drawn at")
	var distinct := {}
	for origin in origins:
		distinct[str(origin)] = true
	t.equal(distinct.size(), slots.size(), "no two tiles are drawn on top of each other")

	t.equal(snapshot.tick, 42, "rendering never advances the server tick")
	t.equal(int(snapshot.lines[0]["activeBatch"]["progressTicks"]), 4, "rendering never advances server progress")
	t.equal(int(snapshot.lines[0]["totalBatchesProduced"]), 0, "rendering never invents a produced batch")

	var newer: Dictionary = JSON.parse_string(JSON.stringify(_fixture_data(t, "state_ok.json")))
	newer["tick"] = 43
	newer["company"]["lines"][0]["activeBatch"]["progressTicks"] = 5
	var newer_snapshot := _parse_snapshot(t, newer, "newer fixture")
	view.apply_snapshot(newer_snapshot)
	t.contains(String(view.slot_summary()[1]["badge"]), "5/10", "a newer snapshot replaces the visible progress instead of advancing it locally")
	_drop(view)


func _test_four_line_states(t: TestSupport) -> void:
	var view := _view()
	if not t.check(view != null, "isometric view scene can be instantiated for the state test"):
		return
	var data := _fixture_data(t, "state_ok.json")
	var lines: Array = data["company"]["lines"]
	lines[0]["status"] = "RUNNING"
	lines[1]["status"] = "PAUSED"
	lines[2]["status"] = "NO_ENERGY"
	var idle_line: Dictionary = JSON.parse_string(JSON.stringify(lines[1]))
	idle_line["lineId"] = "comp_metal_01_line_4"
	idle_line["status"] = "IDLE"
	idle_line["priority"] = 1
	lines.append(idle_line)
	var snapshot := _parse_snapshot(t, data, "four-state fixture")
	if snapshot == null:
		_drop(view)
		return
	view.apply_snapshot(snapshot)

	var by_state := {}
	var slots: Array = view.slot_summary()
	for index in range(1, slots.size()):
		by_state[String(slots[index]["state"])] = slots[index]
	for state in ["RUNNING", "IDLE", "PAUSED", "NO_ENERGY"]:
		t.check(by_state.has(state), "the snapshot line state %s gets its own tile" % state)

	t.check(bool(by_state["RUNNING"]["animating"]), "only RUNNING animates production activity")
	t.check(not bool(by_state["IDLE"]["animating"]), "IDLE does not animate production activity")
	t.check(not bool(by_state["PAUSED"]["animating"]), "PAUSED does not animate production activity")
	t.check(not bool(by_state["NO_ENERGY"]["animating"]), "NO_ENERGY does not animate production activity")
	t.equal(view.animating_slot_ids().size(), 1, "exactly the running tile is animated")
	t.equal(view.animating_slot_ids()[0], String(by_state["RUNNING"]["id"]), "animation is bound to the running server line id")

	var seen_tints := {}
	for state in ["RUNNING", "IDLE", "PAUSED", "NO_ENERGY"]:
		var tint: Color = by_state[state]["tint"]
		t.equal(tint, IsometricView.state_color(state), "%s tile uses the documented state tint" % state)
		seen_tints[tint.to_html()] = true
	t.equal(seen_tints.size(), 4, "all four line states are visually distinct")

	t.check(view.is_processing(), "animation processing is enabled while a line runs")
	_drop(view)


func _test_animation_never_advances_progress(t: TestSupport) -> void:
	var view := _view()
	if not t.check(view != null, "isometric view scene can be instantiated for the animation test"):
		return
	var snapshot := _parse_snapshot(t, _fixture_data(t, "state_ok.json"), "animation fixture")
	if snapshot == null:
		_drop(view)
		return
	view.apply_snapshot(snapshot)
	var badge_before := String(view.slot_summary()[1]["badge"])
	for _frame in 5:
		view.advance_activity_animation(0.2)
	t.equal(snapshot.tick, 42, "animation frames never advance the server tick")
	t.equal(int(snapshot.lines[0]["activeBatch"]["progressTicks"]), 4, "animation frames never advance server progress")
	t.equal(String(view.slot_summary()[1]["badge"]), badge_before, "animation frames never rewrite the authoritative badge")

	var stopped: Dictionary = JSON.parse_string(JSON.stringify(_fixture_data(t, "state_ok.json")))
	for line in stopped["company"]["lines"]:
		line["status"] = "IDLE"
		line["activeBatch"] = null
		line["currentRecipeId"] = null
	var stopped_snapshot := _parse_snapshot(t, stopped, "stopped fixture")
	view.apply_snapshot(stopped_snapshot)
	t.equal(view.animating_slot_ids().size(), 0, "a fully stopped factory animates nothing")
	t.check(not view.is_processing(), "no animation processing runs while every line is stopped")
	var stopped_badge := String(view.slot_summary()[1]["badge"])
	for _frame in 5:
		view.advance_activity_animation(0.2)
	t.equal(String(view.slot_summary()[1]["badge"]), stopped_badge, "advancing a stopped view changes no label")
	_drop(view)


func _test_line_selection_identity(t: TestSupport) -> void:
	var view := _view()
	if not t.check(view != null, "isometric view scene can be instantiated for the selection test"):
		return
	var snapshot := _parse_snapshot(t, _fixture_data(t, "state_ok.json"), "selection fixture")
	if snapshot == null:
		_drop(view)
		return
	view.apply_snapshot(snapshot)

	var emitted: Array[String] = []
	view.line_selected.connect(func(line_id: String) -> void: emitted.append(line_id))
	t.equal(view.get_selected_line_id(), "", "no line is highlighted until the player chooses one")
	t.check(view.select_line("comp_metal_01_line_2"), "selecting a line the server reported succeeds")
	t.equal(view.get_selected_line_id(), "comp_metal_01_line_2", "the selection keeps the server line id")
	t.equal(emitted.size(), 1, "selecting a line emits exactly one selection signal")
	t.equal(emitted[0], "comp_metal_01_line_2", "the selection signal carries the server line id")

	var slots: Array = view.slot_summary()
	var highlighted := 0
	for slot in slots:
		if bool(slot["selected"]):
			highlighted += 1
	t.equal(highlighted, 1, "exactly one tile is highlighted")
	t.check(bool(slots[2]["selected"]), "the selected tile is highlighted")
	t.check(not bool(slots[1]["selected"]), "unselected tiles stay unhighlighted")
	t.check(not bool(slots[0]["selected"]), "the ore source is never highlighted as a line")

	t.check(not view.select_line("comp_metal_01_line_9"), "an unknown line id is refused")
	t.equal(view.get_selected_line_id(), "comp_metal_01_line_2", "a refused selection keeps the previous line")
	t.equal(emitted.size(), 1, "a refused selection emits nothing")

	view.apply_snapshot(snapshot)
	t.equal(view.get_selected_line_id(), "comp_metal_01_line_2", "re-applying a snapshot keeps a still-present selection")

	var dropped_data := _fixture_data(t, "state_ok.json")
	var dropped_lines: Array = dropped_data["company"]["lines"]
	dropped_lines.remove_at(1)
	var dropped_snapshot := _parse_snapshot(t, dropped_data, "line-removed fixture")
	view.apply_snapshot(dropped_snapshot)
	t.equal(view.get_selected_line_id(), "", "a selection for a line the server dropped is cleared")
	t.equal(emitted.size(), 1, "dropping a selected line emits no player selection")

	t.check(view.select_line(""), "clearing the selection is allowed")
	t.equal(view.get_selected_line_id(), "", "clearing removes the highlight")
	t.equal(emitted.size(), 1, "clearing the selection emits no player selection")

	view.apply_snapshot(null)
	t.check(view.is_placeholder_visible(), "a null snapshot returns to the no-data state")
	t.equal(view.slot_summary().size(), 0, "a null snapshot removes every tile")
	t.equal(view.animating_slot_ids().size(), 0, "a null snapshot stops all animation")
	_drop(view)


func _test_local_asset_fallbacks(t: TestSupport) -> void:
	var view := _view()
	if not t.check(view != null, "isometric view scene can be instantiated for the fallback test"):
		return
	t.check(not IsometricView.uses_local_assets("unknown_kind"), "an unknown asset kind is never looked up")

	var floor_available: bool = IsometricView.uses_local_assets(IsometricView.KIND_FLOOR)
	var ore_available: bool = IsometricView.uses_local_assets(IsometricView.KIND_ORE_SOURCE)
	var furnace_available: bool = IsometricView.uses_local_assets(IsometricView.KIND_FURNACE)

	var snapshot := _parse_snapshot(t, _fixture_data(t, "state_ok.json"), "fallback fixture")
	if snapshot == null:
		_drop(view)
		return
	view.apply_snapshot(snapshot)
	var slots: Array = view.slot_summary()
	t.equal(slots.size(), 4, "the view stays complete without licensed assets")

	for slot in slots:
		var asset_kind := String(slot["asset_kind"])
		var piece_available: bool = IsometricView.uses_local_assets(asset_kind)
		var expected_fallback: bool = not (floor_available and piece_available)
		if asset_kind == IsometricView.KIND_FLOOR:
			expected_fallback = not floor_available
		t.equal(bool(slot["using_fallback"]), expected_fallback, "the %s tile fallback matches the local pack state" % asset_kind)
		if not bool(slot["piece_loaded"]):
			t.check(not bool(slot["sprite_playing"]), "a geometric fallback never reports sprite playback")
		# Whatever a real pack ships, the playback this view applied must match the
		# authoritative state. This is the branch that failed while it was untested.
		var expected_playing := String(slot["state"]) == "RUNNING"
		var sprite_states: Dictionary = slot["sprite_states"]
		for sprite_name in sprite_states:
			t.equal(
				bool(sprite_states[sprite_name]),
				expected_playing,
				"the loaded %s sprite playback follows the authoritative state" % String(sprite_name)
			)

	t.contains(String(slots[0]["badge"]), "RAW_ORE", "fallback tiles keep the authoritative ore label")
	t.contains(String(slots[1]["badge"]), "RUNNING", "fallback tiles keep the authoritative state label")

	if floor_available and ore_available and furnace_available:
		t.equal(view.asset_note_text(), IsometricView.ASSET_NOTE, "the view reports that the local pack is in use")
	else:
		t.equal(view.asset_note_text(), IsometricView.FALLBACK_NOTE, "the view tells the player the local pack is not installed")
	_drop(view)


## The loaded-piece branch must work without any licensed file. A generated piece
## scene is registered for the furnace kind, then the normal snapshot renderer has
## to drive both of its AnimatedSprite2D children from the authoritative state.
func _test_loaded_piece_playback(t: TestSupport) -> void:
	var view := _view()
	if not t.check(view != null, "isometric view scene can be instantiated for the loaded-piece test"):
		return
	var fixture := _make_sprite_piece_scene()
	if not t.check(fixture != null, "a generated sprite piece packs into a scene"):
		_drop(view)
		return
	view.set_piece_scene(IsometricView.KIND_FURNACE, fixture)

	for state in ["RUNNING", "PAUSED", "NO_ENERGY", "IDLE"]:
		var data := _fixture_data(t, "state_ok.json")
		var line: Dictionary = data["company"]["lines"][0]
		line["status"] = state
		if state == "IDLE":
			line["activeBatch"] = null
		var snapshot := _parse_snapshot(t, data, "%s loaded-piece fixture" % state)
		if snapshot == null:
			continue
		view.apply_snapshot(snapshot)
		var slot: Dictionary = view.slot_summary()[1]
		t.equal(String(slot["asset_kind"]), IsometricView.KIND_FURNACE, "%s: the R1 line still resolves the furnace piece" % state)
		t.check(bool(slot["piece_loaded"]), "%s: the generated piece scene replaces the geometric placeholder" % state)
		var sprites: Dictionary = slot["sprite_states"]
		if not t.equal(sprites.size(), 2, "%s: both Body and Shadow sprites are introspected" % state):
			continue
		var expected_playing: bool = state == "RUNNING"
		t.equal(bool(sprites.get("Body", not expected_playing)), expected_playing, "%s: Body playback follows the authoritative state" % state)
		t.equal(bool(sprites.get("Shadow", not expected_playing)), expected_playing, "%s: Shadow playback follows the authoritative state" % state)
		t.equal(bool(slot["sprite_playing"]), expected_playing, "%s: the slot reports the real sprite playback" % state)
		t.equal(snapshot.tick, 42, "%s: loaded-piece playback never advances the server tick" % state)
		var progress := 0
		var active: Dictionary = snapshot.lines[0]["activeBatch"]
		if not active.is_empty():
			progress = int(active["progressTicks"])
		t.equal(progress, 4 if state != "IDLE" else 0, "%s: loaded-piece playback never advances server progress" % state)

	view.apply_snapshot(null)
	t.equal(view.slot_summary().size(), 0, "clearing the snapshot removes loaded pieces as well")
	t.check(view.is_placeholder_visible(), "clearing a loaded piece returns to the no-data state")
	_drop(view)
