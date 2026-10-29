# Append-only credit journal: schema version 7

Migration `007_credit_journal` adds the durable storage an auditable credit
ledger needs. It is a **storage and audit foundation**: it records an immutable
opening and append-only movements, and it changes no balance. Contract
settlement, the 2% fee on delivered value and legacy opening creation inside a
live match are later integration work; nothing here runs automatically.

## What the tables mean

| Table | Meaning |
| --- | --- |
| `credit_ledger_openings` | One immutable row per match: the observed tick, `COMPLETE` (covers the whole match) or `CUTOVER` (legacy state enters at this tick), and when it was opened. |
| `credit_ledger_opening_balances` | The available/held balance observed per typed account at that tick. `(match_id, account_json)` is the primary key, so one account cannot appear twice and sinks are rejected. |
| `credit_ledger_movements` | Append-only movements: positive amount, per-match `sequence_number` as primary key, and `UNIQUE (match_id, event_key)`. |

`companies.credits` remains the authoritative spendable balance. The journal is
evidence: it can be used to audit or reconcile, never to grant or repair credits.
Sinks are derived by summing movements, which is why an opening cannot invent
one.

## Typed accounts and movements

Accounts are either company-backed (`AVAILABLE`, `BUYER_ESCROW`,
`SELLER_COLLATERAL`, each with a `companyId`) or global sinks
(`MARKET_FEE_SINK`, `MAINTENANCE_SINK`, which carry no company at all).

| Movement kind | Route | Contract id |
| --- | --- | --- |
| `BUYER_ESCROW_DEPOSIT` | available -> buyer escrow (same company) | required |
| `SELLER_COLLATERAL_DEPOSIT` | available -> seller collateral (same company) | required |
| `DELIVERY_PAYMENT` | buyer escrow -> seller available | required |
| `FEE_SINK` | buyer escrow -> market fee sink | required |
| `INDEMNITY_TRANSFER` | seller collateral -> buyer available | required |
| `REFUND` | buyer escrow or seller collateral -> available (same company) | required |
| `MAINTENANCE_SINK` | available -> maintenance sink | **forbidden** |

A penalty is an `INDEMNITY_TRANSFER`, not a burned movement: credits leave the
seller's collateral and arrive in the buyer's available account. `contract_id`
is nullable only because maintenance belongs to no contract, and it is never part
of a uniqueness rule — the event key, not the nullable contract, identifies a
movement.

## Upgrade behavior

- `schema.sql` and migrations 1-6 are unchanged. Version 7 only adds tables.
- Existing companies, contracts and match rows keep their values; no movement,
  opening or balance row is written by the upgrade. There is no back-pay, no
  opening guess and no money change on a legacy database.
- A legacy match records a `CUTOVER` opening with the balances observed at that
  tick. Prior history is preserved and audited from that cutover only.
- Reopening an already-upgraded database applies nothing again. A failed
  application rolls back the new tables and the version record together.
- Do not run an older build against a version-7 database; the runner refuses a
  database newer than the build.

## Verify on disposable state

```sh
bun test backend/tests/persistence/credit-journal.test.ts \\
  backend/tests/persistence/draft-status-migration.test.ts
```

This schema cut verifies a populated version-6 upgrade with unchanged legacy
rows and empty journal tables, repeat no-op, and complete post-DDL rollback.
Repository opening/movement APIs and the optional atomic batch follow in separate
review cuts; this cut creates no live opening or movement.
