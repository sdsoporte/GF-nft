# Atomic tick persistence

`FactoryMatch.advanceTicks(count)` commits each tick as one database unit. Before
executing it, the match captures a detached `EngineCheckpoint`. If engine execution
or the durable write throws, it restores that tick's engine state and rethrows the
original error. A later failed tick does not undo earlier committed ticks.

The checkpoint includes the clock, PRNG state, actual contract counter, companies
and their inventory/lines, contracts, global project, queue, permanent idempotency
keys, queue sequence and execution history. Restore reuses `hydrate` and
`CommandQueue.restore`; it does not replay commands. Checkpoints are in-process
handles, not new fields in `SimulationSnapshot` or the frozen HTTP/MCP protocol.

A failed tick leaves queued commands, credits, contract state, history and stored
rows/counters unchanged. Removing a transient database fault permits retrying the
same tick without a second escrow debit or a skipped contract identifier. Existing
successful production, priority, pause/resume, expansion and global-project commands
keep their engine behavior.

This unit does not add a monetary journal or repair old balances. Future journal
state must join the checkpoint before its producing game flows are integrated.

## Verification

```sh
bun test backend/tests/persistence/tick-atomicity.test.ts
bun run test
bun run lint
bun run build
```

Tests use disposable SQLite databases, real transaction-aborting triggers and the
public recovery/storage oracles. No live database or production service is used.
