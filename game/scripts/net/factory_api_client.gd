class_name FactoryApiClient
extends Node
## Bearer-authenticated HTTP session with the authoritative factory backend.
##
## Rules this node enforces for the client:
## - the token lives only in memory and never appears in a URL or a message;
## - plaintext HTTP is only used for loopback hosts (see EndpointPolicy);
## - redirects are not followed, so credentials cannot be replayed elsewhere;
## - at most one request is in flight, so polling can never overlap;
## - closing a session bumps a generation counter, and payloads from an older
##   generation are discarded instead of acting on the new session.
##
## The node performs no simulation. It only transports and validates payloads.

signal connection_state_changed(state: String, message: String)
signal snapshot_received(snapshot: FactorySnapshot)
signal production_queued(ack: Dictionary)
signal line_control_queued(ack: Dictionary)
signal command_status_changed(command: Dictionary)
signal market_offers_received(offers_data: Dictionary)
signal contracts_received(contracts_data: Dictionary)
signal owner_session_opened(meta: Dictionary)
signal owner_selling_received(selling_data: Dictionary)
signal owner_command_queued(ack: Dictionary)
signal request_failed(message: String, fatal: bool)

const EXCHANGE_NONE := ""
const EXCHANGE_HEALTH := "health"
const EXCHANGE_STATE := "state"
const EXCHANGE_PRODUCTION := "production"
const EXCHANGE_LINE_CONTROL := "line_control"
const EXCHANGE_COMMAND := "command"
const EXCHANGE_MARKET_OFFERS := "market_offers"
const EXCHANGE_CONTRACTS := "contracts"
const EXCHANGE_OWNER_SESSION := "owner_session"
const EXCHANGE_OWNER_SELLING := "owner_selling"
const EXCHANGE_OWNER_DRAFT := "owner_draft"
const EXCHANGE_OWNER_PUBLISH := "owner_publish"
const EXCHANGE_OWNER_CANCEL := "owner_cancel"
const EXCHANGE_OWNER_DISPATCH := "owner_dispatch"

## Which credential one exchange may present. The root session and the owner
## session never share a request: reads use the root bearer, the seller loop
## uses the short-lived owner bearer.
const AUTH_NONE := ""
const AUTH_ROOT := "root"
const AUTH_OWNER := "owner"

const STATE_DISCONNECTED := "disconnected"
const STATE_CONNECTING := "connecting"
const STATE_CONNECTED := "connected"
const STATE_ERROR := "error"

const PATH_HEALTH := "/health"
const PATH_STATE := "/v1/state"
const PATH_PRODUCTION := "/v1/production"
const PATH_COMMANDS := "/v1/commands/"
const PATH_MARKET_OFFERS := "/v1/market/offers"
const PATH_CONTRACTS := "/v1/contracts"

const HTTP_TIMEOUT_SECONDS := 5.0
const NO_REDIRECTS := 0
const MAX_ERROR_MESSAGE_LENGTH := 240

var _http: HTTPRequest
var _base_url: String = ""
var _token: String = ""
var _owner_token: String = ""
var _generation: int = 0
var _exchange: String = EXCHANGE_NONE
var _exchange_generation: int = 0
var _connection_state: String = STATE_DISCONNECTED
var _request_counter: int = 0
var _http_started: bool = false
var _serial: int = 0
var _in_flight_serial: int = 0


func _init() -> void:
	_http = HTTPRequest.new()
	_http.name = "HttpRequest"
	_http.max_redirects = NO_REDIRECTS
	_http.timeout = HTTP_TIMEOUT_SECONDS
	_http.use_threads = false
	add_child(_http)
	_http.request_completed.connect(_on_request_completed)


func open_session(url: String, token: String) -> Dictionary:
	if _connection_state == STATE_CONNECTING or _connection_state == STATE_CONNECTED:
		return {"ok": false, "error": "A session is already open. Disconnect before connecting again."}
	var policy := EndpointPolicy.validate_backend_url(url)
	if not policy["ok"]:
		return {"ok": false, "error": String(policy["error"])}
	var token_policy := EndpointPolicy.validate_token(token)
	if not token_policy["ok"]:
		return {"ok": false, "error": String(token_policy["error"])}

	_base_url = String(policy["url"])
	_token = token
	_owner_token = ""
	_generation += 1
	_exchange = EXCHANGE_NONE
	_http_started = false
	_set_connection_state(STATE_CONNECTING, "Contacting %s" % _base_url)
	if not _begin_exchange(EXCHANGE_HEALTH, PATH_HEALTH, HTTPClient.METHOD_GET, "", AUTH_NONE):
		_fail("The client could not start its health request to %s." % _base_url, true)
		return {"ok": false, "error": "The client could not start its health request."}
	return {"ok": true, "error": ""}


func close_session(reason: String) -> void:
	if _connection_state == STATE_DISCONNECTED:
		return
	_cancel_transport()
	_exchange = EXCHANGE_NONE
	_generation += 1
	_token = ""
	_owner_token = ""
	_connection_state = STATE_DISCONNECTED
	connection_state_changed.emit(STATE_DISCONNECTED, reason)


func poll() -> bool:
	if _connection_state != STATE_CONNECTED or is_busy():
		return false
	return _begin_exchange(EXCHANGE_STATE, PATH_STATE, HTTPClient.METHOD_GET, "", AUTH_ROOT)


func poll_command(command_id: String) -> bool:
	if _connection_state != STATE_CONNECTED or is_busy():
		return false
	if not FactoryProtocol.is_safe_identifier(command_id, FactoryProtocol.MAX_IDENTIFIER_LENGTH):
		return false
	return _begin_exchange(EXCHANGE_COMMAND, PATH_COMMANDS + command_id, HTTPClient.METHOD_GET, "", AUTH_ROOT)


func submit_production(line_id: String, recipe_id: String) -> Dictionary:
	if _connection_state != STATE_CONNECTED:
		return {"ok": false, "error": "Connect to the server before starting production."}
	if is_busy():
		return {"ok": false, "error": "A request is already in flight; try again in a moment."}
	_request_counter += 1
	var request_id := FactoryProtocol.build_request_id("godot", _request_counter)
	var payload := FactoryProtocol.build_production_request(request_id, line_id, recipe_id)
	if not payload["ok"]:
		return {"ok": false, "error": String(payload["error"])}
	if not _begin_exchange(EXCHANGE_PRODUCTION, PATH_PRODUCTION, HTTPClient.METHOD_POST, String(payload["value"]), AUTH_ROOT):
		return {"ok": false, "error": "The client could not start its production request."}
	return {"ok": true, "error": ""}


func submit_line_pause(line_id: String) -> Dictionary:
	return _submit_line_control(line_id, "pause")


func submit_line_resume(line_id: String) -> Dictionary:
	return _submit_line_control(line_id, "resume")


func submit_line_priority(line_id: String, priority: int) -> Dictionary:
	return _submit_line_control(line_id, "priority", priority)


func _submit_line_control(line_id: String, action: String, priority: int = 0) -> Dictionary:
	if _connection_state != STATE_CONNECTED:
		return {"ok": false, "error": "Connect to the server before controlling a line."}
	if is_busy():
		return {"ok": false, "error": "A request is already in flight; try again in a moment."}
	if not FactoryProtocol.is_safe_identifier(line_id, FactoryProtocol.MAX_IDENTIFIER_LENGTH):
		return {"ok": false, "error": "lineId must be a server-provided line identifier using A-Z, a-z, 0-9, '_' or '-'."}

	_request_counter += 1
	var request_id := FactoryProtocol.build_request_id("godot", _request_counter)
	var payload: Dictionary
	var path: String
	match action:
		"pause":
			payload = FactoryProtocol.build_line_pause_request(request_id)
			path = FactoryProtocol.line_pause_path(line_id)
		"resume":
			payload = FactoryProtocol.build_line_resume_request(request_id)
			path = FactoryProtocol.line_resume_path(line_id)
		"priority":
			payload = FactoryProtocol.build_line_priority_request(request_id, priority)
			path = FactoryProtocol.line_priority_path(line_id)
		_:
			return {"ok": false, "error": "Unknown line control action: %s" % action}

	if not payload["ok"]:
		return {"ok": false, "error": String(payload["error"])}
	if path.is_empty():
		return {"ok": false, "error": "Invalid line identifier."}

	if not _begin_exchange(EXCHANGE_LINE_CONTROL, path, HTTPClient.METHOD_POST, String(payload["value"]), AUTH_ROOT):
		return {"ok": false, "error": "The client could not start its line control request."}
	return {"ok": true, "error": ""}


func poll_market_offers() -> bool:
	if _connection_state != STATE_CONNECTED or is_busy():
		return false
	return _begin_exchange(EXCHANGE_MARKET_OFFERS, PATH_MARKET_OFFERS, HTTPClient.METHOD_GET, "", AUTH_ROOT)


func poll_contracts() -> bool:
	if _connection_state != STATE_CONNECTED or is_busy():
		return false
	return _begin_exchange(EXCHANGE_CONTRACTS, PATH_CONTRACTS, HTTPClient.METHOD_GET, "", AUTH_ROOT)


## Exchanges the root bearer for one short-lived owner session. The session
## token is kept in memory only; the root bearer is what authorizes this call.
func open_owner_session() -> Dictionary:
	if _connection_state != STATE_CONNECTED:
		return {"ok": false, "error": "Connect to the server before opening an owner session."}
	if is_busy():
		return {"ok": false, "error": "A request is already in flight; try again in a moment."}
	if not _begin_exchange(EXCHANGE_OWNER_SESSION, FactoryProtocol.OWNER_SESSION_PATH, HTTPClient.METHOD_POST, "", AUTH_ROOT):
		return {"ok": false, "error": "The client could not start its owner session request."}
	return {"ok": true, "error": ""}


## Local sign-out: the token is dropped here and lapses on the server deadline.
func close_owner_session() -> void:
	_owner_token = ""


func has_owner_session() -> bool:
	return not _owner_token.is_empty()


## Reads the seller loop: own contracts with engine consequences and the
## acting company's recent command outcomes.
func poll_owner_selling() -> bool:
	if _connection_state != STATE_CONNECTED or is_busy() or not has_owner_session():
		return false
	return _begin_exchange(
		EXCHANGE_OWNER_SELLING, FactoryProtocol.OWNER_SELLING_PATH, HTTPClient.METHOD_GET, "", AUTH_OWNER
	)


func draft_offer(
	item_id: String,
	quantity: int,
	unit_price_credits: int,
	deadline_tick: int,
	target_buyer_id: String = ""
) -> Dictionary:
	var guard := _owner_write_guard("drafting an offer")
	if not guard["ok"]:
		return guard
	var key := _next_idempotency_key("sell_draft")
	var payload := FactoryProtocol.build_owner_draft_request(
		key, item_id, quantity, unit_price_credits, deadline_tick, target_buyer_id
	)
	if not payload["ok"]:
		return {"ok": false, "error": String(payload["error"])}
	if not _begin_exchange(
		EXCHANGE_OWNER_DRAFT,
		FactoryProtocol.OWNER_CONTRACTS_PATH,
		HTTPClient.METHOD_POST,
		String(payload["value"]),
		AUTH_OWNER
	):
		return {"ok": false, "error": "The client could not start its draft offer request."}
	return {"ok": true, "error": "", "idempotencyKey": key}


func publish_offer(contract_id: String) -> Dictionary:
	return _submit_owner_contract_action(contract_id, "publish")


func cancel_offer(contract_id: String) -> Dictionary:
	return _submit_owner_contract_action(contract_id, "cancel")


func dispatch_offer(contract_id: String, quantity_to_ship: int) -> Dictionary:
	var guard := _owner_write_guard("dispatching goods")
	if not guard["ok"]:
		return guard
	var key := _next_idempotency_key("sell_dispatch")
	var payload := FactoryProtocol.build_owner_dispatch_request(key, quantity_to_ship)
	if not payload["ok"]:
		return {"ok": false, "error": String(payload["error"])}
	var path := FactoryProtocol.owner_contract_path(contract_id, "dispatch")
	if path.is_empty():
		return {"ok": false, "error": "Invalid contract identifier."}
	if not _begin_exchange(
		EXCHANGE_OWNER_DISPATCH, path, HTTPClient.METHOD_POST, String(payload["value"]), AUTH_OWNER
	):
		return {"ok": false, "error": "The client could not start its dispatch request."}
	return {"ok": true, "error": "", "idempotencyKey": key}


func _submit_owner_contract_action(contract_id: String, action: String) -> Dictionary:
	var guard := _owner_write_guard("%s an offer" % action)
	if not guard["ok"]:
		return guard
	var key := _next_idempotency_key("sell_%s" % action)
	var payload := FactoryProtocol.build_owner_action_request(key)
	if not payload["ok"]:
		return {"ok": false, "error": String(payload["error"])}
	var path := FactoryProtocol.owner_contract_path(contract_id, action)
	if path.is_empty():
		return {"ok": false, "error": "Invalid contract identifier."}
	var kind := EXCHANGE_OWNER_PUBLISH if action == "publish" else EXCHANGE_OWNER_CANCEL
	if not _begin_exchange(kind, path, HTTPClient.METHOD_POST, String(payload["value"]), AUTH_OWNER):
		return {"ok": false, "error": "The client could not start its %s request." % action}
	return {"ok": true, "error": "", "idempotencyKey": key}


func _owner_write_guard(action: String) -> Dictionary:
	if _connection_state != STATE_CONNECTED:
		return {"ok": false, "error": "Connect to the server before %s." % action}
	if not has_owner_session():
		return {"ok": false, "error": "Open an owner session before %s." % action}
	if is_busy():
		return {"ok": false, "error": "A request is already in flight; try again in a moment."}
	return {"ok": true, "error": ""}


## One caller key per financial command: durable admission refuses reuse.
func _next_idempotency_key(prefix: String) -> String:
	_request_counter += 1
	return FactoryProtocol.build_request_id(prefix, _request_counter)


## Applies one finished response. Public so tests can exercise the session rules
## without a live server; the HTTP callback uses the same path.
func deliver_exchange_result(
	generation: int, kind: String, http_result: int, response_code: int, body: String, serial: int = -1
) -> bool:
	if generation != _generation:
		return false
	if kind == EXCHANGE_NONE or kind != _exchange:
		return false
	if serial >= 0 and serial != _in_flight_serial:
		return false
	_exchange = EXCHANGE_NONE
	if _http_started:
		_http.cancel_request()
	_http_started = false
	if http_result != HTTPRequest.RESULT_SUCCESS:
		_fail(
			"Network error contacting %s (%s). Is the backend running?" % [_base_url, _result_name(http_result)],
			kind == EXCHANGE_HEALTH
		)
		return true
	if _is_redirect(response_code):
		_fail(
			"Refused HTTP %d redirect: this client never replays a bearer token to another location." % response_code,
			true
		)
		return true
	match kind:
		EXCHANGE_HEALTH:
			_handle_health(response_code, body)
		EXCHANGE_STATE:
			_handle_state(response_code, body)
		EXCHANGE_PRODUCTION:
			_handle_production(response_code, body)
		EXCHANGE_LINE_CONTROL:
			_handle_line_control(response_code, body)
		EXCHANGE_COMMAND:
			_handle_command(response_code, body)
		EXCHANGE_MARKET_OFFERS:
			_handle_market_offers(response_code, body)
		EXCHANGE_CONTRACTS:
			_handle_contracts(response_code, body)
		EXCHANGE_OWNER_SESSION:
			_handle_owner_session(response_code, body)
		EXCHANGE_OWNER_SELLING:
			_handle_owner_selling(response_code, body)
		EXCHANGE_OWNER_DRAFT, EXCHANGE_OWNER_PUBLISH, EXCHANGE_OWNER_CANCEL, EXCHANGE_OWNER_DISPATCH:
			_handle_owner_command(response_code, body)
	return true


func get_connection_state() -> String:
	return _connection_state


func is_busy() -> bool:
	return _exchange != EXCHANGE_NONE


func get_pending_exchange() -> String:
	return _exchange


func get_generation() -> int:
	return _generation


func get_base_url() -> String:
	return _base_url


func has_credentials() -> bool:
	return not _token.is_empty()

func follows_redirects() -> bool:
	return _http.max_redirects > NO_REDIRECTS


func get_http_timeout_seconds() -> float:
	return _http.timeout


## Safe for logs and tests: never contains either bearer token.
func describe_session() -> String:
	return "FactoryApiClient(url=%s, state=%s, token=%s, owner=%s, pending=%s)" % [
		_base_url if not _base_url.is_empty() else "-",
		_connection_state,
		"set" if not _token.is_empty() else "unset",
		"set" if not _owner_token.is_empty() else "unset",
		_exchange if not _exchange.is_empty() else "none",
	]


func _begin_exchange(kind: String, path: String, method: int, body: String, auth: String) -> bool:
	if _exchange != EXCHANGE_NONE:
		return false
	var headers := PackedStringArray(["Accept: application/json"])
	if auth == AUTH_ROOT:
		if _token.is_empty():
			return false
		headers.append("Authorization: Bearer %s" % _token)
	elif auth == AUTH_OWNER:
		if _owner_token.is_empty():
			return false
		headers.append("Authorization: Bearer %s" % _owner_token)
	if method == HTTPClient.METHOD_POST:
		headers.append("Content-Type: application/json")
	_exchange = kind
	_exchange_generation = _generation
	_serial += 1
	_in_flight_serial = _serial
	var error := _http.request(_base_url + path, headers, method, body)
	_http_started = error == OK
	if error != OK:
		_exchange = EXCHANGE_NONE
		return false
	return true


func _handle_health(response_code: int, body: String) -> void:
	if response_code != 200:
		_fail(_http_failure_message("health check", response_code, body), true)
		return
	var parsed := FactoryProtocol.parse_health(body)
	if not parsed["ok"]:
		_fail("The backend health response is not compatible: %s" % String(parsed["error"]), true)
		return
	_set_connection_state(STATE_CONNECTED, "Connected to %s" % _base_url)
	if _exchange == EXCHANGE_NONE:
		_begin_exchange(EXCHANGE_STATE, PATH_STATE, HTTPClient.METHOD_GET, "", AUTH_ROOT)


func _handle_state(response_code: int, body: String) -> void:
	if response_code != 200:
		_fail(_http_failure_message("state read", response_code, body), _is_fatal_status(response_code))
		return
	var parsed := FactoryProtocol.parse_state(body)
	if not parsed["ok"]:
		_fail("The backend state response is not compatible: %s" % String(parsed["error"]), true)
		return
	snapshot_received.emit(parsed["snapshot"])


func _handle_production(response_code: int, body: String) -> void:
	if response_code == 202:
		var parsed := FactoryProtocol.parse_production_ack(body)
		if not parsed["ok"]:
			_fail("The backend queue acknowledgement is not compatible: %s" % String(parsed["error"]), false)
			return
		production_queued.emit(parsed["ack"])
		return
	_fail(_http_failure_message("production request", response_code, body), _is_fatal_status(response_code))


func _handle_line_control(response_code: int, body: String) -> void:
	if response_code == 202:
		var parsed := FactoryProtocol.parse_line_control_ack(body)
		if not parsed["ok"]:
			_fail("The backend line control acknowledgement is not compatible: %s" % String(parsed["error"]), false)
			return
		line_control_queued.emit(parsed["ack"])
		return
	_fail(_http_failure_message("line control request", response_code, body), _is_fatal_status(response_code))


func _handle_command(response_code: int, body: String) -> void:
	if response_code != 200:
		_fail(_http_failure_message("command status read", response_code, body), _is_fatal_status(response_code))
		return
	var parsed := FactoryProtocol.parse_command_status(body)
	if not parsed["ok"]:
		_fail("The backend command status is not compatible: %s" % String(parsed["error"]), false)
		return
	command_status_changed.emit(parsed["command"])


func _handle_market_offers(response_code: int, body: String) -> void:
	if response_code != 200:
		_fail(_http_failure_message("market offers read", response_code, body), _is_fatal_status(response_code))
		return
	var parsed := FactoryProtocol.parse_market_offers(body)
	if not parsed["ok"]:
		_fail("The backend market offers payload is not compatible: %s" % String(parsed["error"]), false)
		return
	market_offers_received.emit(parsed["value"])


func _handle_contracts(response_code: int, body: String) -> void:
	if response_code != 200:
		_fail(_http_failure_message("contracts read", response_code, body), _is_fatal_status(response_code))
		return
	var parsed := FactoryProtocol.parse_contracts(body)
	if not parsed["ok"]:
		_fail("The backend contracts payload is not compatible: %s" % String(parsed["error"]), false)
		return
	contracts_received.emit(parsed["value"])


func _handle_owner_session(response_code: int, body: String) -> void:
	if response_code == 201:
		var parsed := FactoryProtocol.parse_owner_session(body)
		if not parsed["ok"]:
			_fail(
				"The backend owner session response is not compatible: %s" % String(parsed["error"]),
				false
			)
			return
		var session: Dictionary = parsed["value"]
		_owner_token = String(session["token"])
		owner_session_opened.emit({
			"ownerId": String(session["ownerId"]),
			"expiresAtUtc": String(session["expiresAtUtc"]),
		})
		return
	_fail(
		_http_failure_message("owner session request", response_code, body), _is_fatal_status(response_code)
	)


func _handle_owner_selling(response_code: int, body: String) -> void:
	if response_code == 401:
		_expire_owner_session("The owner session is no longer valid; open a new one before selling.")
		return
	if response_code != 200:
		_fail(_http_failure_message("seller read", response_code, body), false)
		return
	var parsed := FactoryProtocol.parse_owner_selling(body)
	if not parsed["ok"]:
		_fail("The backend seller payload is not compatible: %s" % String(parsed["error"]), false)
		return
	owner_selling_received.emit(parsed["value"])


func _handle_owner_command(response_code: int, body: String) -> void:
	if response_code == 202:
		var parsed := FactoryProtocol.parse_owner_ack(body)
		if not parsed["ok"]:
			_fail(
				"The backend owner acknowledgement is not compatible: %s" % String(parsed["error"]),
				false
			)
			return
		owner_command_queued.emit(parsed["value"])
		return
	if response_code == 401:
		_expire_owner_session("The owner session is no longer valid; nothing was admitted.")
		return
	_fail(_http_failure_message("owner financial request", response_code, body), false)


## An owner refusal ends only the owner session; the root read session stays.
func _expire_owner_session(message: String) -> void:
	_owner_token = ""
	request_failed.emit(_redact(message), false)


func _http_failure_message(action: String, response_code: int, body: String) -> String:
	var parsed := FactoryProtocol.parse_error(body)
	if parsed["ok"]:
		return "%s failed: HTTP %d %s - %s" % [
			action, response_code, String(parsed["code"]), String(parsed["message"])
		]
	return "%s failed: HTTP %d with an unreadable error body." % [action, response_code]


func _on_request_completed(
	result: int, response_code: int, _headers: PackedStringArray, body: PackedByteArray
) -> void:
	var generation := _exchange_generation
	var kind := _exchange
	var serial := _in_flight_serial
	if kind == EXCHANGE_NONE:
		return
	_http_started = false
	deliver_exchange_result(generation, kind, result, response_code, body.get_string_from_utf8(), serial)


func _fail(message: String, fatal: bool) -> void:
	var safe := _redact(message)
	if fatal:
		_cancel_transport()
		_exchange = EXCHANGE_NONE
		_generation += 1
		_token = ""
		_owner_token = ""
		_connection_state = STATE_ERROR
		connection_state_changed.emit(STATE_ERROR, safe)
	request_failed.emit(safe, fatal)


func _set_connection_state(state: String, message: String) -> void:
	_connection_state = state
	connection_state_changed.emit(state, message)


func _cancel_transport() -> void:
	if _http_started:
		_http.cancel_request()
	_http_started = false


## Removes either bearer token from any text that could reach a log or screen.
func _redact(text: String) -> String:
	var safe := text.replace("\n", " ").replace("\r", " ").replace("\t", " ").strip_edges()
	if not _token.is_empty():
		safe = safe.replace(_token, "[redacted]")
	if not _owner_token.is_empty():
		safe = safe.replace(_owner_token, "[redacted]")
	if safe.length() > MAX_ERROR_MESSAGE_LENGTH:
		safe = safe.substr(0, MAX_ERROR_MESSAGE_LENGTH) + "..."
	return safe


func _is_redirect(status: int) -> bool:
	return status >= 300 and status < 400


func _is_fatal_status(status: int) -> bool:
	return status == 401


func _result_name(result: int) -> String:
	match result:
		HTTPRequest.RESULT_CANT_CONNECT:
			return "cannot connect"
		HTTPRequest.RESULT_CANT_RESOLVE:
			return "cannot resolve host"
		HTTPRequest.RESULT_CONNECTION_ERROR:
			return "connection error"
		HTTPRequest.RESULT_TIMEOUT:
			return "timeout"
		HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR:
			return "TLS handshake error"
		HTTPRequest.RESULT_REQUEST_FAILED:
			return "request failed"
		HTTPRequest.RESULT_NO_RESPONSE:
			return "no response"
		HTTPRequest.RESULT_BODY_SIZE_LIMIT_EXCEEDED:
			return "response too large"
		_:
			return "result %d" % result
