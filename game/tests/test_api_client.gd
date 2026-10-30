extends SceneTree
## Observable rules for the HTTP session: credentials stay in memory, plaintext
## and redirects are refused, requests never overlap, and a stale session can
## never deliver payloads into a newer one.

const TestSupport = preload("res://tests/test_support.gd")
const TOKEN := "0123456789abcdef0123456789abcdef"
const UNREACHABLE_URL := "http://127.0.0.1:1"

var _host: Node
var _server: TCPServer
var _url: String
var _started: bool = false


func _process(_delta: float) -> bool:
	if _started:
		return true
	_started = true
	var t := TestSupport.new()
	_host = Node.new()
	_host.name = "ClientTestHost"
	get_root().add_child(_host)
	_server = TCPServer.new()
	if _server.listen(0, "127.0.0.1") != OK:
		t.check(false, "the test can open a loopback socket")
		quit(t.finish("test_api_client"))
		return true
	_url = "http://127.0.0.1:%d" % _server.get_local_port()
	_test_policy_gate(t)
	_test_session_lifecycle(t)
	_test_poll_and_production(t)
	_test_line_controls(t)
	_test_market_and_contracts_api(t)
	_test_redirect_refusal(t)
	_test_token_redaction(t)
	_test_malformed_state(t)
	_test_non_fatal_http_error(t)
	_server.stop()
	_host.free()
	quit(t.finish("test_api_client"))
	return true


func _make_client() -> FactoryApiClient:
	var client := FactoryApiClient.new()
	client.name = "FactoryApiClientUnderTest"
	_host.add_child(client)
	return client


func _dispose(client: FactoryApiClient) -> void:
	client.close_session("test finished")
	_host.remove_child(client)
	client.free()


func _connect_with_health(
	t: TestSupport, client: FactoryApiClient
) -> Dictionary:
	var opened: Dictionary = client.open_session(_url, TOKEN)
	if not t.check(opened["ok"], "session opens against a loopback url: %s" % str(opened["error"])):
		return {"ok": false}
	var generation: int = client.get_generation()
	var delivered: bool = client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_HEALTH, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("health_ok.json")
	)
	t.check(delivered, "health payload is accepted for the open session")
	t.equal(client.get_connection_state(), FactoryApiClient.STATE_CONNECTED, "compatible health marks the session connected")
	return {"ok": true, "generation": generation}


func _test_policy_gate(t: TestSupport) -> void:
	var client := _make_client()
	t.check(not client.follows_redirects(), "the HTTP client does not follow redirects")
	t.check(client.get_http_timeout_seconds() > 0.0, "requests carry a finite timeout")
	t.check(client.get_http_timeout_seconds() <= 10.0, "request timeout stays short")

	var plaintext: Dictionary = client.open_session("http://factory.example.com", TOKEN)
	t.check(not plaintext["ok"], "plaintext remote session is refused")
	t.contains(String(plaintext["error"]), "loopback", "refusal explains the loopback-only plaintext rule")
	t.equal(client.get_connection_state(), FactoryApiClient.STATE_DISCONNECTED, "refused session stays disconnected")
	t.check(not client.is_busy(), "refused session starts no request")
	t.check(not client.has_credentials(), "refused session stores no token")

	var short_token: Dictionary = client.open_session(UNREACHABLE_URL, "short")
	t.check(not short_token["ok"], "short token is refused before any request")
	t.not_contains(String(short_token["error"]), "short", "token refusal never echoes the supplied token")

	_dispose(client)


func _test_session_lifecycle(t: TestSupport) -> void:
	var client := _make_client()
	var opened: Dictionary = client.open_session(_url, TOKEN)
	t.check(opened["ok"], "loopback session opens")
	t.equal(client.get_connection_state(), FactoryApiClient.STATE_CONNECTING, "session starts in connecting state")
	t.check(client.is_busy(), "opening issues one pending exchange")
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_HEALTH, "the first exchange is the health check")
	t.check(client.has_credentials(), "the token is held in memory for the session")
	t.not_contains(client.describe_session(), TOKEN, "session description never prints the token")

	var second: Dictionary = client.open_session(_url, TOKEN)
	t.check(not second["ok"], "a second session cannot open over an active one")

	var generation: int = client.get_generation()
	client.close_session("disconnect for reconnect test")
	t.check(not client.is_busy(), "closing the session cancels the in-flight exchange")
	t.check(not client.has_credentials(), "closing the session releases the token")
	_equal_state(client.get_connection_state(), FactoryApiClient.STATE_DISCONNECTED, t, "closing leaves disconnected")

	var stale_delivered: bool = client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_HEALTH, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("health_ok.json")
	)
	t.check(not stale_delivered, "a payload from the old session is discarded")
	_equal_state(client.get_connection_state(), FactoryApiClient.STATE_DISCONNECTED, t, "stale payload cannot reconnect")

	var reopened: Dictionary = client.open_session(_url, TOKEN)
	t.check(reopened["ok"], "the session can be opened again after closing")
	t.check(client.get_generation() > generation, "reconnecting uses a new session generation")
	_dispose(client)


func _test_poll_and_production(t: TestSupport) -> void:
	var client := _make_client()
	var snapshots: Array = []
	var acks: Array = []
	var statuses: Array = []
	client.snapshot_received.connect(func(snapshot: FactorySnapshot) -> void: snapshots.append(snapshot))
	client.production_queued.connect(func(ack: Dictionary) -> void: acks.append(ack))
	client.command_status_changed.connect(func(command: Dictionary) -> void: statuses.append(command))

	var connected: Dictionary = _connect_with_health(t, client)
	if not connected["ok"]:
		_dispose(client)
		return
	var generation: int = connected["generation"]

	t.check(client.is_busy(), "the client asks for state right after a compatible health check")
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_STATE, "the second exchange reads state")
	t.check(not client.poll(), "polling refuses to overlap the pending request")
	t.check(not client.submit_production("comp_metal_01_line_2", "R1")["ok"], "production refuses to overlap the pending request")

	var delivered: bool = client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("state_ok.json")
	)
	t.check(delivered, "state payload is accepted")
	t.equal(snapshots.size(), 1, "state payload reaches the view once")
	t.equal(snapshots[0].match_id, "match_fixture_0001", "delivered snapshot is the server match")

	t.check(client.poll(), "polling starts a state exchange when idle")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("state_ok.json")
	), "second state payload is accepted")

	var invalid_line: Dictionary = client.submit_production("../etc/passwd", "R1")
	t.check(not invalid_line["ok"], "an unsafe line id never becomes a request")

	var submitted: Dictionary = client.submit_production("comp_metal_01_line_2", "R1")
	t.check(submitted["ok"], "a valid R1 request is submitted: %s" % str(submitted["error"]))
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_PRODUCTION, "production exchange is pending")
	t.check(not client.submit_production("comp_metal_01_line_2", "R1")["ok"], "a second production request is refused while busy")

	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_PRODUCTION, HTTPRequest.RESULT_SUCCESS, 202, t.fixture("ack_queued.json")
	), "queued acknowledgement is accepted")
	t.equal(acks.size(), 1, "queued acknowledgement is surfaced")
	t.equal(String(acks[0]["commandId"]), "cmd_fixture_queued", "acknowledgement keeps the server command id")

	t.check(client.poll_command("cmd_fixture_queued"), "command status polling starts when idle")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_COMMAND, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("command_executed.json")
	), "executed command status is accepted")
	t.equal(statuses.size(), 1, "command status is surfaced")
	t.equal(String(statuses[0]["status"]), "executed", "final status is reported as executed")
	t.check(client.poll_command("cmd with space") == false, "unsafe command ids are never requested")

	_dispose(client)


func _test_line_controls(t: TestSupport) -> void:
	var client := _make_client()
	var acks: Array = []
	client.line_control_queued.connect(func(ack: Dictionary) -> void: acks.append(ack))

	# Disconnected client refuses line controls
	t.check(not client.submit_line_pause("comp_metal_01_line_1")["ok"], "disconnected client refuses pause")
	t.check(not client.submit_line_resume("comp_metal_01_line_1")["ok"], "disconnected client refuses resume")
	t.check(not client.submit_line_priority("comp_metal_01_line_1", 2)["ok"], "disconnected client refuses priority")

	var connected: Dictionary = _connect_with_health(t, client)
	if not connected["ok"]:
		_dispose(client)
		return
	var generation: int = connected["generation"]

	# While state exchange is pending, line controls refuse to overlap
	t.check(not client.submit_line_pause("comp_metal_01_line_1")["ok"], "pause refuses to overlap state request")
	t.check(not client.submit_line_resume("comp_metal_01_line_1")["ok"], "resume refuses to overlap state request")
	t.check(not client.submit_line_priority("comp_metal_01_line_1", 1)["ok"], "priority refuses to overlap state request")

	# Deliver initial state
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("state_ok.json")
	), "state accepted")

	# Validation rejections
	t.check(not client.submit_line_pause("../bad")["ok"], "unsafe line id for pause is refused")
	t.check(not client.submit_line_resume("")["ok"], "empty line id for resume is refused")
	t.check(not client.submit_line_priority("comp_metal_01_line_1", 0)["ok"], "priority 0 is refused")
	t.check(not client.submit_line_priority("comp_metal_01_line_1", 4)["ok"], "priority 4 is refused")

	# Valid pause submission
	var pause_sub: Dictionary = client.submit_line_pause("comp_metal_01_line_1")
	t.check(pause_sub["ok"], "valid pause submitted: %s" % str(pause_sub.get("error", "")))
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_LINE_CONTROL, "line control exchange pending")
	t.check(not client.submit_line_pause("comp_metal_01_line_1")["ok"], "second pause refused while busy")
	t.check(not client.poll(), "poll refused while line control is busy")

	# Deliver 202 ack
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_LINE_CONTROL, HTTPRequest.RESULT_SUCCESS, 202,
		'{"commandId":"cmd_pause_ack_1","status":"queued"}'
	), "pause 202 ack accepted")
	t.equal(acks.size(), 1, "line_control_queued emitted")
	t.equal(String(acks[0]["commandId"]), "cmd_pause_ack_1", "ack command id matches")

	# Valid resume submission
	var resume_sub: Dictionary = client.submit_line_resume("comp_metal_01_line_1")
	t.check(resume_sub["ok"], "valid resume submitted: %s" % str(resume_sub.get("error", "")))
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_LINE_CONTROL, "resume exchange pending")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_LINE_CONTROL, HTTPRequest.RESULT_SUCCESS, 202,
		'{"commandId":"cmd_resume_ack_1","status":"queued"}'
	), "resume 202 ack accepted")
	t.equal(acks.size(), 2, "second line_control_queued emitted")

	# Valid priority submission
	var prio_sub: Dictionary = client.submit_line_priority("comp_metal_01_line_1", 3)
	t.check(prio_sub["ok"], "valid priority submitted: %s" % str(prio_sub.get("error", "")))
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_LINE_CONTROL, "priority exchange pending")
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_LINE_CONTROL, HTTPRequest.RESULT_SUCCESS, 202,
		'{"commandId":"cmd_prio_ack_1","status":"queued"}'
	), "priority 202 ack accepted")
	t.equal(acks.size(), 3, "third line_control_queued emitted")

	# Line control error handling (e.g. 403 Forbidden)
	var err_sub: Dictionary = client.submit_line_pause("comp_metal_01_line_1")
	t.check(err_sub["ok"], "pause for error test submitted")
	var error_received: Array = []
	client.request_failed.connect(func(msg: String, fatal: bool) -> void: error_received.append({"msg": msg, "fatal": fatal}))
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_LINE_CONTROL, HTTPRequest.RESULT_SUCCESS, 403,
		'{"error":{"code":"FORBIDDEN","message":"Line not owned."}}'
	), "403 error delivered")
	t.equal(error_received.size(), 1, "request_failed emitted for 403")
	t.check(not error_received[0]["fatal"], "403 is non-fatal")
	t.contains(error_received[0]["msg"], "FORBIDDEN", "error message contains code")
	t.equal(client.get_connection_state(), FactoryApiClient.STATE_CONNECTED, "session stays connected after non-fatal 403")

	_dispose(client)


func _test_market_and_contracts_api(t: TestSupport) -> void:
	var client := _make_client()
	var offers_events: Array = []
	var contracts_events: Array = []
	client.market_offers_received.connect(func(data: Dictionary) -> void: offers_events.append(data))
	client.contracts_received.connect(func(data: Dictionary) -> void: contracts_events.append(data))

	# Disconnected client refuses requests
	t.check(not client.poll_market_offers(), "disconnected client refuses poll_market_offers")
	t.check(not client.poll_contracts(), "disconnected client refuses poll_contracts")

	var connected: Dictionary = _connect_with_health(t, client)
	if not connected["ok"]:
		_dispose(client)
		return
	var generation: int = connected["generation"]

	# While state exchange is pending, market reads refuse to overlap
	t.check(not client.poll_market_offers(), "market offers refuses to overlap state request")
	t.check(not client.poll_contracts(), "contracts refuses to overlap state request")

	# Deliver state
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("state_ok.json")
	), "state accepted")

	# Poll market offers
	t.check(client.poll_market_offers(), "poll_market_offers starts exchange")
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_MARKET_OFFERS, "exchange is market_offers")
	t.check(not client.poll_contracts(), "contracts refuses to overlap market_offers")

	# Deliver market offers 200
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_MARKET_OFFERS, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("market_offers_ok.json")
	), "market offers accepted")
	t.equal(offers_events.size(), 1, "market_offers_received emitted")
	t.equal(int(offers_events[0].get("tick", -1)), 42, "market offers tick carried")

	# Poll contracts
	t.check(client.poll_contracts(), "poll_contracts starts exchange")
	t.equal(client.get_pending_exchange(), FactoryApiClient.EXCHANGE_CONTRACTS, "exchange is contracts")
	t.check(not client.poll_market_offers(), "market offers refuses to overlap contracts")

	# Deliver contracts 200
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_CONTRACTS, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("contracts_ok.json")
	), "contracts accepted")
	t.equal(contracts_events.size(), 1, "contracts_received emitted")
	t.equal(String(contracts_events[0].get("companyId")), "comp_metal_01", "contracts companyId carried")

	# Error handling on market read (e.g. 500 error is non-fatal)
	t.check(client.poll_market_offers(), "poll_market_offers starts for error test")
	var failures: Array = []
	client.request_failed.connect(func(msg: String, fatal: bool) -> void: failures.append({"msg": msg, "fatal": fatal}))
	t.check(client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_MARKET_OFFERS, HTTPRequest.RESULT_SUCCESS, 500,
		'{"error":{"code":"INTERNAL_ERROR","message":"Server error."}}'
	), "500 delivered")
	t.equal(failures.size(), 1, "request_failed emitted for 500")
	t.check(not failures[0]["fatal"], "500 is non-fatal")
	t.equal(client.get_connection_state(), FactoryApiClient.STATE_CONNECTED, "client stays connected after 500")

	_dispose(client)


func _test_redirect_refusal(t: TestSupport) -> void:
	var client := _make_client()
	var failures: Array = []
	client.request_failed.connect(func(message: String, fatal: bool) -> void: failures.append({"message": message, "fatal": fatal}))
	var connected: Dictionary = _connect_with_health(t, client)
	if not connected["ok"]:
		_dispose(client)
		return
	var generation: int = connected["generation"]

	var delivered: bool = client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 302, ""
	)
	t.check(delivered, "redirect response is consumed as a failure")
	t.equal(failures.size(), 1, "redirect reports exactly one failure")
	t.check(bool(failures[0]["fatal"]), "redirect is fatal for the session")
	t.contains(String(failures[0]["message"]), "redirect", "redirect failure names the refused redirect")
	_equal_state(client.get_connection_state(), FactoryApiClient.STATE_ERROR, t, "redirect leaves the session in error")
	t.check(not client.has_credentials(), "redirect drops the bearer token")
	_dispose(client)


func _test_token_redaction(t: TestSupport) -> void:
	var client := _make_client()
	var failures: Array = []
	client.request_failed.connect(func(message: String, fatal: bool) -> void: failures.append({"message": message, "fatal": fatal}))
	var opened: Dictionary = client.open_session(_url, TOKEN)
	t.check(opened["ok"], "session with the redaction token opens")
	var generation: int = client.get_generation()
	client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_HEALTH, HTTPRequest.RESULT_SUCCESS, 200, t.fixture("health_ok.json")
	)
	client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 401, t.fixture("error_echoes_token.json")
	)
	t.equal(failures.size(), 1, "unauthorized state reports one failure")
	var message := String(failures[0]["message"])
	t.not_contains(message, TOKEN, "an echoing server message cannot leak the token into the UI")
	t.contains(message, "[redacted]", "the token is redacted in server messages")
	t.contains(message, "UNAUTHORIZED", "the server error code is preserved")
	_equal_state(client.get_connection_state(), FactoryApiClient.STATE_ERROR, t, "unauthorized state ends the session")
	_dispose(client)


func _test_malformed_state(t: TestSupport) -> void:
	var client := _make_client()
	var failures: Array = []
	var snapshots: Array = []
	client.request_failed.connect(func(message: String, fatal: bool) -> void: failures.append({"message": message, "fatal": fatal}))
	client.snapshot_received.connect(func(snapshot: FactorySnapshot) -> void: snapshots.append(snapshot))
	var connected: Dictionary = _connect_with_health(t, client)
	if not connected["ok"]:
		_dispose(client)
		return
	var generation: int = connected["generation"]

	client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 200, "{\"protocolVersion\": 1,"
	)
	t.equal(failures.size(), 1, "malformed state reports one failure")
	t.check(bool(failures[0]["fatal"]), "malformed state ends the session instead of being displayed")
	t.equal(snapshots.size(), 0, "malformed state reaches no view")
	_equal_state(client.get_connection_state(), FactoryApiClient.STATE_ERROR, t, "malformed state leaves an error state")
	_dispose(client)


func _test_non_fatal_http_error(t: TestSupport) -> void:
	var client := _make_client()
	var failures: Array = []
	client.request_failed.connect(func(message: String, fatal: bool) -> void: failures.append({"message": message, "fatal": fatal}))
	var connected: Dictionary = _connect_with_health(t, client)
	if not connected["ok"]:
		_dispose(client)
		return
	var generation: int = connected["generation"]

	client.deliver_exchange_result(
		generation, FactoryApiClient.EXCHANGE_STATE, HTTPRequest.RESULT_SUCCESS, 500, "<html>boom</html>"
	)
	t.equal(failures.size(), 1, "server failure reports one failure")
	t.check(not bool(failures[0]["fatal"]), "a server-side failure keeps the session for retry")
	t.contains(String(failures[0]["message"]), "500", "server failure names the HTTP status")
	_equal_state(client.get_connection_state(), FactoryApiClient.STATE_CONNECTED, t, "retryable failure keeps the session")
	t.check(client.poll(), "the session can poll again after a retryable failure")
	_dispose(client)


func _equal_state(actual: String, expected: String, t: TestSupport, message: String) -> void:
	t.equal(actual, expected, message)
