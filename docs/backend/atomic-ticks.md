# Atomic tick persistence

`FactoryMatch.advanceTicks(count)` commits each tick as one database unit. Before
executing it, the match captures a detached `EngineCheckpoint`. If engine execution
or the durable write throws, it restores that tick's engine state and rethrows the
original error. A later failed tick does not undo earlier committed ticks.

The checkpoint includes the clock, PRNG state, actual contract counter, companies
and their inventory/lines, contracts, global project, queue, permanent idempotency
keys, queue sequence, execution history and the complete credit opening/movement
archive. Restore reuses `hydrate` and
`CommandQueue.restore`; it does not replay commands. Checkpoints are in-process
handles, not new fields in `SimulationSnapshot` or the frozen HTTP/MCP protocol.

A failed tick leaves queued commands, credits, contract state, history and stored
rows/counters unchanged. Removing a transient database fault permits retrying the
same tick without a second escrow debit or a skipped contract identifier. Existing
successful production, priority, pause/resume, expansion and global-project commands
keep their engine behavior.

Real economic movements now join the tick transaction with company/contract
snapshots, history and queue removal. The journal sequence cursor advances only
after SQL succeeds. No old balance is repaired: legacy state opens an observed
CUTOVER, while new matches commit COMPLETE coverage at tick 0.
The failure seam observes actual producer input unchanged; it does not synthesize
fixture movements. A retry keeps identical event keys, sequence and amounts.

## Verification

```sh
bun test backend/tests/persistence/tick-atomicity.test.ts
bun run test
bun run lint
bun run build
```

Tests use disposable SQLite databases, real transaction-aborting triggers and the
public recovery/storage oracles. No live database or production service is used.
