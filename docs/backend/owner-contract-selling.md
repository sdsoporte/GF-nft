# Draft, cancel and dispatch offers from an owner session

The player-as-seller loop now has its own three owner-session routes next to the
frozen publication route: draft an offer, cancel an eligible own offer and
dispatch goods for an own active contract. Every route reuses the existing
publication conventions, so a client that already publishes offers needs no new
credential, transport or error vocabulary.

## Quick path

```bash
# 1. Draft an offer: absolute deadline tick, terms only, no server fields.
curl -fsS -X POST http://127.0.0.1:8787/v1/owner/contracts \
  -H "Authorization: Bearer $session" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"draft_offer_0001","item_id":"RAW_ORE",
       "quantity":10,"unit_price":5,"deadline_tick":50}'

# 2. Publish the DRAFT it produced (unchanged route).
curl -fsS -X POST "http://127.0.0.1:8787/v1/owner/contracts/$contract_id/publish" \
  -H "Authorization: Bearer $session" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"publish_offer_0001"}'

# 3. Cancel it while it is still DRAFT or unaccepted PENDING.
curl -fsS -X POST "http://127.0.0.1:8787/v1/owner/contracts/$contract_id/cancel" \
  -H "Authorization: Bearer $session" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"cancel_offer_0001"}'

# 4. Once a buyer accepts, ship part or all of the goods (seller only).
curl -fsS -X POST "http://127.0.0.1:8787/v1/owner/contracts/$contract_id/dispatch" \
  -H "Authorization: Bearer $session" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"dispatch_lot_0001","quantity_to_ship":4}'
```

Each accepted call answers `202` with `status: "ENQUEUED_FOR_NEXT_TICK"`. That
acknowledges durable admission, not completed work: the engine still rechecks
ownership, status, deadline, collateral and stock when it executes the command on
the next tick. Exactly as on publication, `409 ERR_DUPLICATE_IDEMPOTENCY_KEY`
means the key was already used and nothing new was admitted.

## HTTP contract

| Method and path | Body | 202 response |
| --- | --- | --- |
| `POST /v1/owner/contracts` | `idempotency_key`, `item_id`, `quantity`, `unit_price`, `deadline_tick`, optional `target_buyer_id` | `status`, `scheduledTick`, `itemId`, `quantity`, `unitPriceCredits`, `deadlineTick`, `targetBuyerId` (`null` when open) |
| `POST /v1/owner/contracts/<id>/cancel` | `idempotency_key` | `status`, `scheduledTick`, `contractId` |
| `POST /v1/owner/contracts/<id>/dispatch` | `idempotency_key`, `quantity_to_ship` | `status`, `scheduledTick`, `contractId`, `quantityToShip` |
| `POST /v1/owner/contracts/<id>/publish` | `idempotency_key` | `status`, `scheduledTick`, `contractId` (unchanged) |

Authentication is the owner-session bearer only. The root token, an MCP grant
token, a forged token, an expired session and a logged-out session all get the
fixed `401 UNAUTHORIZED` response before any command is admitted, so agents gain
no financial scope from these routes.

### Value bounds

The routes do not restate the domains the MCP write tools already validate; they
read them from the same command schemas (`backend/src/mcp/schemas.ts`).

| Field | Accepted |
| --- | --- |
| `idempotency_key` | 8–64 characters, `A-Z a-z 0-9 _ -` |
| `item_id` | The nine tradable item ids (`RAW_ORE` … `MEGAMACHINE_PART`) |
| `quantity` | Integer 1–5000 |
| `unit_price` | Integer 1–100000 |
| `deadline_tick` | Absolute match tick; its horizon (deadline minus current tick) is 10–2700 |
| `target_buyer_id` | A company id; omit it to create an open offer; explicit `null` is rejected |
| `quantity_to_ship` | Integer 1–1000; the engine clamps it to the quantity still owed |

The body key set is exact. Company id, contract id, command id, scheduled tick
and batch or deadline deltas are rejected with `400 ERR_INVALID_PAYLOAD`, so a
caller can never select the acting company or the tick its command runs on.

### Refusals

| Situation | Response |
| --- | --- |
| Missing/root/grant/expired/logged-out bearer | `401 UNAUTHORIZED` |
| Wrong media type | `415 UNSUPPORTED_MEDIA_TYPE`, message names the route family |
| Body over 8192 bytes | `413 REQUEST_TOO_LARGE` |
| Malformed JSON | `400 INVALID_REQUEST` / fixed message |
| Invalid fields, bounds or key | `400 ERR_INVALID_PAYLOAD`, per-route message |
| Unknown contract, foreign seller, or ineligible status | `404 NOT_FOUND`, generic message |
| Key already used | `409 ERR_DUPLICATE_IDEMPOTENCY_KEY` |

Cancellation is admission-checked against `DRAFT` and `PENDING` only; an `ACTIVE`
contract is `404`, and there is no ACTIVE cancellation anywhere. Dispatch is
seller-only and `ACTIVE`-only, so a foreign contract and an unaccepted offer are
indistinguishable from an absent one.

## Durable behaviour

All three routes go through the publication admission seam
(`FactoryMatch.submitMcpCommand`), which commits the queue row, the permanent
idempotency key and the command in one transaction before the engine observes
it. Consequences a client can rely on:

- A queued draft, cancellation or dispatch survives a restart and executes on
  the next tick of the restored match.
- Retrying the same key after a restart returns `409` and admits nothing.
- One key is one financial command: reusing it for another action, or with
  different terms, is refused rather than replayed or duplicated.
- Refusals change no queue, sequence, acknowledgement or economic state.

## Reading the seller loop back

Writing the seller loop is not enough for an honest confirmation, so one
additive read route serves it to the same owner session:

```bash
curl -fsS http://127.0.0.1:8787/v1/owner/selling \
  -H "Authorization: Bearer $session"
```

```json
{
  "tick": 42,
  "companyId": "comp_metal_01",
  "availableCredits": 10000,
  "marketFeeBps": 200,
  "contracts": [
    {
      "contractId": "cnt_41_1", "sellerCompanyId": "comp_metal_01",
      "buyerCompanyId": null, "itemId": "RAW_ORE",
      "totalQuantity": 10, "deliveredQuantity": 0,
      "unitPriceCredits": 5, "totalValueCredits": 50,
      "collateralSellerCredits": 10,
      "createdAtTick": 41, "deadlineTick": 91, "status": "DRAFT",
      "settledAtTick": null,
      "consequences": {
        "buyerEscrowCredits": 50, "sellerCollateralCredits": 10,
        "marketFeeCredits": 1, "sellerNetOnFullDeliveryCredits": 49,
        "penaltyPerMissingUnitCredits": 10,
        "maximumDefaultIndemnityCredits": 10
      }
    }
  ],
  "recentCommands": [
    {"idempotencyKey": "sell_draft-1-1", "status": "executed",
     "executedAtTick": 41, "errorCode": null}
  ]
}
```

| Field group | Meaning |
| --- | --- |
| `tick` | The server tick an absolute `deadline_tick` must be computed from. |
| `contracts` | The acting company's own contracts only, in engine order. Foreign drafts and foreign contracts never appear. |
| `consequences` | Engine-owned figures for that contract, derived from the stored record and the engine's own constants: the escrow acceptance locks, the seller collateral, the market fee on full delivery, the net payout, the per-unit default penalty and the indemnity cap. |
| `recentCommands` | The acting company's recent command outcomes, newest last, correlated by the caller's own `idempotency_key`. `202` means admitted; this list is where a queued command becomes `executed` or `rejected` with its `errorCode`. |

Use it in two places:

1. **Before publishing or dispatching** — present `consequences` to the human.
   The client never computes economic rules locally.
2. **After a `202`** — poll until the caller key appears with a final status, or
   until the contract it changed shows the new `status`/`deliveredQuantity`.

Nothing here is public market data: the route needs the owner-session bearer,
it is read-only (`GET` only, other methods are `405`), and it changes no queue,
sequence, acknowledgement or economic state. The public offer book
(`GET /v1/market/offers`) keeps its existing shape and visibility.

`recentCommands` reports keys from every route of the acting company, including
production keys shaped `http:<matchId>:<requestId>`; a client must therefore
correlate by exact key equality rather than by key syntax.

## Checklist

- [ ] A draft carries only offer terms; the server selects company and tick.
- [ ] `202` means "admitted", never "published" or "shipped".
- [ ] Cancellation is refused for anything not `DRAFT`/`PENDING`.
- [ ] Dispatch is refused for anything but the seller's own `ACTIVE` contract.
- [ ] One `idempotency_key` maps to exactly one financial command.
- [ ] Escrow, collateral, fee and default indemnity are read from
      `GET /v1/owner/selling`, never recomputed by a client.

See [owner API](mcp-owner-api.md) for the session and grant routes,
[supply contracts](supply-contracts.md) for the engine rules these routes reach,
and [market visibility](market-visibility.md) for the public offer listing.
