class_name FactoryProtocol
extends RefCounted
## Parser and request builder for the frozen contract in docs/factory-api.md.
##
## Every function is pure: it either returns a validated projection or a
## rejection with a human-readable reason. Nothing here trusts the payload, and
## nothing here builds state the server did not send.

const PROTOCOL_VERSION := 1
const MAX_RESPONSE_CHARS := 65536
const MAX_REQUEST_ID_LENGTH := 64
const MAX_IDENTIFIER_LENGTH := 128
const MAX_ERROR_MESSAGE_LENGTH := 200
const PRODUCTION_RECIPE_ID := "R1"

const ALLOWED_LINE_STATUSES := ["IDLE", "RUNNING", "PAUSED", "NO_ENERGY"]
const ALLOWED_COMMAND_STATUSES := ["queued", "executed", "rejected"]
const FINAL_COMMAND_STATUSES := ["executed", "rejected"]
const ALLOWED_CONTRACT_STATUSES := ["DRAFT", "PENDING", "ACTIVE", "FULFILLED", "DEFAULTED", "CANCELLED"]

# Issue #58 milestone B: the owner-session seller loop.
const OWNER_SESSION_PATH := "/v1/owner/sessions"
const OWNER_SELLING_PATH := "/v1/owner/selling"
const OWNER_CONTRACTS_PATH := "/v1/owner/contracts"
const OWNER_ACK_STATUS := "ENQUEUED_FOR_NEXT_TICK"
const OWNER_SESSION_TOKEN_PREFIX := "gf_owner_"
const OWNER_SESSION_TOKEN_HEX_LENGTH := 64
const MIN_IDEMPOTENCY_KEY_LENGTH := 8
const MAX_IDEMPOTENCY_KEY_LENGTH := 64
## Reported keys come from every route, including `http:<match>:<requestId>`,
## so the read model only bounds them instead of reusing the caller key shape.
const MAX_COMMAND_KEY_LENGTH := 128
const ALLOWED_SELLING_COMMAND_STATUSES := ["executed", "rejected"]
const OWNER_CONTRACT_ACTIONS := ["publish", "cancel", "dispatch"]
## Engine figures the human confirmation presents; every one must be present.
const SELLING_CONSEQUENCE_FIELDS := [
	"buyerEscrowCredits",
	"sellerCollateralCredits",
	"marketFeeCredits",
	"sellerNetOnFullDeliveryCredits",
	"penaltyPerMissingUnitCredits",
	"maximumDefaultIndemnityCredits",
]


static func parse_state(body: String) -> Dictionary:
	var root := _parse_object(body, "state")
	if not root["ok"]:
		return root
	var data: Dictionary = root["value"]

	var version := _int_field(data, "protocolVersion", 1, "state")
	if not version["ok"]:
		return version
	if int(version["value"]) != PROTOCOL_VERSION:
		return _fail(
			"state.protocolVersion is %d but this client speaks protocol %d." % [int(version["value"]), PROTOCOL_VERSION]
		)

	var match_id := _string_field(data, "matchId", "state")
	if not match_id["ok"]:
		return match_id
	var tick := _int_field(data, "tick", 0, "state")
	if not tick["ok"]:
		return tick
	var interval := _int_field(data, "tickIntervalMs", 1, "state")
	if not interval["ok"]:
		return interval

	var company_result := _object_field(data, "company", "state")
	if not company_result["ok"]:
		return company_result
	var company: Dictionary = company_result["value"]

	var snapshot := FactorySnapshot.new()
	snapshot.protocol_version = int(version["value"])
	snapshot.match_id = String(match_id["value"])
	snapshot.tick = int(tick["value"])
	snapshot.tick_interval_ms = int(interval["value"])

	var company_id := _string_field(company, "companyId", "state.company")
	if not company_id["ok"]:
		return company_id
	var company_name := _string_field(company, "name", "state.company")
	if not company_name["ok"]:
		return company_name
	var company_class := _string_field(company, "industrialClass", "state.company")
	if not company_class["ok"]:
		return company_class
	var credits := _int_field(company, "credits", 0, "state.company")
	if not credits["ok"]:
		return credits
	var energy := _int_field(company, "energy", 0, "state.company")
	if not energy["ok"]:
		return energy
	var max_energy := _int_field(company, "maxEnergyStorage", 0, "state.company")
	if not max_energy["ok"]:
		return max_energy

	snapshot.company_id = String(company_id["value"])
	snapshot.company_name = String(company_name["value"])
	snapshot.company_class = String(company_class["value"])
	snapshot.credits = int(credits["value"])
	snapshot.energy = int(energy["value"])
	snapshot.max_energy = int(max_energy["value"])

	var inventory_result := _dictionary_field(company, "inventory", "state.company")
	if not inventory_result["ok"]:
		return inventory_result
	var inventory: Dictionary = inventory_result["value"]
	for item_id in inventory.keys():
		var stock_result := _parse_stock(inventory[item_id], "state.company.inventory.%s" % str(item_id))
		if not stock_result["ok"]:
			return stock_result
		snapshot.inventory[String(item_id)] = stock_result["value"]

	var lines_result := _array_field(company, "lines", "state.company")
	if not lines_result["ok"]:
		return lines_result
	var raw_lines: Array = lines_result["value"]
	for index in raw_lines.size():
		var line_result := _parse_line(raw_lines[index], index)
		if not line_result["ok"]:
			return line_result
		snapshot.lines.append(line_result["value"])

	var recipes_result := _array_field(data, "recipes", "state")
	if not recipes_result["ok"]:
		return recipes_result
	var raw_recipes: Array = recipes_result["value"]
	for index in raw_recipes.size():
		var recipe_result := _parse_recipe(raw_recipes[index], index)
		if not recipe_result["ok"]:
			return recipe_result
		snapshot.recipes.append(recipe_result["value"])

	return {"ok": true, "error": "", "snapshot": snapshot}


static func parse_health(body: String) -> Dictionary:
	var root := _parse_object(body, "health")
	if not root["ok"]:
		return root
	var data: Dictionary = root["value"]
	var status := _string_field(data, "status", "health")
	if not status["ok"]:
		return status
	if String(status["value"]) != "ok":
		return _fail("health.status is '%s', not 'ok'." % String(status["value"]))
	var version := _int_field(data, "protocolVersion", 1, "health")
	if not version["ok"]:
		return version
	if int(version["value"]) != PROTOCOL_VERSION:
		return _fail(
			"health.protocolVersion is %d but this client speaks protocol %d." % [int(version["value"]), PROTOCOL_VERSION]
		)
	return _ok(true)


static func parse_production_ack(body: String) -> Dictionary:
	var root := _parse_object(body, "production acknowledgement")
	if not root["ok"]:
		return root
	var data: Dictionary = root["value"]
	var command_id := _identifier_field(data, "commandId", "production acknowledgement")
	if not command_id["ok"]:
		return command_id
	var status := _string_field(data, "status", "production acknowledgement")
	if not status["ok"]:
		return status
	if String(status["value"]) != "queued":
		return _fail(
			"A 202 acknowledgement must report status 'queued', not '%s'." % String(status["value"])
		)
	return {"ok": true, "error": "", "ack": {"commandId": String(command_id["value"]), "status": "queued"}}


static func parse_command_status(body: String) -> Dictionary:
	var root := _parse_object(body, "command status")
	if not root["ok"]:
		return root
	var data: Dictionary = root["value"]
	var command_id := _identifier_field(data, "commandId", "command status")
	if not command_id["ok"]:
		return command_id
	var status := _string_field(data, "status", "command status")
	if not status["ok"]:
		return status
	var status_text := String(status["value"])
	if not ALLOWED_COMMAND_STATUSES.has(status_text):
		return _fail("command status '%s' is not one of: %s." % [status_text, ", ".join(ALLOWED_COMMAND_STATUSES)])

	var executed_at_tick := -1
	if FINAL_COMMAND_STATUSES.has(status_text):
		var executed := _int_field(data, "executedAtTick", 0, "command status")
		if not executed["ok"]:
			return executed
		executed_at_tick = int(executed["value"])

	var error_code := ""
	if status_text == "rejected":
		var rejected := _string_field(data, "errorCode", "command status")
		if not rejected["ok"]:
			return rejected
		error_code = String(rejected["value"])

	return {
		"ok": true,
		"error": "",
		"command": {
			"commandId": String(command_id["value"]),
			"status": status_text,
			"executedAtTick": executed_at_tick,
			"errorCode": error_code,
		},
	}


static func parse_error(body: String) -> Dictionary:
	if body.length() > MAX_RESPONSE_CHARS:
		return _fail("The error response is too large to display.")
	var json := JSON.new()
	if json.parse(body) != OK:
		return _fail("The server returned an unreadable error response.")
	var parsed: Variant = json.data
	if typeof(parsed) != TYPE_DICTIONARY:
		return _fail("The server returned an unreadable error response.")
	var data: Dictionary = parsed
	var error_value: Variant = data.get("error")
	if typeof(error_value) != TYPE_DICTIONARY:
		return _fail("The server returned an error without an error object.")
	var error_object: Dictionary = error_value
	var code := _string_field(error_object, "code", "error")
	if not code["ok"]:
		return code
	var message_text := "Request failed."
	if error_object.has("message"):
		var message := _string_field(error_object, "message", "error")
		if message["ok"]:
			message_text = _sanitise_message(String(message["value"]))
	return {"ok": true, "error": "", "code": String(code["value"]), "message": message_text}


static func build_production_request(request_id: String, line_id: String, recipe_id: String) -> Dictionary:
	if not is_valid_request_id(request_id):
		return _fail("requestId must be 1-%d characters from A-Z, a-z, 0-9, '_' or '-'." % MAX_REQUEST_ID_LENGTH)
	if not is_safe_identifier(line_id, MAX_IDENTIFIER_LENGTH):
		return _fail("lineId must be a server-provided line identifier using A-Z, a-z, 0-9, '_' or '-'.")
	if recipe_id != PRODUCTION_RECIPE_ID:
		return _fail("Only recipe R1 is available in this slice.")
	var payload := {"requestId": request_id, "lineId": line_id, "recipeId": recipe_id}
	return _ok(JSON.stringify(payload))


static func build_line_pause_request(request_id: String) -> Dictionary:
	if not is_valid_request_id(request_id):
		return _fail("requestId must be 1-%d characters from A-Z, a-z, 0-9, '_' or '-'." % MAX_REQUEST_ID_LENGTH)
	var payload := {"requestId": request_id}
	return _ok(JSON.stringify(payload))


static func build_line_resume_request(request_id: String) -> Dictionary:
	if not is_valid_request_id(request_id):
		return _fail("requestId must be 1-%d characters from A-Z, a-z, 0-9, '_' or '-'." % MAX_REQUEST_ID_LENGTH)
	var payload := {"requestId": request_id}
	return _ok(JSON.stringify(payload))


static func build_line_priority_request(request_id: String, priority: int) -> Dictionary:
	if not is_valid_request_id(request_id):
		return _fail("requestId must be 1-%d characters from A-Z, a-z, 0-9, '_' or '-'." % MAX_REQUEST_ID_LENGTH)
	if priority < 1 or priority > 3:
		return _fail("priority must be 1, 2 or 3.")
	var payload := {"requestId": request_id, "priority": priority}
	return _ok(JSON.stringify(payload))


static func line_pause_path(line_id: String) -> String:
	if not is_safe_identifier(line_id, MAX_IDENTIFIER_LENGTH):
		return ""
	return "/v1/lines/%s/pause" % line_id


static func line_resume_path(line_id: String) -> String:
	if not is_safe_identifier(line_id, MAX_IDENTIFIER_LENGTH):
		return ""
	return "/v1/lines/%s/resume" % line_id


static func line_priority_path(line_id: String) -> String:
	if not is_safe_identifier(line_id, MAX_IDENTIFIER_LENGTH):
		return ""
	return "/v1/lines/%s/priority" % line_id


static func parse_line_control_ack(body: String) -> Dictionary:
	return parse_production_ack(body)


static func parse_market_offers(body: String) -> Dictionary:
	var root := _parse_object(body, "market offers")
	if not root["ok"]:
		return root
	var data: Dictionary = root["value"]

	var tick_result := _int_field(data, "tick", 0, "market offers")
	if not tick_result["ok"]:
		return tick_result
	var tick: int = int(tick_result["value"])

	var offers_result := _array_field(data, "offers", "market offers")
	if not offers_result["ok"]:
		return offers_result
	var raw_offers: Array = offers_result["value"]

	var offers: Array = []
	for i in raw_offers.size():
		var raw: Variant = raw_offers[i]
		if typeof(raw) != TYPE_DICTIONARY:
			return _fail("market offers.offers[%d] must be an object." % i)
		var item: Dictionary = raw
		var contract_id := _identifier_field(item, "contractId", "market offers.offers[%d]" % i)
		if not contract_id["ok"]:
			return contract_id
		var seller_company_id := _identifier_field(item, "sellerCompanyId", "market offers.offers[%d]" % i)
		if not seller_company_id["ok"]:
			return seller_company_id

		var buyer_company_id: Variant = null
		if item.has("buyerCompanyId") and item["buyerCompanyId"] != null:
			var b_result := _identifier_field(item, "buyerCompanyId", "market offers.offers[%d]" % i)
			if not b_result["ok"]:
				return b_result
			buyer_company_id = String(b_result["value"])

		var item_id := _identifier_field(item, "itemId", "market offers.offers[%d]" % i)
		if not item_id["ok"]:
			return item_id
		var quantity := _int_field(item, "quantity", 1, "market offers.offers[%d]" % i)
		if not quantity["ok"]:
			return quantity
		var unit_price := _int_field(item, "unitPriceCredits", 1, "market offers.offers[%d]" % i)
		if not unit_price["ok"]:
			return unit_price
		var total_value := _int_field(item, "totalValueCredits", 1, "market offers.offers[%d]" % i)
		if not total_value["ok"]:
			return total_value
		var created_at := _int_field(item, "createdAtTick", 0, "market offers.offers[%d]" % i)
		if not created_at["ok"]:
			return created_at
		var deadline := _int_field(item, "deadlineTick", 1, "market offers.offers[%d]" % i)
		if not deadline["ok"]:
			return deadline

		offers.append({
			"contractId": String(contract_id["value"]),
			"sellerCompanyId": String(seller_company_id["value"]),
			"buyerCompanyId": buyer_company_id,
			"itemId": String(item_id["value"]),
			"quantity": int(quantity["value"]),
			"unitPriceCredits": int(unit_price["value"]),
			"totalValueCredits": int(total_value["value"]),
			"createdAtTick": int(created_at["value"]),
			"deadlineTick": int(deadline["value"])
		})

	return _ok({"tick": tick, "offers": offers})


static func parse_contracts(body: String) -> Dictionary:
	var root := _parse_object(body, "contracts")
	if not root["ok"]:
		return root
	var data: Dictionary = root["value"]

	var tick_result := _int_field(data, "tick", 0, "contracts")
	if not tick_result["ok"]:
		return tick_result
	var tick: int = int(tick_result["value"])

	var company_id_result := _identifier_field(data, "companyId", "contracts")
	if not company_id_result["ok"]:
		return company_id_result
	var company_id: String = String(company_id_result["value"])

	var contracts_result := _array_field(data, "contracts", "contracts")
	if not contracts_result["ok"]:
		return contracts_result
	var raw_contracts: Array = contracts_result["value"]

	var contracts: Array = []
	for i in raw_contracts.size():
		var raw: Variant = raw_contracts[i]
		if typeof(raw) != TYPE_DICTIONARY:
			return _fail("contracts.contracts[%d] must be an object." % i)
		var item: Dictionary = raw
		var contract_id := _identifier_field(item, "contractId", "contracts.contracts[%d]" % i)
		if not contract_id["ok"]:
			return contract_id
		var seller_company_id := _identifier_field(item, "sellerCompanyId", "contracts.contracts[%d]" % i)
		if not seller_company_id["ok"]:
			return seller_company_id

		var buyer_company_id: Variant = null
		if item.has("buyerCompanyId") and item["buyerCompanyId"] != null:
			var b_result := _identifier_field(item, "buyerCompanyId", "contracts.contracts[%d]" % i)
			if not b_result["ok"]:
				return b_result
			buyer_company_id = String(b_result["value"])

		var item_id := _identifier_field(item, "itemId", "contracts.contracts[%d]" % i)
		if not item_id["ok"]:
			return item_id
		var total_quantity := _int_field(item, "totalQuantity", 1, "contracts.contracts[%d]" % i)
		if not total_quantity["ok"]:
			return total_quantity
		var delivered_quantity := _int_field(item, "deliveredQuantity", 0, "contracts.contracts[%d]" % i)
		if not delivered_quantity["ok"]:
			return delivered_quantity
		var unit_price := _int_field(item, "unitPriceCredits", 1, "contracts.contracts[%d]" % i)
		if not unit_price["ok"]:
			return unit_price
		var total_value := _int_field(item, "totalValueCredits", 1, "contracts.contracts[%d]" % i)
		if not total_value["ok"]:
			return total_value
		var collateral := _int_field(item, "collateralSellerCredits", 0, "contracts.contracts[%d]" % i)
		if not collateral["ok"]:
			return collateral
		var created_at := _int_field(item, "createdAtTick", 0, "contracts.contracts[%d]" % i)
		if not created_at["ok"]:
			return created_at
		var deadline := _int_field(item, "deadlineTick", 1, "contracts.contracts[%d]" % i)
		if not deadline["ok"]:
			return deadline

		var status_result := _string_field(item, "status", "contracts.contracts[%d]" % i)
		if not status_result["ok"]:
			return status_result
		var status_str: String = String(status_result["value"])
		if not ALLOWED_CONTRACT_STATUSES.has(status_str):
			return _fail("contracts.contracts[%d].status must be one of %s." % [i, str(ALLOWED_CONTRACT_STATUSES)])

		var settled_at: Variant = null
		if item.has("settledAtTick") and item["settledAtTick"] != null:
			var s_result := _int_field(item, "settledAtTick", 0, "contracts.contracts[%d]" % i)
			if not s_result["ok"]:
				return s_result
			settled_at = int(s_result["value"])

		contracts.append({
			"contractId": String(contract_id["value"]),
			"sellerCompanyId": String(seller_company_id["value"]),
			"buyerCompanyId": buyer_company_id,
			"itemId": String(item_id["value"]),
			"totalQuantity": int(total_quantity["value"]),
			"deliveredQuantity": int(delivered_quantity["value"]),
			"unitPriceCredits": int(unit_price["value"]),
			"totalValueCredits": int(total_value["value"]),
			"collateralSellerCredits": int(collateral["value"]),
			"createdAtTick": int(created_at["value"]),
			"deadlineTick": int(deadline["value"]),
			"status": status_str,
			"settledAtTick": settled_at
		})

	return _ok({"tick": tick, "companyId": company_id, "contracts": contracts})


## Reads the one-time owner session credential. The token is returned to the
## caller only so the client can keep it in memory; nothing else echoes it.
static func parse_owner_session(body: String) -> Dictionary:
	var root := _parse_object(body, "owner session")
	if not root["ok"]:
		return root
	var data: Dictionary = root["value"]
	var token := _string_field(data, "token", "owner session")
	if not token["ok"]:
		return token
	var token_text := String(token["value"])
	if not is_owner_session_token(token_text):
		return _fail("owner session.token is not a gf_owner_ credential.")
	var owner_id := _identifier_field(data, "ownerId", "owner session")
	if not owner_id["ok"]:
		return owner_id
	var expires := _string_field(data, "expiresAtUtc", "owner session")
	if not expires["ok"]:
		return expires
	return _ok({
		"token": token_text,
		"ownerId": String(owner_id["value"]),
		"expiresAtUtc": String(expires["value"]),
	})


static func is_owner_session_token(value: String) -> bool:
	if not value.begins_with(OWNER_SESSION_TOKEN_PREFIX):
		return false
	var hex := value.substr(OWNER_SESSION_TOKEN_PREFIX.length())
	if hex.length() != OWNER_SESSION_TOKEN_HEX_LENGTH:
		return false
	for index in hex.length():
		var code := hex.unicode_at(index)
		var is_digit := code >= 48 and code <= 57
		var is_hex_letter := code >= 97 and code <= 102
		if not (is_digit or is_hex_letter):
			return false
	return true


## The seller read model: own contracts with engine consequences, plus the
## acting company's recent command outcomes keyed by the caller's own key.
static func parse_owner_selling(body: String) -> Dictionary:
	var root := _parse_object(body, "owner selling")
	if not root["ok"]:
		return root
	var data: Dictionary = root["value"]

	var tick := _int_field(data, "tick", 0, "owner selling")
	if not tick["ok"]:
		return tick
	var company_id := _identifier_field(data, "companyId", "owner selling")
	if not company_id["ok"]:
		return company_id
	var credits := _int_field(data, "availableCredits", 0, "owner selling")
	if not credits["ok"]:
		return credits
	var fee_bps := _int_field(data, "marketFeeBps", 0, "owner selling")
	if not fee_bps["ok"]:
		return fee_bps

	var contracts_result := _array_field(data, "contracts", "owner selling")
	if not contracts_result["ok"]:
		return contracts_result
	var contracts: Array = []
	var raw_contracts: Array = contracts_result["value"]
	for index in raw_contracts.size():
		var parsed := _parse_selling_contract(raw_contracts[index], index)
		if not parsed["ok"]:
			return parsed
		contracts.append(parsed["value"])

	var commands_result := _array_field(data, "recentCommands", "owner selling")
	if not commands_result["ok"]:
		return commands_result
	var commands: Array = []
	var raw_commands: Array = commands_result["value"]
	for index in raw_commands.size():
		var parsed_command := _parse_selling_command(raw_commands[index], index)
		if not parsed_command["ok"]:
			return parsed_command
		commands.append(parsed_command["value"])

	return _ok({
		"tick": int(tick["value"]),
		"companyId": String(company_id["value"]),
		"availableCredits": int(credits["value"]),
		"marketFeeBps": int(fee_bps["value"]),
		"contracts": contracts,
		"recentCommands": commands,
	})


static func _parse_selling_contract(raw: Variant, index: int) -> Dictionary:
	var context := "owner selling.contracts[%d]" % index
	if typeof(raw) != TYPE_DICTIONARY:
		return _fail("%s must be an object." % context)
	var item: Dictionary = raw

	var contract_id := _identifier_field(item, "contractId", context)
	if not contract_id["ok"]:
		return contract_id
	var seller_id := _identifier_field(item, "sellerCompanyId", context)
	if not seller_id["ok"]:
		return seller_id
	var buyer_id: Variant = null
	if item.has("buyerCompanyId") and item["buyerCompanyId"] != null:
		var parsed_buyer := _identifier_field(item, "buyerCompanyId", context)
		if not parsed_buyer["ok"]:
			return parsed_buyer
		buyer_id = String(parsed_buyer["value"])
	var item_id := _identifier_field(item, "itemId", context)
	if not item_id["ok"]:
		return item_id
	var status := _string_field(item, "status", context)
	if not status["ok"]:
		return status
	if not ALLOWED_CONTRACT_STATUSES.has(String(status["value"])):
		return _fail("%s.status '%s' is not a contract status." % [context, String(status["value"])])

	var total_quantity := _int_field(item, "totalQuantity", 1, context)
	if not total_quantity["ok"]:
		return total_quantity
	var delivered := _int_field(item, "deliveredQuantity", 0, context)
	if not delivered["ok"]:
		return delivered
	if int(delivered["value"]) > int(total_quantity["value"]):
		return _fail("%s.deliveredQuantity exceeds totalQuantity." % context)
	var unit_price := _int_field(item, "unitPriceCredits", 1, context)
	if not unit_price["ok"]:
		return unit_price
	var total_value := _int_field(item, "totalValueCredits", 1, context)
	if not total_value["ok"]:
		return total_value
	var collateral := _int_field(item, "collateralSellerCredits", 0, context)
	if not collateral["ok"]:
		return collateral
	var created_at := _int_field(item, "createdAtTick", 0, context)
	if not created_at["ok"]:
		return created_at
	var deadline := _int_field(item, "deadlineTick", 1, context)
	if not deadline["ok"]:
		return deadline
	var settled_at: Variant = null
	if item.has("settledAtTick") and item["settledAtTick"] != null:
		var parsed_settled := _int_field(item, "settledAtTick", 0, context)
		if not parsed_settled["ok"]:
			return parsed_settled
		settled_at = int(parsed_settled["value"])

	var consequences_result := _dictionary_field(item, "consequences", context)
	if not consequences_result["ok"]:
		return consequences_result
	var raw_consequences: Dictionary = consequences_result["value"]
	var consequences := {}
	for field in SELLING_CONSEQUENCE_FIELDS:
		var parsed_field := _int_field(raw_consequences, String(field), 0, "%s.consequences" % context)
		if not parsed_field["ok"]:
			return parsed_field
		consequences[String(field)] = int(parsed_field["value"])

	return _ok({
		"contractId": String(contract_id["value"]),
		"sellerCompanyId": String(seller_id["value"]),
		"buyerCompanyId": buyer_id,
		"itemId": String(item_id["value"]),
		"status": String(status["value"]),
		"totalQuantity": int(total_quantity["value"]),
		"deliveredQuantity": int(delivered["value"]),
		"unitPriceCredits": int(unit_price["value"]),
		"totalValueCredits": int(total_value["value"]),
		"collateralSellerCredits": int(collateral["value"]),
		"createdAtTick": int(created_at["value"]),
		"deadlineTick": int(deadline["value"]),
		"settledAtTick": settled_at,
		"consequences": consequences,
	})


static func _parse_selling_command(raw: Variant, index: int) -> Dictionary:
	var context := "owner selling.recentCommands[%d]" % index
	if typeof(raw) != TYPE_DICTIONARY:
		return _fail("%s must be an object." % context)
	var item: Dictionary = raw
	var key := _string_field(item, "idempotencyKey", context)
	if not key["ok"]:
		return key
	if not is_readable_command_key(String(key["value"])):
		return _fail("%s.idempotencyKey is not a readable command key." % context)
	var status := _string_field(item, "status", context)
	if not status["ok"]:
		return status
	if not ALLOWED_SELLING_COMMAND_STATUSES.has(String(status["value"])):
		return _fail("%s.status must be executed or rejected." % context)
	var executed_at := _int_field(item, "executedAtTick", 0, context)
	if not executed_at["ok"]:
		return executed_at
	var error_code := ""
	if item.has("errorCode") and item["errorCode"] != null:
		var parsed_error := _string_field(item, "errorCode", context)
		if not parsed_error["ok"]:
			return parsed_error
		error_code = String(parsed_error["value"])
	return _ok({
		"idempotencyKey": String(key["value"]),
		"status": String(status["value"]),
		"executedAtTick": int(executed_at["value"]),
		"errorCode": error_code,
	})


## One acknowledged financial command: admitted for a tick, never final work.
static func parse_owner_ack(body: String) -> Dictionary:
	var root := _parse_object(body, "owner acknowledgement")
	if not root["ok"]:
		return root
	var data: Dictionary = root["value"]
	var status := _string_field(data, "status", "owner acknowledgement")
	if not status["ok"]:
		return status
	if String(status["value"]) != OWNER_ACK_STATUS:
		return _fail(
			"An owner acknowledgement must report status '%s', not '%s'."
			% [OWNER_ACK_STATUS, String(status["value"])]
		)
	var scheduled := _int_field(data, "scheduledTick", 0, "owner acknowledgement")
	if not scheduled["ok"]:
		return scheduled

	var ack := {"status": OWNER_ACK_STATUS, "scheduledTick": int(scheduled["value"])}
	for field in ["quantity", "unitPriceCredits", "deadlineTick", "quantityToShip"]:
		if not data.has(field):
			continue
		var parsed := _int_field(data, String(field), 1, "owner acknowledgement")
		if not parsed["ok"]:
			return parsed
		ack[String(field)] = int(parsed["value"])
	for field in ["contractId", "itemId"]:
		if not data.has(field):
			continue
		var parsed := _identifier_field(data, String(field), "owner acknowledgement")
		if not parsed["ok"]:
			return parsed
		ack[String(field)] = String(parsed["value"])
	if data.has("targetBuyerId"):
		if data["targetBuyerId"] == null:
			ack["targetBuyerId"] = null
		else:
			var parsed := _identifier_field(data, "targetBuyerId", "owner acknowledgement")
			if not parsed["ok"]:
				return parsed
			ack["targetBuyerId"] = String(parsed["value"])
	return _ok(ack)


## `POST /v1/owner/contracts`: offer terms only. An open offer omits the buyer.
static func build_owner_draft_request(
	idempotency_key: String,
	item_id: String,
	quantity: int,
	unit_price_credits: int,
	deadline_tick: int,
	target_buyer_id: String = ""
) -> Dictionary:
	if not is_valid_idempotency_key(idempotency_key):
		return _fail(
			"idempotency_key must be %d-%d characters from A-Z, a-z, 0-9, '_' or '-'."
			% [MIN_IDEMPOTENCY_KEY_LENGTH, MAX_IDEMPOTENCY_KEY_LENGTH]
		)
	if not is_safe_identifier(item_id, MAX_IDENTIFIER_LENGTH):
		return _fail("itemId must be a server item identifier using A-Z, a-z, 0-9, '_' or '-'.")
	if quantity < 1 or unit_price_credits < 1 or deadline_tick < 1:
		return _fail("quantity, unit price and deadline tick must be positive integers.")
	var payload := {
		"idempotency_key": idempotency_key,
		"item_id": item_id,
		"quantity": quantity,
		"unit_price": unit_price_credits,
		"deadline_tick": deadline_tick,
	}
	if not target_buyer_id.is_empty():
		if not is_safe_identifier(target_buyer_id, MAX_IDENTIFIER_LENGTH):
			return _fail("targetBuyerId must be a company identifier, or empty for an open offer.")
		payload["target_buyer_id"] = target_buyer_id
	return _ok(JSON.stringify(payload))


static func build_owner_action_request(idempotency_key: String) -> Dictionary:
	if not is_valid_idempotency_key(idempotency_key):
		return _fail(
			"idempotency_key must be %d-%d characters from A-Z, a-z, 0-9, '_' or '-'."
			% [MIN_IDEMPOTENCY_KEY_LENGTH, MAX_IDEMPOTENCY_KEY_LENGTH]
		)
	return _ok(JSON.stringify({"idempotency_key": idempotency_key}))


static func build_owner_dispatch_request(idempotency_key: String, quantity_to_ship: int) -> Dictionary:
	if not is_valid_idempotency_key(idempotency_key):
		return _fail(
			"idempotency_key must be %d-%d characters from A-Z, a-z, 0-9, '_' or '-'."
			% [MIN_IDEMPOTENCY_KEY_LENGTH, MAX_IDEMPOTENCY_KEY_LENGTH]
		)
	if quantity_to_ship < 1:
		return _fail("quantity_to_ship must be a positive integer.")
	return _ok(JSON.stringify({"idempotency_key": idempotency_key, "quantity_to_ship": quantity_to_ship}))


static func owner_contract_path(contract_id: String, action: String) -> String:
	if not is_safe_identifier(contract_id, MAX_IDENTIFIER_LENGTH):
		return ""
	if not OWNER_CONTRACT_ACTIONS.has(action):
		return ""
	return "%s/%s/%s" % [OWNER_CONTRACTS_PATH, contract_id, action]


## Keys the seller loop reports include other routes' keys, so this never
## reuses the stricter caller-key shape the financial routes require.
static func is_readable_command_key(value: String) -> bool:
	if value.is_empty() or value.length() > MAX_COMMAND_KEY_LENGTH:
		return false
	for index in value.length():
		var code := value.unicode_at(index)
		if code < 33 or code > 126:
			return false
	return true


static func is_valid_idempotency_key(value: String) -> bool:
	if value.length() < MIN_IDEMPOTENCY_KEY_LENGTH or value.length() > MAX_IDEMPOTENCY_KEY_LENGTH:
		return false
	return is_safe_identifier(value, MAX_IDEMPOTENCY_KEY_LENGTH)


static func build_request_id(prefix: String, sequence: int) -> String:
	var safe_prefix := "godot"
	var cleaned := prefix.strip_edges().to_lower()
	if is_safe_identifier(cleaned, 12):
		safe_prefix = cleaned
	return "%s-%d-%d" % [safe_prefix, Time.get_ticks_usec(), sequence]


static func is_valid_request_id(value: String) -> bool:
	return is_safe_identifier(value, MAX_REQUEST_ID_LENGTH)


static func is_safe_identifier(value: String, max_length: int) -> bool:
	if value.is_empty() or value.length() > max_length:
		return false
	for index in value.length():
		var code := value.unicode_at(index)
		var is_digit := code >= 48 and code <= 57
		var is_upper := code >= 65 and code <= 90
		var is_lower := code >= 97 and code <= 122
		var is_separator := code == 95 or code == 45
		if not (is_digit or is_upper or is_lower or is_separator):
			return false
	return true


static func _parse_stock(raw: Variant, context: String) -> Dictionary:
	if typeof(raw) != TYPE_DICTIONARY:
		return _fail("%s must be an object with 'available' and 'reserved'." % context)
	var stock: Dictionary = raw
	var available := _int_field(stock, "available", 0, context)
	if not available["ok"]:
		return available
	var reserved := _int_field(stock, "reserved", 0, context)
	if not reserved["ok"]:
		return reserved
	return _ok({"available": int(available["value"]), "reserved": int(reserved["value"])})


static func _parse_line(raw: Variant, index: int) -> Dictionary:
	var context := "state.company.lines[%d]" % index
	if typeof(raw) != TYPE_DICTIONARY:
		return _fail("%s must be an object." % context)
	var line: Dictionary = raw
	var line_id := _identifier_field(line, "lineId", context)
	if not line_id["ok"]:
		return line_id
	var status := _string_field(line, "status", context)
	if not status["ok"]:
		return status
	var status_text := String(status["value"])
	if not ALLOWED_LINE_STATUSES.has(status_text):
		return _fail("%s.status '%s' is not one of: %s." % [context, status_text, ", ".join(ALLOWED_LINE_STATUSES)])
	var priority := _int_field(line, "priority", 1, context)
	if not priority["ok"]:
		return priority
	if int(priority["value"]) > 3:
		return _fail("%s.priority must be 1, 2 or 3." % context)

	var active_batch: Dictionary = {}
	if line.has("activeBatch") and line["activeBatch"] != null:
		var batch_result := _parse_active_batch(line["activeBatch"], "%s.activeBatch" % context)
		if not batch_result["ok"]:
			return batch_result
		active_batch = batch_result["value"]

	var current_recipe_id := ""
	if line.has("currentRecipeId") and line["currentRecipeId"] != null:
		var recipe_field := _string_field(line, "currentRecipeId", context)
		if not recipe_field["ok"]:
			return recipe_field
		current_recipe_id = String(recipe_field["value"])

	return _ok({
		"lineId": String(line_id["value"]),
		"companyId": String(line.get("companyId", "")),
		"priority": int(priority["value"]),
		"status": status_text,
		"currentRecipeId": current_recipe_id,
		"totalBatchesProduced": int(line.get("totalBatchesProduced", 0)),
		"lastActionTick": int(line.get("lastActionTick", 0)),
		"activeBatch": active_batch,
	})


static func _parse_active_batch(raw: Variant, context: String) -> Dictionary:
	if typeof(raw) != TYPE_DICTIONARY:
		return _fail("%s must be an object." % context)
	var batch: Dictionary = raw
	var recipe_id := _string_field(batch, "recipeId", context)
	if not recipe_id["ok"]:
		return recipe_id
	var target := _int_field(batch, "targetBatches", 1, context)
	if not target["ok"]:
		return target
	var completed := _int_field(batch, "completedBatches", 0, context)
	if not completed["ok"]:
		return completed
	var progress := _int_field(batch, "progressTicks", 0, context)
	if not progress["ok"]:
		return progress
	var duration := _int_field(batch, "totalDurationTicks", 1, context)
	if not duration["ok"]:
		return duration
	if int(progress["value"]) > int(duration["value"]):
		return _fail(
			"%s.progressTicks (%d) exceeds totalDurationTicks (%d)."
			% [context, int(progress["value"]), int(duration["value"])]
		)
	return _ok({
		"recipeId": String(recipe_id["value"]),
		"targetBatches": int(target["value"]),
		"completedBatches": int(completed["value"]),
		"progressTicks": int(progress["value"]),
		"totalDurationTicks": int(duration["value"]),
		"energyPerTick": int(batch.get("energyPerTick", 0)),
		"energyRemainder": int(batch.get("energyRemainder", 0)),
	})


static func _parse_recipe(raw: Variant, index: int) -> Dictionary:
	var context := "state.recipes[%d]" % index
	if typeof(raw) != TYPE_DICTIONARY:
		return _fail("%s must be an object." % context)
	var recipe: Dictionary = raw
	var recipe_id := _string_field(recipe, "id", context)
	if not recipe_id["ok"]:
		return recipe_id
	var name := _string_field(recipe, "name", context)
	if not name["ok"]:
		return name
	var output_item := _string_field(recipe, "outputItem", context)
	if not output_item["ok"]:
		return output_item
	var output_quantity := _int_field(recipe, "outputQuantity", 1, context)
	if not output_quantity["ok"]:
		return output_quantity
	var duration := _int_field(recipe, "durationTicks", 1, context)
	if not duration["ok"]:
		return duration
	var energy_cost := _int_field(recipe, "energyCost", 0, context)
	if not energy_cost["ok"]:
		return energy_cost

	var inputs: Array[Dictionary] = []
	var inputs_result := _array_field(recipe, "inputs", context)
	if not inputs_result["ok"]:
		return inputs_result
	var raw_inputs: Array = inputs_result["value"]
	for input_index in raw_inputs.size():
		var input_context := "%s.inputs[%d]" % [context, input_index]
		if typeof(raw_inputs[input_index]) != TYPE_DICTIONARY:
			return _fail("%s must be an object." % input_context)
		var raw_input: Dictionary = raw_inputs[input_index]
		var item_id := _string_field(raw_input, "itemId", input_context)
		if not item_id["ok"]:
			return item_id
		var quantity := _int_field(raw_input, "quantity", 1, input_context)
		if not quantity["ok"]:
			return quantity
		inputs.append({"itemId": String(item_id["value"]), "quantity": int(quantity["value"])})

	return _ok({
		"id": String(recipe_id["value"]),
		"name": String(name["value"]),
		"outputItem": String(output_item["value"]),
		"outputQuantity": int(output_quantity["value"]),
		"durationTicks": int(duration["value"]),
		"energyCost": int(energy_cost["value"]),
		"inputs": inputs,
	})


static func _parse_object(body: String, context: String) -> Dictionary:
	if body.length() > MAX_RESPONSE_CHARS:
		return _fail("The %s response is too large (%d bytes)." % [context, body.length()])
	var json := JSON.new()
	if json.parse(body) != OK:
		return _fail(
			"The %s response is not valid JSON (line %d: %s)."
			% [context, json.get_error_line(), json.get_error_message()]
		)
	var parsed: Variant = json.data
	if typeof(parsed) != TYPE_DICTIONARY:
		return _fail("The %s response is not a JSON object." % context)
	return _ok(parsed)


static func _dictionary_field(source: Dictionary, key: String, context: String) -> Dictionary:
	if not source.has(key):
		return _fail("%s.%s is missing." % [context, key])
	var value: Variant = source[key]
	if typeof(value) != TYPE_DICTIONARY:
		return _fail("%s.%s must be an object." % [context, key])
	return _ok(value)


static func _object_field(source: Dictionary, key: String, context: String) -> Dictionary:
	return _dictionary_field(source, key, context)


static func _array_field(source: Dictionary, key: String, context: String) -> Dictionary:
	if not source.has(key):
		return _fail("%s.%s is missing." % [context, key])
	var value: Variant = source[key]
	if typeof(value) != TYPE_ARRAY:
		return _fail("%s.%s must be an array." % [context, key])
	return _ok(value)


static func _string_field(source: Dictionary, key: String, context: String) -> Dictionary:
	if not source.has(key):
		return _fail("%s.%s is missing." % [context, key])
	var value: Variant = source[key]
	if typeof(value) != TYPE_STRING:
		return _fail("%s.%s must be a string." % [context, key])
	var text := String(value)
	if text.is_empty():
		return _fail("%s.%s must not be empty." % [context, key])
	return _ok(text)


static func _identifier_field(source: Dictionary, key: String, context: String) -> Dictionary:
	var text := _string_field(source, key, context)
	if not text["ok"]:
		return text
	if not is_safe_identifier(String(text["value"]), MAX_IDENTIFIER_LENGTH):
		return _fail("%s.%s contains characters outside A-Z, a-z, 0-9, '_' or '-'." % [context, key])
	return text


static func _int_field(source: Dictionary, key: String, min_value: int, context: String) -> Dictionary:
	if not source.has(key):
		return _fail("%s.%s is missing." % [context, key])
	var result := _as_int(source[key], "%s.%s" % [context, key], min_value)
	return result


static func _as_int(value: Variant, label: String, min_value: int) -> Dictionary:
	var value_type := typeof(value)
	if value_type == TYPE_INT:
		var integer: int = value
		if integer < min_value:
			return _fail("%s must be an integer >= %d." % [label, min_value])
		return _ok(integer)
	if value_type == TYPE_FLOAT:
		var number: float = value
		if not is_finite(number) or number != floor(number):
			return _fail("%s must be a whole number." % label)
		if absf(number) > 9007199254740991.0:
			return _fail("%s is outside the supported integer range." % label)
		var converted := int(number)
		if converted < min_value:
			return _fail("%s must be an integer >= %d." % [label, min_value])
		return _ok(converted)
	return _fail("%s must be a number." % label)


static func _sanitise_message(message: String) -> String:
	var safe := message.replace("\n", " ").replace("\r", " ").replace("\t", " ").strip_edges()
	if safe.length() > MAX_ERROR_MESSAGE_LENGTH:
		safe = safe.substr(0, MAX_ERROR_MESSAGE_LENGTH)
	return safe


static func _ok(value: Variant) -> Dictionary:
	return {"ok": true, "error": "", "value": value}


static func _fail(message: String) -> Dictionary:
	return {"ok": false, "error": message}
