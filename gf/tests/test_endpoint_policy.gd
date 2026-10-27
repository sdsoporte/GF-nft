extends SceneTree
## Observable rules for the connection policy: which URLs and tokens the client
## may use, and that plaintext or credential-bearing URLs are refused.

const TestSupport = preload("res://tests/test_support.gd")


func _initialize() -> void:
	var t := TestSupport.new()
	_test_loopback_urls(t)
	_test_remote_urls(t)
	_test_malformed_urls(t)
	_test_tokens(t)
	_test_environment_input(t)
	quit(t.finish("test_endpoint_policy"))


func _test_loopback_urls(t: TestSupport) -> void:
	var local: Dictionary = EndpointPolicy.validate_backend_url("http://127.0.0.1:8787")
	t.check(local["ok"], "plaintext loopback url is accepted")
	t.equal(local["url"], "http://127.0.0.1:8787", "loopback url is normalised")
	t.equal(local["host"], "127.0.0.1", "loopback host is reported")
	t.equal(local["port"], 8787, "loopback port is reported")
	t.check(local["is_loopback"], "loopback flag is true")

	var trailing: Dictionary = EndpointPolicy.validate_backend_url("http://127.0.0.1:8787/")
	t.check(trailing["ok"], "trailing slash is accepted")
	t.equal(trailing["url"], "http://127.0.0.1:8787", "trailing slash is stripped")

	t.check(EndpointPolicy.validate_backend_url("http://localhost:8787")["ok"], "localhost is loopback")
	t.check(EndpointPolicy.validate_backend_url("http://127.0.0.2:8787")["ok"], "127/8 addresses are loopback")

	var ipv6: Dictionary = EndpointPolicy.validate_backend_url("http://[::1]:8787")
	t.check(ipv6["ok"], "bracketed IPv6 loopback is accepted")
	t.equal(ipv6["host"], "::1", "IPv6 host is reported without brackets")

	var default_url: Dictionary = EndpointPolicy.validate_backend_url(EndpointPolicy.DEFAULT_BACKEND_URL)
	t.check(default_url["ok"], "the built-in default url is a valid loopback endpoint")


func _test_remote_urls(t: TestSupport) -> void:
	var secure: Dictionary = EndpointPolicy.validate_backend_url("https://factory.example.com")
	t.check(secure["ok"], "https remote url is accepted")
	t.equal(secure["port"], 0, "https url without port reports no explicit port")

	var plaintext: Dictionary = EndpointPolicy.validate_backend_url("http://factory.example.com:8787")
	t.check(not plaintext["ok"], "plaintext remote url is refused")
	t.equal(plaintext["code"], "INSECURE_TRANSPORT", "plaintext remote refusal names the transport rule")


func _test_malformed_urls(t: TestSupport) -> void:
	t.equal(EndpointPolicy.validate_backend_url("")["code"], "URL_SCHEME_REQUIRED", "empty url is refused")
	t.equal(
		EndpointPolicy.validate_backend_url("127.0.0.1:8787")["code"],
		"URL_SCHEME_REQUIRED",
		"scheme-less url is refused instead of guessing http"
	)
	t.equal(
		EndpointPolicy.validate_backend_url("ftp://127.0.0.1:8787")["code"],
		"URL_SCHEME_UNSUPPORTED",
		"non-http scheme is refused"
	)
	t.equal(
		EndpointPolicy.validate_backend_url("https://user:secret@factory.example.com")["code"],
		"URL_HAS_USERINFO",
		"credentials in the url are refused"
	)
	t.equal(
		EndpointPolicy.validate_backend_url("http://127.0.0.1:8787/v1")["code"],
		"URL_HAS_PATH",
		"a base url with a path is refused"
	)
	t.equal(
		EndpointPolicy.validate_backend_url("http://127.0.0.1:8787?x=1")["code"],
		"URL_HAS_QUERY",
		"a base url with a query is refused"
	)
	t.equal(
		EndpointPolicy.validate_backend_url("http://127.0.0.1:0")["code"],
		"URL_INVALID_PORT",
		"port zero is refused"
	)
	t.equal(
		EndpointPolicy.validate_backend_url("http://127.0.0.1:http")["code"],
		"URL_INVALID_PORT",
		"non-numeric port is refused"
	)
	t.equal(
		EndpointPolicy.validate_backend_url("http://:8787")["code"],
		"URL_HOST_REQUIRED",
		"missing host is refused"
	)


func _test_tokens(t: TestSupport) -> void:
	t.equal(EndpointPolicy.validate_token("")["code"], "TOKEN_REQUIRED", "empty token is refused")

	var short_token := "s3cret-short-token"
	var short_result: Dictionary = EndpointPolicy.validate_token(short_token)
	t.equal(short_result["code"], "TOKEN_TOO_SHORT", "token shorter than the server minimum is refused")
	t.not_contains(String(short_result["error"]), short_token, "short-token error never echoes the token")

	var spaced := "0123456789abcdef0123456789abcde "
	t.equal(EndpointPolicy.validate_token(spaced)["code"], "TOKEN_HAS_WHITESPACE", "token with trailing space is refused")

	var good := "0123456789abcdef0123456789abcdef"
	var good_result: Dictionary = EndpointPolicy.validate_token(good)
	t.check(good_result["ok"], "32-character token is accepted")
	t.not_contains(String(good_result["error"]), good, "accepted-token result never echoes the token")

	var combined_bad_url: Dictionary = EndpointPolicy.connection_problem("http://example.com", good)
	t.equal(combined_bad_url["code"], "INSECURE_TRANSPORT", "connection check reports the url problem first")

	var combined_bad_token: Dictionary = EndpointPolicy.connection_problem("http://127.0.0.1:8787", "short")
	t.equal(combined_bad_token["code"], "TOKEN_TOO_SHORT", "connection check reports the token problem")

	t.check(
		EndpointPolicy.connection_problem("http://127.0.0.1:8787", good)["ok"],
		"a loopback url with a long token passes the connection check"
	)


func _test_environment_input(t: TestSupport) -> void:
	OS.set_environment("GF_BACKEND_URL", "http://127.0.0.1:9999")
	OS.set_environment("GF_API_TOKEN", " 0123456789abcdef0123456789abcdef \n")
	t.equal(EndpointPolicy.backend_url_from_environment(), "http://127.0.0.1:9999", "backend url is read from the environment")
	t.equal(
		EndpointPolicy.token_from_environment(),
		"0123456789abcdef0123456789abcdef",
		"token is read from the environment and trimmed"
	)
	OS.unset_environment("GF_BACKEND_URL")
	OS.unset_environment("GF_API_TOKEN")
	t.equal(
		EndpointPolicy.backend_url_from_environment(),
		EndpointPolicy.DEFAULT_BACKEND_URL,
		"missing environment url falls back to loopback"
	)
	t.equal(EndpointPolicy.token_from_environment(), "", "missing environment token yields no credential")
