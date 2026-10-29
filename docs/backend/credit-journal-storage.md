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

## Repository API

The repository now provides `createOpening`, `getOpening`, `append`, `list`
and `count` through `createRepositories(db).creditJournal`. Openings are
immutable; movement batches are atomic, ordered by contiguous per-match sequence,
and reject a reused event key. `list` strictly decodes records in journal order.

`CreditJournalError` carries `code` and a `CODE: detail` message: unknown or
mismatched match, missing/repeated opening, future/before-opening tick, sequence
out of order, or duplicated event key. Malformed records use
`CreditLedgerValidationError`. No API mutates spendable credits. No game flow produces a live journal yet.

## Atomic tick composition

`MatchStore.commitExecutions({ metadata, results, completedCommandIds, opening?, movements? })`
saves optional opening/movements in the same transaction as tick metadata,
execution history and queue removal. Both journal arguments must belong to
`metadata.matchId`; a foreign one is rejected with the existing
`MatchStore received a ... for match ... inside the unit of work of ...` error.
Movements require this batch's opening or an earlier committed opening. Even an
explicit empty movement array requires an opening; omit both arguments to keep
the old behavior exactly. No implicit opening or backfill is created.

The caller still owns the in-memory checkpoint and actual credits. The combined
seam test supplies records at this public boundary, forces a later history write
to fail, and checks A's engine restoration plus B's database rollback and retry.
It is not a runtime journal producer or a settlement implementation.

## Verify on disposable state

```sh
bun test backend/tests/persistence/credit-journal.test.ts \
  backend/tests/persistence/draft-status-migration.test.ts \
  backend/tests/persistence/repos-atomicity.test.ts \
  backend/tests/persistence/credit-journal-tick-seam.test.ts
```

The tests use fresh or disposable databases and public APIs only: fresh version
7, a populated version-6 upgrade with no journal backfill, repeat no-op, forced
post-DDL rollback, opening/movement round-trip, strict codec rejection,
duplicate/sequence/match/tick rejection, and batch rollback of the tick
metadata, history and journal rows together.
