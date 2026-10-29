# Durable Replay: Complete State Checksum, Snapshots, and Replay Engine (issue #11)

Reproduce full matches from fixed seed and durable command log, complete canonical state checksum (SHA-256), periodic snapshot persistence, and entity/field diff reporting.
Branch: `feat/issue-11-durable-replay` from `origin/main` (`58757311647d4fb35994976eabd1d550ca601e11`) | Delivery: local work-unit commits, no push/PR/merge | Checks: `bun test`, `bun run lint`, `bun run build`.

## Specs

Source: GitHub issue #11 "[P1][Replay] Reproducir partidas con log durable, snapshots y hash completo".

- **S1** — Canonical state serialization & robust checksum: define canonical serialization covering all relevant simulation state (tick, ruleVersion, seed, global project, companies, inventories, production lines with active batch progress, contracts with escrow/status, credit ledger). Compute robust SHA-256 checksum separate from fast internal 32-bit FNV-1a.
- **S2** — Checksum sensitivity: verify that any mutation in contracts, production lines, inventory, or escrows/ledger produces an immediate change in the SHA-256 checksum.
- **S3** — Entity/field diff reporting: structured diff function that compares two canonical snapshots and pinpoints divergence by entity type, entity ID, field name, expected value, and actual value.
- **S4** — Replay engine & 2,700-tick full match verification: replaying a full 2,700-tick match from fixed seed and accepted command log yields identical final state and byte-identical checkpoint hashes.
- **S5** — Durable snapshot persistence & restart recovery: migration 008 and snapshot repository for periodic snapshots. Verify match restart retains execution history and idempotency keys without data loss.

## Product Questions (Open Decisions for Human Review)

Per task constraints, product decisions are left parameterized:
1. **Checkpoint Frequency**: Default is 300 ticks (matching maintenance cadence). Question for product: Should snapshots be taken every 300 ticks, every 900 ticks (match phases), or on demand?
2. **Snapshot Storage Format**: Default is Canonical JSON with SHA-256 checksum. Question for product: Is JSON preferred for inspectability/auditing, or is a compressed/binary format desired for high-throughput matches?
3. **Snapshot Retention Policy**: Default retains all snapshots per match. Question for product: Should the database retain all checkpoints per match or maintain a sliding window of the last N checkpoints?

## Tasks

- **T1** [S1,S2,S3] — **done** — Canonical serialization, robust SHA-256 checksum, and entity/field diff utility (`backend/src/engine/replay/canonicalState.ts`, `backend/src/engine/replay/stateDiff.ts`). Evidence: `computeStateChecksumSha256`, `diffCanonicalStates`, `SimulatorEngine.calculateStateChecksumSha256()`.
- **T2** [S1,S4] — **done** — Replay engine for match execution from seed + command log (`backend/src/engine/replay/ReplayRunner.ts`). Evidence: `ReplayRunner.run()` and `ReplayRunner.verify()` deterministically replaying ticks with periodic checkpoints.
- **T3** [S5] — **done** — Migration 008 and durable snapshot repository (`backend/src/persistence/migrations/008_replay_snapshots.ts`, `backend/src/persistence/repos/replaySnapshots.ts`). Evidence: `match_snapshots` schema with checksumSha256, SQLite-backed CRUD operations.
- **T4** [S2,S3] — **done** — Test-first sensitivity and diff suite verifying contracts, lines, inventory, and escrow mutations (`backend/tests/engine/replay/checksum-sensitivity.test.ts`). Evidence: 5/5 tests passing.
- **T5** [S4,S5] — **done** — 2,700-tick full match replay test and restart recovery test (`backend/tests/engine/replay/full-match-replay.test.ts`, `backend/tests/engine/replay/restart-recovery.test.ts`). Evidence: Full 2,700-tick match verified byte-identical in ~1s; recovery test passes (3/3 tests total).
- **T6** [S1-S5] — **done** — Verification (`bun test`: 640 pass, 1 skip; `bun run lint`: 0 errors; `bun run build`: 0 errors), Engram persistence, and criteria report. Evidence: clean CI checks in worktree.
