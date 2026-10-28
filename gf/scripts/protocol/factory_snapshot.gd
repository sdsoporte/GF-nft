class_name FactorySnapshot
extends RefCounted
## Detached, validated copy of one `GET /v1/state` response.
##
## The client only reads these values. It never writes them back, never ticks
## them forward and never derives resources of its own: the backend owns the
## match, its clock and every mutation.

var protocol_version: int = 0
var match_id: String = ""
var tick: int = 0
var tick_interval_ms: int = 0

var company_id: String = ""
var company_name: String = ""
var company_class: String = ""
var credits: int = 0
var energy: int = 0
var max_energy: int = 0

## item_id -> {"available": int, "reserved": int}
var inventory: Dictionary = {}

## Each entry: {"lineId", "companyId", "priority", "status", "currentRecipeId",
## "totalBatchesProduced", "lastActionTick", "activeBatch": Dictionary}
var lines: Array[Dictionary] = []

## Each entry: {"id", "name", "outputItem", "outputQuantity", "durationTicks",
## "energyCost", "inputs": Array[Dictionary] with "itemId" and "quantity"}
var recipes: Array[Dictionary] = []


func inventory_available(item_id: String) -> int:
	var entry: Variant = inventory.get(item_id)
	if typeof(entry) != TYPE_DICTIONARY:
		return 0
	return int((entry as Dictionary).get("available", 0))


func recipe(recipe_id: String) -> Dictionary:
	for entry in recipes:
		if String(entry.get("id", "")) == recipe_id:
			return entry
	return {}


func line(line_id: String) -> Dictionary:
	for entry in lines:
		if String(entry.get("lineId", "")) == line_id:
			return entry
	return {}


func first_idle_line_id() -> String:
	for entry in lines:
		if String(entry.get("status", "")) == "IDLE":
			return String(entry.get("lineId", ""))
	return ""
