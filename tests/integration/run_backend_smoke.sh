#!/usr/bin/env bash
# Real-backend smoke for the Godot client.
#
# Runs the visible main scene (res://scenes/main.tscn) headless with `--smoke`
# against an already running backend, then exits nonzero when the server-driven
# production loop does not complete. The fixture suites never call this script.
#
# Requirements:
#   GODOT_BIN        Godot 4.7 executable (falls back to `godot` on PATH).
#   GF_API_TOKEN     The backend bearer token (32+ characters). Required.
#   GF_BACKEND_URL   Backend base URL (default: http://127.0.0.1:8787).
#   GF_SMOKE_TIMEOUT Overall timeout in seconds (default: 60).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/game"

usage() {
	cat <<'EOF'
Usage: tests/integration/run_backend_smoke.sh [--help]

Runs the actual backend seam through the visible Godot main scene. The scene
connects, waits for a server snapshot, starts one R1 batch on an idle line,
polls the command status, and asserts the resulting inventory from the next
server snapshots.

Environment:
  GODOT_BIN        Godot 4.7 executable. Required unless `godot` is on PATH.
  GF_API_TOKEN     Backend bearer token, 32+ characters. Required.
  GF_BACKEND_URL   Backend base URL. Default: http://127.0.0.1:8787
  GF_SMOKE_TIMEOUT Overall timeout in seconds. Default: 60

The token is only passed to Godot through the environment; this script never
prints it. Plaintext http:// is accepted for loopback hosts only.
EOF
}

for argument in "$@"; do
	case "$argument" in
	--help | -h)
		usage
		exit 0
		;;
	*)
		echo "ERROR: unknown argument '$argument' (try --help)" >&2
		exit 2
		;;
	esac
done

GODOT_BIN="${GODOT_BIN:-}"
if [[ -z "$GODOT_BIN" ]] && command -v godot >/dev/null 2>&1; then
	GODOT_BIN="$(command -v godot)"
fi
if [[ -z "$GODOT_BIN" || ! -x "$GODOT_BIN" ]]; then
	echo "ERROR: set GODOT_BIN to a Godot 4.7 executable (try --help)" >&2
	exit 2
fi
if [[ -z "${GF_API_TOKEN:-}" ]]; then
	echo "ERROR: GF_API_TOKEN is required: the backend has no built-in token" >&2
	exit 2
fi
if [[ ${#GF_API_TOKEN} -lt 32 ]]; then
	echo "ERROR: GF_API_TOKEN must be at least 32 characters, matching the backend requirement" >&2
	exit 2
fi

export GF_API_TOKEN
GF_BACKEND_URL="${GF_BACKEND_URL:-http://127.0.0.1:8787}"
export GF_BACKEND_URL
SMOKE_TIMEOUT="${GF_SMOKE_TIMEOUT:-60}"

SCRATCH_DIR="$(mktemp -d)"
mkdir -p "$SCRATCH_DIR/.xdg-data" "$SCRATCH_DIR/.xdg-config" "$SCRATCH_DIR/.xdg-cache"
export XDG_DATA_HOME="$SCRATCH_DIR/.xdg-data"
export XDG_CONFIG_HOME="$SCRATCH_DIR/.xdg-config"
export XDG_CACHE_HOME="$SCRATCH_DIR/.xdg-cache"

echo "backend url: $GF_BACKEND_URL"
echo "project copy: $SCRATCH_DIR"

if ! tar -C "$PROJECT_DIR" \
	--exclude=./.godot \
	--exclude=./override.cfg \
	--exclude=./addons/funplay_mcp \
	-cf - . | tar -C "$SCRATCH_DIR" -xf -; then
	echo "FAIL: could not copy the project into $SCRATCH_DIR" >&2
	exit 1
fi

if ! timeout 30 "$GODOT_BIN" --headless --path "$SCRATCH_DIR" --import >"$SCRATCH_DIR/import.log" 2>&1; then
	echo "FAIL: headless import failed (see $SCRATCH_DIR/import.log)" >&2
	tail -n 20 "$SCRATCH_DIR/import.log" >&2
	exit 1
fi

timeout "$SMOKE_TIMEOUT" "$GODOT_BIN" --headless --path "$SCRATCH_DIR" \
	res://scenes/main.tscn -- --smoke
status=$?
if [[ $status -eq 124 ]]; then
	echo "FAIL: backend smoke timed out after ${SMOKE_TIMEOUT}s" >&2
	exit 1
fi
if [[ $status -ne 0 ]]; then
	echo "FAIL: backend smoke exited with status $status" >&2
	exit "$status"
fi
echo "PASS: backend smoke completed against $GF_BACKEND_URL"
