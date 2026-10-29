# Supply contract authorization

Supply offers are accepted through the authoritative engine command
`ACCEPT_SUPPLY_OFFER`. Client parameters never override the acting company or
the seller and terms already recorded on the offer.

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
| `ERR_OFFER_NOT_AVAILABLE` | `Offer does not exist or is not pending` | The offer is missing or no longer pending, including competing acceptance/retries. |

Existing insufficient-funds and insufficient-collateral results are unchanged.
These rules do not yet resolve MCP draft publication (#3) or partial-default
settlement (#5); neither is claimed complete by the acceptance fix.

## Verify

```sh
bun test backend/tests/engine/contracts-lifecycle.test.ts backend/tests/mcp/isolation.test.ts backend/tests/regressions
```
