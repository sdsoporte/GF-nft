#!/usr/bin/env bash
# Focused headless checks for the Godot authoritative-factory client.
#
# The script copies the project into a fresh temporary directory that excludes
# .godot/, override.cfg and addons/funplay_mcp/, then imports and runs the
# fixture/UI suites with that copy as the project root. The scratch copy is
# kept on purpose so failures can be inspected; nothing inside the repository
# is modified.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_TIMEOUT_SECONDS="${CHECK_TIMEOUT_SECONDS:-30}"

usage() {
	cat <<'EOF'
Usage: game/tests/run_checks.sh [--help] [suite ...]

Runs the Godot client checks in an isolated copy of game/.

Environment:
  GODOT_BIN                 Path to a Godot 4.7 executable. Required unless
                            `godot` is on PATH.
  CHECK_TIMEOUT_SECONDS     Per-step timeout in seconds (default: 30).

Arguments:
  suite                     Optional suite name without `.gd`, for example
                            `test_protocol`. Defaults to every `tests/test_*.gd`.

Scratch directory:
  A fresh `mktemp -d` project copy is created for every run. It excludes
  `.godot/`, `override.cfg` and `addons/funplay_mcp/`, so the tracked project is
  proven to run without the optional editor plugin. XDG data/config/cache
  directories point inside that scratch copy. The path is printed at the end;
  delete it yourself when you are done inspecting it.

Exit codes:
  0  all requested suites and the scene boot check passed
  1  a check failed
  2  configuration or environment problem
EOF
}

GODOT_BIN="${GODOT_BIN:-}"
if [[ -z "$GODOT_BIN" ]] && command -v godot >/dev/null 2>&1; then
	GODOT_BIN="$(command -v godot)"
fi

requested_suites=()
for argument in "$@"; do
	case "$argument" in
	--help | -h)
		usage
		exit 0
		;;
	-*)
		echo "ERROR: unknown option '$argument' (try --help)" >&2
		exit 2
		;;
	*)
		requested_suites+=("$argument")
		;;
	esac
done

if [[ -z "$GODOT_BIN" || ! -x "$GODOT_BIN" ]]; then
	echo "ERROR: set GODOT_BIN to a Godot 4.7 executable, for example:" >&2
	echo "  GODOT_BIN=/path/to/Godot_v4.7.2-stable_linux.x86_64 bash game/tests/run_checks.sh" >&2
	exit 2
fi

SCRATCH_DIR="$(mktemp -d)"
LOG_DIR="$SCRATCH_DIR/check-logs"
mkdir -p "$LOG_DIR" "$SCRATCH_DIR/.xdg-data" "$SCRATCH_DIR/.xdg-config" "$SCRATCH_DIR/.xdg-cache"

export XDG_DATA_HOME="$SCRATCH_DIR/.xdg-data"
export XDG_CONFIG_HOME="$SCRATCH_DIR/.xdg-config"
export XDG_CACHE_HOME="$SCRATCH_DIR/.xdg-cache"
unset GF_API_TOKEN
unset GF_BACKEND_URL

copy_project() {
	tar -C "$PROJECT_DIR" \
		--exclude=./.godot \
		--exclude=./override.cfg \
		--exclude=./addons/funplay_mcp \
		-cf - . | tar -C "$SCRATCH_DIR" -xf -
}

fail_with_log() {
	local label="$1"
	local log_file="$2"
	echo "FAIL: $label" >&2
	if [[ -s "$log_file" ]]; then
		echo "----- last 40 log lines ($log_file) -----" >&2
		tail -n 40 "$log_file" >&2
	else
		echo "no diagnostic output was produced for $label" >&2
	fi
}

echo "project copy: $SCRATCH_DIR"
if ! copy_project; then
	echo "FAIL: could not copy the project into $SCRATCH_DIR" >&2
	exit 1
fi

if [[ -e "$SCRATCH_DIR/addons/funplay_mcp" ]]; then
	echo "FAIL: the scratch copy still contains addons/funplay_mcp" >&2
	exit 1
fi
if [[ -e "$SCRATCH_DIR/override.cfg" ]]; then
	echo "FAIL: the scratch copy still contains override.cfg" >&2
	exit 1
fi

import_log="$LOG_DIR/import.log"
if ! timeout "$DEFAULT_TIMEOUT_SECONDS" "$GODOT_BIN" --headless --path "$SCRATCH_DIR" --import >"$import_log" 2>&1; then
	fail_with_log "headless import" "$import_log"
	exit 1
fi
if grep -q "SCRIPT ERROR" "$import_log"; then
	fail_with_log "headless import reported a script error" "$import_log"
	exit 1
fi
echo "PASS: headless import of the clean project copy"

suites=()
if [[ ${#requested_suites[@]} -gt 0 ]]; then
	suites=("${requested_suites[@]}")
else
	for path in "$SCRATCH_DIR"/tests/test_*.gd; do
		name="$(basename "$path" .gd)"
		if [[ "$name" == "test_support" ]]; then
			continue
		fi
		suites+=("$name")
	done
fi

failed_suites=()
for suite in "${suites[@]}"; do
	suite_log="$LOG_DIR/$suite.log"
	if [[ ! -f "$SCRATCH_DIR/tests/$suite.gd" ]]; then
		echo "FAIL: unknown suite '$suite'" >&2
		failed_suites+=("$suite")
		continue
	fi
	if ! timeout "$DEFAULT_TIMEOUT_SECONDS" "$GODOT_BIN" --headless --path "$SCRATCH_DIR" \
		--script "res://tests/$suite.gd" >"$suite_log" 2>&1; then
		fail_with_log "suite $suite exited with a failure" "$suite_log"
		failed_suites+=("$suite")
		continue
	fi
	if ! grep -q "RESULT $suite: PASSED" "$suite_log"; then
		fail_with_log "suite $suite did not report a passing result" "$suite_log"
		failed_suites+=("$suite")
		continue
	fi
	if grep -q "SCRIPT ERROR" "$suite_log"; then
		fail_with_log "suite $suite raised a script error, so its checks were not completed" "$suite_log"
		failed_suites+=("$suite")
		continue
	fi
	echo "PASS: $suite -> $(grep 'RESULT ' "$suite_log" | tail -n 1)"
done

scene_log="$LOG_DIR/main_scene_boot.log"
if ! timeout "$DEFAULT_TIMEOUT_SECONDS" "$GODOT_BIN" --headless --path "$SCRATCH_DIR" \
	--quit-after 45 res://scenes/main.tscn >"$scene_log" 2>&1; then
	fail_with_log "main scene boot" "$scene_log"
	failed_suites+=("main_scene_boot")
elif grep -q "SCRIPT ERROR" "$scene_log"; then
	fail_with_log "main scene boot reported a script error" "$scene_log"
	failed_suites+=("main_scene_boot")
else
	echo "PASS: main scene boots headless without script errors"
fi

echo "scratch copy kept for inspection: $SCRATCH_DIR"
if [[ ${#failed_suites[@]} -gt 0 ]]; then
	echo "CHECKS FAILED: ${failed_suites[*]}" >&2
	exit 1
fi
echo "ALL CHECKS PASSED (${#suites[@]} suites)"
