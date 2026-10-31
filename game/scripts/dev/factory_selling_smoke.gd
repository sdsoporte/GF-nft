class_name FactorySellingSmoke
extends Node
## Optional real-backend check for the sell-first loop (issue #58, milestone B).
##
## Enabled only by the `--smoke-selling` user argument (see
## tests/run_selling_smoke.sh). It drives the visible screen the way a player
## does and asserts what the server reports for each step:
##
##   connect -> owner session -> one R1 batch -> draft offer of that batch
##   (confirmed) -> publish (confirmed) -> normal NPC purchase -> dispatch
##   (confirmed) -> settlement -> engine rejection of an unaffordable publish.
##
## The goods offered are the batch the line just produced: the run fails if the
## player already held the offered item or if the offered quantity is not the
## observed inventory delta. The price stays at the existing NPC buy ceiling.
##
## The NPC buyer is part of the authoritative tick loop; this script never calls
## an NPC policy itself. Every financial command goes through the confirmation
## gate, and a queued 202 counts as admitted, never as done. Exits 0 when the
## whole journey matches the server state and 1 otherwise.

enum Phase {
	WAIT_STATE,
	WAIT_OWNER,
	WAIT_IDLE,
	WAIT_PRODUCTION,
	WAIT_DRAFT_ACK,
	WAIT_DRAFT_ROW,
	WAIT_PUBLISH_ACK,
	WAIT_PENDING,
	WAIT_ACTIVE,
	WAIT_SETTLED,
	WAIT_REJECTED_DRAFT,
	WAIT_REJECT_ACK,
	WAIT_REJECT_OUTCOME,
	FINISHED,
}

const DEFAULT_TIMEOUT_SECONDS := 180.0
const ENV_TIMEOUT := "GF_SMOKE_TIMEOUT"
const ENV_BUYER := "GF_SMOKE_NPC_BUYER"
## One R1 batch. The engine sells R1 output at its shipped 0%-margin ceiling:
## R1 base cost 50 credits / 5 output = 10 credits per IRON_INGOT.
const OFFER_ITEM := "IRON_INGOT"
const OFFER_UNIT_PRICE := "10"
const OFFER_HORIZON := "2000"
const UNAFFORDABLE_QUANTITY := "5000"
const UNAFFORDABLE_UNIT_PRICE := "100000"
const NPC_BUYER_DEFAULT := "comp_metal_02"

var _main: Node
var _client: FactoryApiClient
var _phase: int = Phase.WAIT_STATE
var _deadline_msec: int = 0
var _failures: PackedStringArray = PackedStringArray()
var _finished: bool = false
var _line_id: String = ""
var _baseline_total_batches: int = 0
var _offer_contract_id: String = ""
var _rejected_contract_id: String = ""
var _credits_before_settlement: int = -1
var _production_seen: bool = false
var _output_item: String = ""
var _baseline_output_units: int = -1
var _produced_units: int = -1
var _last_recent_commands: Array = []
## A confirmation is raised while the screen may still be reading the seller
## loop, so the confirmed command is submitted on the next idle frame.
var _confirm_pending: bool = false
var _expected_exchange: String = ""


func start(host_main: Node) -> void:
	_main = host_main
	_client = host_main.get_client()
	_deadline_msec = Time.get_ticks_msec() + int(_timeout_seconds() * 1000.0)
	_client.snapshot_received.connect(_on_snapshot)
	_client.owner_session_opened.connect(_on_owner_session_opened)
	_client.owner_command_queued.connect(_on_owner_command_queued)
	_client.owner_selling_received.connect(_on_owner_selling)
	_client.command_status_changed.connect(_on_command_status)
	_client.request_failed.connect(_on_request_failed)
	_client.connection_state_changed.connect(_on_connection_state)
	var opened: Dictionary = _main.connect_to_server()
	if not opened["ok"]:
		_finish_with("could not open the session: %s" % String(opened["error"]))
		return
	print("SMOKE SELLING: connecting to %s" % _client.get_base_url())


func _process(_delta: float) -> void:
	if _finished:
		return
	if Time.get_ticks_msec() > _deadline_msec:
		_finish_with("timed out after %ds in phase %s" % [int(_timeout_seconds()), _phase_name()])
		return
	if _confirm_pending and not _client.is_busy():
		_confirm_pending = false
		_main.press_confirm_selling()
		if _client.get_pending_exchange() != _expected_exchange:
			_finish_with("the confirmed command did not issue the %s request" % _expected_exchange)
			return
	if _phase == Phase.WAIT_IDLE and not _client.is_busy():
		_start_production()


func _on_connection_state(state: String, message: String) -> void:
	if _finished:
		return
	if state == FactoryApiClient.STATE_ERROR:
		_finish_with("connection error: %s" % message)


func _on_request_failed(message: String, _fatal: bool) -> void:
	if _finished:
		return
	_finish_with("request failed: %s" % message)


func _on_owner_session_opened(_meta: Dictionary) -> void:
	if _finished or _phase != Phase.WAIT_OWNER:
		return
	print("SMOKE SELLING: owner session open; nothing financial was sent yet")
	if not _check_no_financial_exchange("opening the owner session"):
		return
	_phase = Phase.WAIT_IDLE


func _on_command_status(command: Dictionary) -> void:
	if _finished or _phase != Phase.WAIT_PRODUCTION:
		return
	var status := String(command.get("status", ""))
	if status == "rejected":
		_finish_with("the server rejected production with %s" % String(command.get("errorCode", "")))
		return
	if status != "executed":
		return
	_production_seen = true
	print("SMOKE SELLING: production executed on tick %d" % int(command.get("executedAtTick", -1)))


func _on_snapshot(snapshot: FactorySnapshot) -> void:
	if _finished or snapshot == null:
		return
	match _phase:
		Phase.WAIT_STATE:
			_on_first_snapshot(snapshot)
		Phase.WAIT_PRODUCTION:
			if _production_seen and FactorySmoke.batch_completed(
				snapshot, _line_id, _baseline_total_batches
			):
				if _verify_produced_goods(snapshot):
					_begin_draft()
		Phase.WAIT_PENDING:
			if _contract_status(_offer_contract_id) == "PENDING":
				print("SMOKE SELLING: the published offer is PENDING")
				_phase = Phase.WAIT_ACTIVE
		Phase.WAIT_ACTIVE:
			var status := _contract_status(_offer_contract_id)
			if status == "ACTIVE":
				print("SMOKE SELLING: the NPC buyer accepted the offer; dispatching goods")
				_dispatch()
			elif status == "CANCELLED" or status == "DEFAULTED":
				_finish_with("the offer left the market as %s before a buyer accepted it" % status)
		Phase.WAIT_SETTLED:
			if _contract_status(_offer_contract_id) == "FULFILLED":
				_verify_settlement()
		Phase.WAIT_REJECTED_DRAFT:
			if _contract_status(_rejected_contract_id) == "DRAFT":
				_publish_unaffordable()
		Phase.WAIT_REJECT_OUTCOME:
			_check_unaffordable_outcome()


func _on_first_snapshot(snapshot: FactorySnapshot) -> void:
	if snapshot.match_id.is_empty():
		_finish_with("the server snapshot has no match id")
		return
	if snapshot.tick < 0:
		_finish_with("the server reported a negative tick")
		return
	print("SMOKE SELLING: match %s at tick %d" % [snapshot.match_id, snapshot.tick])
	if not _check_no_financial_exchange("the first snapshot"):
		return
	var opened: Dictionary = _main.press_open_owner_session()
	if not opened["ok"]:
		_finish_with("the owner session request was refused: %s" % String(opened["error"]))
		return
	if _client.get_pending_exchange() != FactoryApiClient.EXCHANGE_OWNER_SESSION:
		_finish_with("the owner session button did not issue a session request")
		return
	_phase = Phase.WAIT_OWNER


func _start_production() -> void:
	var snapshot: FactorySnapshot = _main.get_snapshot()
	if snapshot == null:
		_finish_with("no snapshot to start production from")
		return
	_line_id = snapshot.first_idle_line_id()
	if _line_id.is_empty():
		_finish_with("no idle production line; run the smoke against a fresh backend")
		return
	_baseline_total_batches = int(snapshot.line(_line_id).get("totalBatchesProduced", 0))
	var recipe: Dictionary = snapshot.recipe(FactoryProtocol.PRODUCTION_RECIPE_ID)
	_output_item = String(recipe.get("outputItem", ""))
	if _output_item.is_empty():
		_finish_with("the server did not report the R1 output item")
		return
	_baseline_output_units = snapshot.inventory_available(_output_item)
	if _baseline_output_units != 0:
		_finish_with(
			"%s already holds %d %s; the offered goods must come from this batch, so run against a fresh backend"
			% [String(snapshot.company_name), _baseline_output_units, _output_item]
		)
		return
	_phase = Phase.WAIT_PRODUCTION
	print(
		"SMOKE SELLING: starting one R1 batch on %s (starting %s stock: 0)"
		% [_line_id, _output_item]
	)
	_main.press_start(_line_id)
	if String(_main.ui_error_text()) != "":
		_finish_with("the visible Start action was refused: %s" % String(_main.ui_error_text()))
		return
	if _client.get_pending_exchange() != FactoryApiClient.EXCHANGE_PRODUCTION:
		_finish_with("the visible Start action did not issue a production request")
		return


## The batch, not the starting stock, must supply the offered goods: the item
## must be the server's R1 output and the inventory delta must be its promised
## output quantity.
func _verify_produced_goods(snapshot: FactorySnapshot) -> bool:
	var recipe: Dictionary = snapshot.recipe(FactoryProtocol.PRODUCTION_RECIPE_ID)
	var expected_units := int(recipe.get("outputQuantity", 0))
	var produced := snapshot.inventory_available(_output_item) - _baseline_output_units
	if _output_item != OFFER_ITEM:
		_finish_with(
			"R1 produced %s but the smoke offers %s" % [_output_item, OFFER_ITEM]
		)
		return false
	if expected_units <= 0:
		_finish_with("the server reported no R1 output quantity")
		return false
	if produced != expected_units:
		_finish_with(
			"the completed batch produced %d %s but R1 promises %d"
			% [produced, _output_item, expected_units]
		)
		return false
	_produced_units = produced
	print(
		"SMOKE SELLING: line %s completed one R1 batch: %s 0 -> %d; offering all %d at the existing %s credit NPC buy ceiling"
		% [_line_id, _output_item, produced, produced, OFFER_UNIT_PRICE]
	)
	return true


func _begin_draft() -> void:
	if _phase == Phase.WAIT_DRAFT_ACK or _phase == Phase.WAIT_DRAFT_ROW:
		return
	if _produced_units <= 0:
		_finish_with("the smoke has no produced batch to offer")
		return
	_main.set_sell_terms(
		_output_item, offered_quantity_text(_produced_units), OFFER_UNIT_PRICE, OFFER_HORIZON, _npc_buyer()
	)
	# The unconfirmed draft path must not admit anything.
	_main.press_draft_offer()
	if not _main.is_confirmation_visible():
		_finish_with("the draft terms did not raise a confirmation")
		return
	if not _check_no_financial_exchange("showing the draft confirmation"):
		return
	var confirmation_lines := _lines(_main.ui_confirmation_text())
	_main.press_decline_selling()
	if _main.is_confirmation_visible():
		_finish_with("declining the confirmation left it visible")
		return
	if not _check_no_financial_exchange("declining the draft confirmation"):
		return
	print("SMOKE SELLING: draft confirmation showed %d lines and declined without sending" % confirmation_lines)
	_main.press_draft_offer()
	if not _main.is_confirmation_visible():
		_finish_with("the draft confirmation did not reappear for the confirmed attempt")
		return
	_phase = Phase.WAIT_DRAFT_ACK
	_request_confirm(FactoryApiClient.EXCHANGE_OWNER_DRAFT)


func _on_owner_command_queued(ack: Dictionary) -> void:
	if _finished:
		return
	if _phase == Phase.WAIT_DRAFT_ACK:
		if String(ack.get("status", "")) != FactoryProtocol.OWNER_ACK_STATUS:
			_finish_with("the draft acknowledgement was not %s" % FactoryProtocol.OWNER_ACK_STATUS)
			return
		print("SMOKE SELLING: draft admitted for tick %d" % int(ack.get("scheduledTick", -1)))
		_phase = Phase.WAIT_DRAFT_ROW
		return
	if _phase == Phase.WAIT_PUBLISH_ACK:
		print("SMOKE SELLING: publish admitted for tick %d" % int(ack.get("scheduledTick", -1)))
		_phase = Phase.WAIT_PENDING
		return
	if _phase == Phase.WAIT_REJECT_ACK:
		print("SMOKE SELLING: unaffordable publish admitted for tick %d" % int(ack.get("scheduledTick", -1)))
		_phase = Phase.WAIT_REJECT_OUTCOME
		return


func _on_owner_selling(data: Dictionary) -> void:
	if _finished:
		return
	_last_recent_commands = data.get("recentCommands", [])
	match _phase:
		Phase.WAIT_DRAFT_ROW:
			if not _offer_contract_id.is_empty():
				return
			var draft := _first_contract_with_status("DRAFT", OFFER_ITEM)
			if draft.is_empty():
				return
			_offer_contract_id = String(draft.get("contractId", ""))
			print("SMOKE SELLING: engine created DRAFT %s" % _offer_contract_id)
			_publish_offer()
		Phase.WAIT_REJECTED_DRAFT:
			if _rejected_contract_id.is_empty():
				var draft := _first_contract_with_status("DRAFT", OFFER_ITEM)
				if not draft.is_empty() and String(draft.get("contractId", "")) != _offer_contract_id:
					_rejected_contract_id = String(draft.get("contractId", ""))
					print("SMOKE SELLING: engine created oversized DRAFT %s" % _rejected_contract_id)


func _publish_offer() -> void:
	if not _main.select_selling_contract(_offer_contract_id):
		_finish_with("the seller loop does not list the draft %s" % _offer_contract_id)
		return
	_main.press_publish_offer()
	if not _main.is_confirmation_visible():
		_finish_with("publishing did not raise a confirmation")
		return
	var text: String = _main.ui_confirmation_text()
	if not text.contains("escrow") or not text.contains("collateral") or not text.contains("indemnity"):
		_finish_with("the publish confirmation does not show escrow, collateral and default consequences")
		return
	var consequence_text: String = text
	_phase = Phase.WAIT_PUBLISH_ACK
	_request_confirm(FactoryApiClient.EXCHANGE_OWNER_PUBLISH)
	print("SMOKE SELLING: publish confirmation showed %d characters of consequences" % consequence_text.length())


func _dispatch() -> void:
	if not _main.select_selling_contract(_offer_contract_id):
		_finish_with("the seller loop does not list the active contract")
		return
	_main.set_dispatch_quantity(offered_quantity_text(_produced_units))
	_main.press_dispatch_offer()
	if not _main.is_confirmation_visible():
		_finish_with("dispatching did not raise a confirmation")
		return
	_credits_before_settlement = _main.selling_available_credits()
	_phase = Phase.WAIT_SETTLED
	_request_confirm(FactoryApiClient.EXCHANGE_OWNER_DISPATCH)


func _verify_settlement() -> void:
	var contract := _contract(_offer_contract_id)
	var delivered := int(contract.get("deliveredQuantity", 0))
	var total := int(contract.get("totalQuantity", 0))
	if delivered != total:
		_finish_with("settled with %d of %d units delivered" % [delivered, total])
		return
	# The dispatch reading is taken after acceptance locked the collateral, so a
	# full delivery must return exactly the engine-reported net payout plus that
	# collateral. Both figures come from the seller read model, not from the test.
	var consequences: Dictionary = contract.get("consequences", {})
	var net_payout := int(consequences.get("sellerNetOnFullDeliveryCredits", -1))
	var collateral := int(consequences.get("sellerCollateralCredits", -1))
	if net_payout < 0 or collateral < 0:
		_finish_with("the seller read model reported no net payout or collateral for the contract")
		return
	var credits: int = _main.selling_available_credits()
	var paid := credits - _credits_before_settlement
	var expected := net_payout + collateral
	if paid != expected:
		_finish_with(
			"settlement changed seller credits by %d but the engine reported %d (net payout %d + returned collateral %d) for value %d with a %d market fee"
			% [
				paid,
				expected,
				net_payout,
				collateral,
				int(contract.get("totalValueCredits", 0)),
				int(consequences.get("marketFeeCredits", 0)),
			]
		)
		return
	print(
		"SMOKE SELLING: %s FULFILLED at tick %d, seller credits %d -> %d (+%d = %d net payout + %d returned collateral, %d market fee on %d)"
		% [
			_offer_contract_id,
			int(contract.get("settledAtTick", -1)),
			_credits_before_settlement,
			credits,
			paid,
			net_payout,
			collateral,
			int(consequences.get("marketFeeCredits", 0)),
			int(contract.get("totalValueCredits", 0)),
		]
	)
	_begin_rejection()


## A second offer the seller cannot collateralize: the 202 admits it and the
## engine refuses it, which the read model reports with the exact error code.
func _begin_rejection() -> void:
	_main.set_sell_terms(
		OFFER_ITEM, UNAFFORDABLE_QUANTITY, UNAFFORDABLE_UNIT_PRICE, OFFER_HORIZON, ""
	)
	_main.press_draft_offer()
	if not _main.is_confirmation_visible():
		_finish_with("the oversized draft did not raise a confirmation")
		return
	_phase = Phase.WAIT_REJECTED_DRAFT
	_request_confirm(FactoryApiClient.EXCHANGE_OWNER_DRAFT)


func _publish_unaffordable() -> void:
	if not _main.select_selling_contract(_rejected_contract_id):
		_finish_with("the seller loop does not list the oversized draft")
		return
	_main.press_publish_offer()
	if not _main.is_confirmation_visible():
		_finish_with("publishing the oversized draft did not raise a confirmation")
		return
	_phase = Phase.WAIT_REJECT_ACK
	_request_confirm(FactoryApiClient.EXCHANGE_OWNER_PUBLISH)


func _check_unaffordable_outcome() -> void:
	var status := _contract_status(_rejected_contract_id)
	if status != "DRAFT":
		return
	for index in range(_last_recent_commands.size() - 1, -1, -1):
		var outcome: Dictionary = _last_recent_commands[index]
		if String(outcome.get("status", "")) != "rejected":
			continue
		print(
			"SMOKE SELLING: engine rejected the unaffordable publish with %s"
			% String(outcome.get("errorCode", ""))
		)
		print("SMOKE SELLING: rejection changed no contract state; the oversized DRAFT is still DRAFT")
		_finish(0)
		return


func _contract(contract_id: String) -> Dictionary:
	var contracts: Array = _main.selling_contracts()
	for index in contracts.size():
		var contract: Dictionary = contracts[index]
		if String(contract.get("contractId", "")) == contract_id:
			return contract
	return {}


func _contract_status(contract_id: String) -> String:
	return String(_contract(contract_id).get("status", ""))


func _first_contract_with_status(status: String, item_id: String) -> Dictionary:
	var contracts: Array = _main.selling_contracts()
	for index in contracts.size():
		var contract: Dictionary = contracts[index]
		if String(contract.get("status", "")) == status and String(contract.get("itemId", "")) == item_id:
			return contract
	return {}


## Holds the player's confirmation until the screen is idle, then submits it.
func _request_confirm(expected_exchange: String) -> void:
	_expected_exchange = expected_exchange
	_confirm_pending = true


func _check_no_financial_exchange(action: String) -> bool:
	var pending := _client.get_pending_exchange()
	if pending == FactoryApiClient.EXCHANGE_OWNER_DRAFT \
		or pending == FactoryApiClient.EXCHANGE_OWNER_PUBLISH \
		or pending == FactoryApiClient.EXCHANGE_OWNER_CANCEL \
		or pending == FactoryApiClient.EXCHANGE_OWNER_DISPATCH:
		_finish_with("%s started a financial exchange the player did not confirm" % action)
		return false
	return true


func _npc_buyer() -> String:
	return resolved_npc_buyer()


## What the smoke sells: the item R1 produces, at the shipped NPC buy ceiling.
## The quantity is not a constant here — it is the batch the line produced, which
## is why the journey fails if the player already held the item.
static func offer_terms() -> Dictionary:
	return {
		"itemId": OFFER_ITEM,
		"unitPriceCredits": int(OFFER_UNIT_PRICE),
		"horizonTicks": int(OFFER_HORIZON),
		"targetBuyerId": NPC_BUYER_DEFAULT,
	}


## The offered lot is exactly the produced batch, never an invented amount.
static func offered_quantity_text(produced_units: int) -> String:
	return str(produced_units)


## Terms whose 20% collateral exceeds any company's starting credits, so the
## engine refuses the publication after admission.
static func unaffordable_terms() -> Dictionary:
	return {
		"itemId": OFFER_ITEM,
		"quantity": int(UNAFFORDABLE_QUANTITY),
		"unitPriceCredits": int(UNAFFORDABLE_UNIT_PRICE),
	}


static func resolved_npc_buyer() -> String:
	var configured := OS.get_environment(ENV_BUYER).strip_edges()
	return configured if not configured.is_empty() else NPC_BUYER_DEFAULT


static func default_timeout_seconds() -> float:
	return DEFAULT_TIMEOUT_SECONDS


func _lines(text: String) -> int:
	var count := 0
	for line in text.split("\n"):
		if not String(line).strip_edges().is_empty():
			count += 1
	return count


func _phase_name() -> String:
	match _phase:
		Phase.WAIT_STATE:
			return "waiting for the first snapshot"
		Phase.WAIT_OWNER:
			return "waiting for the owner session"
		Phase.WAIT_IDLE:
			return "waiting for the owner session read to finish"
		Phase.WAIT_PRODUCTION:
			return "waiting for the R1 batch"
		Phase.WAIT_DRAFT_ACK:
			return "waiting for the draft acknowledgement"
		Phase.WAIT_DRAFT_ROW:
			return "waiting for the engine to create the DRAFT"
		Phase.WAIT_PUBLISH_ACK:
			return "waiting for the publish acknowledgement"
		Phase.WAIT_PENDING:
			return "waiting for the published offer"
		Phase.WAIT_ACTIVE:
			return "waiting for the NPC buyer to accept"
		Phase.WAIT_SETTLED:
			return "waiting for settlement after dispatch"
		Phase.WAIT_REJECTED_DRAFT:
			return "waiting for the oversized DRAFT"
		Phase.WAIT_REJECT_ACK:
			return "waiting for the oversized publish acknowledgement"
		Phase.WAIT_REJECT_OUTCOME:
			return "waiting for the engine rejection"
		_:
			return "finished"


func _finish_with(reason: String) -> void:
	_failures.append(reason)
	print("SMOKE SELLING FAIL: %s" % reason)
	for failure in _failures:
		if failure != reason:
			print("SMOKE SELLING FAIL: %s" % failure)
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
		if parsed >= 5.0 and parsed <= 900.0:
			return parsed
	return DEFAULT_TIMEOUT_SECONDS
