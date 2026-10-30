extends Control
## Visible factory screen for the authoritative-factory slice.
##
## The screen only renders server snapshots and sends two kinds of requests:
## read state, and ask the server to start one R1 batch. It never ticks, never
## mutates resources and never keeps its own simulation.

const HELP_TEXT := """Server setup (the backend owns this factory)
1. Start the backend from the repository root with a real bearer token of 32+ characters, for example:
     export GF_API_TOKEN="$(openssl rand -hex 32)"
   See docs/factory-api.md for the exact backend entrypoint command.
2. Native development: the service listens on http://127.0.0.1:8787.
   Docker: `docker compose up --build` in the repository root publishes 127.0.0.1:8787 by default (loopback only).
3. Connect here with the same token, or launch Godot with GF_BACKEND_URL and GF_API_TOKEN exported.
There is no built-in token: without GF_API_TOKEN the backend refuses to start.
Plain http:// works only for loopback hosts; any remote backend must use https://.
This screen shows server snapshots only: ticks, credits, energy and inventory change on the server."""

const SMOKE_FLAG := "--smoke"
const POLL_INTERVAL_SECONDS := 1.0

var _url_edit: LineEdit
var _token_edit: LineEdit
var _connect_button: Button
var _disconnect_button: Button
var _status_label: Label
var _help_label: Label
var _match_label: Label
var _tick_label: Label
var _credits_label: Label
var _energy_label: Label
var _inventory_list: ItemList
var _lines_list: ItemList
var _recipes_list: ItemList
var _start_button: Button
var _pause_button: Button
var _resume_button: Button
var _priority_1_button: Button
var _priority_2_button: Button
var _priority_3_button: Button
var _action_hint: Label
var _command_label: Label
var _error_label: Label
var _poll_timer: Timer
var _offers_list: ItemList
var _contracts_list: ItemList
var _market_tick_label: Label
var _contracts_tick_label: Label
var _refresh_market_button: Button
var _auto_fetch_contracts: bool = false

var _client: FactoryApiClient
var _snapshot: FactorySnapshot
var _pending_command_id: String = ""
var _smoke: FactorySmoke
var _initialized: bool = false
var _tracked_line_id: String = ""
var _tracked_match_id: String = ""
var _baseline_total_batches: int = -1
var _last_executed_command_id: String = ""
var _last_executed_tick: int = -1
var _waiting_for_batch_completion: bool = false
var _last_action_kind: String = ""
var _last_action_line_id: String = ""
var _last_action_priority: int = -1


func _ready() -> void:
	setup()


## Wires the screen. Idempotent so headless checks can call it directly
## instead of relying on the scene tree's first frame.
func setup() -> void:
	if _initialized:
		return
	_initialized = true
	_url_edit = %UrlEdit
	_token_edit = %TokenEdit
	_connect_button = %ConnectButton
	_disconnect_button = %DisconnectButton
	_status_label = %StatusLabel
	_help_label = %HelpLabel
	_match_label = %MatchLabel
	_tick_label = %TickLabel
	_credits_label = %CreditsLabel
	_energy_label = %EnergyLabel
	_inventory_list = %InventoryList
	_lines_list = %LinesList
	_recipes_list = %RecipesList
	_start_button = %StartButton
	_pause_button = %PauseButton
	_resume_button = %ResumeButton
	_priority_1_button = %Priority1Button
	_priority_2_button = %Priority2Button
	_priority_3_button = %Priority3Button
	_action_hint = %ActionHint
	_command_label = %CommandLabel
	_error_label = %ErrorLabel
	_poll_timer = %PollTimer
	_offers_list = %OffersList
	_contracts_list = %ContractsList
	_market_tick_label = %MarketTickLabel
	_contracts_tick_label = %ContractsTickLabel
	_refresh_market_button = %RefreshMarketButton

	_help_label.text = HELP_TEXT
	_token_edit.secret = true
	_token_edit.placeholder_text = "Bearer token (never stored)"
	_url_edit.text = EndpointPolicy.backend_url_from_environment()
	var environment_token := EndpointPolicy.token_from_environment()
	if not environment_token.is_empty():
		_token_edit.text = environment_token
		_token_edit.placeholder_text = "Token loaded from GF_API_TOKEN"

	_client = FactoryApiClient.new()
	_client.name = "FactoryApiClient"
	add_child(_client)
	_client.connection_state_changed.connect(_on_connection_state_changed)
	_client.snapshot_received.connect(_on_snapshot_received)
	_client.production_queued.connect(_on_production_queued)
	_client.line_control_queued.connect(_on_line_control_queued)
	_client.command_status_changed.connect(_on_command_status_changed)
	_client.market_offers_received.connect(_on_market_offers_received)
	_client.contracts_received.connect(_on_contracts_received)
	_client.request_failed.connect(_on_request_failed)

	_connect_button.pressed.connect(_on_connect_pressed)
	_disconnect_button.pressed.connect(_on_disconnect_pressed)
	_refresh_market_button.pressed.connect(_on_refresh_market_pressed)
	_start_button.pressed.connect(_on_start_pressed)
	_pause_button.pressed.connect(_on_pause_pressed)
	_resume_button.pressed.connect(_on_resume_pressed)
	_priority_1_button.pressed.connect(func() -> void: _on_priority_pressed(1))
	_priority_2_button.pressed.connect(func() -> void: _on_priority_pressed(2))
	_priority_3_button.pressed.connect(func() -> void: _on_priority_pressed(3))
	_lines_list.item_selected.connect(_on_line_selected)
	_poll_timer.wait_time = POLL_INTERVAL_SECONDS
	_poll_timer.timeout.connect(_on_poll_timeout)

	_set_status("Disconnected", false)
	_disconnect_button.disabled = true
	_clear_snapshot_ui()
	_refresh_action_state()

	if OS.get_cmdline_user_args().has(SMOKE_FLAG):
		_smoke = FactorySmoke.new()
		_smoke.name = "FactorySmoke"
		add_child(_smoke)
		_smoke.start(self)


func get_client() -> FactoryApiClient:
	return _client


func get_snapshot() -> FactorySnapshot:
	return _snapshot


func is_connected_to_server() -> bool:
	if _client == null:
		return false
	var state := _client.get_connection_state()
	return state == FactoryApiClient.STATE_CONNECTED or state == FactoryApiClient.STATE_CONNECTING


func connect_to_server() -> Dictionary:
	if _client == null:
		return {"ok": false, "error": "The API client is not ready."}
	var opened := _client.open_session(_url_edit.text, _token_edit.text)
	if not opened["ok"]:
		_show_error(String(opened["error"]))
		return opened
	_error_label.text = ""
	_connect_button.disabled = true
	_disconnect_button.disabled = false
	if _poll_timer.is_stopped():
		_poll_timer.start()
	return opened


func disconnect_from_server() -> void:
	if _client != null:
		_client.close_session("Disconnected by the player.")
	if _poll_timer != null and not _poll_timer.is_stopped():
		_poll_timer.stop()
	_token_edit.text = ""
	_connect_button.disabled = false
	_disconnect_button.disabled = true
	_clear_snapshot_ui()
	_set_status("Disconnected", false)
	_refresh_action_state()


func apply_snapshot(snapshot: FactorySnapshot) -> void:
	if snapshot == null:
		_clear_snapshot_ui()
		return
	_snapshot = snapshot
	_match_label.text = FactoryViewModel.match_text(snapshot)
	_tick_label.text = FactoryViewModel.tick_text(snapshot)
	_credits_label.text = FactoryViewModel.credits_text(snapshot)
	_energy_label.text = FactoryViewModel.energy_text(snapshot)
	_fill_list(_inventory_list, FactoryViewModel.inventory_rows(snapshot))
	_fill_list(_recipes_list, FactoryViewModel.recipe_rows(snapshot))
	var previous_selection := _lines_list.get_selected_items()
	_fill_list(_lines_list, FactoryViewModel.line_rows(snapshot))
	if not previous_selection.is_empty() and previous_selection[0] < _lines_list.item_count:
		_lines_list.select(previous_selection[0])
	_error_label.text = ""

	if _waiting_for_batch_completion and not _tracked_line_id.is_empty():
		if snapshot.match_id != _tracked_match_id:
			_waiting_for_batch_completion = false
			_tracked_line_id = ""
			_tracked_match_id = ""
			_baseline_total_batches = -1
		else:
			var line: Dictionary = snapshot.line(_tracked_line_id)
			if not line.is_empty():
				var current_batches := int(line.get("totalBatchesProduced", 0))
				if current_batches > _baseline_total_batches:
					_waiting_for_batch_completion = false
					_command_label.text = "Server executed %s on tick %d; line %s completed batch (total produced: %d)." % [
						_last_executed_command_id, _last_executed_tick, _tracked_line_id, current_batches
					]
					_baseline_total_batches = current_batches

	_refresh_action_state()


func apply_market_offers(data: Dictionary) -> void:
	if _market_tick_label != null:
		_market_tick_label.text = FactoryViewModel.market_tick_text(data)
	if _offers_list != null:
		_fill_list(_offers_list, FactoryViewModel.market_offer_rows(data))


func apply_contracts(data: Dictionary) -> void:
	if _contracts_tick_label != null:
		_contracts_tick_label.text = FactoryViewModel.contracts_tick_text(data)
	if _contracts_list != null:
		_fill_list(_contracts_list, FactoryViewModel.contract_rows(data))


func ui_status_text() -> String:
	return _status_label.text


func ui_inventory_rows() -> PackedStringArray:
	var rows := PackedStringArray()
	for index in _inventory_list.item_count:
		rows.append(_inventory_list.get_item_text(index))
	return rows


func ui_command_text() -> String:
	return _command_label.text


func ui_error_text() -> String:
	return _error_label.text


func ui_line_rows() -> PackedStringArray:
	var rows := PackedStringArray()
	for index in _lines_list.item_count:
		rows.append(_lines_list.get_item_text(index))
	return rows


func ui_market_offer_rows() -> PackedStringArray:
	var rows := PackedStringArray()
	if _offers_list != null:
		for index in _offers_list.item_count:
			rows.append(_offers_list.get_item_text(index))
	return rows


func ui_contract_rows() -> PackedStringArray:
	var rows := PackedStringArray()
	if _contracts_list != null:
		for index in _contracts_list.item_count:
			rows.append(_contracts_list.get_item_text(index))
	return rows


func ui_market_tick_text() -> String:
	return _market_tick_label.text if _market_tick_label != null else ""


func ui_contracts_tick_text() -> String:
	return _contracts_tick_label.text if _contracts_tick_label != null else ""


## Runs the same handler the Start button uses, after selecting the line in the
## visible list. The real-backend smoke uses this so the checked path is the UI.
func press_start(line_id: String = "") -> void:
	if _snapshot != null and not line_id.is_empty():
		for index in _snapshot.lines.size():
			if String(_snapshot.lines[index].get("lineId", "")) == line_id:
				_lines_list.select(index)
				break
	_on_start_pressed()


func _on_connect_pressed() -> void:
	connect_to_server()


func _on_disconnect_pressed() -> void:
	disconnect_from_server()


func _on_connection_state_changed(state: String, message: String) -> void:
	match state:
		FactoryApiClient.STATE_CONNECTING:
			_set_status("Connecting to %s ..." % _client.get_base_url(), false)
		FactoryApiClient.STATE_CONNECTED:
			_set_status("Connected: %s" % _client.get_base_url(), false)
			_error_label.text = ""
			_refresh_action_state()
		FactoryApiClient.STATE_ERROR:
			_set_status("Connection error", true)
			_show_error(message)
			_poll_timer.stop()
			_connect_button.disabled = false
			_disconnect_button.disabled = true
			_token_edit.text = ""
			_clear_snapshot_ui()
			_refresh_action_state()
		FactoryApiClient.STATE_DISCONNECTED:
			_set_status("Disconnected", false)
			_poll_timer.stop()
			_connect_button.disabled = false
			_disconnect_button.disabled = true
			_token_edit.text = ""
			_clear_snapshot_ui()
			_refresh_action_state()


func _on_snapshot_received(snapshot: FactorySnapshot) -> void:
	apply_snapshot(snapshot)


func _on_production_queued(ack: Dictionary) -> void:
	_pending_command_id = String(ack.get("commandId", ""))
	_command_label.text = "Server queued command %s; it executes on the next server tick." % _pending_command_id
	_refresh_action_state()


func _on_line_control_queued(ack: Dictionary) -> void:
	_pending_command_id = String(ack.get("commandId", ""))
	_command_label.text = "Server queued command %s; waiting for the server tick." % _pending_command_id
	_refresh_action_state()


func _on_command_status_changed(command: Dictionary) -> void:
	var command_id := String(command.get("commandId", ""))
	var status := String(command.get("status", ""))
	if status == "queued":
		_command_label.text = "Command %s is queued; waiting for the server tick." % command_id
		return
	if _pending_command_id == command_id:
		_pending_command_id = ""
	if status == "executed":
		_last_executed_command_id = command_id
		_last_executed_tick = int(command.get("executedAtTick", -1))
		match _last_action_kind:
			"pause":
				_command_label.text = "Server executed %s on tick %d; line %s paused." % [
					command_id, _last_executed_tick, _last_action_line_id
				]
			"resume":
				_command_label.text = "Server executed %s on tick %d; line %s resumed." % [
					command_id, _last_executed_tick, _last_action_line_id
				]
			"priority":
				_command_label.text = "Server executed %s on tick %d; line %s priority set to %d." % [
					command_id, _last_executed_tick, _last_action_line_id, _last_action_priority
				]
			_:
				_waiting_for_batch_completion = not _tracked_line_id.is_empty()
				_command_label.text = "Server executed %s on tick %d; production target applied." % [
					command_id, _last_executed_tick
				]
	elif status == "rejected":
		_waiting_for_batch_completion = false
		_tracked_line_id = ""
		_command_label.text = "Server rejected %s with %s." % [
			command_id, String(command.get("errorCode", "an engine error"))
		]
	_refresh_action_state()


func _on_request_failed(message: String, fatal: bool) -> void:
	_auto_fetch_contracts = false
	if not fatal and not _pending_command_id.is_empty():
		# A lost status response does not prove that the economic command failed.
		var unknown_command := _pending_command_id
		_clear_snapshot_ui()
		_command_label.text = "Command %s status is unknown; refreshing server state. No production was retried." % unknown_command
	_show_error(message)
	if fatal:
		_poll_timer.stop()
		_connect_button.disabled = false
		_disconnect_button.disabled = true
		_token_edit.text = ""
	_refresh_action_state()


func refresh_market() -> bool:
	if _client == null or _client.get_connection_state() != FactoryApiClient.STATE_CONNECTED:
		_show_error("Connect to the server before refreshing market.")
		return false
	if _client.is_busy():
		return false
	_auto_fetch_contracts = true
	var started := _client.poll_market_offers()
	if not started:
		_auto_fetch_contracts = false
	_refresh_action_state()
	return started


func _on_refresh_market_pressed() -> void:
	refresh_market()


func _on_market_offers_received(data: Dictionary) -> void:
	apply_market_offers(data)
	if _auto_fetch_contracts:
		var started := _client.poll_contracts()
		if not started:
			_auto_fetch_contracts = false
			_refresh_action_state()
	else:
		_refresh_action_state()


func _on_contracts_received(data: Dictionary) -> void:
	apply_contracts(data)
	_auto_fetch_contracts = false
	_refresh_action_state()


func _on_start_pressed() -> void:
	if _client == null or _client.get_connection_state() != FactoryApiClient.STATE_CONNECTED:
		_show_error("Connect to the server before starting production.")
		return
	if _snapshot == null:
		_show_error("No server snapshot yet; wait for the first state read.")
		return
	var action := FactoryViewModel.action_state(_snapshot)
	if not action["can_start"]:
		_show_error(String(action["reason"]))
		return
	var line_id := String(action["line_id"])
	var selected := _lines_list.get_selected_items()
	if not selected.is_empty() and selected[0] < _snapshot.lines.size():
		line_id = String(_snapshot.lines[selected[0]].get("lineId", line_id))
	_start_button.disabled = true
	var submitted := _client.submit_production(line_id, String(action["recipe_id"]))
	if not submitted["ok"]:
		_start_button.disabled = false
		_show_error(String(submitted["error"]))
		return
	_tracked_line_id = line_id
	_tracked_match_id = _snapshot.match_id
	_baseline_total_batches = int(_snapshot.line(line_id).get("totalBatchesProduced", 0))
	_waiting_for_batch_completion = false
	_last_action_kind = "production"
	_last_action_line_id = line_id
	_last_action_priority = -1
	_last_executed_command_id = ""
	_last_executed_tick = -1
	_error_label.text = ""
	_command_label.text = "Requesting one R1 batch on %s ..." % line_id


func _on_pause_pressed() -> void:
	_submit_line_control("pause")


func _on_resume_pressed() -> void:
	_submit_line_control("resume")


func _on_priority_pressed(priority: int) -> void:
	_submit_line_control("priority", priority)


func _submit_line_control(action: String, priority: int = 0) -> void:
	if _client == null or _client.get_connection_state() != FactoryApiClient.STATE_CONNECTED:
		_show_error("Connect to the server before controlling a line.")
		return
	if _snapshot == null:
		_show_error("No server snapshot yet; wait for the first state read.")
		return
	var line_id := _get_selected_line_id()
	if line_id.is_empty():
		_show_error("No production line selected.")
		return

	_start_button.disabled = true
	if _pause_button != null:
		_pause_button.disabled = true
	if _resume_button != null:
		_resume_button.disabled = true
	if _priority_1_button != null:
		_priority_1_button.disabled = true
	if _priority_2_button != null:
		_priority_2_button.disabled = true
	if _priority_3_button != null:
		_priority_3_button.disabled = true

	var submitted: Dictionary
	match action:
		"pause":
			submitted = _client.submit_line_pause(line_id)
		"resume":
			submitted = _client.submit_line_resume(line_id)
		"priority":
			submitted = _client.submit_line_priority(line_id, priority)
		_:
			return

	if not submitted["ok"]:
		_refresh_action_state()
		_show_error(String(submitted["error"]))
		return

	_last_action_kind = action
	_last_action_line_id = line_id
	_last_action_priority = priority
	_last_executed_command_id = ""
	_last_executed_tick = -1
	_error_label.text = ""

	match action:
		"pause":
			_command_label.text = "Requesting pause on %s ..." % line_id
		"resume":
			_command_label.text = "Requesting resume on %s ..." % line_id
		"priority":
			_command_label.text = "Requesting priority %d on %s ..." % [priority, line_id]


func _get_selected_line_id() -> String:
	if _snapshot == null or _snapshot.lines.is_empty():
		return ""
	var selected := _lines_list.get_selected_items()
	if not selected.is_empty() and selected[0] < _snapshot.lines.size():
		return String(_snapshot.lines[selected[0]].get("lineId", ""))
	return String(_snapshot.lines[0].get("lineId", ""))


func press_pause(line_id: String = "") -> void:
	_select_line_by_id(line_id)
	_on_pause_pressed()


func press_resume(line_id: String = "") -> void:
	_select_line_by_id(line_id)
	_on_resume_pressed()


func press_priority(priority: int, line_id: String = "") -> void:
	_select_line_by_id(line_id)
	_on_priority_pressed(priority)


func _select_line_by_id(line_id: String) -> void:
	if _snapshot != null and not line_id.is_empty():
		for index in _snapshot.lines.size():
			if String(_snapshot.lines[index].get("lineId", "")) == line_id:
				_lines_list.select(index)
				break


func _on_line_selected(_index: int) -> void:
	_refresh_action_state()


func _on_poll_timeout() -> void:
	if _client == null or _client.get_connection_state() != FactoryApiClient.STATE_CONNECTED:
		return
	if not _pending_command_id.is_empty():
		_client.poll_command(_pending_command_id)
	else:
		_client.poll()


func _refresh_action_state() -> void:
	var action := FactoryViewModel.action_state(_snapshot)
	var connected := _client != null and _client.get_connection_state() == FactoryApiClient.STATE_CONNECTED
	var busy := _client != null and (_client.is_busy() or not _pending_command_id.is_empty())
	_start_button.disabled = not bool(action["can_start"]) or not connected or busy
	_action_hint.text = String(action["reason"])

	var selected_line_id := _get_selected_line_id()
	var can_control := connected and not busy and not selected_line_id.is_empty()
	if _pause_button != null:
		_pause_button.disabled = not can_control
	if _resume_button != null:
		_resume_button.disabled = not can_control
	if _priority_1_button != null:
		_priority_1_button.disabled = not can_control
	if _priority_2_button != null:
		_priority_2_button.disabled = not can_control
	if _priority_3_button != null:
		_priority_3_button.disabled = not can_control
	if _refresh_market_button != null:
		_refresh_market_button.disabled = not connected or busy


func _fill_list(list: ItemList, rows: PackedStringArray) -> void:
	list.clear()
	for row in rows:
		list.add_item(row)


func _clear_snapshot_ui() -> void:
	_snapshot = null
	_pending_command_id = ""
	_tracked_line_id = ""
	_tracked_match_id = ""
	_baseline_total_batches = -1
	_waiting_for_batch_completion = false
	_last_executed_command_id = ""
	_last_executed_tick = -1
	_last_action_kind = ""
	_last_action_line_id = ""
	_last_action_priority = -1
	if _pause_button != null:
		_pause_button.disabled = true
	if _resume_button != null:
		_resume_button.disabled = true
	if _priority_1_button != null:
		_priority_1_button.disabled = true
	if _priority_2_button != null:
		_priority_2_button.disabled = true
	if _priority_3_button != null:
		_priority_3_button.disabled = true
	_match_label.text = "Match: not connected"
	_tick_label.text = "Tick: not connected"
	_credits_label.text = "Credits: not connected"
	_energy_label.text = "Energy: not connected"
	_inventory_list.clear()
	_lines_list.clear()
	_recipes_list.clear()
	if _offers_list != null:
		_offers_list.clear()
	if _contracts_list != null:
		_contracts_list.clear()
	if _market_tick_label != null:
		_market_tick_label.text = "Market: not connected"
	if _contracts_tick_label != null:
		_contracts_tick_label.text = "Contracts: not connected"
	if _refresh_market_button != null:
		_refresh_market_button.disabled = true
	_auto_fetch_contracts = false
	_command_label.text = ""
	_action_hint.text = FactoryViewModel.NO_SNAPSHOT_REASON


func _set_status(text: String, is_error: bool) -> void:
	_status_label.text = text
	var colour := Color(0.92, 0.45, 0.42) if is_error else Color(0.85, 0.88, 0.92)
	_status_label.add_theme_color_override("font_color", colour)


func _show_error(message: String) -> void:
	_error_label.text = message
