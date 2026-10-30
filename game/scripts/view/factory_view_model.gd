class_name FactoryViewModel
extends RefCounted
## Pure projection from a server snapshot to the strings the screen shows.
##
## Everything here is derived from `FactorySnapshot` values the backend sent.
## No function invents progress, credits, energy or inventory.

const ITEM_ORDER := [
	"RAW_ORE",
	"IRON_INGOT",
	"STEEL_PLATE",
	"HEAVY_ALLOY",
	"MECH_FRAME",
	"CTRL_CIRCUIT",
	"POWER_MODULE",
	"IND_TURBINE",
	"MEGAMACHINE_PART",
]

const NO_SNAPSHOT_REASON := "No server snapshot yet; connect to the backend first."


static func match_text(snapshot: FactorySnapshot) -> String:
	if snapshot == null:
		return "Match: not connected"
	return "Match %s" % snapshot.match_id


static func tick_text(snapshot: FactorySnapshot) -> String:
	if snapshot == null:
		return "Tick: not connected"
	return "Tick %d (%d ms)" % [snapshot.tick, snapshot.tick_interval_ms]


static func credits_text(snapshot: FactorySnapshot) -> String:
	if snapshot == null:
		return "Credits: not connected"
	return "Credits %s" % format_integer(snapshot.credits)


static func energy_text(snapshot: FactorySnapshot) -> String:
	if snapshot == null:
		return "Energy: not connected"
	return "Energy %s / %s" % [format_integer(snapshot.energy), format_integer(snapshot.max_energy)]


static func inventory_rows(snapshot: FactorySnapshot) -> PackedStringArray:
	var rows := PackedStringArray()
	if snapshot == null:
		return rows
	for item_id in ordered_item_ids(snapshot):
		var entry: Variant = snapshot.inventory.get(item_id)
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var stock: Dictionary = entry
		var available := int(stock.get("available", 0))
		var reserved := int(stock.get("reserved", 0))
		if reserved > 0:
			rows.append(
				"%s: %s (%s reserved)"
				% [item_id, format_integer(available), format_integer(reserved)]
			)
		else:
			rows.append("%s: %s" % [item_id, format_integer(available)])
	return rows


static func ordered_item_ids(snapshot: FactorySnapshot) -> PackedStringArray:
	var ordered := PackedStringArray()
	for item_id in ITEM_ORDER:
		if snapshot.inventory.has(item_id):
			ordered.append(item_id)
	var extras: Array[String] = []
	for item_id in snapshot.inventory.keys():
		var text := String(item_id)
		if ITEM_ORDER.has(text):
			continue
		extras.append(text)
	extras.sort()
	for item_id in extras:
		ordered.append(item_id)
	return ordered


static func line_rows(snapshot: FactorySnapshot) -> PackedStringArray:
	var rows := PackedStringArray()
	if snapshot == null:
		return rows
	for line in snapshot.lines:
		rows.append(_line_row(line))
	return rows


static func _line_row(line: Dictionary) -> String:
	var line_id := String(line.get("lineId", "unknown"))
	var status := String(line.get("status", "UNKNOWN"))
	var priority := int(line.get("priority", 0))
	var active: Variant = line.get("activeBatch", {})
	if typeof(active) == TYPE_DICTIONARY and not (active as Dictionary).is_empty():
		var batch: Dictionary = active
		var recipe_id := String(batch.get("recipeId", line.get("currentRecipeId", "")))
		var progress := int(batch.get("progressTicks", 0))
		var duration := int(batch.get("totalDurationTicks", 0))
		var completed := int(batch.get("completedBatches", 0))
		var target := int(batch.get("targetBatches", 0))
		return "%s: %s %s %d/%d ticks (batch %d/%d)" % [
			line_id, status, recipe_id, progress, duration, completed + 1, target
		]
	return "%s: %s (priority %d)" % [line_id, status, priority]


static func recipe_rows(snapshot: FactorySnapshot) -> PackedStringArray:
	var rows := PackedStringArray()
	if snapshot == null:
		return rows
	for recipe in snapshot.recipes:
		var inputs_label := "no inputs"
		var inputs: Variant = recipe.get("inputs", [])
		if typeof(inputs) == TYPE_ARRAY and not (inputs as Array).is_empty():
			var parts := PackedStringArray()
			for entry in (inputs as Array):
				if typeof(entry) != TYPE_DICTIONARY:
					continue
				var input: Dictionary = entry
				parts.append("%s %s" % [format_integer(int(input.get("quantity", 0))), String(input.get("itemId", ""))])
			inputs_label = ", ".join(parts)
		rows.append(
			"%s: %s -> %s %s | %d ticks | %s energy | input %s"
			% [
				String(recipe.get("id", "?")),
				String(recipe.get("name", "")),
				format_integer(int(recipe.get("outputQuantity", 0))),
				String(recipe.get("outputItem", "")),
				int(recipe.get("durationTicks", 0)),
				format_integer(int(recipe.get("energyCost", 0))),
				inputs_label,
			]
		)
	return rows


## Describes whether the one available action (start one R1 batch) can be shown
## as available, and which line it would target. The backend still decides
## whether the batch is accepted.
static func action_state(snapshot: FactorySnapshot) -> Dictionary:
	var state := {
		"can_start": false,
		"reason": NO_SNAPSHOT_REASON,
		"recipe_id": FactoryProtocol.PRODUCTION_RECIPE_ID,
		"line_id": "",
	}
	if snapshot == null:
		return state
	var recipe: Dictionary = snapshot.recipe(FactoryProtocol.PRODUCTION_RECIPE_ID)
	if recipe.is_empty():
		state["reason"] = "The server did not offer recipe R1; this client slice can only start R1."
		return state
	if snapshot.lines.is_empty():
		state["reason"] = "The server reported no production lines, so there is nothing to start."
		return state

	state["can_start"] = true
	state["reason"] = ""
	var default_line := snapshot.first_idle_line_id()
	if default_line.is_empty():
		default_line = String(snapshot.lines[0].get("lineId", ""))
	state["line_id"] = default_line
	state["energy_guide"] = energy_guide_text(snapshot, default_line)

	var notes := PackedStringArray()
	var energy_cost := int(recipe.get("energyCost", 0))
	var duration := int(recipe.get("durationTicks", 0))
	var per_tick := int(energy_cost / duration) if duration > 0 else energy_cost
	var target_line := snapshot.line(default_line)
	var active_batch: Variant = target_line.get("activeBatch", {})
	if typeof(active_batch) == TYPE_DICTIONARY and not (active_batch as Dictionary).is_empty():
		per_tick = int((active_batch as Dictionary).get("energyPerTick", per_tick))

	if snapshot.energy < energy_cost:
		notes.append(
			"energy %s is below the R1 cost of %s (demands %s energy/tick per productive tick; uninterrupted progress is not guaranteed)"
			% [format_integer(snapshot.energy), format_integer(energy_cost), format_integer(per_tick)]
		)
	var inputs: Variant = recipe.get("inputs", [])
	if typeof(inputs) == TYPE_ARRAY:
		for entry in (inputs as Array):
			if typeof(entry) != TYPE_DICTIONARY:
				continue
			var input: Dictionary = entry
			var item_id := String(input.get("itemId", ""))
			var required := int(input.get("quantity", 0))
			var available := snapshot.inventory_available(item_id)
			if available < required:
				notes.append(
					"only %s %s available (R1 needs %s)"
					% [format_integer(available), item_id, format_integer(required)]
				)
	if not notes.is_empty():
		state["reason"] = "The server may reject this batch: %s." % ", ".join(notes)
	return state


## Returns an advisory breakdown of energy demand per productive tick vs total batch cost.
## Shows activeBatch.energyPerTick when present, or recipe defaults, without promising
## uninterrupted progress.
static func energy_guide_text(snapshot: FactorySnapshot, line_id: String = "") -> String:
	if snapshot == null:
		return ""
	var recipe: Dictionary = snapshot.recipe(FactoryProtocol.PRODUCTION_RECIPE_ID)
	var total_cost := int(recipe.get("energyCost", 0))
	var duration := int(recipe.get("durationTicks", 0))
	var per_tick := int(total_cost / duration) if duration > 0 else total_cost
	if not line_id.is_empty():
		var line := snapshot.line(line_id)
		var active: Variant = line.get("activeBatch", {})
		if typeof(active) == TYPE_DICTIONARY and not (active as Dictionary).is_empty():
			per_tick = int((active as Dictionary).get("energyPerTick", per_tick))
			var active_recipe_id := String((active as Dictionary).get("recipeId", ""))
			if not active_recipe_id.is_empty():
				total_cost = int(snapshot.recipe(active_recipe_id).get("energyCost", total_cost))
	return "Energy demand: %s per productive tick (total batch cost %s); uninterrupted progress is not guaranteed." % [
		format_integer(per_tick), format_integer(total_cost)
	]


## Groups digits without changing the value the server sent.
static func format_integer(value: int) -> String:
	var digits := str(absi(value))
	var grouped := ""
	var counter := 0
	for index in range(digits.length() - 1, -1, -1):
		grouped = digits[index] + grouped
		counter += 1
		if counter % 3 == 0 and index > 0:
			grouped = "," + grouped
	if value < 0:
		return "-" + grouped
	return grouped
