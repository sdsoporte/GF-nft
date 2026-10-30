#!/usr/bin/env bash
# Disposable-backend smoke for the sell-first loop (issue #58, milestone B).
#
# This script owns everything it touches: it generates a throwaway bearer
# token, boots a throwaway backend on a random loopback port with a temporary
# SQLite file, drives the visible Godot main scene with `--smoke-selling`, then
# restarts a second backend process on the same temporary file to prove that the
# admitted commands and the settled contract are durable.
#
# The journey it proves, through public interfaces only:
#   production -> offer (confirmed) -> normal NPC purchase -> seller dispatch
#   (confirmed) -> settlement -> engine rejection of an unaffordable publish
#
# Nothing here uses live user data, a real wallet or a persistent state file:
# the token and the database live in this run's scratch directory and are
# deleted with it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# game/tests -> repository root
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT_DIR="$REPO_DIR/game"

usage() {
	cat <<'EOF'
Usage: game/tests/run_selling_smoke.sh [--help]

Boots a disposable backend, runs the visible Godot selling journey against it,
then restarts the backend on the same temporary database to prove durability.

Environment:
  GODOT_BIN              Godot 4.7 executable. Required unless `godot` is on PATH.
  GF_SMOKE_TIMEOUT       Overall journey timeout in seconds. Default: 180
  GF_SMOKE_TICK_MS       Disposable backend tick interval in ms. Default: 40
  GF_SMOKE_NPC_BUYER     NPC company the offer targets. Default: comp_metal_02

Exit codes:
  0  the journey, the rejection and the restart checks all passed
  1  a check failed
  2  configuration or environment problem
EOF
}

case "${1:-}" in
--help | -h)
	usage
	exit 0
	;;
"") ;;
*)
	echo "ERROR: unknown argument '$1' (try --help)" >&2
	exit 2
	;;
esac

GODOT_BIN="${GODOT_BIN:-}"
if [[ -z "$GODOT_BIN" ]] && command -v godot >/dev/null 2>&1; then
	GODOT_BIN="$(command -v godot)"
fi
if [[ -z "$GODOT_BIN" || ! -x "$GODOT_BIN" ]]; then
	echo "ERROR: set GODOT_BIN to a Godot 4.7 executable (try --help)" >&2
	exit 2
fi
if ! command -v bun >/dev/null 2>&1; then
	echo "ERROR: bun is required to boot the disposable backend" >&2
	exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
	echo "ERROR: curl is required for the restart checks" >&2
	exit 2
fi

SMOKE_TIMEOUT="${GF_SMOKE_TIMEOUT:-180}"
TICK_MS="${GF_SMOKE_TICK_MS:-40}"

# A throwaway credential: never printed, never written to the repository.
if command -v openssl >/dev/null 2>&1; then
	GENERATED_TOKEN="$(openssl rand -hex 32)"
else
	GENERATED_TOKEN="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
fi

SCRATCH_DIR="$(mktemp -d)"
export XDG_DATA_HOME="$SCRATCH_DIR/.xdg-data"
export XDG_CONFIG_HOME="$SCRATCH_DIR/.xdg-config"
export XDG_CACHE_HOME="$SCRATCH_DIR/.xdg-cache"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"

export GF_API_TOKEN="$GENERATED_TOKEN"
export GF_OWNER_ID="smoke_owner"
export GF_SQLITE_PATH="$SCRATCH_DIR/match.sqlite"
export GF_SMOKE_TICK_MS="$TICK_MS"
export GF_SMOKE_TIMEOUT="$((SMOKE_TIMEOUT > 45 ? SMOKE_TIMEOUT - 15 : SMOKE_TIMEOUT))"

SERVER_LOG="$SCRATCH_DIR/backend.log"
SERVER_PID=""
BACKEND_URL=""

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null
		wait "$SERVER_PID" 2>/dev/null
	fi
}
trap cleanup EXIT

# The disposable backend is the repository's own server factory, booted with an
# explicit tick interval so the NPC's own policy reaches a purchase in seconds.
read -r -d '' SERVER_CODE <<'JS' || true
const http = await import(process.env.SMOKE_HTTP_MODULE);
const database = await import(process.env.SMOKE_DB_MODULE);
const migrations = await import(process.env.SMOKE_MIGRATION_MODULE);
const matchStore = await import(process.env.SMOKE_STORE_MODULE);
const db = database.openDatabase(process.env.GF_SQLITE_PATH);
migrations.migrate(db);
const handle = http.createFactoryServer({
  token: process.env.GF_API_TOKEN,
  ownerId: process.env.GF_OWNER_ID,
  tickIntervalMs: Number(process.env.GF_SMOKE_TICK_MS),
  store: matchStore.createMatchStore(db),
});
const address = await handle.listen({ host: "127.0.0.1", port: 0 });
process.stdout.write(`listening http://127.0.0.1:${address.port}\n`);
JS
export SMOKE_HTTP_MODULE="$REPO_DIR/backend/src/http.ts"
export SMOKE_DB_MODULE="$REPO_DIR/backend/src/persistence/database.ts"
export SMOKE_MIGRATION_MODULE="$REPO_DIR/backend/src/persistence/migrations.ts"
export SMOKE_STORE_MODULE="$REPO_DIR/backend/src/persistence/matchStore.ts"

start_backend() {
	if [[ -s "$SERVER_LOG" ]]; then
		mv "$SERVER_LOG" "$SERVER_LOG.previous"
	fi
	bun -e "$SERVER_CODE" >"$SERVER_LOG" 2>&1 &
	SERVER_PID=$!
	local waited=0
	while [[ $waited -lt 150 ]]; do
		BACKEND_URL="$(sed -n 's/^listening \(http[^ ]*\)$/\1/p' "$SERVER_LOG" | head -n 1)"
		if [[ -n "$BACKEND_URL" ]]; then
			if curl -fsS "$BACKEND_URL/health" >/dev/null 2>&1; then
				return 0
			fi
		fi
		if ! kill -0 "$SERVER_PID" 2>/dev/null; then
			echo "FAIL: the disposable backend exited before it was ready" >&2
			tail -n 20 "$SERVER_LOG" >&2
			return 1
		fi
		sleep 0.2
		waited=$((waited + 1))
	done
	echo "FAIL: the disposable backend did not answer /health in 30s" >&2
	tail -n 20 "$SERVER_LOG" >&2
	return 1
}

stop_backend() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null
		wait "$SERVER_PID" 2>/dev/null
	fi
	SERVER_PID=""
}

# One owner session from the generated root bearer. Printed by the caller only
# as a pass/fail line; the token itself never reaches stdout.
open_owner_session() {
	local response
	response="$(curl -fsS -X POST "$BACKEND_URL/v1/owner/sessions" \
		-H "Authorization: Bearer $GF_API_TOKEN" 2>/dev/null)" || return 1
	printf '%s' "$response" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

echo "repository: $REPO_DIR"
echo "scratch: $SCRATCH_DIR"
echo "tick interval: ${TICK_MS}ms, journey timeout: ${SMOKE_TIMEOUT}s"
if ! start_backend; then
	exit 1
fi
echo "disposable backend: $BACKEND_URL"

echo "project copy: $SCRATCH_DIR/project"
mkdir -p "$SCRATCH_DIR/project"
if ! tar -C "$PROJECT_DIR" \
	--exclude=./.godot \
	--exclude=./override.cfg \
	--exclude=./addons/funplay_mcp \
	-cf - . | tar -C "$SCRATCH_DIR/project" -xf -; then
	echo "FAIL: could not copy the game project into the scratch directory" >&2
	exit 1
fi
IMPORT_LOG="$SCRATCH_DIR/import.log"
if ! timeout 60 "$GODOT_BIN" --headless --path "$SCRATCH_DIR/project" --import >"$IMPORT_LOG" 2>&1; then
	echo "FAIL: headless import of the scratch project failed (see $IMPORT_LOG)" >&2
	tail -n 20 "$IMPORT_LOG" >&2
	exit 1
fi

export GF_BACKEND_URL="$BACKEND_URL"
JOURNEY_LOG="$SCRATCH_DIR/journey.log"
timeout "$SMOKE_TIMEOUT" "$GODOT_BIN" --headless --path "$SCRATCH_DIR/project" \
	res://scenes/main.tscn -- --smoke-selling >"$JOURNEY_LOG" 2>&1
journey_status=$?
if [[ $journey_status -eq 124 ]]; then
	echo "FAIL: the selling journey timed out after ${SMOKE_TIMEOUT}s (see $JOURNEY_LOG)" >&2
	tail -n 20 "$JOURNEY_LOG" >&2
	exit 1
fi
if [[ $journey_status -ne 0 ]] || ! grep -q "SMOKE RESULT: PASSED" "$JOURNEY_LOG"; then
	echo "FAIL: the selling journey did not pass (see $JOURNEY_LOG)" >&2
	grep -E "SMOKE SELLING" "$JOURNEY_LOG" | tail -n 20 >&2
	exit 1
fi
grep -E "SMOKE SELLING:" "$JOURNEY_LOG" | sed 's/^/  /'
echo "PASS: production, offer, NPC purchase, dispatch and settlement"

# Restart on the same temporary database: the settled contract and the admitted
# keys must survive a whole new process with no in-memory carry-over.
stop_backend
if ! start_backend; then
	echo "FAIL: the restarted backend did not boot" >&2
	exit 1
fi
SESSION="$(open_owner_session)"
if [[ -z "$SESSION" ]]; then
	echo "FAIL: the restarted backend refused a fresh owner session" >&2
	exit 1
fi
RESTART_BODY="$SCRATCH_DIR/restart-selling.json"
if ! curl -fsS "$BACKEND_URL/v1/owner/selling" -H "Authorization: Bearer $SESSION" >"$RESTART_BODY"; then
	echo "FAIL: the restarted backend did not serve the seller read model" >&2
	exit 1
fi
if ! grep -q '"status":"FULFILLED"' "$RESTART_BODY"; then
	echo "FAIL: the settled contract did not survive the restart" >&2
	exit 1
fi
echo "PASS: the settled contract is still FULFILLED after a fresh backend process"

TICK="$(sed -n 's/.*"tick":\([0-9]*\).*/\1/p' "$RESTART_BODY" | head -n 1)"
USED_KEY="$(sed -n 's/.*"idempotencyKey":"\([^"]*\)".*/\1/p' "$RESTART_BODY" | head -n 1)"
if [[ -z "$TICK" || -z "$USED_KEY" ]]; then
	echo "FAIL: the restarted read model reported no tick or no command key" >&2
	exit 1
fi
DEADLINE=$((TICK + 200))
REPLAY_CODE="$(curl -s -o "$SCRATCH_DIR/replay.json" -w '%{http_code}' \
	-X POST "$BACKEND_URL/v1/owner/contracts" \
	-H "Authorization: Bearer $SESSION" \
	-H 'Content-Type: application/json' \
	-d "{\"idempotency_key\":\"$USED_KEY\",\"item_id\":\"RAW_ORE\",\"quantity\":1,\"unit_price\":1,\"deadline_tick\":$DEADLINE}")"
if [[ "$REPLAY_CODE" != "409" ]]; then
	echo "FAIL: a key admitted before the restart was not refused (HTTP $REPLAY_CODE)" >&2
	exit 1
fi
if ! grep -q 'ERR_DUPLICATE_IDEMPOTENCY_KEY' "$SCRATCH_DIR/replay.json"; then
	echo "FAIL: the replay refusal did not report ERR_DUPLICATE_IDEMPOTENCY_KEY" >&2
	exit 1
fi
echo "PASS: a key admitted before the restart is still refused with ERR_DUPLICATE_IDEMPOTENCY_KEY"

stop_backend
echo "SELLING SMOKE PASSED"
echo "scratch kept for inspection: $SCRATCH_DIR"
