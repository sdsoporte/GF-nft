# Selling your output (issue #58, milestone B)

The player is now a seller: produce or hold goods, draft an offer, publish it,
wait for a buyer, ship the goods and get paid. This page explains what the screen
shows, what the server decides, and what you are approving when the confirmation
asks.

Buying (accepting someone else's offer as the player) is a later slice. Agent
financial scope is unchanged: an MCP grant can read the market, never publish,
accept, cancel or dispatch.

## Quick path

1. Start the backend with an owner identity (`GF_OWNER_ID`). Without it the
   owner-session routes do not exist and the selling panel stays disabled.
2. **Connect**, then **Open owner session**. The screen trades your root bearer
   for a short-lived owner session and keeps it in memory only.
3. Fill the offer form (item, quantity, unit price, ticks until the deadline, and
   an optional target buyer) and press **Draft offer**.
4. Read the confirmation and press **Confirm and send**. The server admits the
   command; the engine creates the `DRAFT` on the next tick. The item defaults
   to the R1 output (`IRON_INGOT`) and the offer is priced at the NPC's existing
   buy ceiling, 10 credits per ingot.
5. Select the draft, press **Publish selected draft**, read the escrow,
   collateral, fee and default consequences, and confirm.
6. Wait for a buyer. A designated or open-market buyer accepts through its own
   path; a targeted offer is still publicly listed, and only the designated
   buyer may accept it.
7. Once the offer is `ACTIVE`, enter the lot and press **Dispatch goods**, read
   the consequences and confirm. Settlement pays the delivered value minus the
   market fee and returns the collateral.

## What the human confirmation shows

| Step | What the player approves |
| --- | --- |
| Draft | The exact terms (item, quantity, unit price, total value) and the absolute deadline tick. A draft locks nothing. |
| Publish | Only that the offer becomes available. Publishing itself still locks nothing. The panel repeats the figures the server reported for that contract: buyer escrow on acceptance, your collateral, the market fee and net payout on full delivery, the per-unit default penalty and the maximum indemnity. |
| dispatch | The lot that leaves your inventory this tick, the resulting delivery progress, the net payout on full delivery and what each still-missing unit would cost after the deadline. |
| Cancel | That an unaccepted offer stops being available. Nothing was locked, so no credits, collateral or goods move. |

Figures come from the server's authenticated seller read model; the client never
recomputes collateral, fees or penalties locally. If the panel cannot read them,
it refuses the step instead of guessing.

## Queued is not done

Every accepted financial command answers `202 ENQUEUED_FOR_NEXT_TICK`. That means
admitted, not done. The screen says so, then follows the command's own
`idempotency_key` through the seller read model until the engine reports
`executed` or `rejected` with its error code, or the contract shows the new
status. A rejection is displayed with the engine code and no economic change is
claimed.

## Engine rules this screen relies on

| Rule | Consequence for the seller |
| --- | --- |
| A draft reserves nothing | You can hold up to five open drafts without locking credits or goods. |
| Acceptance locks the economics | The buyer escrows the full value; you lock 20% collateral. |
| Delivery is inclusive of the deadline tick | A dispatch on the deadline still counts; later dispatches change nothing. |
| Settlement pays delivered value minus 2% | Four units at 50 pay 200 gross, 4 fee, 196 net; your collateral returns. |
| Default forfeits at most the collateral | The buyer is refunded the undelivered value and indemnified with the smaller of your collateral and the per-unit penalty; you lose reputation. |
| Dispatch is seller-only | Only your own `ACTIVE` contract can ship, and only from stock you hold. |

Exact engine values live in [supply contracts](../backend/supply-contracts.md);
the HTTP contract for the four writing routes and the seller read model lives in
[owner-session selling](../backend/owner-contract-selling.md).

## Who buys your R1 output?

The metallurgy NPC (`comp_metal_02`) is the buyer of R1 output. The approved
configuration keeps a target buffer of **five `IRON_INGOT`** for that company —
one R1 batch — so it buys ingots while its own stock is below five and still
retains five before releasing surplus. That is one explicit exception to the
50%-of-starting-stock default from Issue #13, and only for this company and
item: starting stock, every other NPC buffer, the buy algorithm, the price
margins, the fees and the credit rules are unchanged.

| Item | Who wants it | Why |
| --- | --- | --- |
| `IRON_INGOT` | `comp_metal_02`, below a buffer of 5 | Its own `R2` line consumes four ingots per batch; the exception is one R1 batch of demand. |
| `RAW_ORE` | `comp_metal_02`, below its unchanged retention buffer of 100 | Existing ore buying, unchanged by the exception. |
| Anything else | Nobody with a zero buffer | A zero buffer is still zero demand, so those offers stay `PENDING`. |

Prices are unchanged: an NPC pays at most the recipe base unit cost at a 0%
margin, so R1 output sells at **10 credits per ingot** (50 base cost / 5 output).
The screen does not drive NPC decisions; NPCs run inside the authoritative tick
loop and accept through their own policy.

## Checks

```bash
# Client rules only, no backend
GODOT_BIN=/path/to/Godot_v4.7.2 bash game/tests/run_checks.sh

# Full journey against a disposable backend: production, offer, NPC purchase,
# dispatch, settlement, one engine rejection and a restart
GODOT_BIN=/path/to/Godot_v4.7.2 bash game/tests/run_selling_smoke.sh
```

The smoke sells the batch the line just produced: it fails unless the player
started with zero IRON_INGOT, the completed R1 batch added exactly the five units
the server promises, and the offered lot is that same quantity. It also fails
unless settlement pays exactly the net payout the server reported (50 value − 1
market fee = 49 credits, with the 10-credit collateral returned). The script
generates its own token, boots its own backend on a random loopback port with a
temporary SQLite file, and restarts that backend to prove the settled contract
and the used command key survive a new process. It never touches live data, a
real wallet or a persistent state file.
