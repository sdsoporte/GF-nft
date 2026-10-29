# Durable contract drafts: schema version 6

Migration `006_contract_draft_status` adds `DRAFT` to the supported contract
states. It prepares durable storage; owner-authenticated publication is a
separate application work unit.

## Upgrade behavior

- Migration 1 and `schema.sql` remain the original baseline; versions 1–5 are
  unchanged.
- SQLite cannot widen a CHECK in place. Version 6 creates the replacement table,
  copies all 14 contract columns without rewriting values, replaces the old
  table and recreates the seller, buyer and status indexes.
- Existing PENDING, ACTIVE, FULFILLED, DEFAULTED and CANCELLED rows keep their
  IDs, parties, amounts, delivered quantities, deadlines and settlement ticks.
  Numeric checks and the seller foreign key remain enforced.
- The existing migration runner commits the whole replacement together with
  its version record. An error rolls back both, leaving version 5 usable.
  Reopening an already-upgraded database applies nothing again.

## Operating boundary

No live database migration or deployment is performed by this change. Before
starting an existing volume with the new build, take a verified backup and
review the migration. Do not run an older build against a version-6 database;
the runner correctly refuses a database newer than that build. Recovery is a
backup restore, not an automatic destructive downgrade.

## Verify on disposable state

```sh
bun test backend/tests/persistence/draft-status-migration.test.ts
```

The tests use fresh in-memory databases and public migration/repository APIs:
fresh DRAFT round-trip, v5 legacy preservation, rejected-write nonmutation,
repeat no-op and forced post-DDL rollback before a clean application.
