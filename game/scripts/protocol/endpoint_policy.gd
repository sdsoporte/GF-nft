class_name EndpointPolicy
extends RefCounted
## Pure connection policy for the authoritative factory client.
##
## These functions perform no I/O. They decide whether a URL and token may be
## used at all, so the API client can refuse unsafe combinations before it ever
## builds a request: plaintext only to loopback, no credentials in the URL, and
## no silently guessed scheme.

const DEFAULT_BACKEND_URL := "http://127.0.0.1:8787"
const MIN_TOKEN_LENGTH := 32
const ENV_BACKEND_URL := "GF_BACKEND_URL"
const ENV_API_TOKEN := "GF_API_TOKEN"

const CODE_URL_SCHEME_REQUIRED := "URL_SCHEME_REQUIRED"
const CODE_URL_SCHEME_UNSUPPORTED := "URL_SCHEME_UNSUPPORTED"
const CODE_URL_HOST_REQUIRED := "URL_HOST_REQUIRED"
const CODE_URL_HAS_USERINFO := "URL_HAS_USERINFO"
const CODE_URL_HAS_PATH := "URL_HAS_PATH"
const CODE_URL_HAS_QUERY := "URL_HAS_QUERY"
const CODE_URL_INVALID_PORT := "URL_INVALID_PORT"
const CODE_INSECURE_TRANSPORT := "INSECURE_TRANSPORT"
const CODE_TOKEN_REQUIRED := "TOKEN_REQUIRED"
const CODE_TOKEN_TOO_SHORT := "TOKEN_TOO_SHORT"
const CODE_TOKEN_HAS_WHITESPACE := "TOKEN_HAS_WHITESPACE"


static func validate_backend_url(raw_url: String) -> Dictionary:
	var input := raw_url.strip_edges()
	if input.is_empty():
		return _url_failure(CODE_URL_SCHEME_REQUIRED, "Enter the backend URL, for example %s." % DEFAULT_BACKEND_URL)
	return _validate_clean_url(input)


static func _validate_clean_url(input: String) -> Dictionary:
	for forbidden in [" ", "\t", "\n", "\r"]:
		if input.contains(forbidden):
			return _url_failure(CODE_URL_HOST_REQUIRED, "The backend URL must not contain spaces or line breaks.")
	var scheme_end := input.find("://")
	if scheme_end <= 0:
		return _url_failure(CODE_URL_SCHEME_REQUIRED, "The backend URL must start with http:// or https://.")
	var scheme := input.substr(0, scheme_end).to_lower()
	if scheme != "http" and scheme != "https":
		return _url_failure(
			CODE_URL_SCHEME_UNSUPPORTED,
			"Only http:// and https:// URLs are supported (got '%s')." % scheme
		)
	var rest := input.substr(scheme_end + 3)
	var authority_end := rest.length()
	for separator in ["/", "?", "#"]:
		var index := rest.find(separator)
		if index != -1 and index < authority_end:
			authority_end = index
	var authority := rest.substr(0, authority_end)
	var remainder := rest.substr(authority_end)
	if authority.contains("@"):
		return _url_failure(
			CODE_URL_HAS_USERINFO,
			"Put credentials in the token field, never in the URL."
		)
	if remainder.contains("?") or remainder.contains("#"):
		return _url_failure(
			CODE_URL_HAS_QUERY,
			"The backend URL must not contain a query string or fragment."
		)
	if remainder.length() > 1:
		return _url_failure(
			CODE_URL_HAS_PATH,
			"Use only scheme://host[:port]; the client appends its own API paths."
		)
	if authority.is_empty():
		return _url_failure(CODE_URL_HOST_REQUIRED, "The backend URL is missing a host.")

	var host := ""
	var port_text := ""
	var bracketed := authority.begins_with("[")
	if bracketed:
		var closing := authority.find("]")
		if closing == -1:
			return _url_failure(CODE_URL_HOST_REQUIRED, "The IPv6 host is missing its closing bracket.")
		host = authority.substr(1, closing - 1)
		var after := authority.substr(closing + 1)
		if after.begins_with(":"):
			port_text = after.substr(1)
		elif not after.is_empty():
			return _url_failure(CODE_URL_HOST_REQUIRED, "Unexpected text after the IPv6 host.")
	else:
		var colon := authority.rfind(":")
		if colon != -1:
			host = authority.substr(0, colon)
			port_text = authority.substr(colon + 1)
		else:
			host = authority

	if host.is_empty():
		if authority.contains(":"):
			return _url_failure(
				CODE_URL_HOST_REQUIRED,
				"IPv6 hosts need brackets, for example http://[::1]:8787."
			)
		return _url_failure(CODE_URL_HOST_REQUIRED, "The backend URL is missing a host.")

	var port := 0
	if not port_text.is_empty():
		if not port_text.is_valid_int():
			return _url_failure(CODE_URL_INVALID_PORT, "The port must be a number between 1 and 65535.")
		port = port_text.to_int()
		if port < 1 or port > 65535:
			return _url_failure(CODE_URL_INVALID_PORT, "The port must be a number between 1 and 65535.")

	var normalized_host := host.to_lower()
	var loopback := is_loopback_host(normalized_host)
	if scheme == "http" and not loopback:
		return _url_failure(
			CODE_INSECURE_TRANSPORT,
			"Refusing plaintext http:// to non-loopback host '%s'. Use https://, or connect through 127.0.0.1, localhost or [::1]." % normalized_host
		)

	var rendered_host := normalized_host
	if bracketed:
		rendered_host = "[%s]" % normalized_host
	var normalized_url := "%s://%s" % [scheme, rendered_host]
	if port > 0:
		normalized_url += ":%d" % port
	return {
		"ok": true,
		"code": "",
		"error": "",
		"url": normalized_url,
		"scheme": scheme,
		"host": normalized_host,
		"port": port,
		"is_loopback": loopback,
	}


static func is_loopback_host(host: String) -> bool:
	var normalized := host.strip_edges().to_lower()
	if normalized == "localhost" or normalized == "::1":
		return true
	var parts := normalized.split(".", true)
	if parts.size() != 4 or parts[0] != "127":
		return false
	for part in parts:
		if not part.is_valid_int():
			return false
		var octet := part.to_int()
		if octet < 0 or octet > 255:
			return false
	return true


static func validate_token(token: String) -> Dictionary:
	if token.is_empty():
		return _token_failure(
			CODE_TOKEN_REQUIRED,
			"Enter the backend bearer token. The server requires GF_API_TOKEN with at least %d characters." % MIN_TOKEN_LENGTH
		)
	for index in token.length():
		var code := token.unicode_at(index)
		if code <= 32 or code == 127:
			return _token_failure(
				CODE_TOKEN_HAS_WHITESPACE,
				"The token must not contain spaces, tabs or line breaks."
			)
	if token.length() < MIN_TOKEN_LENGTH:
		return _token_failure(
			CODE_TOKEN_TOO_SHORT,
			"The token is not long enough: the server requires at least %d characters." % MIN_TOKEN_LENGTH
		)
	return {"ok": true, "code": "", "error": ""}


## Validates both halves of a manual connection and reports the first problem.
static func connection_problem(url: String, token: String) -> Dictionary:
	var url_result := validate_backend_url(url)
	if not url_result["ok"]:
		return url_result
	return validate_token(token)


static func backend_url_from_environment() -> String:
	var value := OS.get_environment(ENV_BACKEND_URL).strip_edges()
	if value.is_empty():
		return DEFAULT_BACKEND_URL
	return value


static func token_from_environment() -> String:
	return OS.get_environment(ENV_API_TOKEN).strip_edges()


static func _url_failure(code: String, message: String) -> Dictionary:
	return {
		"ok": false,
		"code": code,
		"error": message,
		"url": "",
		"scheme": "",
		"host": "",
		"port": 0,
		"is_loopback": false,
	}


static func _token_failure(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "error": message}
