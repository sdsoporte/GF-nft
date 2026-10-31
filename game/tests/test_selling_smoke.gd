extends SceneTree
## Rules for the disposable-backend selling smoke (issue #58, milestone B).
##
## The journey itself needs a live backend, so this suite pins the parts that
## would make that journey meaningless if they drifted: the smoke sells the R1
## output itself, its price stays at the shipped NPC buy ceiling, the lot is the
## produced batch rather than a constant, the deliberately unaffordable offer
## really is unaffordable, and the NPC buyer it targets can be overridden without
## editing code.

const TestSupport = preload("res://tests/test_support.gd")
const TRADABLE_ITEMS := [
	"RAW_ORE", "IRON_INGOT", "STEEL_PLATE", "HEAVY_ALLOY", "MECH_FRAME",
	"CTRL_CIRCUIT", "POWER_MODULE", "IND_TURBINE", "MEGAMACHINE_PART",
]
const OFFER_QUANTITY_MIN := 1
const OFFER_QUANTITY_MAX := 5000
const UNIT_PRICE_MIN := 1
const UNIT_PRICE_MAX := 100000
const HORIZON_MIN := 10
const HORIZON_MAX := 2700
const STARTING_CREDITS := 10000
## R1 sells at its shipped base unit cost with the unchanged 0% NPC buy margin:
## 50 credits of recipe base cost / 5 output units.
const R1_NPC_BUY_CEILING := 10

var _started: bool = false


func _process(_delta: float) -> bool:
	if _started:
		return true
	_started = true
	var t := TestSupport.new()
	_test_offer_terms(t)
	_test_produced_batch_is_the_lot(t)
	_test_r1_trade_figures(t)
	_test_unaffordable_terms(t)
	_test_npc_buyer_override(t)
	_test_timeout_budget(t)
	quit(t.finish("test_selling_smoke"))
	return true


func _test_offer_terms(t: TestSupport) -> void:
	var terms: Dictionary = FactorySellingSmoke.offer_terms()
	var recipe := _r1_recipe(t)
	t.equal(String(terms["itemId"]), "IRON_INGOT", "the smoke sells the R1 output item")
	t.equal(
		String(terms["itemId"]),
		String(recipe.get("outputItem", "")),
		"the offered item is exactly the item the server says R1 produces"
	)
	t.check(TRADABLE_ITEMS.has(String(terms["itemId"])), "the smoke sells a tradable item id")
	t.check(
		int(terms["unitPriceCredits"]) >= UNIT_PRICE_MIN and int(terms["unitPriceCredits"]) <= UNIT_PRICE_MAX,
		"the smoke's unit price is inside the documented route bounds"
	)
	t.equal(
		int(terms["unitPriceCredits"]),
		R1_NPC_BUY_CEILING,
		"the smoke asks only the shipped NPC buy ceiling, not a new price policy"
	)
	t.check(
		int(terms["horizonTicks"]) >= HORIZON_MIN and int(terms["horizonTicks"]) <= HORIZON_MAX,
		"the smoke's deadline horizon is inside the documented route bounds"
	)
	t.check(
		not String(terms["targetBuyerId"]).is_empty(),
		"the smoke targets the NPC buyer instead of the open market"
	)
	t.check(
		FactoryProtocol.build_owner_draft_request(
			"sell_smoke_probe-1-1",
			String(terms["itemId"]),
			int(recipe.get("outputQuantity", 0)),
			int(terms["unitPriceCredits"]),
			1000,
			String(terms["targetBuyerId"])
		)["ok"],
		"the smoke's terms pass the same request builder the screen uses"
	)


## The offered lot is the batch the line produced, so a run cannot borrow from
## starting stock or invent a quantity.
func _test_produced_batch_is_the_lot(t: TestSupport) -> void:
	var recipe := _r1_recipe(t)
	var batch := int(recipe.get("outputQuantity", 0))
	t.check(batch >= OFFER_QUANTITY_MIN and batch <= OFFER_QUANTITY_MAX,
		"one R1 batch is inside the documented quantity bounds")
	t.equal(
		FactorySellingSmoke.offered_quantity_text(batch),
		str(batch),
		"the offered quantity is the produced batch, not a constant"
	)
	t.equal(
		FactorySellingSmoke.offered_quantity_text(0),
		"0",
		"the smoke never substitutes a default lot when nothing was produced"
	)
	var carried := int(FactorySellingSmoke.offer_terms().get("quantity", -1))
	t.equal(carried, -1, "the smoke's terms carry no baked-in quantity")


## The R1 fixture is the reference trade the journey has to reproduce.
func _test_r1_trade_figures(t: TestSupport) -> void:
	var parsed: Dictionary = FactoryProtocol.parse_owner_selling(
		FileAccess.get_file_as_string("res://tests/fixtures/owner_selling_r1.json")
	)
	if not t.check(parsed["ok"], "the R1 trade fixture parses: %s" % str(parsed.get("error", ""))):
		return
	var contract: Dictionary = parsed["value"]["contracts"][0]
	var recipe := _r1_recipe(t)
	t.equal(String(contract["itemId"]), "IRON_INGOT", "the reference trade sells the R1 output")
	t.equal(
		int(contract["totalQuantity"]),
		int(recipe.get("outputQuantity", 0)),
		"the reference trade sells exactly one R1 batch"
	)
	t.equal(
		int(contract["totalQuantity"]) * int(contract["unitPriceCredits"]),
		int(contract["totalValueCredits"]),
		"the reference trade value is quantity times the ceiling price"
	)
	var consequences: Dictionary = contract["consequences"]
	t.equal(int(consequences["buyerEscrowCredits"]), 50, "escrow for five ingots at the ceiling is 50")
	t.equal(int(consequences["sellerCollateralCredits"]), 10, "the 20% collateral is 10")
	t.equal(int(consequences["marketFeeCredits"]), 1, "the 2% market fee is 1")
	t.equal(
		int(consequences["sellerNetOnFullDeliveryCredits"]),
		49,
		"the expected settlement delta is the value minus the fee"
	)
	t.equal(
		int(consequences["sellerNetOnFullDeliveryCredits"]),
		int(contract["totalValueCredits"]) - int(consequences["marketFeeCredits"]),
		"the journey's settlement assertion is the engine-reported net payout"
	)
	t.equal(
		int(consequences["sellerNetOnFullDeliveryCredits"]) + int(consequences["sellerCollateralCredits"]),
		59,
		"full delivery must return the net payout plus the collateral locked at acceptance"
	)
	t.equal(int(consequences["penaltyPerMissingUnitCredits"]), 10, "the per-unit default penalty is unchanged")
	t.equal(
		int(consequences["maximumDefaultIndemnityCredits"]),
		int(consequences["sellerCollateralCredits"]),
		"the indemnity cap is the seller collateral for this trade"
	)


func _r1_recipe(t: TestSupport) -> Dictionary:
	var parsed: Dictionary = FactoryProtocol.parse_state(t.fixture("state_ok.json"))
	if not t.check(parsed["ok"], "the state fixture parses for the smoke rules"):
		return {}
	return parsed["snapshot"].recipe(FactoryProtocol.PRODUCTION_RECIPE_ID)


func _test_unaffordable_terms(t: TestSupport) -> void:
	var terms: Dictionary = FactorySellingSmoke.unaffordable_terms()
	var total := int(terms["quantity"]) * int(terms["unitPriceCredits"])
	var collateral := int(floor(float(total) * 0.2))
	t.check(
		collateral > STARTING_CREDITS,
		"the rejection leg really exceeds a starting company's collateral (20%% = %d)" % collateral
	)
	t.check(
		int(terms["quantity"]) <= OFFER_QUANTITY_MAX,
		"the rejection leg is refused by the engine, not by client-side bounds"
	)
	t.check(
		int(terms["unitPriceCredits"]) <= UNIT_PRICE_MAX,
		"the rejection leg keeps the unit price the route accepts"
	)


func _test_npc_buyer_override(t: TestSupport) -> void:
	OS.set_environment("GF_SMOKE_NPC_BUYER", "comp_metal_02")
	t.equal(
		FactorySellingSmoke.resolved_npc_buyer(),
		"comp_metal_02",
		"the NPC buyer can be overridden through the environment"
	)
	OS.set_environment("GF_SMOKE_NPC_BUYER", "  ")
	t.equal(
		FactorySellingSmoke.resolved_npc_buyer(),
		String(FactorySellingSmoke.offer_terms()["targetBuyerId"]),
		"a blank override falls back to the documented buyer"
	)
	OS.unset_environment("GF_SMOKE_NPC_BUYER")
	t.check(
		not FactorySellingSmoke.resolved_npc_buyer().is_empty(),
		"the smoke always names an NPC buyer"
	)


func _test_timeout_budget(t: TestSupport) -> void:
	var budget := FactorySellingSmoke.default_timeout_seconds()
	t.check(budget >= 30.0, "the default smoke budget leaves room for production and one NPC tick")
	t.check(budget <= 300.0, "the default smoke budget stays bounded")
