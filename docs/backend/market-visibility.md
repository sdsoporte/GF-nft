# Market visibility (issue #58, milestone A)

The player can now inspect the market and their own contracts. Two additive
`GET` routes project engine state that already existed; the frozen v1 contract in
`contracts/factory-api.md` is untouched — no existing route changed, no new
protocol version, no new error code, no new command type.

This milestone is **read-only by construction**. There is no accept, cancel,
dispatch or publish route here. Trading is milestone B, a separate authorized
slice; today the only way a contract moves is an engine command queued by
another slice.

## Routes

| Route | Method | Auth | Response |
| --- | --- | --- | --- |
| `/v1/market/offers` | `GET` | root bearer token (same gate as `/v1/state`) | public supply book |
| `/v1/contracts` | `GET` | root bearer token (same gate as `/v1/state`) | own contracts |

Both are authenticated exactly like `/v1/state`: the root match token, not an
MCP grant. A missing or wrong token is `401 UNAUTHORIZED`. Any other method on
these paths is `405 METHOD_NOT_ALLOWED`, so no write verb can be aimed at them.
A body sent to a `GET` is discarded, never parsed. The response is
`application/json; charset=utf-8` and `cache-control: no-store`, like every
other route.

## `GET /v1/market/offers`

```json
{
  "tick": 41,
  "offers": [
    {
      "contractId": "cnt_12_3",
      "sellerCompanyId": "comp_metal_02",
      "buyerCompanyId": null,
      "itemId": "IRON_INGOT",
      "quantity": 5,
      "unitPriceCredits": 22,
      "totalValueCredits": 110,
      "createdAtTick": 12,
      "deadlineTick": 312
    }
  ]
}
```

- `tick` is the authoritative match tick the list was read at.
- An entry is listed only when it is tradable right now: `status === 'PENDING'`
  and `deadlineTick > tick`. That is the same absolute-tick expiry predicate the
  NPC policy and the engine's dispatch checks already use.
- `DRAFT` offers never appear. A draft is its creator's private business, so the
  book shows no draft of any company, not even the server-selected one. Own
  drafts are visible on `/v1/contracts` instead.
- `buyerCompanyId` is `null` for an open offer and the designated company ID for
  an offer addressed to one buyer.
- `quantity` is the offered quantity (the contract's `totalQuantity`); there is
  no delivered quantity on an offer because nothing has been delivered yet.
- Entry order is the engine's contract order, so two identical matches produce
  identical books.
- NPC surplus offers appear here naturally: NPC companies are wired into the
  authoritative tick loop (#55) and publish like any other seller.

An expired `PENDING` offer simply drops out of this projection. The engine is not
mutated by reading: the contract stays `PENDING` in state until a mutating slice
decides what to do with it, and this route neither cancels nor settles anything.

## `GET /v1/contracts`

```json
{
  "tick": 41,
  "companyId": "comp_metal_01",
  "contracts": [
    {
      "contractId": "cnt_12_1",
      "sellerCompanyId": "comp_metal_01",
      "buyerCompanyId": "comp_manuf_02",
      "itemId": "MEGAMACHINE_PART",
      "totalQuantity": 2,
      "deliveredQuantity": 1,
      "unitPriceCredits": 10,
      "totalValueCredits": 20,
      "collateralSellerCredits": 4,
      "createdAtTick": 6,
      "deadlineTick": 206,
      "status": "ACTIVE",
      "settledAtTick": null
    }
  ]
}
```

Visibility is the rule the MCP `get_contracts` tool already applies, shared by
construction rather than re-implemented:

- A contract is own when the server-selected company (`companyId`) is its seller
  **or** its buyer. Both sides of the trade are therefore visible.
- A `DRAFT` is own only for its seller. A foreign draft never appears, on any
  route.
- Foreign contracts in which the company is neither seller nor buyer are omitted.

`status` is the engine's contract status (`DRAFT`, `PENDING`, `ACTIVE`,
`FULFILLED`, `DEFAULTED`, `CANCELLED`). `settledAtTick` is always present and is
`null` until the engine settles the contract, so a client never has to guess
between an absent key and a missing value.

## Empty states

Both routes always answer with an explicit array:

```json
{"tick": 0, "offers": []}
{"tick": 0, "companyId": "comp_metal_01", "contracts": []}
```

An empty market or a company without contracts is a normal `200` with `[]`,
never `null`, never an omitted key and never a `404`.

## Freshness

Every response carries `tick`, the authoritative match tick at read time. A
client compares it with the `tick` of `/v1/state` to know whether the market and
contract data describe the same simulation step. Nothing is cached server-side.

## Errors

| HTTP | Code | Cause |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | Missing or incorrect root bearer token |
| 405 | `METHOD_NOT_ALLOWED` | Known read route with a non-`GET` method |
| 404 | `NOT_FOUND` | Unknown route (for example `/v1/market/accept`) |
| 500 | `INTERNAL_ERROR` | Unexpected projection failure |

The table is the frozen v1 catalogue; this slice adds no code to it.

## Out of scope

Accepting, cancelling, dispatching, publishing and every other mutation belong to
milestone B. The Godot client must render these projections and never predict or
simulate contract transitions locally.

## Verification

```sh
bun test backend/tests/market-visibility.test.ts
bun run test
bun run lint
bun run build
```

`backend/tests/market-visibility.test.ts` covers root-token authentication on
both routes, the explicit empty book and empty contract list, seller attribution
and the exact key set of an offer, draft privacy for both own and foreign
drafts, expiry falling out of the book without the engine mutating the contract,
delivery progress and `FULFILLED` settlement, buyer-side ownership, foreign
contract scoping, the snapshot tick matching `/v1/state`, NPC surplus offers
surfacing in the book, and read-only behavior (no queued command, no execution,
no state change, `405` on write verbs). Every test owns an isolated in-memory
match with a manual clock; no test depends on wall-clock time.
