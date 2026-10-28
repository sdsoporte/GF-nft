class_name TestSupport
extends RefCounted
## Minimal assertion collector for headless Godot script suites.
## Each suite prints a machine-readable RESULT line that run_checks.sh requires.

var checks: int = 0
var failures: PackedStringArray = PackedStringArray()


func check(condition: bool, message: String) -> bool:
	checks += 1
	if not condition:
		failures.append(message)
		print("FAIL: %s" % message)
	return condition


func equal(actual: Variant, expected: Variant, message: String) -> bool:
	checks += 1
	if actual != expected:
		var detail := "%s (expected '%s', got '%s')" % [message, str(expected), str(actual)]
		failures.append(detail)
		print("FAIL: %s" % detail)
		return false
	return true


func contains(haystack: String, needle: String, message: String) -> bool:
	checks += 1
	if not haystack.contains(needle):
		var detail := "%s (missing '%s' in '%s')" % [message, needle, haystack]
		failures.append(detail)
		print("FAIL: %s" % detail)
		return false
	return true


func not_contains(haystack: String, needle: String, message: String) -> bool:
	checks += 1
	if haystack.contains(needle):
		var detail := "%s (found forbidden '%s' in '%s')" % [message, needle, haystack]
		failures.append(detail)
		print("FAIL: %s" % detail)
		return false
	return true


func fixture(name: String) -> String:
	var path := "res://tests/fixtures/%s" % name
	if not FileAccess.file_exists(path):
		check(false, "fixture %s exists" % name)
		return ""
	return FileAccess.get_file_as_string(path)


func finish(name: String) -> int:
	if failures.is_empty():
		print("RESULT %s: PASSED (%d checks)" % [name, checks])
		return 0
	print("RESULT %s: FAILED (%d of %d checks failed)" % [name, failures.size(), checks])
	return 1
