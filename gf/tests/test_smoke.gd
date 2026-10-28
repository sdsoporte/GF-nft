extends SceneTree
## Regression rules for the real-backend smoke result decision.
##
## The smoke must wait for the selected line's server-reported completion, not
## for "any tick after the command executed", and it must tolerate the
## independent ore extractor changing RAW_ORE while a batch runs.

const TestSupport = preload("res://tests/test_support.gd")
const LINE_ID := "comp_metal_01_line_2"
const EXECUTED_AT_TICK := 327


func _initialize() -> void:
	var t := TestSupport.new()
	var in_progress := _snapshot(t, "smoke_in_progress.json")
	var completed := _snapshot(t, "smoke_completed.json")
	var missing_output := _snapshot(t, "smoke_completed_missing_output.json")
	var replenished := _snapshot(t, "smoke_extraction_replenished.json")
	var overconsumed := _snapshot(t, "smoke_overconsumed_input.json")
	var surplus := _snapshot(t, "smoke_output_surplus.json")
	if in_progress == null or completed == null or missing_output == null or replenished == null or overconsumed == null or surplus == null:
		quit(t.finish("test_smoke"))
		return

	_test_in_progress_is_not_completion(t, in_progress)
	_test_completed_line_is_completion(t, completed)
	_test_completed_batch_still_requires_output(t, missing_output)
	_test_extraction_tolerance(t, completed, replenished, overconsumed)
	_test_output_surplus_is_accepted(t, surplus)
	quit(t.finish("test_smoke"))


func _snapshot(t: TestSupport, fixture_name: String) -> FactorySnapshot:
	var parsed: Dictionary = FactoryProtocol.parse_state(t.fixture(fixture_name))
	if not t.check(parsed["ok"], "fixture %s parses: %s" % [fixture_name, str(parsed.get("error", ""))]):
		return null
	return parsed["snapshot"]


func _baseline() -> Dictionary:
	return {"RAW_ORE": 200, "IRON_INGOT": 0}


func _recipe(snapshot: FactorySnapshot) -> Dictionary:
	return snapshot.recipe("R1")


func _test_in_progress_is_not_completion(t: TestSupport, snapshot: FactorySnapshot) -> void:
	var line := snapshot.line(LINE_ID)
	t.equal(String(line.get("status", "")), "RUNNING", "the regression fixture is a running batch")
	t.equal(int(line.get("totalBatchesProduced", -1)), 0, "the running batch has not completed a batch yet")
	t.check(
		snapshot.tick > EXECUTED_AT_TICK,
		"the regression fixture tick is already past the server execution tick"
	)
	t.check(
		not FactorySmoke.batch_completed(snapshot, LINE_ID, 0),
		"a tick after execution is not a completed batch"
	)
	t.check(
		not FactorySmoke.batch_completed(snapshot, LINE_ID, 1),
		"an in-progress line never counts as a new completed batch"
	)


func _test_completed_line_is_completion(t: TestSupport, snapshot: FactorySnapshot) -> void:
	t.check(
		FactorySmoke.batch_completed(snapshot, LINE_ID, 0),
		"a new server-reported batch count marks the batch complete"
	)
	t.check(
		not FactorySmoke.batch_completed(snapshot, LINE_ID, 1),
		"a batch count that did not grow is not a new completion"
	)
	t.check(
		not FactorySmoke.batch_completed(snapshot, "comp_metal_01_line_9", 0),
		"an unknown line is never complete"
	)
	t.equal(
		FactorySmoke.inventory_failures(snapshot, _baseline(), _recipe(snapshot)).size(),
		0,
		"a completed batch with catalog output and extraction replenishment passes"
	)


func _test_completed_batch_still_requires_output(t: TestSupport, snapshot: FactorySnapshot) -> void:
	t.check(
		FactorySmoke.batch_completed(snapshot, LINE_ID, 0),
		"the missing-output fixture still reports a completed batch"
	)
	var failures := FactorySmoke.inventory_failures(snapshot, _baseline(), _recipe(snapshot))
	t.check(failures.size() > 0, "a completed batch without its output still fails")
	t.contains(", ".join(failures), "IRON_INGOT", "the missing-output failure names the output item")


func _test_extraction_tolerance(
	t: TestSupport,
	completed: FactorySnapshot,
	replenished: FactorySnapshot,
	overconsumed: FactorySnapshot
) -> void:
	t.equal(
		FactorySmoke.inventory_failures(completed, _baseline(), _recipe(completed)).size(),
		0,
		"RAW_ORE below baseline input cost but above baseline-minus-recipe passes"
	)
	t.equal(
		FactorySmoke.inventory_failures(replenished, _baseline(), _recipe(replenished)).size(),
		0,
		"RAW_ORE fully replenished by extraction still passes"
	)
	var failures := FactorySmoke.inventory_failures(overconsumed, _baseline(), _recipe(overconsumed))
	t.check(failures.size() > 0, "consuming more input than the recipe requires still fails")
	t.contains(", ".join(failures), "RAW_ORE", "the over-consumption failure names the input item")


func _test_output_surplus_is_accepted(t: TestSupport, snapshot: FactorySnapshot) -> void:
	t.equal(
		FactorySmoke.inventory_failures(snapshot, _baseline(), _recipe(snapshot)).size(),
		0,
		"more output than one batch is not treated as a client failure"
	)
