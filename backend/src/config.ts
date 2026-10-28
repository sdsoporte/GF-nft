/**
 * Runtime configuration for the authoritative factory backend.
 *
 * The bearer token is always supplied by the environment or the user. There is
 * no committed default token, and configuration errors never echo the value.
 */

export const TOKEN_ENV_VAR = 'GF_API_TOKEN';
/** Empty/unset leaves owner administration disabled. */
export const OWNER_ID_ENV_VAR = 'GF_OWNER_ID';
export const OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const HOST_ENV_VAR = 'GF_HOST';
export const PORT_ENV_VAR = 'GF_PORT';
/** SQLite database file. Unset disables persistence (in-memory behaviour). */
export const SQLITE_PATH_ENV_VAR = 'GF_SQLITE_PATH';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const MIN_TOKEN_LENGTH = 32;

/** Printable ASCII without spaces: safe for an `Authorization` header value. */
const PRINTABLE_TOKEN_PATTERN = /^[!-~]+$/;

export interface FactoryConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /**
   * Absolute or relative database file path. Absent means persistence is
   * disabled; the field is omitted entirely so existing configuration shapes
   * stay byte-identical (A3 backward compatibility).
   */
  readonly sqlitePath?: string;
  /** Explicit single-owner identity; absent preserves the legacy server surface. */
  readonly ownerId?: string;
}

export type FactoryConfigResult =
  | { readonly ok: true; readonly config: FactoryConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

function readHost(env: Record<string, string | undefined>, errors: string[]): string {
  const raw = env[HOST_ENV_VAR];
  if (typeof raw !== 'string') return DEFAULT_HOST;
  const host = raw.trim();
  if (host.length === 0) {
    errors.push(`${HOST_ENV_VAR} must not be empty when set.`);
    return DEFAULT_HOST;
  }
  return host;
}

function readPort(env: Record<string, string | undefined>, errors: string[]): number {
  const raw = env[PORT_ENV_VAR];
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_PORT;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    errors.push(`${PORT_ENV_VAR} must be an integer between 1 and 65535.`);
    return DEFAULT_PORT;
  }
  return parsed;
}

/**
 * Read `GF_SQLITE_PATH`. Unset (or not a string) means persistence is disabled.
 * A set value is trimmed and must be a usable file path; creating the parent
 * directory is boot's job, not configuration's.
 */
function readSqlitePath(
  env: Record<string, string | undefined>,
  errors: string[],
): string | undefined {
  const raw = env[SQLITE_PATH_ENV_VAR];
  if (typeof raw !== 'string') return undefined;
  const sqlitePath = raw.trim();
  if (sqlitePath.length === 0) {
    errors.push(`${SQLITE_PATH_ENV_VAR} must not be empty when set.`);
    return undefined;
  }
  if (sqlitePath.includes('\u0000')) {
    errors.push(`${SQLITE_PATH_ENV_VAR} must not contain NUL characters.`);
    return undefined;
  }
  return sqlitePath;
}

function readToken(env: Record<string, string | undefined>, errors: string[]): string {
  const raw = env[TOKEN_ENV_VAR];
  const token = typeof raw === 'string' ? raw : '';
  if (token.length === 0) {
    errors.push(
      `${TOKEN_ENV_VAR} is required: provide a bearer token of at least ${MIN_TOKEN_LENGTH} printable characters.`,
    );
  } else if (!PRINTABLE_TOKEN_PATTERN.test(token)) {
    errors.push(`${TOKEN_ENV_VAR} must use printable characters without spaces or control characters.`);
  } else if (token.length < MIN_TOKEN_LENGTH) {
    errors.push(`${TOKEN_ENV_VAR} must be at least ${MIN_TOKEN_LENGTH} printable characters.`);
  }
  return token;
}

/**
 * Read and validate the runtime configuration.
 * Error messages name variables but never include the token value.
 */
export function readFactoryConfig(env: Record<string, string | undefined>): FactoryConfigResult {
  const errors: string[] = [];
  const token = readToken(env, errors);
  const host = readHost(env, errors);
  const port = readPort(env, errors);
  const sqlitePath = readSqlitePath(env, errors);
  const rawOwnerId = env[OWNER_ID_ENV_VAR];
  const ownerId = rawOwnerId === undefined || rawOwnerId === '' ? undefined : rawOwnerId;
  if (ownerId !== undefined && !OWNER_ID_PATTERN.test(ownerId)) {
    errors.push(`${OWNER_ID_ENV_VAR} must be 1-64 ASCII letters, digits, underscores or dashes.`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    config: {
      host, port, token,
      ...(sqlitePath === undefined ? {} : { sqlitePath }),
      ...(ownerId === undefined ? {} : { ownerId }),
    },
  };
}
