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
