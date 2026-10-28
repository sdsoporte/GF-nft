# Client/server contracts

[`factory-api.md`](factory-api.md) owns the version-1 gameplay HTTP contract,
examples and exact unauthorized response. The backend implements it; Godot is
a validating client. Change neither side independently of the contract checks.

This directory does not own the simulation, domain, database or backend-only
MCP authorization logic. Godot runtime fixtures remain under `game/tests/`
because they are loaded through res://. Component-private test data stays with
its owner; root integration tests validate the real seam.
