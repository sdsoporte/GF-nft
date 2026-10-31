class_name OwnerSellingFlow
extends RefCounted
## Human confirmation gate for the sell-first loop (issue #58, milestone B).
##
## Every financial command passes through here first: the player states the
## terms, the screen shows exactly what the engine will do with them, and only
## an explicit confirmation hands the command to the API client. The flow keeps
## no credentials, sends nothing and decides no economic rule; the figures it
## shows are the ones the server reported for that contract.

enum Stage { NONE, DRAFT, PUBLISH, CANCEL, DISPATCH }

## The server owns the real bounds; these only keep obviously unusable input out
## of a confirmation the player would have to read twice.
const MIN_POSITIVE := 1

var _stage: int = Stage.NONE
var _text: String = ""
var _intent: Dictionary = {}
var _contract: Dictionary = {}
var _quantity: int = 0


func is_confirming() -> bool:
	return _stage != Stage.NONE


func stage() -> int:
	return _stage


func confirmation_text() -> String:
	return _text


func contract_id() -> String:
	return String(_contract.get("contractId", ""))


func quantity() -> int:
	return _quantity


## Terms ready to submit once the player confirms the draft.
func intent() -> Dictionary:
	return _intent


func decline() -> String:
	_clear()
	return "Cancelled: no command was sent."


func _clear() -> void:
	_stage = Stage.NONE
	_text = ""
	_intent = {}
	_contract = {}
	_quantity = 0


## Reads a whole number the player typed. Empty, negative or non-numeric input
## is refused before any confirmation is shown.
static func read_positive_int(text: String) -> Dictionary:
	var trimmed := text.strip_edges()
	if trimmed.is_empty():
		return {"ok": false, "error": "Enter a whole number."}
	if not trimmed.is_valid_int():
		return {"ok": false, "error": "'%s' is not a whole number." % trimmed}
	var value := trimmed.to_int()
	if value < MIN_POSITIVE:
		return {"ok": false, "error": "Enter a whole number of at least %d." % MIN_POSITIVE}
	return {"ok": true, "error": "", "value": value}


## Turns the visible draft form into the exact terms the route accepts, or a
## message the player can act on. The deadline is absolute: the server tick the
## offer expires on, computed from the current tick and the chosen horizon.
static func build_draft_intent(
	item_id: String,
	quantity_text: String,
	unit_price_text: String,
	horizon_text: String,
	current_tick: int,
	target_buyer_id: String = ""
) -> Dictionary:
	var trimmed_item := item_id.strip_edges()
	if trimmed_item.is_empty():
		return {"ok": false, "error": "Enter the item id to sell."}
	if not FactoryProtocol.is_safe_identifier(trimmed_item, FactoryProtocol.MAX_IDENTIFIER_LENGTH):
		return {
			"ok": false,
			"error": "The item id must use A-Z, a-z, 0-9, '_' or '-'.",
		}
	var quantity := read_positive_int(quantity_text)
	if not quantity["ok"]:
		return {"ok": false, "error": "Quantity: %s" % String(quantity["error"])}
	var unit_price := read_positive_int(unit_price_text)
	if not unit_price["ok"]:
		return {"ok": false, "error": "Unit price: %s" % String(unit_price["error"])}
	var horizon := read_positive_int(horizon_text)
	if not horizon["ok"]:
		return {"ok": false, "error": "Deadline horizon: %s" % String(horizon["error"])}
	if current_tick < 0:
		return {"ok": false, "error": "Wait for the first server snapshot before drafting an offer."}
	var buyer := target_buyer_id.strip_edges()
	if not buyer.is_empty() and not FactoryProtocol.is_safe_identifier(
		buyer, FactoryProtocol.MAX_IDENTIFIER_LENGTH
	):
		return {"ok": false, "error": "The target buyer must be a company id, or empty for an open offer."}
	return {
		"ok": true,
		"error": "",
		"value": {
			"itemId": trimmed_item,
			"quantity": int(quantity["value"]),
			"unitPriceCredits": int(unit_price["value"]),
			"deadlineTick": current_tick + int(horizon["value"]),
			"horizonTicks": int(horizon["value"]),
			"targetBuyerId": buyer,
		},
	}


## First confirmation: the terms to submit. Nothing is locked by a draft.
func begin_draft(intent: Dictionary) -> Dictionary:
	_clear()
	if not intent.has("itemId") or not intent.has("deadlineTick"):
		return {"ok": false, "error": "The offer terms are incomplete."}
	_stage = Stage.DRAFT
	_intent = intent
	_text = draft_confirmation_text(intent)
	return {"ok": true, "error": "", "text": _text}


static func draft_confirmation_text(intent: Dictionary) -> String:
	var quantity := int(intent.get("quantity", 0))
	var unit_price := int(intent.get("unitPriceCredits", 0))
	var total := quantity * unit_price
	var buyer := String(intent.get("targetBuyerId", ""))
	var audience := "%s only; nobody else may accept it" % buyer if not buyer.is_empty() \
		else "the open market; any other company may accept it"
	return (
		"Confirm draft: sell %d %s at %s credits each, total value %s credits.\n"
		+ "Deadline tick %d (%d ticks from the current server tick).\n"
		+ "Audience: %s.\n"
		+ "The server creates the DRAFT on its next tick. Nothing is locked yet: publishing is a"
		+ " separate confirmation, and credits move only when a buyer accepts."
	) % [
		quantity,
		String(intent.get("itemId", "")),
		format_credits(unit_price),
		format_credits(total),
		int(intent.get("deadlineTick", 0)),
		int(intent.get("horizonTicks", 0)),
		audience,
	]


## Second confirmation: publishing an engine-created DRAFT, with the escrow,
## collateral, fee and default indemnity the server reported for it.
func begin_publish(contract: Dictionary, market_fee_bps: int) -> Dictionary:
	_clear()
	var status := String(contract.get("status", ""))
	if status != "DRAFT":
		return {"ok": false, "error": "Only a DRAFT offer can be published."}
	_stage = Stage.PUBLISH
	_contract = contract
	_text = publish_confirmation_text(contract, market_fee_bps)
	return {"ok": true, "error": "", "text": _text}


static func publish_confirmation_text(contract: Dictionary, market_fee_bps: int) -> String:
	var consequences: Dictionary = contract.get("consequences", {})
	var remaining := int(contract.get("totalQuantity", 0)) - int(contract.get("deliveredQuantity", 0))
	return (
		"Confirm publish of %s: %d %s at %s credits each, total value %s credits, deadline tick %d.\n"
		+ "Publishing locks nothing; it lists the offer for its audience.\n"
		+ "When a buyer accepts, the engine locks %s buyer escrow and %s of your credits as"
		+ " collateral.\n"
		+ "On full delivery of all %d units you receive %s credits net of the %s market fee (%d bps),"
		+ " and your collateral returns.\n"
		+ "If you default, undelivered units earn nothing and you lose up to %s credits of collateral"
		+ " as indemnity (%s per missing unit); %d of %d units are still undelivered."
	) % [
		String(contract.get("contractId", "")),
		int(contract.get("totalQuantity", 0)),
		String(contract.get("itemId", "")),
		format_credits(int(contract.get("unitPriceCredits", 0))),
		format_credits(int(contract.get("totalValueCredits", 0))),
		int(contract.get("deadlineTick", 0)),
		format_credits(int(consequences.get("buyerEscrowCredits", 0))),
		format_credits(int(consequences.get("sellerCollateralCredits", 0))),
		int(contract.get("totalQuantity", 0)),
		format_credits(int(consequences.get("sellerNetOnFullDeliveryCredits", 0))),
		format_credits(int(consequences.get("marketFeeCredits", 0))),
		market_fee_bps,
		format_credits(int(consequences.get("maximumDefaultIndemnityCredits", 0))),
		format_credits(int(consequences.get("penaltyPerMissingUnitCredits", 0))),
		remaining,
		int(contract.get("totalQuantity", 0)),
	]


func begin_cancel(contract: Dictionary) -> Dictionary:
	_clear()
	var status := String(contract.get("status", ""))
	if not can_cancel(contract):
		return {"ok": false, "error": "Only a DRAFT or unaccepted PENDING offer can be cancelled."}
	_stage = Stage.CANCEL
	_contract = contract
	_text = (
		"Confirm cancellation of %s (%s x%d, status %s).\n"
		+ "Nothing is locked before acceptance, so no credits, collateral or goods move; the offer"
		+ " stops being available to buyers."
	) % [
		String(contract.get("contractId", "")),
		String(contract.get("itemId", "")),
		int(contract.get("totalQuantity", 0)),
		status,
	]
	return {"ok": true, "error": "", "text": _text}


func begin_dispatch(contract: Dictionary, quantity_text: String, market_fee_bps: int) -> Dictionary:
	_clear()
	if not can_dispatch(contract):
		return {"ok": false, "error": "Only your own ACTIVE contract can be dispatched."}
	var parsed := read_positive_int(quantity_text)
	if not parsed["ok"]:
		return {"ok": false, "error": "Dispatch quantity: %s" % String(parsed["error"])}
	var quantity: int = int(parsed["value"])
	var remaining := int(contract.get("totalQuantity", 0)) - int(contract.get("deliveredQuantity", 0))
	var actual := mini(quantity, remaining)
	_stage = Stage.DISPATCH
	_contract = contract
	_quantity = quantity
	_text = dispatch_confirmation_text(contract, quantity, actual, market_fee_bps)
	return {"ok": true, "error": "", "text": _text}


static func dispatch_confirmation_text(
	contract: Dictionary, requested: int, actual: int, market_fee_bps: int
) -> String:
	var consequences: Dictionary = contract.get("consequences", {})
	var delivered := int(contract.get("deliveredQuantity", 0))
	var total := int(contract.get("totalQuantity", 0))
	var buyer := buyer_text(contract)
	return (
		"Confirm dispatch of %d %s on %s to %s.\n"
		+ "The engine ships %d units this tick (you asked for %d); goods leave your inventory and"
		+ " seller-only transport energy applies.\n"
		+ "Delivered after this: %d of %d units.\n"
		+ "On full delivery you receive %s credits net of the %s market fee (%d bps); %s of your"
		+ " collateral stays locked until then.\n"
		+ "Each unit still missing after deadline tick %d forfeits %s credits of collateral, capped"
		+ " at %s in total."
	) % [
		actual,
		String(contract.get("itemId", "")),
		String(contract.get("contractId", "")),
		buyer if not buyer.is_empty() else "its buyer",
		actual,
		requested,
		delivered + actual,
		total,
		format_credits(int(consequences.get("sellerNetOnFullDeliveryCredits", 0))),
		format_credits(int(consequences.get("marketFeeCredits", 0))),
		market_fee_bps,
		format_credits(int(consequences.get("sellerCollateralCredits", 0))),
		int(contract.get("deadlineTick", 0)),
		format_credits(int(consequences.get("penaltyPerMissingUnitCredits", 0))),
		format_credits(int(consequences.get("maximumDefaultIndemnityCredits", 0))),
	]


static func can_publish(contract: Dictionary) -> bool:
	return String(contract.get("status", "")) == "DRAFT"


static func can_cancel(contract: Dictionary) -> bool:
	var status := String(contract.get("status", ""))
	return status == "DRAFT" or status == "PENDING"


static func can_dispatch(contract: Dictionary) -> bool:
	return String(contract.get("status", "")) == "ACTIVE"


## One row per own contract, including the figures that matter to the decision.
static func contract_rows(data: Dictionary) -> PackedStringArray:
	var rows := PackedStringArray()
	if data.is_empty():
		return rows
	var contracts: Array = data.get("contracts", [])
	for index in contracts.size():
		var contract: Dictionary = contracts[index]
		var consequences: Dictionary = contract.get("consequences", {})
		var buyer := buyer_text(contract)
		rows.append(
			"%s %s x%d @ %s = %s | %s | deadline %d | escrow %s collateral %s fee %s | %s"
			% [
				String(contract.get("contractId", "")),
				String(contract.get("itemId", "")),
				int(contract.get("totalQuantity", 0)),
				format_credits(int(contract.get("unitPriceCredits", 0))),
				format_credits(int(contract.get("totalValueCredits", 0))),
				String(contract.get("status", "")),
				int(contract.get("deadlineTick", 0)),
				format_credits(int(consequences.get("buyerEscrowCredits", 0))),
				format_credits(int(consequences.get("sellerCollateralCredits", 0))),
				format_credits(int(consequences.get("marketFeeCredits", 0))),
				buyer if not buyer.is_empty() else "open",
			]
		)
	return rows


static func find_contract(data: Dictionary, contract_id: String) -> Dictionary:
	var contracts: Array = data.get("contracts", [])
	for index in contracts.size():
		var contract: Dictionary = contracts[index]
		if String(contract.get("contractId", "")) == contract_id:
			return contract
	return {}


## The engine's final word for one caller key, when the read model has it yet.
static func find_outcome(data: Dictionary, idempotency_key: String) -> Dictionary:
	var commands: Array = data.get("recentCommands", [])
	for index in range(commands.size() - 1, -1, -1):
		var outcome: Dictionary = commands[index]
		if String(outcome.get("idempotencyKey", "")) == idempotency_key:
			return outcome
	return {}


## 202 means "admitted for the next tick", never "done".
static func queued_feedback(ack: Dictionary, idempotency_key: String) -> String:
	return (
		"Server queued key %s for tick %d; waiting for the engine. Nothing is final yet."
		% [idempotency_key, int(ack.get("scheduledTick", -1))]
	)


static func outcome_feedback(idempotency_key: String, outcome: Dictionary) -> String:
	if outcome.is_empty():
		return "Key %s is still awaiting its engine result." % idempotency_key
	var tick := int(outcome.get("executedAtTick", -1))
	if String(outcome.get("status", "")) == "executed":
		return "Server executed %s on tick %d." % [idempotency_key, tick]
	var code := String(outcome.get("errorCode", ""))
	if code.is_empty():
		return "Server rejected %s on tick %d; nothing changed." % [idempotency_key, tick]
	return "Server rejected %s on tick %d with %s; nothing changed." % [idempotency_key, tick, code]


## An open offer has no buyer: the wire says null, and the screen says nothing.
static func buyer_text(contract: Dictionary) -> String:
	var value: Variant = contract.get("buyerCompanyId", "")
	return "" if value == null else String(value)


static func format_credits(value: int) -> String:
	return FactoryViewModel.format_integer(value)
