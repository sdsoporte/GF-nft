extends SceneTree
## Observable rules for the projection of server snapshots into screen text.
## The view only re-formats numbers the server already produced.

const TestSupport = preload("res://tests/test_support.gd")


func _initialize() -> void:
	var t := TestSupport.new()
	var parsed: Dictionary = FactoryProtocol.parse_state(t.fixture("state_ok.json"))
	if not t.check(parsed["ok"], "fixture snapshot parses"):
		quit(t.finish("test_view_model"))
		return
	var snapshot: FactorySnapshot = parsed["snapshot"]
	_test_summary(t, snapshot)
	_test_inventory(t, snapshot)
	_test_lines(t, snapshot)
	_test_recipes(t, snapshot)
	_test_action_state(t, snapshot)
	_test_affordability(t)
	_test_paused_and_no_energy_progress(t)
	_test_energy_guide(t, snapshot)
	quit(t.finish("test_view_model"))


func _test_summary(t: TestSupport, snapshot: FactorySnapshot) -> void:
	t.equal(FactoryViewModel.match_text(snapshot), "Match match_fixture_0001", "match text shows the server match")
	t.equal(FactoryViewModel.tick_text(snapshot), "Tick 42 (1000 ms)", "tick text shows tick and server interval")
	t.equal(FactoryViewModel.credits_text(snapshot), "Credits 10,000", "credits text groups digits")
	t.equal(FactoryViewModel.energy_text(snapshot), "Energy 400 / 1,000", "energy text shows current and capacity")
	t.equal(FactoryViewModel.format_integer(0), "0", "zero formats without separators")
	t.equal(FactoryViewModel.format_integer(999), "999", "three digits format without separators")
	t.equal(FactoryViewModel.format_integer(1000), "1,000", "four digits get one separator")
	t.equal(FactoryViewModel.format_integer(1234567), "1,234,567", "large numbers get grouped separators")


func _test_inventory(t: TestSupport, snapshot: FactorySnapshot) -> void:
	var rows: PackedStringArray = FactoryViewModel.inventory_rows(snapshot)
	t.equal(rows.size(), 9, "every inventory item is rendered")
	t.equal(rows[0], "RAW_ORE: 200", "available stock is rendered")
	t.equal(rows[1], "IRON_INGOT: 12 (5 reserved)", "reserved stock is rendered separately")
	t.equal(rows[2], "STEEL_PLATE: 0", "empty stock is rendered as zero")


func _test_lines(t: TestSupport, snapshot: FactorySnapshot) -> void:
	var rows: PackedStringArray = FactoryViewModel.line_rows(snapshot)
	t.equal(rows.size(), 3, "every production line is rendered")
	t.equal(
		rows[0],
		"comp_metal_01_line_1: RUNNING R1 4/10 ticks (batch 1/1)",
		"running line shows server progress"
	)
	t.equal(rows[1], "comp_metal_01_line_2: IDLE (priority 2)", "idle line shows status and priority")
	t.equal(rows[2], "comp_metal_01_line_3: IDLE (priority 3)", "third line shows status and priority")


func _test_recipes(t: TestSupport, snapshot: FactorySnapshot) -> void:
	var rows: PackedStringArray = FactoryViewModel.recipe_rows(snapshot)
	t.equal(rows.size(), 1, "offered recipes are rendered")
	t.equal(
		rows[0],
		"R1: Lingote de Hierro (IRON_INGOT) -> 5 IRON_INGOT | 10 ticks | 20 energy | input 10 RAW_ORE",
		"recipe row shows catalog values from the server"
	)


func _test_action_state(t: TestSupport, snapshot: FactorySnapshot) -> void:
	var action: Dictionary = FactoryViewModel.action_state(snapshot)
	t.check(action["can_start"], "an idle line makes the R1 action available")
	t.equal(String(action["recipe_id"]), "R1", "action targets R1")
	t.equal(String(action["line_id"]), "comp_metal_01_line_2", "action prefers the first idle line")
	t.equal(String(action["reason"]), "", "no advisory when inputs look sufficient")

	var empty_view: Dictionary = FactoryViewModel.action_state(null)
	t.check(not empty_view["can_start"], "no snapshot means no action")
	t.check(String(empty_view["reason"]).length() > 0, "missing snapshot explains why")

	var no_recipe: Dictionary = FactoryProtocol.parse_state(
		FileAccess.get_file_as_string("res://tests/fixtures/state_no_r1.json")
	)
	var no_recipe_action: Dictionary = FactoryViewModel.action_state(no_recipe["snapshot"])
	t.check(not no_recipe_action["can_start"], "a server without R1 disables the action")
	t.contains(String(no_recipe_action["reason"]).to_lower(), "r1", "disabled action explains the missing recipe")

	var no_lines: Dictionary = FactoryProtocol.parse_state(t.fixture("state_no_r1.json"))
	t.check(not FactoryViewModel.action_state(no_lines["snapshot"])["can_start"], "a server without lines disables the action")


func _test_affordability(t: TestSupport) -> void:
	var parsed: Dictionary = FactoryProtocol.parse_state(t.fixture("state_ok.json"))
	var snapshot: FactorySnapshot = parsed["snapshot"]
	snapshot.energy = 5
	snapshot.inventory["RAW_ORE"] = {"available": 2, "reserved": 0}
	var action: Dictionary = FactoryViewModel.action_state(snapshot)
	t.check(action["can_start"], "the action stays available; the server owns rejection")
	var reason := String(action["reason"])
	t.contains(reason, "energy", "advisory mentions insufficient energy")
	t.contains(reason, "RAW_ORE", "advisory mentions insufficient input stock")


func _test_paused_and_no_energy_progress(t: TestSupport) -> void:
	var parsed: Dictionary = FactoryProtocol.parse_state(t.fixture("state_ok.json"))
	var snapshot: FactorySnapshot = parsed["snapshot"]

	# Line in PAUSED with activeBatch must show progress ticks, duration, and batch count
	snapshot.lines[0]["status"] = "PAUSED"
	var rows: PackedStringArray = FactoryViewModel.line_rows(snapshot)
	t.equal(
		rows[0],
		"comp_metal_01_line_1: PAUSED R1 4/10 ticks (batch 1/1)",
		"paused line with active batch preserves visible progress"
	)

	# Line in NO_ENERGY with activeBatch must show progress ticks, duration, and batch count
	snapshot.lines[0]["status"] = "NO_ENERGY"
	rows = FactoryViewModel.line_rows(snapshot)
	t.equal(
		rows[0],
		"comp_metal_01_line_1: NO_ENERGY R1 4/10 ticks (batch 1/1)",
		"starved line with active batch preserves visible progress"
	)

	# Line in PAUSED without activeBatch shows status and priority
	snapshot.lines[0]["status"] = "PAUSED"
	snapshot.lines[0]["activeBatch"] = null
	rows = FactoryViewModel.line_rows(snapshot)
	t.equal(
		rows[0],
		"comp_metal_01_line_1: PAUSED (priority 1)",
		"paused line without active batch shows status and priority"
	)


func _test_energy_guide(t: TestSupport, snapshot: FactorySnapshot) -> void:
	# Guide for line with active batch (comp_metal_01_line_1 has energyPerTick 2)
	var active_guide: String = FactoryViewModel.energy_guide_text(snapshot, "comp_metal_01_line_1")
	t.contains(active_guide, "2", "guide shows energy demand per productive tick")
	t.contains(active_guide, "20", "guide shows total recipe energy cost")
	t.contains(active_guide.to_lower(), "uninterrupted", "guide disclaims uninterrupted progress")

	# Guide for idle line (comp_metal_01_line_2 uses recipe default duration/cost)
	var idle_guide: String = FactoryViewModel.energy_guide_text(snapshot, "comp_metal_01_line_2")
	t.contains(idle_guide, "2", "idle line uses recipe rate for per-tick demand")
	t.contains(idle_guide, "20", "idle line shows total recipe cost")
	t.contains(idle_guide.to_lower(), "uninterrupted", "idle line disclaims uninterrupted progress")
