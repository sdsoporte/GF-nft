extends SceneTree
## Rules for the sell-first client: the owner-session wire format, the human
## confirmation gate, and the queued-versus-final feedback text.
##
## Nothing here talks to a backend: the parsers, builders and the confirmation
## flow are pure, so the suite pins exactly what a player is shown and exactly
## what would be submitted.

const TestSupport = preload("res://tests/test_support.gd")

var _started: bool = false


func _process(_delta: float) -> bool:
	if _started:
		return true
	_started = true
	var t := TestSupport.new()
	_test_owner_session_parsing(t)
	_test_draft_request_building(t)
	_test_action_and_dispatch_building(t)
	_test_acknowledgement_parsing(t)
	_test_selling_read_model_parsing(t)
	_test_draft_intent(t)
	_test_draft_confirmation(t)
	_test_publish_confirmation(t)
	_test_cancel_and_dispatch_confirmations(t)
	_test_decline_sends_nothing(t)
	_test_rows_and_feedback(t)
	quit(t.finish("test_owner_selling"))
	return true


func _test_owner_session_parsing(t: TestSupport) -> void:
	var parsed: Dictionary = FactoryProtocol.parse_owner_session(t.fixture("owner_session_ok.json"))
	if not t.check(parsed["ok"], "the owner session fixture parses: %s" % str(parsed.get("error", ""))):
		return
	var session: Dictionary = parsed["value"]
	t.equal(session["ownerId"], "owner_fixture", "the owner identity comes from the server")
	t.equal(session["expiresAtUtc"], "2030-01-01T00:15:00.000Z", "the expiry is reported, never the digest")
	t.check(
		FactoryProtocol.is_owner_session_token(String(session["token"])),
		"the issued token is a gf_owner_ credential"
	)

	t.check(
		not FactoryProtocol.parse_owner_session('{"token":"gf_owner_zz","ownerId":"o","expiresAtUtc":"x"}')["ok"],
		"a token that is not a gf_owner_ credential is refused"
	)
	t.check(
		not FactoryProtocol.parse_owner_session(
			'{"token":"gf_mcp_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","ownerId":"o","expiresAtUtc":"x"}'
		)["ok"],
		"a grant token can never be mistaken for an owner session"
	)
	t.check(
		not FactoryProtocol.parse_owner_session('{"token":"gf_owner_00","ownerId":"o"}')["ok"],
		"a session payload without an expiry is refused"
	)


func _test_draft_request_building(t: TestSupport) -> void:
	var open := FactoryProtocol.build_owner_draft_request("sell_draft-1-1", "IRON_INGOT", 10, 5, 53)
	if not t.check(open["ok"], "an open draft request is built: %s" % str(open.get("error", ""))):
		return
	var open_payload: Dictionary = JSON.parse_string(String(open["value"]))
	t.equal(open_payload.size(), 5, "an open draft carries exactly five keys")
	t.equal(open_payload["idempotency_key"], "sell_draft-1-1", "the caller owns the command key")
	t.equal(open_payload["item_id"], "IRON_INGOT", "the item is sent as given")
	t.equal(int(open_payload["quantity"]), 10, "the quantity is sent as an integer")
	t.equal(int(open_payload["unit_price"]), 5, "the unit price is sent as an integer")
	t.equal(int(open_payload["deadline_tick"]), 53, "the deadline is an absolute tick")
	t.check(not open_payload.has("target_buyer_id"), "an open offer omits the buyer instead of sending null")

	var targeted := FactoryProtocol.build_owner_draft_request(
		"sell_draft-1-2", "IRON_INGOT", 10, 5, 53, "comp_manuf_02"
	)
	var targeted_payload: Dictionary = JSON.parse_string(String(targeted["value"]))
	t.equal(String(targeted_payload.get("target_buyer_id", "")), "comp_manuf_02", "a targeted offer names its buyer")
	t.equal(targeted_payload.size(), 6, "a targeted draft carries exactly six keys")

	t.check(not FactoryProtocol.build_owner_draft_request("short", "IRON_INGOT", 1, 1, 10)["ok"],
		"a command key shorter than eight characters is refused")
	t.check(not FactoryProtocol.build_owner_draft_request("sell_draft-1-3", "IRON INGOT", 1, 1, 10)["ok"],
		"an item id with a space is refused")
	t.check(not FactoryProtocol.build_owner_draft_request("sell_draft-1-4", "IRON_INGOT", 0, 1, 10)["ok"],
		"a zero quantity is refused")
	t.check(not FactoryProtocol.build_owner_draft_request("sell_draft-1-5", "IRON_INGOT", 1, 0, 10)["ok"],
		"a zero unit price is refused")
	t.check(not FactoryProtocol.build_owner_draft_request("sell_draft-1-6", "IRON_INGOT", 1, 1, 0)["ok"],
		"a zero deadline tick is refused")
	t.check(not FactoryProtocol.build_owner_draft_request("sell_draft-1-7", "IRON_INGOT", 1, 1, 10, "bad buyer")["ok"],
		"an invalid target buyer is refused before any request")


func _test_action_and_dispatch_building(t: TestSupport) -> void:
	var publish := FactoryProtocol.build_owner_action_request("sell_publish-1-1")
	if not t.check(publish["ok"], "a publish request is built"):
		return
	var publish_payload: Dictionary = JSON.parse_string(String(publish["value"]))
	t.equal(publish_payload.size(), 1, "publish and cancel carry only the command key")

	var dispatch := FactoryProtocol.build_owner_dispatch_request("sell_dispatch-1-1", 3)
	if not t.check(dispatch["ok"], "a dispatch request is built"):
		return
	var dispatch_payload: Dictionary = JSON.parse_string(String(dispatch["value"]))
	t.equal(int(dispatch_payload["quantity_to_ship"]), 3, "dispatch carries the lot to ship")
	t.check(not FactoryProtocol.build_owner_dispatch_request("sell_dispatch-1-2", 0)["ok"],
		"a zero dispatch quantity is refused")
	t.check(not FactoryProtocol.build_owner_action_request("bad key")["ok"],
		"a command key with a space is refused")

	t.equal(
		FactoryProtocol.owner_contract_path("cnt_42_1", "publish"),
		"/v1/owner/contracts/cnt_42_1/publish",
		"the publish path names the contract"
	)
	t.equal(
		FactoryProtocol.owner_contract_path("cnt_42_1", "dispatch"),
		"/v1/owner/contracts/cnt_42_1/dispatch",
		"the dispatch path names the contract"
	)
	t.equal(FactoryProtocol.owner_contract_path("cnt 42", "cancel"), "", "an unsafe contract id has no path")
	t.equal(FactoryProtocol.owner_contract_path("cnt_42_1", "accept"), "", "an unknown action has no path")


func _test_acknowledgement_parsing(t: TestSupport) -> void:
	var draft: Dictionary = FactoryProtocol.parse_owner_ack(t.fixture("owner_ack_draft.json"))
	if not t.check(draft["ok"], "the draft acknowledgement parses: %s" % str(draft.get("error", ""))):
		return
	var ack: Dictionary = draft["value"]
	t.equal(ack["status"], FactoryProtocol.OWNER_ACK_STATUS, "admission is reported as enqueued, not done")
	t.equal(int(ack["scheduledTick"]), 43, "the acknowledgement names the tick it runs on")
	t.equal(String(ack["itemId"]), "IRON_INGOT", "the admitted item is echoed")
	t.equal(int(ack["quantity"]), 10, "the admitted quantity is echoed")
	t.check(ack.has("targetBuyerId") and ack["targetBuyerId"] == null, "an open offer echoes a null buyer")

	var publish: Dictionary = FactoryProtocol.parse_owner_ack(t.fixture("owner_ack_publish.json"))
	t.equal(String(publish["value"]["contractId"]), "cnt_42_1", "the publish acknowledgement names the contract")
	var dispatch: Dictionary = FactoryProtocol.parse_owner_ack(t.fixture("owner_ack_dispatch.json"))
	t.equal(int(dispatch["value"]["quantityToShip"]), 3, "the dispatch acknowledgement echoes the lot")

	t.check(not FactoryProtocol.parse_owner_ack(t.fixture("owner_ack_wrong_status.json"))["ok"],
		"an acknowledgement with another status word is refused")
	t.check(not FactoryProtocol.parse_owner_ack('{"scheduledTick":4}')["ok"],
		"an acknowledgement without a status is refused")
	t.check(not FactoryProtocol.parse_owner_ack(t.fixture("command_rejected.json"))["ok"],
		"a command-status payload is not accepted as an owner acknowledgement")


func _test_selling_read_model_parsing(t: TestSupport) -> void:
	var parsed: Dictionary = FactoryProtocol.parse_owner_selling(t.fixture("owner_selling_ok.json"))
	if not t.check(parsed["ok"], "the seller read model parses: %s" % str(parsed.get("error", ""))):
		return
	var data: Dictionary = parsed["value"]
	t.equal(int(data["tick"]), 42, "the read model reports the server tick")
	t.equal(String(data["companyId"]), "comp_metal_01", "the read model reports the acting company")
	t.equal(int(data["availableCredits"]), 10000, "the read model reports available credits")
	t.equal(int(data["marketFeeBps"]), 200, "the fee rate comes from the server")
	var contracts: Array = data["contracts"]
	t.equal(contracts.size(), 2, "every own contract is reported")
	var draft: Dictionary = contracts[0]
	t.equal(String(draft["status"]), "DRAFT", "the draft status survives parsing")
	t.check(draft["buyerCompanyId"] == null, "an open offer has no buyer")
	var consequences: Dictionary = draft["consequences"]
	t.equal(int(consequences["buyerEscrowCredits"]), 50, "escrow is reported, not guessed")
	t.equal(int(consequences["sellerCollateralCredits"]), 10, "collateral is reported, not guessed")
	t.equal(int(consequences["marketFeeCredits"]), 1, "the market fee is reported, not guessed")
	t.equal(int(consequences["sellerNetOnFullDeliveryCredits"]), 49, "the net payout is reported")
	t.equal(int(consequences["penaltyPerMissingUnitCredits"]), 10, "the penalty is reported")
	t.equal(int(consequences["maximumDefaultIndemnityCredits"]), 10, "the indemnity cap is reported")
	var active: Dictionary = contracts[1]
	t.equal(String(active["status"]), "ACTIVE", "an active contract is reported with its progress")
	t.equal(int(active["deliveredQuantity"]), 2, "delivery progress is reported")

	var commands: Array = data["recentCommands"]
	t.equal(commands.size(), 2, "recent command outcomes are reported")
	t.equal(String(commands[0]["status"]), "executed", "an executed outcome is reported")
	t.equal(String(commands[1]["status"]), "rejected", "a rejected outcome is reported")
	t.equal(String(commands[1]["errorCode"]), "ERR_INSUFFICIENT_COLLATERAL", "the engine error code survives")

	var empty: Dictionary = FactoryProtocol.parse_owner_selling(t.fixture("owner_selling_empty.json"))
	t.check(empty["ok"], "an empty seller loop parses")
	t.equal((empty["value"]["contracts"] as Array).size(), 0, "an empty seller loop has no rows")

	t.check(
		FactoryProtocol.is_readable_command_key("http:match_owner_test:godot-1731-1"),
		"a production-style key is reported, not rejected as a call-site key"
	)
	var mixed := FactoryProtocol.parse_owner_selling(
		'{"tick":1,"companyId":"comp_metal_01","availableCredits":5,"marketFeeBps":200,"contracts":[],'
		+ '"recentCommands":[{"idempotencyKey":"http:match_1:godot-1-1","status":"executed",'
		+ '"executedAtTick":1,"errorCode":null}]}'
	)
	if t.check(mixed["ok"], "a read model that also reports production keys still parses"):
		t.equal(
			String(mixed["value"]["recentCommands"][0]["idempotencyKey"]),
			"http:match_1:godot-1-1",
			"another route's key survives parsing unchanged"
		)
	t.check(
		not FactoryProtocol.parse_owner_selling(t.fixture("owner_selling_missing_consequences.json"))["ok"],
		"a contract without consequences is refused instead of shown partially"
	)
	t.check(
		not FactoryProtocol.parse_owner_selling(t.fixture("owner_selling_overdelivered.json"))["ok"],
		"a contract delivering more than it sells is refused"
	)


func _test_draft_intent(t: TestSupport) -> void:
	var intent: Dictionary = OwnerSellingFlow.build_draft_intent("IRON_INGOT", "10", "5", "40", 12, "")
	if not t.check(intent["ok"], "a complete offer form builds an intent: %s" % str(intent.get("error", ""))):
		return
	var value: Dictionary = intent["value"]
	t.equal(String(value["itemId"]), "IRON_INGOT", "the intent keeps the item")
	t.equal(int(value["quantity"]), 10, "the intent parses the quantity")
	t.equal(int(value["unitPriceCredits"]), 5, "the intent parses the unit price")
	t.equal(int(value["deadlineTick"]), 52, "the deadline is the current tick plus the horizon")
	t.equal(String(value["targetBuyerId"]), "", "an empty buyer field means an open offer")

	t.check(not OwnerSellingFlow.build_draft_intent("", "1", "1", "40", 12)["ok"], "a missing item is refused")
	t.check(not OwnerSellingFlow.build_draft_intent("IRON_INGOT", "", "1", "40", 12)["ok"],
		"a missing quantity is refused")
	t.check(not OwnerSellingFlow.build_draft_intent("IRON_INGOT", "ten", "1", "40", 12)["ok"],
		"a non-numeric quantity is refused")
	t.check(not OwnerSellingFlow.build_draft_intent("IRON_INGOT", "0", "1", "40", 12)["ok"],
		"a zero quantity is refused")
	t.check(not OwnerSellingFlow.build_draft_intent("IRON_INGOT", "1", "1", "0", 12)["ok"],
		"a zero horizon is refused")
	t.check(not OwnerSellingFlow.build_draft_intent("IRON_INGOT", "1", "1", "40", -1)["ok"],
		"drafting without a snapshot tick is refused")
	t.check(not OwnerSellingFlow.build_draft_intent("IRON_INGOT", "1", "1", "40", 12, "buyer 1")["ok"],
		"an unsafe target buyer is refused")

	var targeted: Dictionary = OwnerSellingFlow.build_draft_intent(
		"RAW_ORE", "5", "20", "300", 12, "comp_metal_02"
	)
	t.equal(String(targeted["value"]["targetBuyerId"]), "comp_metal_02", "a named buyer is kept")
	t.equal(int(targeted["value"]["deadlineTick"]), 312, "the horizon still sets the absolute deadline")


func _test_draft_confirmation(t: TestSupport) -> void:
	var flow := OwnerSellingFlow.new()
	t.check(not flow.is_confirming(), "a new flow is idle")
	var intent: Dictionary = OwnerSellingFlow.build_draft_intent("IRON_INGOT", "10", "5", "40", 12, "")["value"]
	var begun: Dictionary = flow.begin_draft(intent)
	if not t.check(begun["ok"], "the draft confirmation opens"):
		return
	t.equal(flow.stage(), OwnerSellingFlow.Stage.DRAFT, "the flow is confirming a draft")
	var text := flow.confirmation_text()
	t.contains(text, "10 IRON_INGOT", "the confirmation repeats the item and quantity")
	t.contains(text, "5 credits each", "the confirmation repeats the unit price")
	t.contains(text, "total value 50 credits", "the confirmation computes the total value")
	t.contains(text, "Deadline tick 52", "the confirmation states the absolute deadline")
	t.contains(text, "40 ticks", "the confirmation states the horizon")
	t.contains(text, "Nothing is locked yet", "the draft confirmation says a draft locks nothing")
	t.contains(text, "publishing is a separate confirmation", "the draft is not the financial step")
	t.contains(text, "the open market", "an open offer is described as public")
	t.not_contains(text, "gf_owner_", "the confirmation never prints a credential")

	var targeted := OwnerSellingFlow.new()
	var targeted_intent: Dictionary = OwnerSellingFlow.build_draft_intent(
		"RAW_ORE", "5", "20", "300", 12, "comp_metal_02"
	)["value"]
	targeted.begin_draft(targeted_intent)
	t.contains(
		targeted.confirmation_text(),
		"comp_metal_02 only",
		"a targeted offer says only the designated buyer may accept"
	)
	t.contains(targeted.confirmation_text(), "total value 100 credits", "the targeted total is computed")


func _fixture_contract(index: int) -> Dictionary:
	var parsed: Dictionary = FactoryProtocol.parse_owner_selling(
		FileAccess.get_file_as_string("res://tests/fixtures/owner_selling_ok.json")
	)
	return parsed["value"]["contracts"][index]


func _test_publish_confirmation(t: TestSupport) -> void:
	var draft := _fixture_contract(0)
	var flow := OwnerSellingFlow.new()
	t.check(not flow.begin_publish(_fixture_contract(1), 200)["ok"], "an ACTIVE contract cannot be published")
	var begun: Dictionary = flow.begin_publish(draft, 200)
	if not t.check(begun["ok"], "publishing a draft opens a confirmation"):
		return
	t.equal(flow.stage(), OwnerSellingFlow.Stage.PUBLISH, "the flow is confirming a publish")
	t.equal(flow.contract_id(), "cnt_42_1", "the confirmation remembers the draft")
	var text := flow.confirmation_text()
	t.contains(text, "cnt_42_1", "the confirmation names the contract")
	t.contains(text, "escrow", "the confirmation names buyer escrow")
	t.contains(text, "50 buyer escrow", "the escrow figure comes from the server")
	t.contains(text, "10 of your credits as collateral", "the collateral figure comes from the server")
	t.contains(text, "49 credits net", "the net payout comes from the server")
	t.contains(text, "1 market fee (200 bps)", "the fee and its rate come from the server")
	t.contains(text, "up to 10 credits of collateral", "the default indemnity is stated")
	t.contains(text, "10 per missing unit", "the per-unit penalty is stated")
	t.contains(text, "Publishing locks nothing", "publishing itself is described honestly")
	t.not_contains(text, "gf_owner_", "the publish confirmation never prints a credential")


func _test_cancel_and_dispatch_confirmations(t: TestSupport) -> void:
	var draft := _fixture_contract(0)
	var active := _fixture_contract(1)
	var cancel := OwnerSellingFlow.new()
	t.check(not cancel.begin_cancel(active)["ok"], "an ACTIVE contract cannot be cancelled")
	var begun: Dictionary = cancel.begin_cancel(draft)
	if not t.check(begun["ok"], "cancelling a draft opens a confirmation"):
		return
	t.contains(cancel.confirmation_text(), "no credits, collateral or goods move",
		"the cancellation says nothing is locked yet")
	t.contains(cancel.confirmation_text(), "status DRAFT", "the cancellation states the current status")

	var dispatch := OwnerSellingFlow.new()
	t.check(not dispatch.begin_dispatch(draft, "1", 200)["ok"], "a DRAFT cannot be dispatched")
	t.check(not dispatch.begin_dispatch(active, "0", 200)["ok"], "a zero dispatch quantity is refused")
	t.check(not dispatch.begin_dispatch(active, "", 200)["ok"], "a blank dispatch quantity is refused")
	var dispatched: Dictionary = dispatch.begin_dispatch(active, "3", 200)
	if not t.check(dispatched["ok"], "dispatching an active contract opens a confirmation: %s" % str(dispatched.get("error", ""))):
		return
	t.equal(dispatch.stage(), OwnerSellingFlow.Stage.DISPATCH, "the flow is confirming a dispatch")
	t.equal(dispatch.quantity(), 3, "the requested lot is remembered for the command")
	var text := dispatch.confirmation_text()
	t.contains(text, "Confirm dispatch of 3 RAW_ORE", "the confirmation names the lot and the item")
	t.contains(text, "Delivered after this: 5 of 5 units", "the confirmation predicts only engine-known progress")
	t.contains(text, "98 credits net", "the dispatch confirmation repeats the net payout")
	t.contains(text, "20 of your collateral", "the dispatch confirmation repeats the locked collateral")
	t.contains(text, "capped at 20 in total", "the dispatch confirmation repeats the indemnity cap")

	var clamp := OwnerSellingFlow.new()
	clamp.begin_dispatch(active, "99", 200)
	t.contains(
		clamp.confirmation_text(),
		"The engine ships 3 units this tick (you asked for 99)",
		"a lot larger than what is owed is clamped the way the engine clamps it"
	)


func _test_decline_sends_nothing(t: TestSupport) -> void:
	var flow := OwnerSellingFlow.new()
	var draft := _fixture_contract(0)
	flow.begin_publish(draft, 200)
	t.check(flow.is_confirming(), "the publish confirmation is pending before the decision")
	var message := flow.decline()
	t.check(not flow.is_confirming(), "declining clears the confirmation")
	t.equal(flow.stage(), OwnerSellingFlow.Stage.NONE, "declining returns the flow to idle")
	t.equal(flow.contract_id(), "", "declining forgets the contract")
	t.equal(flow.confirmation_text(), "", "declining clears the confirmation text")
	t.contains(message, "no command was sent", "the player is told nothing was sent")


func _test_rows_and_feedback(t: TestSupport) -> void:
	var parsed: Dictionary = FactoryProtocol.parse_owner_selling(
		FileAccess.get_file_as_string("res://tests/fixtures/owner_selling_ok.json")
	)
	var data: Dictionary = parsed["value"]
	var rows: PackedStringArray = OwnerSellingFlow.contract_rows(data)
	t.equal(rows.size(), 2, "one row per own contract")
	t.contains(rows[0], "cnt_42_1 IRON_INGOT x10 @ 5 = 50 | DRAFT", "the row states terms and status")
	t.contains(rows[0], "escrow 50 collateral 10 fee 1", "the row states the engine figures")
	t.contains(rows[0], "open", "an open offer is labelled as such")
	t.contains(rows[1], "comp_manuf_02", "a targeted contract shows its buyer")

	t.equal(String(OwnerSellingFlow.find_contract(data, "cnt_42_1")["status"]), "DRAFT",
		"a contract can be found by id")
	t.check(OwnerSellingFlow.find_contract(data, "cnt_absent").is_empty(), "an unknown contract is not invented")

	var executed: Dictionary = OwnerSellingFlow.find_outcome(data, "sell_draft-1-1")
	t.equal(String(executed["status"]), "executed", "an outcome is found by the caller key")
	var rejected: Dictionary = OwnerSellingFlow.find_outcome(data, "sell_publish-1-2")
	t.contains(
		OwnerSellingFlow.outcome_feedback("sell_publish-1-2", rejected),
		"ERR_INSUFFICIENT_COLLATERAL",
		"a rejection reports the engine error code"
	)
	t.contains(
		OwnerSellingFlow.outcome_feedback("sell_draft-1-1", executed),
		"executed sell_draft-1-1 on tick 41",
		"an execution is reported with its tick"
	)
	t.contains(
		OwnerSellingFlow.outcome_feedback("sell_waiting-1-1", {}),
		"still awaiting",
		"an unreported key is described as pending, never as done"
	)
	var ack: Dictionary = FactoryProtocol.parse_owner_ack(
		FileAccess.get_file_as_string("res://tests/fixtures/owner_ack_draft.json")
	)["value"]
	t.contains(
		OwnerSellingFlow.queued_feedback(ack, "sell_draft-1-1"),
		"queued key sell_draft-1-1 for tick 43",
		"a 202 is reported as queued for a tick"
	)
	t.contains(
		OwnerSellingFlow.queued_feedback(ack, "sell_draft-1-1"),
		"Nothing is final yet",
		"a 202 never claims completion"
	)
