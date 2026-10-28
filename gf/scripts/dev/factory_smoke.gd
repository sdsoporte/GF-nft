class_name FactorySmoke
extends Node
## Optional real-backend check that runs inside the visible main scene.
##
## Enabled only by the `--smoke` user argument (see tests/run_backend_smoke.sh).
## It drives the same UI paths a player uses, then asserts the server result:
## a queued command, an executed command, and the selected line's own
## server-reported batch completion with the resulting inventory. A tick after
## execution is not completion, and the independent ore extractor may change
## RAW_ORE while the batch runs. Exits with code 0 on success and 1 on any
## failure or timeout.

enum Phase { WAIT_STATE, WAIT_ACK, WAIT_COMMAND, WAIT_RESULT, FINISHED }

const DEFAULT_TIMEOUT_SECONDS := 45.0
const ENV_TIMEOUT := "GF_SMOKE_TIMEOUT"

var _main: Node
var _client: FactoryApiClient
var _phase: int = Phase.WAIT_STATE
var _deadline_msec: int = 0
var _recipe: Dictionary = {}
var _baseline: Dictionary = {}
var _line_id: String = ""
var _command_id: String = ""
var _executed_tick: int = -1
var _baseline_total_batches: int = 0
var _saw_progress: bool = false
var _failures: PackedStringArray = PackedStringArray()
var _finished: bool = false


func start(host_main: Node) -> void:
	_main = host_main
	_client = host_main.get_client()
	_deadline_msec = Time.get_ticks_msec() + int(_timeout_seconds() * 1000.0)
	_client.snapshot_received.connect(_on_snapshot)
	_client.production_queued.connect(_on_ack)
	_client.command_status_changed.connect(_on_command_status)
	_client.request_failed.connect(_on_request_failed)
	_client.connection_state_changed.connect(_on_connection_state)
	var opened: Dictionary = _main.connect_to_server()
	if not opened["ok"]:
		_finish_with("could not open the session: %s" % String(opened["error"]))
		return
	print("SMOKE: connecting to %s" % _client.get_base_url())


func _process(_delta: float) -> void:
	if _finished:
		return
	if Time.get_ticks_msec() > _deadline_msec:
		_finish_with(
			"timed out after %ds in phase %s. Check GF_BACKEND_URL, GF_API_TOKEN and that the backend is advancing ticks."
			% [int(_timeout_seconds()), _phase_name()]
		)


func _on_connection_state(state: String, message: String) -> void:
	if _finished:
		return
	if state == FactoryApiClient.STATE_ERROR:
		_finish_with("connection error: %s" % message)


func _on_request_failed(message: String, _fatal: bool) -> void:
	if _finished:
		return
	_finish_with("request failed: %s" % message)


func _on_snapshot(snapshot: FactorySnapshot) -> void:
	if _finished or snapshot == null:
		return
	for line in snapshot.lines:
		var active: Variant = line.get("activeBatch", {})
		if typeof(active) == TYPE_DICTIONARY and not (active as Dictionary).is_empty():
			if int((active as Dictionary).get("progressTicks", 0)) > 0:
				_saw_progress = true
	match _phase:
		Phase.WAIT_STATE:
			_start_batch(snapshot)
		Phase.WAIT_RESULT:
			if batch_completed(snapshot, _line_id, _baseline_total_batches):
				_verify_result(snapshot)


func _start_batch(snapshot: FactorySnapshot) -> void:
	if snapshot.match_id.is_empty():
		_finish_with("the server snapshot has no match id")
		return
	if snapshot.tick < 0:
		_finish_with("the server reported a negative tick")
		return
	_recipe = snapshot.recipe(FactoryProtocol.PRODUCTION_RECIPE_ID)
	if _recipe.is_empty():
		_finish_with("the server did not offer recipe R1")
		return
	_line_id = snapshot.first_idle_line_id()
	if _line_id.is_empty():
		_finish_with("no idle production line; run the smoke against a fresh backend process")
		return
	_baseline_total_batches = int(snapshot.line(_line_id).get("totalBatchesProduced", 0))
	_baseline = _inventory_snapshot(snapshot)
	print("SMOKE: match %s tick %d, starting R1 on %s" % [snapshot.match_id, snapshot.tick, _line_id])
	_main.press_start(_line_id)
	var ui_error := String(_main.ui_error_text())
	if not ui_error.is_empty():
		_finish_with("the visible Start action was refused: %s" % ui_error)
		return
	if _client.get_pending_exchange() != FactoryApiClient.EXCHANGE_PRODUCTION:
		_finish_with("the visible Start action did not issue a production request")
		return
	_phase = Phase.WAIT_ACK


func _on_ack(ack: Dictionary) -> void:
	if _finished or _phase != Phase.WAIT_ACK:
		return
	_command_id = String(ack.get("commandId", ""))
	if _command_id.is_empty():
		_finish_with("the queue acknowledgement carried no command id")
		return
	if String(ack.get("status", "")) != "queued":
		_finish_with("the queue acknowledgement was not 'queued'")
		return
	print("SMOKE: server queued command %s" % _command_id)
	_phase = Phase.WAIT_COMMAND


func _on_command_status(command: Dictionary) -> void:
	if _finished or _phase != Phase.WAIT_COMMAND:
		return
	if String(command.get("commandId", "")) != _command_id:
		return
	var status := String(command.get("status", ""))
	if status == "queued":
		return
	if status == "rejected":
		_finish_with("the server rejected the command with %s" % String(command.get("errorCode", "an engine error")))
		return
	if status != "executed":
		return
	_executed_tick = int(command.get("executedAtTick", -1))
	print("SMOKE: server executed command %s on tick %d" % [_command_id, _executed_tick])
	_phase = Phase.WAIT_RESULT


func _verify_result(snapshot: FactorySnapshot) -> void:
	var output_item := String(_recipe.get("outputItem", ""))
	var failures := FactorySmoke.inventory_failures(snapshot, _baseline, _recipe)
	var actual_output := snapshot.inventory_available(output_item)

	var inventory_rows: PackedStringArray = _main.ui_inventory_rows()
	var status_text := String(_main.ui_status_text())
	var command_text := String(_main.ui_command_text())
	if not status_text.contains("Connected"):
		failures.append("the visible status line does not report a connection: '%s'" % status_text)
	if not command_text.contains("executed"):
		failures.append("the visible command line does not report the executed command: '%s'" % command_text)
	var expected_output_row := "%s: %s" % [output_item, FactoryViewModel.format_integer(actual_output)]
	var output_visible := false
	for row in inventory_rows:
		if String(row) == expected_output_row:
			output_visible = true
	if not output_visible:
		failures.append("the visible inventory does not show '%s'" % expected_output_row)
	if not failures.is_empty():
		for failure in failures:
			_failures.append(failure)
		_finish_with("server result verification failed")
		return

	print(
		"SMOKE: line %s reported batch completion (total %d -> %d)%s"
		% [
			_line_id,
			_baseline_total_batches,
			snapshot.line(_line_id).get("totalBatchesProduced", 0),
			" with a sampled mid-batch progress snapshot" if _saw_progress else "",
		]
	)
	print("SMOKE OK: %s %d -> %d from server snapshots" % [output_item, int(_baseline.get(output_item, 0)), actual_output])
	print("SMOKE OK: visible scene reported Connected and the executed command")
	print("SMOKE OK: match %s at tick %d" % [snapshot.match_id, snapshot.tick])
	_finish(0)


func _inventory_snapshot(snapshot: FactorySnapshot) -> Dictionary:
	var baseline := {}
	for item_id in snapshot.inventory.keys():
		baseline[String(item_id)] = snapshot.inventory_available(String(item_id))
	return baseline


## True only when the server reports one more finished batch on the selected
## line than before this run. A tick number after execution proves nothing.
static func batch_completed(snapshot: FactorySnapshot, line_id: String, baseline_total_batches: int) -> bool:
	if snapshot == null or line_id.is_empty():
		return false
	var line: Dictionary = snapshot.line(line_id)
	if line.is_empty():
		return false
	return int(line.get("totalBatchesProduced", 0)) > baseline_total_batches


## Inventory expectations for one completed batch. The output must have
## appeared. Inputs may be replenished by the independent ore extractor, so an
## input only fails when it dropped deeper than the recipe allows.
static func inventory_failures(
	snapshot: FactorySnapshot, baseline_inventory: Dictionary, recipe: Dictionary
) -> PackedStringArray:
	var failures := PackedStringArray()
	if snapshot == null or recipe.is_empty():
		failures.append("the smoke has no snapshot or recipe to verify")
		return failures
	var output_item := String(recipe.get("outputItem", ""))
	var output_quantity := int(recipe.get("outputQuantity", 0))
	var expected_output := int(baseline_inventory.get(output_item, 0)) + output_quantity
	var actual_output := snapshot.inventory_available(output_item)
	if actual_output < expected_output:
		failures.append(
			"%s expected at least %d after the completed batch but the server snapshot shows %d"
			% [output_item, expected_output, actual_output]
		)
	var inputs: Variant = recipe.get("inputs", [])
	if typeof(inputs) == TYPE_ARRAY:
		for entry in (inputs as Array):
			if typeof(entry) != TYPE_DICTIONARY:
				continue
			var input: Dictionary = entry
			var item_id := String(input.get("itemId", ""))
			var required := int(input.get("quantity", 0))
			var minimum := int(baseline_inventory.get(item_id, 0)) - required
			var actual := snapshot.inventory_available(item_id)
			if actual < minimum:
				failures.append(
					"%s expected at least %d (baseline minus %d recipe input; extraction can only add stock) but the server snapshot shows %d"
					% [item_id, minimum, required, actual]
				)
	return failures


func _phase_name() -> String:
	match _phase:
		Phase.WAIT_STATE:
			return "waiting for the first snapshot"
		Phase.WAIT_ACK:
			return "waiting for the queue acknowledgement"
		Phase.WAIT_COMMAND:
			return "waiting for the command result"
		Phase.WAIT_RESULT:
			return "waiting for the batch to finish producing"
		_:
			return "finished"


func _finish_with(reason: String) -> void:
	_failures.append(reason)
	print("SMOKE FAIL: %s" % reason)
	for failure in _failures:
		if failure != reason:
			print("SMOKE FAIL: %s" % failure)
	_finish(1)


func _finish(exit_code: int) -> void:
	if _finished:
		return
	_finished = true
	if _main != null and _main.has_method("disconnect_from_server"):
		_main.disconnect_from_server()
	if exit_code == 0:
		print("SMOKE RESULT: PASSED")
	else:
		print("SMOKE RESULT: FAILED")
	get_tree().quit(exit_code)


func _timeout_seconds() -> float:
	var configured := OS.get_environment(ENV_TIMEOUT).strip_edges()
	if configured.is_valid_float():
		var parsed := configured.to_float()
		if parsed >= 5.0 and parsed <= 600.0:
			return parsed
	return DEFAULT_TIMEOUT_SECONDS
