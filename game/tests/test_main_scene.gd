extends SceneTree
## Observable rules for the visible main scene: it starts without the editor
## plugin, explains real backend authentication, masks the token, and renders
## server snapshots without inventing local state.

const TestSupport = preload("res://tests/test_support.gd")
const ENV_TOKEN := "fedcba9876543210fedcba9876543210"

var _started: bool = false


func _process(_delta: float) -> bool:
	if _started:
		return true
	_started = true
	var t := TestSupport.new()
	OS.unset_environment("GF_BACKEND_URL")
	OS.unset_environment("GF_API_TOKEN")
	_test_scene_boots(t)
	_test_snapshot_rendering(t)
	_test_blocked_action_without_session(t)
	_test_environment_prefill(t)
	_test_command_poll_recovery(t)
	_test_production_lifecycle_distinction(t)
	_test_line_controls_in_scene(t)
	_test_market_visibility_in_scene(t)
	quit(t.finish("test_main_scene"))
	return true


func _instantiate() -> Node:
	var scene: PackedScene = load("res://scenes/main.tscn")
	if scene == null:
		return null
	var main: Node = scene.instantiate()
	get_root().add_child(main)
	main.setup()
	return main


func _node(main: Node, unique_name: String) -> Node:
	return main.get_node("%" + unique_name)


func _test_scene_boots(t: TestSupport) -> void:
	var main := _instantiate()
	if not t.check(main != null, "main scene can be instantiated"):
		return
	var token_edit: LineEdit = _node(main, "TokenEdit")
	var url_edit: LineEdit = _node(main, "UrlEdit")
	var status_label: Label = _node(main, "StatusLabel")
	var help_label: Label = _node(main, "HelpLabel")
	var start_button: Button = _node(main, "StartButton")
	var inventory_list: ItemList = _node(main, "InventoryList")
	var client := main.get_node_or_null("FactoryApiClient")

	t.check(token_edit != null, "token field exists")
	t.check(token_edit.secret, "token field masks its content")
	t.equal(url_edit.text, EndpointPolicy.DEFAULT_BACKEND_URL, "url field defaults to loopback")
	t.equal(token_edit.text, "", "no token is prefilled without environment input")
	t.contains(status_label.text, "Disconnected", "scene opens in a disconnected state")
	t.check(start_button.disabled, "production cannot start before a snapshot")
	t.check(_node(main, "PauseButton").disabled, "pause cannot start before a snapshot")
	t.check(_node(main, "ResumeButton").disabled, "resume cannot start before a snapshot")
	t.check(_node(main, "Priority1Button").disabled, "p1 cannot start before a snapshot")
	t.check(_node(main, "Priority2Button").disabled, "p2 cannot start before a snapshot")
	t.check(_node(main, "Priority3Button").disabled, "p3 cannot start before a snapshot")
	t.equal(inventory_list.item_count, 0, "inventory list starts empty")
	t.check(client != null, "scene owns an API client node")

	var help := help_label.text
	t.contains(help, "GF_API_TOKEN", "help explains the real backend token requirement")
	t.contains(help, "127.0.0.1:8787", "help names the native loopback port")
	t.contains(help.to_lower(), "docker", "help names the Docker path")
	t.contains(help.to_lower(), "token", "help explains authentication")
	t.contains(help.to_lower(), "https", "help explains the https requirement for remote hosts")
	t.check(not main.is_connected_to_server(), "the scene does not auto-connect on boot")
	get_root().remove_child(main)
	main.free()


func _test_snapshot_rendering(t: TestSupport) -> void:
	var main := _instantiate()
	if not t.check(main != null, "main scene can be instantiated for rendering"):
		return
	var parsed: Dictionary = FactoryProtocol.parse_state(FileAccess.get_file_as_string("res://tests/fixtures/state_ok.json"))
	if not t.check(parsed["ok"], "fixture snapshot parses for the scene"):
		get_root().remove_child(main)
		main.free()
		return
	var snapshot: FactorySnapshot = parsed["snapshot"]
	main.apply_snapshot(snapshot)

	var credits_label: Label = _node(main, "CreditsLabel")
	var energy_label: Label = _node(main, "EnergyLabel")
	var match_label: Label = _node(main, "MatchLabel")
	var tick_label: Label = _node(main, "TickLabel")
	var inventory_list: ItemList = _node(main, "InventoryList")
	var lines_list: ItemList = _node(main, "LinesList")
	var recipes_list: ItemList = _node(main, "RecipesList")
	var action_hint: Label = _node(main, "ActionHint")
	var start_button: Button = _node(main, "StartButton")

	t.equal(match_label.text, "Match match_fixture_0001", "match label shows the server match")
	t.equal(tick_label.text, "Tick 42 (1000 ms)", "tick label shows the server tick")
	t.equal(credits_label.text, "Credits 10,000", "credits label shows server credits")
	t.equal(energy_label.text, "Energy 400 / 1,000", "energy label shows server energy")
	t.equal(inventory_list.item_count, 9, "inventory list shows every server item")
	t.equal(lines_list.item_count, 3, "lines list shows every server line")
	t.equal(recipes_list.item_count, 1, "recipes list shows the offered recipe")
	t.equal(inventory_list.get_item_text(1), "IRON_INGOT: 12 (5 reserved)", "inventory rows are formatted once")
	t.contains(lines_list.get_item_text(0), "4/10", "line rows show server progress")
	t.equal(action_hint.text, "", "no advisory for a sufficient fixture")
	t.check(start_button.disabled, "production still needs a live connection, not just a snapshot")
	get_root().remove_child(main)
	main.free()


func _test_blocked_action_without_session(t: TestSupport) -> void:
	var main := _instantiate()
	if not t.check(main != null, "main scene can be instantiated for the action test"):
		return
	var parsed: Dictionary = FactoryProtocol.parse_state(FileAccess.get_file_as_string("res://tests/fixtures/state_ok.json"))
	main.apply_snapshot(parsed["snapshot"])
	var start_button: Button = _node(main, "StartButton")
	var error_label: Label = _node(main, "ErrorLabel")
	start_button.emit_signal("pressed")
	t.contains(error_label.text.to_lower(), "connect", "starting without a session asks for a connection")
	t.check(error_label.text.length() > 0, "a blocked action is visible to the player")
	get_root().remove_child(main)
	main.free()


func _test_environment_prefill(t: TestSupport) -> void:
	OS.set_environment("GF_BACKEND_URL", "http://127.0.0.1:1")
	OS.set_environment("GF_API_TOKEN", ENV_TOKEN)
	var main := _instantiate()
	if not t.check(main != null, "main scene can be instantiated with environment input"):
		OS.unset_environment("GF_BACKEND_URL")
		OS.unset_environment("GF_API_TOKEN")
		return

	var url_edit: LineEdit = _node(main, "UrlEdit")
	var token_edit: LineEdit = _node(main, "TokenEdit")
	t.equal(url_edit.text, "http://127.0.0.1:1", "url field is prefilled from the environment")
	t.equal(token_edit.text, ENV_TOKEN, "token field is prefilled from the environment")
	t.check(token_edit.secret, "environment token stays masked")
	t.check(not main.is_connected_to_server(), "environment input does not auto-connect")

	var opened: Dictionary = main.connect_to_server()
	t.check(opened["ok"], "manual connection from the visible controls opens the session")
	t.check(main.is_connected_to_server(), "the scene reports an open session")
	var rendered := ""
	for label_name in ["StatusLabel", "ErrorLabel", "CommandLabel", "HelpLabel", "ActionHint"]:
		rendered += _node(main, label_name).text
	t.not_contains(rendered, ENV_TOKEN, "no visible label ever renders the token")

	main.disconnect_from_server()
	var token_after: LineEdit = _node(main, "TokenEdit")
	t.equal(token_after.text, "", "disconnecting clears the token field")
	var status_label: Label = _node(main, "StatusLabel")
	t.contains(status_label.text, "Disconnected", "disconnecting returns to the disconnected state")

	OS.unset_environment("GF_BACKEND_URL")
	OS.unset_environment("GF_API_TOKEN")
	get_root().remove_child(main)
	main.free()


func _test_command_poll_recovery(t: TestSupport) -> void:
	var server := TCPServer.new()
	if not t.equal(server.listen(0, "127.0.0.1"), OK, "recovery test owns a loopback listener"):
		return
	var url := "http://127.0.0.1:%d" % server.get_local_port()
	for status in [404, 500, 200, 0, 401]:
		_check_command_failure(t, url, status)
	server.stop()


func _check_command_failure(t: TestSupport, url: String, status: int) -> void:
	var main := _instantiate()
	var label := "command failure %d" % status
	_node(main, "UrlEdit").text = url
	_node(main, "TokenEdit").text = ENV_TOKEN
	_node(main, "ConnectButton").pressed.emit()
	var client: FactoryApiClient = main.get_client()
	var generation := client.get_generation()
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_HEALTH, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("health_ok.json")
	), label + ": health accepted")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("state_ok.json")
	), label + ": initial snapshot accepted")
	if status == 401:
		t.check(client.poll(), "ordinary state read still starts")
		t.check(client.deliver_exchange_result(
			generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 500, t.fixture("error_not_found.json")
		), "ordinary state error is consumed")
		t.check(main.ui_inventory_rows().has("IRON_INGOT: 12 (5 reserved)"), "ordinary state error preserves its snapshot")
		t.equal(client.get_connection_state(), FactoryApiClient.STATE_CONNECTED, "ordinary state error keeps its session")
	_node(main, "LinesList").select(1)
	_node(main, "StartButton").pressed.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_PRODUCTION, label + ": one production request")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_PRODUCTION, HTTPRequest.RESULT_SUCCESS, 202, t.fixture("ack_queued.json")
	), label + ": queued acknowledgement accepted")
	_node(main, "PollTimer").timeout.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_COMMAND, label + ": command poll started")

	var body := t.fixture("error_not_found.json")
	var result := HTTPRequest.RESULT_SUCCESS
	if status == 500:
		body = '{"error":{"code":"INTERNAL_ERROR","message":"Temporary server failure."}}'
	elif status == 200:
		body = "{malformed"
	elif status == 0:
		result = HTTPRequest.RESULT_TIMEOUT
		body = ""
	elif status == 401:
		body = t.fixture("error_unauthorized.json")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_COMMAND, result, status, body
	), label + ": failure consumed")
	t.check(_node(main, "StartButton").disabled, label + ": no write from a stale view")
	if status == 401:
		t.equal(client.get_connection_state(), FactoryApiClient.STATE_ERROR, "401 still ends the session")
		t.check(not client.has_credentials(), "401 still drops credentials")
		t.equal(_node(main, "TokenEdit").text, "", "401 still clears the masked field")
		t.check(_node(main, "PollTimer").is_stopped(), "401 still stops polling")
		_node(main, "PollTimer").timeout.emit()
		t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_NONE, "401 never restarts a request")
	else:
		t.contains(main.ui_command_text(), "unknown", label + ": execution is not claimed or retried")
		t.check(client.has_credentials(), label + ": recoverable failure keeps the session")
		_node(main, "PollTimer").timeout.emit()
		var recovering := client.get_pending_exchange() == FactoryApiClient.EXCHANGE_STATE
		t.check(recovering, label + ": next timer reads state, not the missing command")
		if recovering:
			var fresh: Dictionary = JSON.parse_string(t.fixture("state_ok.json"))
			fresh["matchId"] = "match_recovered_%d" % status
			fresh["tick"] = 0
			fresh["company"]["inventory"]["IRON_INGOT"] = {"available": 0, "reserved": 0}
			for line in fresh["company"]["lines"]:
				line["status"] = "IDLE"
				line["currentRecipeId"] = null
				line["activeBatch"] = null
				line["totalBatchesProduced"] = 0
				line["lastActionTick"] = 0
			t.check(client.deliver_exchange_result(
				generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, JSON.stringify(fresh)
			), label + ": restarted server snapshot accepted")
			t.equal(_node(main, "MatchLabel").text, "Match " + fresh["matchId"], label + ": new match rendered")
			t.equal(_node(main, "TickLabel").text, "Tick 0 (1000 ms)", label + ": new server clock rendered")
			t.check(main.ui_inventory_rows().has("IRON_INGOT: 0"), label + ": new inventory rendered")
			t.check(not _node(main, "StartButton").disabled, label + ": fresh state restores Start")
			_node(main, "PollTimer").timeout.emit()
			t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_STATE, label + ": no production replay")
	main.disconnect_from_server()
	get_root().remove_child(main)
	main.free()


func _test_production_lifecycle_distinction(t: TestSupport) -> void:
	var server := TCPServer.new()
	if not t.equal(server.listen(0, "127.0.0.1"), OK, "lifecycle test owns a loopback listener"):
		return
	var url := "http://127.0.0.1:%d" % server.get_local_port()
	var main := _instantiate()
	_node(main, "UrlEdit").text = url
	_node(main, "TokenEdit").text = ENV_TOKEN
	_node(main, "ConnectButton").pressed.emit()
	var client: FactoryApiClient = main.get_client()
	var generation := client.get_generation()

	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_HEALTH, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("health_ok.json")
	), "lifecycle: health accepted")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("state_ok.json")
	), "lifecycle: initial snapshot accepted")

	# Select idle line 2 (index 1) which has totalBatchesProduced = 0
	_node(main, "LinesList").select(1)
	_node(main, "StartButton").pressed.emit()

	# 1. Enqueued stage
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_PRODUCTION, HTTPRequest.RESULT_SUCCESS, 202, t.fixture("ack_queued.json")
	), "lifecycle: queued ack accepted")
	var queued_text: String = main.ui_command_text()
	t.contains(queued_text, "queued", "lifecycle: queued stage reports command queued")
	t.not_contains(queued_text, "completed", "lifecycle: queued stage does not claim completion")

	# Poll command status
	_node(main, "PollTimer").timeout.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_COMMAND, "lifecycle: command poll started")

	# 2. Target applied stage (executed on server tick, batch NOT completed yet)
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_COMMAND, HTTPRequest.RESULT_SUCCESS, 200,
		'{"commandId":"cmd_fixture_queued","status":"executed","executedAtTick":43}'
	), "lifecycle: executed status delivered")
	var executed_text: String = main.ui_command_text()
	t.contains(executed_text, "executed", "lifecycle: target applied stage reports execution")
	t.contains(executed_text.to_lower(), "target applied", "lifecycle: target applied stage reports target applied")
	t.not_contains(executed_text, "completed batch", "lifecycle: execution before completion never claims batch completed")

	# 3. Intermediate snapshots with elapsed time / progress but totalBatchesProduced = 0
	_node(main, "PollTimer").timeout.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_STATE, "lifecycle: regular state poll resumes")
	var mid_batch: Dictionary = JSON.parse_string(t.fixture("state_ok.json"))
	mid_batch["tick"] = 46
	# Line 2 is now running with 3/10 ticks progress, totalBatchesProduced is still 0
	mid_batch["company"]["lines"][1]["status"] = "RUNNING"
	mid_batch["company"]["lines"][1]["currentRecipeId"] = "R1"
	mid_batch["company"]["lines"][1]["totalBatchesProduced"] = 0
	mid_batch["company"]["lines"][1]["activeBatch"] = {
		"recipeId": "R1", "targetBatches": 1, "completedBatches": 0,
		"progressTicks": 3, "totalDurationTicks": 10, "energyPerTick": 2, "energyRemainder": 0
	}
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, JSON.stringify(mid_batch)
	), "lifecycle: mid-batch snapshot delivered")
	t.not_contains(main.ui_command_text(), "completed batch", "lifecycle: elapsed time without batch increment does not claim completion")

	# 4. Line enters NO_ENERGY or PAUSED with active batch: preserves progress, does not claim completion
	_node(main, "PollTimer").timeout.emit()
	var paused_batch: Dictionary = JSON.parse_string(JSON.stringify(mid_batch))
	paused_batch["tick"] = 48
	paused_batch["company"]["lines"][1]["status"] = "NO_ENERGY"
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, JSON.stringify(paused_batch)
	), "lifecycle: starved snapshot delivered")
	t.contains(main.ui_line_rows()[1], "NO_ENERGY R1 3/10 ticks", "lifecycle: NO_ENERGY preserves visible progress")
	t.not_contains(main.ui_command_text(), "completed batch", "lifecycle: NO_ENERGY does not claim completion")

	# 5. Extraneous inventory change without batch increment does not claim completion
	_node(main, "PollTimer").timeout.emit()
	var inventory_change: Dictionary = JSON.parse_string(JSON.stringify(paused_batch))
	inventory_change["tick"] = 50
	inventory_change["company"]["inventory"]["IRON_INGOT"]["available"] = 999
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, JSON.stringify(inventory_change)
	), "lifecycle: inventory change snapshot delivered")
	t.not_contains(main.ui_command_text(), "completed batch", "lifecycle: extraneous inventory change does not claim completion")

	# 6. Batch completed: server snapshot reports totalBatchesProduced increment on chosen line
	_node(main, "PollTimer").timeout.emit()
	var completed_snapshot: Dictionary = JSON.parse_string(JSON.stringify(mid_batch))
	completed_snapshot["tick"] = 53
	completed_snapshot["company"]["lines"][1]["status"] = "IDLE"
	completed_snapshot["company"]["lines"][1]["activeBatch"] = null
	completed_snapshot["company"]["lines"][1]["totalBatchesProduced"] = 1
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, JSON.stringify(completed_snapshot)
	), "lifecycle: completed snapshot delivered")
	var completed_text: String = main.ui_command_text()
	t.contains(completed_text, "executed", "lifecycle: completion retains executed reference")
	t.contains(completed_text, "completed batch", "lifecycle: completion clearly distinguishes batch completion")
	t.contains(completed_text, "comp_metal_01_line_2", "lifecycle: completion names the targeted line")
	t.contains(completed_text, "total produced: 1", "lifecycle: completion reports total produced count")

	# 7. Rejection test: command rejected does not claim target applied or completion
	_node(main, "LinesList").select(1)
	_node(main, "StartButton").pressed.emit()
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_PRODUCTION, HTTPRequest.RESULT_SUCCESS, 202,
		'{"commandId":"cmd_rej_01","status":"queued"}'
	), "lifecycle: second queued ack delivered")
	_node(main, "PollTimer").timeout.emit()
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_COMMAND, HTTPRequest.RESULT_SUCCESS, 200,
		'{"commandId":"cmd_rej_01","status":"rejected","executedAtTick":55,"errorCode":"ERR_LINE_BUSY"}'
	), "lifecycle: rejected command status delivered")
	var rejected_text: String = main.ui_command_text()
	t.contains(rejected_text, "rejected", "lifecycle: rejection reports rejection")
	t.contains(rejected_text, "ERR_LINE_BUSY", "lifecycle: rejection reports error code")
	t.not_contains(rejected_text, "target applied", "lifecycle: rejected command does not report target applied")
	t.not_contains(rejected_text, "completed batch", "lifecycle: rejected command does not report completion")

	main.disconnect_from_server()
	get_root().remove_child(main)
	main.free()
	server.stop()


func _test_line_controls_in_scene(t: TestSupport) -> void:
	var server := TCPServer.new()
	if not t.equal(server.listen(0, "127.0.0.1"), OK, "line controls test owns a loopback listener"):
		return
	var url := "http://127.0.0.1:%d" % server.get_local_port()
	var main := _instantiate()

	# Controls exist on boot and are disabled
	var pause_btn: Button = _node(main, "PauseButton")
	var resume_btn: Button = _node(main, "ResumeButton")
	var p1_btn: Button = _node(main, "Priority1Button")
	var p2_btn: Button = _node(main, "Priority2Button")
	var p3_btn: Button = _node(main, "Priority3Button")

	t.check(pause_btn != null, "pause button exists")
	t.check(resume_btn != null, "resume button exists")
	t.check(p1_btn != null, "priority 1 button exists")
	t.check(p2_btn != null, "priority 2 button exists")
	t.check(p3_btn != null, "priority 3 button exists")

	t.check(pause_btn.disabled, "pause disabled before connection")
	t.check(resume_btn.disabled, "resume disabled before connection")
	t.check(p1_btn.disabled, "p1 disabled before connection")
	t.check(p2_btn.disabled, "p2 disabled before connection")
	t.check(p3_btn.disabled, "p3 disabled before connection")

	_node(main, "UrlEdit").text = url
	_node(main, "TokenEdit").text = ENV_TOKEN
	_node(main, "ConnectButton").pressed.emit()
	var client: FactoryApiClient = main.get_client()
	var generation := client.get_generation()

	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_HEALTH, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("health_ok.json")
	), "line_ctrl: health accepted")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("state_ok.json")
	), "line_ctrl: initial snapshot accepted")

	# With connected snapshot, buttons become enabled for selected line (index 0 by default)
	t.check(not pause_btn.disabled, "pause enabled after snapshot")
	t.check(not resume_btn.disabled, "resume enabled after snapshot")
	t.check(not p1_btn.disabled, "p1 enabled after snapshot")
	t.check(not p2_btn.disabled, "p2 enabled after snapshot")
	t.check(not p3_btn.disabled, "p3 enabled after snapshot")

	# 1. Pause line 2
	_node(main, "LinesList").select(1)
	pause_btn.pressed.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_LINE_CONTROL, "pause request in flight")
	t.check(pause_btn.disabled, "pause button disabled while request in flight")
	t.check(_node(main, "StartButton").disabled, "start button disabled while request in flight")

	# Deliver 202 queued ack
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_LINE_CONTROL, HTTPRequest.RESULT_SUCCESS, 202,
		'{"commandId":"cmd_pause_01","status":"queued"}'
	), "pause ack accepted")
	var queued_text: String = main.ui_command_text()
	t.contains(queued_text, "queued", "command label shows queued status")
	t.contains(queued_text, "cmd_pause_01", "command label names the command id")

	# Poll command
	_node(main, "PollTimer").timeout.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_COMMAND, "command poll started")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_COMMAND, HTTPRequest.RESULT_SUCCESS, 200,
		'{"commandId":"cmd_pause_01","status":"executed","executedAtTick":43}'
	), "executed status delivered")
	var executed_text: String = main.ui_command_text()
	t.contains(executed_text, "executed", "command label reports execution")
	t.contains(executed_text, "paused", "command label reports line paused")
	t.contains(executed_text, "comp_metal_01_line_2", "command label reports paused line id")
	t.not_contains(executed_text, "completed batch", "pause execution does not claim batch completed")

	# Deliver state with paused line 2
	_node(main, "PollTimer").timeout.emit()
	var paused_state: Dictionary = JSON.parse_string(t.fixture("state_ok.json"))
	paused_state["company"]["lines"][1]["status"] = "PAUSED"
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, JSON.stringify(paused_state)
	), "paused state delivered")
	t.contains(main.ui_line_rows()[1], "PAUSED", "line row shows PAUSED")

	# 2. Set priority to 3 on line 2
	p3_btn.pressed.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_LINE_CONTROL, "priority request in flight")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_LINE_CONTROL, HTTPRequest.RESULT_SUCCESS, 202,
		'{"commandId":"cmd_prio_03","status":"queued"}'
	), "priority ack accepted")
	_node(main, "PollTimer").timeout.emit()
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_COMMAND, HTTPRequest.RESULT_SUCCESS, 200,
		'{"commandId":"cmd_prio_03","status":"executed","executedAtTick":44}'
	), "priority executed delivered")
	var prio_text: String = main.ui_command_text()
	t.contains(prio_text, "executed", "priority command reports executed")
	t.contains(prio_text, "priority set to 3", "priority command reports priority set to 3")

	# Deliver state with priority 3
	_node(main, "PollTimer").timeout.emit()
	var prio_state: Dictionary = JSON.parse_string(JSON.stringify(paused_state))
	prio_state["company"]["lines"][1]["priority"] = 3
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, JSON.stringify(prio_state)
	), "priority state delivered")
	t.contains(main.ui_line_rows()[1], "priority 3", "line row shows priority 3")

	# 3. Resume line 2
	resume_btn.pressed.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_LINE_CONTROL, "resume request in flight")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_LINE_CONTROL, HTTPRequest.RESULT_SUCCESS, 202,
		'{"commandId":"cmd_res_01","status":"queued"}'
	), "resume ack accepted")
	_node(main, "PollTimer").timeout.emit()
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_COMMAND, HTTPRequest.RESULT_SUCCESS, 200,
		'{"commandId":"cmd_res_01","status":"executed","executedAtTick":45}'
	), "resume executed delivered")
	var res_text: String = main.ui_command_text()
	t.contains(res_text, "executed", "resume command reports executed")
	t.contains(res_text, "resumed", "resume command reports resumed")

	# 4. Error handling on line control (non-fatal, shown without auto-retry)
	pause_btn.pressed.emit()
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_LINE_CONTROL, HTTPRequest.RESULT_SUCCESS, 403,
		'{"error":{"code":"FORBIDDEN","message":"Line not owned by company."}}'
	), "403 delivered")
	t.contains(main.ui_error_text(), "FORBIDDEN", "error label displays FORBIDDEN")
	t.contains(main.ui_error_text(), "Line not owned", "error label displays reason")
	_node(main, "PollTimer").timeout.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_STATE, "poll resumes normal state read, no retry")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, JSON.stringify(prio_state)
	), "state delivered after error")

	# 5. Engine rejection on line control command
	pause_btn.pressed.emit()
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_LINE_CONTROL, HTTPRequest.RESULT_SUCCESS, 202,
		'{"commandId":"cmd_pause_rej","status":"queued"}'
	), "pause ack accepted")
	_node(main, "PollTimer").timeout.emit()
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_COMMAND, HTTPRequest.RESULT_SUCCESS, 200,
		'{"commandId":"cmd_pause_rej","status":"rejected","executedAtTick":46,"errorCode":"ERR_LINE_NOT_FOUND"}'
	), "rejected status delivered")
	var rej_text: String = main.ui_command_text()
	t.contains(rej_text, "rejected", "rejection reported")
	t.contains(rej_text, "ERR_LINE_NOT_FOUND", "rejection error code reported")

	main.disconnect_from_server()
	get_root().remove_child(main)
	main.free()
	server.stop()


func _test_market_visibility_in_scene(t: TestSupport) -> void:
	var main := _instantiate()
	var offers_list: ItemList = _node(main, "OffersList")
	var contracts_list: ItemList = _node(main, "ContractsList")
	var market_tick_label: Label = _node(main, "MarketTickLabel")
	var contracts_tick_label: Label = _node(main, "ContractsTickLabel")
	var refresh_market_btn: Button = _node(main, "RefreshMarketButton")

	t.check(offers_list != null, "offers list exists")
	t.check(contracts_list != null, "contracts list exists")
	t.check(market_tick_label != null, "market tick label exists")
	t.check(contracts_tick_label != null, "contracts tick label exists")
	t.check(refresh_market_btn != null, "refresh market button exists")

	t.check(refresh_market_btn.disabled, "refresh market disabled before connection")
	t.contains(market_tick_label.text, "not connected", "market tick shows not connected")
	t.contains(contracts_tick_label.text, "not connected", "contracts tick shows not connected")

	# Direct rendering with fixtures
	var offers_parsed: Dictionary = FactoryProtocol.parse_market_offers(t.fixture("market_offers_ok.json"))
	main.apply_market_offers(offers_parsed["value"])
	var contracts_parsed: Dictionary = FactoryProtocol.parse_contracts(t.fixture("contracts_ok.json"))
	main.apply_contracts(contracts_parsed["value"])

	t.equal(main.ui_market_tick_text(), "Market (tick 42)", "market tick rendered")
	t.equal(main.ui_contracts_tick_text(), "Contracts (tick 42)", "contracts tick rendered")

	var offer_rows: PackedStringArray = main.ui_market_offer_rows()
	t.equal(offer_rows.size(), 2, "two market offer rows rendered")
	t.contains(offer_rows[0], "comp_metal_02", "offer row has seller")
	t.contains(offer_rows[0], "IRON_INGOT", "offer row has item")
	t.contains(offer_rows[0], "5", "offer row has quantity")
	t.contains(offer_rows[0], "22", "offer row has unit price")
	t.contains(offer_rows[0], "312", "offer row has deadline")

	var contract_rows: PackedStringArray = main.ui_contract_rows()
	t.equal(contract_rows.size(), 2, "two contract rows rendered")
	t.contains(contract_rows[0], "ACTIVE", "contract row has status")
	t.contains(contract_rows[0], "MEGAMACHINE_PART", "contract row has item")
	t.contains(contract_rows[0], "1/2", "contract row has delivered/total")
	t.contains(contract_rows[0], "206", "contract row has deadline")

	# Empty state rendering
	var empty_offers_parsed: Dictionary = FactoryProtocol.parse_market_offers(t.fixture("market_offers_empty.json"))
	main.apply_market_offers(empty_offers_parsed["value"])
	var empty_contracts_parsed: Dictionary = FactoryProtocol.parse_contracts(t.fixture("contracts_empty.json"))
	main.apply_contracts(empty_contracts_parsed["value"])

	var empty_offer_rows: PackedStringArray = main.ui_market_offer_rows()
	t.equal(empty_offer_rows.size(), 1, "empty offers renders 1 row")
	t.contains(empty_offer_rows[0], "No active market offers", "explicit empty offers message")

	var empty_contract_rows: PackedStringArray = main.ui_contract_rows()
	t.equal(empty_contract_rows.size(), 1, "empty contracts renders 1 row")
	t.contains(empty_contract_rows[0], "No contracts for this company", "explicit empty contracts message")

	# Network refresh cycle
	var server := TCPServer.new()
	if not t.equal(server.listen(0, "127.0.0.1"), OK, "market network test owns loopback"):
		get_root().remove_child(main)
		main.free()
		return
	var url := "http://127.0.0.1:%d" % server.get_local_port()
	_node(main, "UrlEdit").text = url
	_node(main, "TokenEdit").text = ENV_TOKEN
	_node(main, "ConnectButton").pressed.emit()
	var client: FactoryApiClient = main.get_client()
	var generation := client.get_generation()

	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_HEALTH, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("health_ok.json")
	), "market_net: health accepted")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("state_ok.json")
	), "market_net: initial snapshot accepted")

	t.check(not refresh_market_btn.disabled, "refresh market button enabled when connected")

	# Trigger refresh
	refresh_market_btn.pressed.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_MARKET_OFFERS, "refresh starts market offers exchange")
	t.check(refresh_market_btn.disabled, "refresh button disabled while in flight")
	t.check(_node(main, "StartButton").disabled, "start button disabled while market fetch in flight")

	# Deliver market offers 200 -> chains to contracts
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_MARKET_OFFERS, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("market_offers_ok.json")
	), "market_net: offers accepted")
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_CONTRACTS, "offers completion chains to contracts")

	# Deliver contracts 200
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_CONTRACTS, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("contracts_ok.json")
	), "market_net: contracts accepted")
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_NONE, "exchanges finished")
	t.check(not refresh_market_btn.disabled, "refresh button re-enabled")
	t.equal(main.ui_market_offer_rows().size(), 2, "two offers loaded via network")
	t.equal(main.ui_contract_rows().size(), 2, "two contracts loaded via network")

	# Non-fatal error handling: 500 on market read
	refresh_market_btn.pressed.emit()
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_MARKET_OFFERS, "second refresh started")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_MARKET_OFFERS, HTTPRequest.RESULT_SUCCESS, 500,
		'{"error":{"code":"INTERNAL_ERROR","message":"Market service unavailable."}}'
	), "500 delivered")
	t.contains(main.ui_error_text(), "INTERNAL_ERROR", "error label displays INTERNAL_ERROR")
	t.equal(client.get_connection_state(), FactoryApiClient.STATE_CONNECTED, "session stays connected")
	t.check(not refresh_market_btn.disabled, "refresh button restored")

	main.disconnect_from_server()
	t.contains(market_tick_label.text, "not connected", "disconnect clears market tick")
	t.contains(contracts_tick_label.text, "not connected", "disconnect clears contracts tick")
	t.equal(main.ui_market_offer_rows().size(), 0, "disconnect clears offers list")
	t.equal(main.ui_contract_rows().size(), 0, "disconnect clears contracts list")

	get_root().remove_child(main)
	main.free()
	server.stop()
