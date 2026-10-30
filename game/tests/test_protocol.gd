extends SceneTree
## Observable rules for the frozen docs/factory-api.md payloads: a compatible
## snapshot is projected, and every malformed or incompatible payload is
## rejected before it can reach the view.

const TestSupport = preload("res://tests/test_support.gd")


func _initialize() -> void:
	var t := TestSupport.new()
	_test_valid_state(t)
	_test_rejected_states(t)
	_test_health(t)
	_test_command_status(t)
	_test_production_ack(t)
	_test_error_payload(t)
	_test_requests(t)
	_test_line_control_requests(t)
	_test_market_offers_parsing(t)
	_test_contracts_parsing(t)
	quit(t.finish("test_protocol"))


func _parse_state_fixture(t: TestSupport, name: String) -> Dictionary:
	return FactoryProtocol.parse_state(t.fixture(name))


func _test_valid_state(t: TestSupport) -> void:
	var parsed: Dictionary = _parse_state_fixture(t, "state_ok.json")
	if not t.check(parsed["ok"], "valid snapshot is accepted: %s" % str(parsed.get("error", ""))):
		return
	var snapshot: FactorySnapshot = parsed["snapshot"]
	t.equal(snapshot.protocol_version, 1, "snapshot protocol version")
	t.equal(snapshot.match_id, "match_fixture_0001", "snapshot match id")
	t.equal(snapshot.tick, 42, "snapshot tick")
	t.equal(snapshot.tick_interval_ms, 1000, "snapshot tick interval")
	t.equal(snapshot.company_id, "comp_metal_01", "snapshot company id")
	t.equal(snapshot.company_name, "Ironclad Metallurgy", "snapshot company name")
	t.equal(snapshot.credits, 10000, "snapshot credits")
	t.equal(snapshot.energy, 400, "snapshot energy")
	t.equal(snapshot.max_energy, 1000, "snapshot max energy")
	t.equal(snapshot.inventory.size(), 9, "snapshot inventory size")
	t.equal(int(snapshot.inventory["RAW_ORE"]["available"]), 200, "raw ore available")
	t.equal(int(snapshot.inventory["IRON_INGOT"]["reserved"]), 5, "iron ingot reserved")
	t.equal(snapshot.lines.size(), 3, "snapshot line count")
	t.equal(String(snapshot.lines[0]["lineId"]), "comp_metal_01_line_1", "first line id")
	t.equal(String(snapshot.lines[0]["status"]), "RUNNING", "first line status")
	t.equal(int(snapshot.lines[0]["activeBatch"]["progressTicks"]), 4, "line progress ticks")
	t.equal(int(snapshot.lines[0]["activeBatch"]["totalDurationTicks"]), 10, "line batch duration")
	t.equal(String(snapshot.lines[1]["status"]), "IDLE", "second line is idle")
	t.equal(snapshot.recipes.size(), 1, "snapshot recipe count")
	t.equal(String(snapshot.recipes[0]["id"]), "R1", "recipe id")
	t.equal(String(snapshot.recipes[0]["outputItem"]), "IRON_INGOT", "recipe output item")
	t.equal(int(snapshot.recipes[0]["outputQuantity"]), 5, "recipe output quantity")
	t.equal(int(snapshot.recipes[0]["durationTicks"]), 10, "recipe duration")
	t.equal(int(snapshot.recipes[0]["energyCost"]), 20, "recipe energy cost")
	t.equal(String(snapshot.recipes[0]["inputs"][0]["itemId"]), "RAW_ORE", "recipe input item")
	t.equal(int(snapshot.recipes[0]["inputs"][0]["quantity"]), 10, "recipe input quantity")
	t.equal(snapshot.recipe("R1").size() > 0, true, "snapshot can look up recipe R1")
	t.equal(snapshot.first_idle_line_id(), "comp_metal_01_line_2", "first idle line is discoverable")

	var minimal: Dictionary = _parse_state_fixture(t, "state_no_r1.json")
	t.check(minimal["ok"], "minimal state without recipes is still a valid snapshot")
	t.equal(minimal["snapshot"].recipes.size(), 0, "minimal state reports no recipes")


func _test_rejected_states(t: TestSupport) -> void:
	var valid_text: String = t.fixture("state_ok.json")
	_expect_reject(t, valid_text.substr(0, 40), "truncated json is rejected")
	_expect_reject(t, t.fixture("state_not_object.json"), "json array is rejected")
	_expect_reject(t, t.fixture("state_wrong_protocol.json"), "future protocol version is rejected")
	_expect_reject(t, t.fixture("state_missing_company.json"), "state without company is rejected")
	_expect_reject(t, t.fixture("state_negative_credits.json"), "negative credits are rejected")
	_expect_reject(t, t.fixture("state_fractional_energy.json"), "fractional energy is rejected")
	_expect_reject(t, t.fixture("state_progress_overrun.json"), "line progress beyond batch duration is rejected")
	_expect_reject(t, t.fixture("state_wrong_types.json"), "non-object company and mistyped identity fields are rejected")
	_expect_reject(t, "x".repeat(FactoryProtocol.MAX_RESPONSE_CHARS + 1), "oversized body is rejected")


func _expect_reject(t: TestSupport, body: String, message: String) -> void:
	var parsed: Dictionary = FactoryProtocol.parse_state(body)
	t.check(not parsed["ok"], message)
	t.check(String(parsed["error"]).length() > 0, "%s: rejection carries a reason" % message)
	t.check(not parsed.has("snapshot"), "%s: rejection yields no snapshot" % message)


func _test_health(t: TestSupport) -> void:
	var good: Dictionary = FactoryProtocol.parse_health(t.fixture("health_ok.json"))
	t.check(good["ok"], "compatible health payload is accepted")
	t.check(not FactoryProtocol.parse_health(t.fixture("health_wrong_protocol.json"))["ok"], "future protocol health is rejected")
	t.check(not FactoryProtocol.parse_health("not json")["ok"], "non-json health is rejected")
	t.check(not FactoryProtocol.parse_health('{"status":"starting","protocolVersion":1}')["ok"], "non-ok health status is rejected")


func _test_command_status(t: TestSupport) -> void:
	var executed: Dictionary = FactoryProtocol.parse_command_status(t.fixture("command_executed.json"))
	t.check(executed["ok"], "executed command status is accepted")
	t.equal(String(executed["command"]["status"]), "executed", "executed status value")
	t.equal(int(executed["command"]["executedAtTick"]), 44, "executed tick is carried")

	var rejected: Dictionary = FactoryProtocol.parse_command_status(t.fixture("command_rejected.json"))
	t.check(rejected["ok"], "rejected command status is accepted")
	t.equal(String(rejected["command"]["errorCode"]), "ERR_MISSING_INPUTS", "engine error code is carried")

	var queued: Dictionary = FactoryProtocol.parse_command_status('{"commandId":"cmd_1","status":"queued"}')
	t.check(queued["ok"], "queued command status is accepted without an executed tick")
	t.equal(int(queued["command"]["executedAtTick"]), -1, "queued status reports no executed tick")

	t.check(
		not FactoryProtocol.parse_command_status(t.fixture("command_bad_status.json"))["ok"],
		"unknown command status is rejected"
	)
	t.check(
		not FactoryProtocol.parse_command_status(t.fixture("command_executed_missing_tick.json"))["ok"],
		"final command status without executed tick is rejected"
	)


func _test_production_ack(t: TestSupport) -> void:
	var ack: Dictionary = FactoryProtocol.parse_production_ack(t.fixture("ack_queued.json"))
	t.check(ack["ok"], "202 queued acknowledgement is accepted")
	t.equal(String(ack["ack"]["commandId"]), "cmd_fixture_queued", "acknowledgement command id")
	t.equal(String(ack["ack"]["status"]), "queued", "acknowledgement status is queued")

	t.check(
		not FactoryProtocol.parse_production_ack('{"commandId":"cmd_1","status":"executed"}')["ok"],
		"202 acknowledgement with a final status is rejected"
	)


func _test_error_payload(t: TestSupport) -> void:
	var unauthorized: Dictionary = FactoryProtocol.parse_error(t.fixture("error_unauthorized.json"))
	t.check(unauthorized["ok"], "structured error payload is accepted")
	t.equal(String(unauthorized["code"]), "UNAUTHORIZED", "error code is carried")
	t.equal(String(unauthorized["message"]), "A valid bearer token is required.", "error message is carried")

	var unreadable: Dictionary = FactoryProtocol.parse_error("<html>not json</html>")
	t.check(not unreadable["ok"], "unreadable error body is rejected")
	t.check(String(unreadable["error"]).length() > 0, "unreadable error body still yields a reason")


func _test_requests(t: TestSupport) -> void:
	var request: Dictionary = FactoryProtocol.build_production_request(
		"godot-42-1", "comp_metal_01_line_2", "R1"
	)
	t.check(request["ok"], "valid production request is built")
	var decoded: Variant = JSON.parse_string(String(request["value"]))
	if t.check(typeof(decoded) == TYPE_DICTIONARY, "production request is a JSON object"):
		var payload: Dictionary = decoded
		t.equal(payload.size(), 3, "production request carries exactly three fields")
		t.equal(String(payload["requestId"]), "godot-42-1", "production request id field")
		t.equal(String(payload["lineId"]), "comp_metal_01_line_2", "production request line field")
		t.equal(String(payload["recipeId"]), "R1", "production request recipe field")

	t.check(
		not FactoryProtocol.build_production_request("bad id", "comp_metal_01_line_2", "R1")["ok"],
		"request id with a space is refused"
	)
	t.check(
		not FactoryProtocol.build_production_request("godot-1", "comp_metal_01_line_2", "R2")["ok"],
		"only recipe R1 is requested in this slice"
	)
	t.check(
		not FactoryProtocol.build_production_request("godot-1", "../etc/passwd", "R1")["ok"],
		"line id outside the identifier alphabet is refused"
	)

	t.check(FactoryProtocol.is_valid_request_id("a"), "single-character request id is valid")
	t.check(FactoryProtocol.is_valid_request_id("a".repeat(64)), "64-character request id is valid")
	t.check(not FactoryProtocol.is_valid_request_id("a".repeat(65)), "65-character request id is invalid")
	t.check(not FactoryProtocol.is_valid_request_id(""), "empty request id is invalid")
	t.check(not FactoryProtocol.is_valid_request_id("a/b"), "request id with a slash is invalid")

	var generated: String = FactoryProtocol.build_request_id("godot", 3)
	t.check(FactoryProtocol.is_valid_request_id(generated), "generated request id is valid: %s" % generated)
	t.check(not FactoryProtocol.is_safe_identifier("cmd id", 64), "identifier with a space is refused")


func _test_line_control_requests(t: TestSupport) -> void:
	# Pause request payload
	var pause_req: Dictionary = FactoryProtocol.build_line_pause_request("req-pause-1")
	t.check(pause_req["ok"], "valid pause request is built")
	var pause_json: Variant = JSON.parse_string(String(pause_req["value"]))
	if t.check(typeof(pause_json) == TYPE_DICTIONARY, "pause request is a JSON object"):
		var data: Dictionary = pause_json
		t.equal(data.size(), 1, "pause request carries exactly requestId")
		t.equal(String(data["requestId"]), "req-pause-1", "pause request id")

	# Resume request payload
	var resume_req: Dictionary = FactoryProtocol.build_line_resume_request("req-resume-1")
	t.check(resume_req["ok"], "valid resume request is built")
	var resume_json: Variant = JSON.parse_string(String(resume_req["value"]))
	if t.check(typeof(resume_json) == TYPE_DICTIONARY, "resume request is a JSON object"):
		var data: Dictionary = resume_json
		t.equal(data.size(), 1, "resume request carries exactly requestId")
		t.equal(String(data["requestId"]), "req-resume-1", "resume request id")

	# Priority request payload (1, 2, 3)
	for prio in [1, 2, 3]:
		var prio_req: Dictionary = FactoryProtocol.build_line_priority_request("req-prio-%d" % prio, prio)
		t.check(prio_req["ok"], "valid priority %d request is built" % prio)
		var prio_json: Variant = JSON.parse_string(String(prio_req["value"]))
		if t.check(typeof(prio_json) == TYPE_DICTIONARY, "priority request is a JSON object"):
			var data: Dictionary = prio_json
			t.equal(data.size(), 2, "priority request carries requestId and priority")
			t.equal(String(data["requestId"]), "req-prio-%d" % prio, "priority request id")
			t.equal(int(data["priority"]), prio, "priority value")

	# Refusals: invalid priority values
	t.check(not FactoryProtocol.build_line_priority_request("req-1", 0)["ok"], "priority 0 is refused")
	t.check(not FactoryProtocol.build_line_priority_request("req-1", 4)["ok"], "priority 4 is refused")
	t.check(not FactoryProtocol.build_line_priority_request("req-1", -1)["ok"], "priority -1 is refused")

	# Refusals: invalid request IDs
	t.check(not FactoryProtocol.build_line_pause_request("")["ok"], "empty request id for pause is refused")
	t.check(not FactoryProtocol.build_line_resume_request("bad id")["ok"], "space in request id for resume is refused")
	t.check(not FactoryProtocol.build_line_priority_request("a".repeat(65), 1)["ok"], "oversized request id is refused")

	# Path builders
	t.equal(
		FactoryProtocol.line_pause_path("comp_metal_01_line_1"),
		"/v1/lines/comp_metal_01_line_1/pause",
		"line pause path is formatted"
	)
	t.equal(
		FactoryProtocol.line_resume_path("comp_metal_01_line_1"),
		"/v1/lines/comp_metal_01_line_1/resume",
		"line resume path is formatted"
	)
	t.equal(
		FactoryProtocol.line_priority_path("comp_metal_01_line_1"),
		"/v1/lines/comp_metal_01_line_1/priority",
		"line priority path is formatted"
	)
	t.equal(FactoryProtocol.line_pause_path("../unsafe"), "", "unsafe line id produces empty pause path")
	t.equal(FactoryProtocol.line_resume_path("has space"), "", "unsafe line id produces empty resume path")
	t.equal(FactoryProtocol.line_priority_path(""), "", "empty line id produces empty priority path")

	# Acknowledgement parsing
	var ack: Dictionary = FactoryProtocol.parse_line_control_ack('{"commandId":"cmd_ctrl_01","status":"queued"}')
	t.check(ack["ok"], "line control ack is accepted")
	t.equal(String(ack["ack"]["commandId"]), "cmd_ctrl_01", "ack command id")
	t.equal(String(ack["ack"]["status"]), "queued", "ack status")
	t.check(not FactoryProtocol.parse_line_control_ack('{"commandId":"cmd_1","status":"executed"}')["ok"], "executed ack is rejected")


func _test_market_offers_parsing(t: TestSupport) -> void:
	var parsed: Dictionary = FactoryProtocol.parse_market_offers(t.fixture("market_offers_ok.json"))
	t.check(parsed["ok"], "valid market offers fixture is accepted")
	var data: Dictionary = parsed.get("value", {})
	t.equal(int(data.get("tick", -1)), 42, "market offers tick is carried")
	var offers: Array = data.get("offers", [])
	t.equal(offers.size(), 2, "two offers parsed")
	var offer0: Dictionary = offers[0]
	t.equal(String(offer0.get("contractId")), "cnt_fixture_01", "first offer contract id")
	t.equal(String(offer0.get("sellerCompanyId")), "comp_metal_02", "first offer seller")
	t.equal(offer0.get("buyerCompanyId"), null, "first offer open buyer is null")
	t.equal(String(offer0.get("itemId")), "IRON_INGOT", "first offer item")
	t.equal(int(offer0.get("quantity")), 5, "first offer quantity")
	t.equal(int(offer0.get("unitPriceCredits")), 22, "first offer unit price")
	t.equal(int(offer0.get("totalValueCredits")), 110, "first offer total value")
	t.equal(int(offer0.get("deadlineTick")), 312, "first offer deadline")

	var offer1: Dictionary = offers[1]
	t.equal(String(offer1.get("buyerCompanyId")), "comp_metal_01", "second offer targeted buyer")

	# Empty offers
	var empty: Dictionary = FactoryProtocol.parse_market_offers(t.fixture("market_offers_empty.json"))
	t.check(empty["ok"], "empty market offers accepted")
	t.equal((empty["value"]["offers"] as Array).size(), 0, "empty offers list")

	# Rejections
	t.check(not FactoryProtocol.parse_market_offers("not json")["ok"], "non-json offers rejected")
	t.check(not FactoryProtocol.parse_market_offers('{"offers":[]}')["ok"], "offers missing tick rejected")
	t.check(not FactoryProtocol.parse_market_offers('{"tick": -1, "offers":[]}')["ok"], "negative tick rejected")
	t.check(not FactoryProtocol.parse_market_offers('{"tick": 0}')["ok"], "missing offers array rejected")


func _test_contracts_parsing(t: TestSupport) -> void:
	var parsed: Dictionary = FactoryProtocol.parse_contracts(t.fixture("contracts_ok.json"))
	t.check(parsed["ok"], "valid contracts fixture is accepted")
	var data: Dictionary = parsed.get("value", {})
	t.equal(int(data.get("tick", -1)), 42, "contracts tick is carried")
	t.equal(String(data.get("companyId")), "comp_metal_01", "contracts companyId is carried")
	var contracts: Array = data.get("contracts", [])
	t.equal(contracts.size(), 2, "two contracts parsed")
	var c0: Dictionary = contracts[0]
	t.equal(String(c0.get("contractId")), "cnt_fixture_03", "contract id")
	t.equal(String(c0.get("status")), "ACTIVE", "contract status")
	t.equal(String(c0.get("itemId")), "MEGAMACHINE_PART", "contract item")
	t.equal(int(c0.get("deliveredQuantity")), 1, "contract delivered qty")
	t.equal(int(c0.get("totalQuantity")), 2, "contract total qty")
	t.equal(int(c0.get("deadlineTick")), 206, "contract deadline")
	t.equal(c0.get("settledAtTick"), null, "unsettled settledAtTick is null")

	var c1: Dictionary = contracts[1]
	t.equal(String(c1.get("status")), "FULFILLED", "second contract status fulfilled")
	t.equal(int(c1.get("settledAtTick")), 35, "second contract settled tick")

	# Empty contracts
	var empty: Dictionary = FactoryProtocol.parse_contracts(t.fixture("contracts_empty.json"))
	t.check(empty["ok"], "empty contracts accepted")
	t.equal((empty["value"]["contracts"] as Array).size(), 0, "empty contracts list")

	# Rejections
	t.check(not FactoryProtocol.parse_contracts("not json")["ok"], "non-json contracts rejected")
	t.check(not FactoryProtocol.parse_contracts('{"tick": 0, "contracts":[]}')["ok"], "missing companyId rejected")
	t.check(not FactoryProtocol.parse_contracts('{"tick": 0, "companyId": "c1"}')["ok"], "missing contracts array rejected")
	t.check(not FactoryProtocol.parse_contracts('{"tick": 0, "companyId": "c1", "contracts":[{"status":"INVALID"}]}')["ok"], "invalid status rejected")
