# Supply contract authorization

Supply offers are accepted through the authoritative engine command
`ACCEPT_SUPPLY_OFFER`. Client parameters never override the acting company or
the seller and terms already recorded on the offer.

## Drafts and human publication

- `draft_supply_offer` requires `contracts:draft` and enqueues
  `DRAFT_SUPPLY_OFFER`, never the legacy manual `CREATE_SUPPLY_OFFER` command.
- A DRAFT reserves no credits, collateral or goods. Its stored collateral amount
  is only a requirement estimate. Drafts are visible only to their author via
  `get_contracts` (including `status: "DRAFT"`), never in market quotes or to a
  prospective buyer, and cannot be accepted.
- Each company may hold at most five open DRAFTs. The engine checks this while
  executing the authoritative queue, so same-tick submissions cannot bypass it.
  A rejected draft does not consume a contract ID. Cancellation or publication
  frees a draft slot.
- `cancel_own_pending_offer` may cancel the author's DRAFT or unaccepted PENDING
  offer. It cannot cancel another company's offer or an ACTIVE contract. Calls
  use the existing gateway audit interface; durable execution history records
  command outcomes when persistence is enabled.
- Only an active owner session can call
  `POST /v1/owner/contracts/<id>/publish`. The server selects the acting company
  and schedules `PUBLISH_SUPPLY_OFFER` on the next tick through durable command
  admission. The engine rechecks draft ownership, deadline and collateral.
  Publication changes DRAFT to PENDING without locking funds; buyer acceptance
  remains the point where escrow and collateral are debited.
- There is no MCP publish/accept tool or grantable financial scope. A root bearer
  or MCP grant cannot authenticate publication. Existing trusted/manual
  `CREATE_SUPPLY_OFFER` behavior stays PENDING for backward compatibility.

See [owner API](mcp-owner-api.md) for the request and exact responses, and
[storage version 6](contract-draft-storage.md) before starting an existing volume.

## Acceptance rules

- A pending open offer has an empty `buyerCompanyId`. Any existing company other
  than its seller may accept it; that company becomes the buyer.
- A targeted offer records `targetBuyerId` as `buyerCompanyId`. Only that buyer
  may accept it. Acceptance preserves the seller, item, quantity, price,
  collateral, penalty and deadline.
- A seller cannot accept its own offer, including an open offer.
- Authorization is checked before debiting buyer funds or seller collateral.
  Rejected commands produce an execution-history error without changing offer
  state, credits or inventories.
- Commands scheduled for the same tick use the existing authoritative queue.
  The first valid acceptance activates the offer and locks escrow once; competing
  acceptance or later retries cannot activate it again.

## Rejection results

| Error code | Exact message | Condition |
| --- | --- | --- |
| `ERR_OFFER_NOT_FOR_BUYER` | `Only the designated buyer can accept this offer` | A company other than the targeted buyer tries to accept. |
| `ERR_SELF_CONTRACT` | `Seller cannot accept its own offer` | The accepting company is the seller. |
| `ERR_OFFER_NOT_AVAILABLE` | `Offer does not exist or is not pending` | The offer is missing or not pending, including DRAFTs and competing acceptance/retries. |
| `ERR_CANNOT_PUBLISH` | `Only draft offers owned by the company can be published` | Internal publication targets another owner or a non-DRAFT. |
| `ERR_MAX_DRAFTS_REACHED` | `Maximum 5 open draft offers per company` | A sixth open draft would be created. |
| `ERR_CANNOT_CANCEL` | `Only draft or pending offers owned by the company can be cancelled` | Cancellation targets another owner or a non-cancellable state. |
| `ERR_INVALID_OFFER_PARAMS` | `Offer deadline must be in the future` | A draft expires before its publication tick. |

Existing insufficient-funds and insufficient-collateral results are unchanged.
Partial-default settlement (#5) remains separate; no accounting completion is
claimed by the authorization/draft work.

## Verify

```sh
bun test backend/tests/engine/contracts-lifecycle.test.ts backend/tests/mcp/contract-drafts.test.ts backend/tests/mcp/isolation.test.ts backend/tests/owner-contract-publication.test.ts backend/tests/regressions
```
