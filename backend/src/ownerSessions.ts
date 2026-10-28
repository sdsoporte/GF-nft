/**
 * Owner sessions for the single configured owner (#7, T3a).
 *
 * The server owns one owner identity and one root credential, both read from
 * configuration; no client chooses who it is. `create` exchanges the root
 * credential for an opaque session token, `authenticate` maps a token back to
 * owner metadata, and `revoke` ends exactly one session. Only SHA-256 digests
 * of the root secret and of every session token are retained, so the plaintext
 * secret is never stored and a token leaves the process only in its issuance
 * response.
 *
 * Sessions live in memory only: restarting the backend invalidates all of them,
 * which is the required restart/logout behaviour, and there is no persistence
 * or public signup here. Time is injected so expiry is deterministic; a session
 * is valid while `now() < expiresAt`, so the deadline itself already denies.
 *
 * This module is a primitive. HTTP wiring, configuration and the gateway
 * resolver stay in their own units.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { MIN_TOKEN_LENGTH } from './config.ts';

/** Visible marker of an owner session bearer token. */
export const OWNER_SESSION_TOKEN_PREFIX = 'gf_owner_';
/** Default session lifetime: 15 minutes. */
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

/** Entropy behind every session token: 32 random bytes (256 bits). */
const SESSION_TOKEN_ENTROPY_BYTES = 32;
/** SHA-256 output size, used to keep constant-time comparisons equal-length. */
const DIGEST_BYTES = 32;
/** Largest representable `Date` value in epoch milliseconds. */
const MAX_DATE_MS = 8_640_000_000_000_000;

export interface OwnerSessionsOptions {
  /** Configured owner identity. Never taken from a request body. */
  readonly ownerId: string;
  /** Configured root credential of that owner. Never echoed or stored raw. */
  readonly ownerSecret: string;
  /** Session lifetime in milliseconds. Defaults to 15 minutes. */
  readonly sessionTtlMs?: number;
  /** Injected epoch-millisecond clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** What the owner may learn about an existing session. No token, no digest. */
export interface OwnerSessionPrincipal {
  readonly ownerId: string;
  readonly expiresAtUtc: string;
}

/** One-time issuance result: the only response that carries a token. */
export interface OwnerSessionIssued extends OwnerSessionPrincipal {
  readonly token: string;
}

export interface OwnerSessionsHandle {
  /** Issue a session for the owner secret; `undefined` when it does not match. */
  create(providedSecret: unknown): OwnerSessionIssued | undefined;
  /** Resolve a live session to owner metadata; `undefined` otherwise. */
  authenticate(token: unknown): OwnerSessionPrincipal | undefined;
  /** End a session; `true` only when a session was still live at revoke time. */
  revoke(token: unknown): boolean;
}

interface StoredSession {
  readonly ownerId: string;
  readonly expiresAtMs: number;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Lookup key for the session map: the hex SHA-256 of the whole token. */
function digestKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two SHA-256 digests. Both sides are always
 * 32 bytes, so the length check never reveals the length of the input.
 */
function digestsEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== DIGEST_BYTES || right.length !== DIGEST_BYTES) return false;
  return timingSafeEqual(left, right);
}

function readOwnerId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new Error('OwnerSessions requires a non-empty ownerId string.');
  }
  return value;
}

/**
 * The root credential keeps the configuration contract: at least
 * `MIN_TOKEN_LENGTH` characters. The rejected value never appears in the error.
 */
function readOwnerSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `OwnerSessions requires an ownerSecret string of at least ${MIN_TOKEN_LENGTH} characters.`,
    );
  }
  return value;
}

function readSessionTtlMs(value: unknown): number {
  if (value === undefined) return DEFAULT_SESSION_TTL_MS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      'OwnerSessions sessionTtlMs must be a whole number of milliseconds greater than zero.',
    );
  }
  return value;
}

function readNow(value: unknown): () => number {
  if (value === undefined) return Date.now;
  if (typeof value !== 'function') {
    throw new Error('OwnerSessions now must be a function returning epoch milliseconds.');
  }
  return value as () => number;
}

/** Read the injected clock; an unusable value fails closed instead of guessing. */
function currentTimeMs(now: () => number): number | undefined {
  let value: unknown;
  try {
    value = now();
  } catch {
    return undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isTokenString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Create the owner-session primitive for the configured owner.
 * Invalid configuration throws an `Error` that names the field, never a value.
 */
export function OwnerSessions(options: OwnerSessionsOptions): OwnerSessionsHandle {
  if (options === null || typeof options !== 'object') {
    throw new Error('OwnerSessions requires an options object.');
  }

  const ownerId = readOwnerId(options.ownerId);
  // Hash the root credential once and drop the plaintext reference immediately.
  const secretDigest = digest(readOwnerSecret(options.ownerSecret));
  const sessionTtlMs = readSessionTtlMs(options.sessionTtlMs);
  const now = readNow(options.now);

  /** token hash -> session. The token itself is never a key nor a value. */
  const sessions = new Map<string, StoredSession>();

  const sweepExpired = (currentMs: number): void => {
    for (const [key, session] of sessions) {
      if (currentMs >= session.expiresAtMs) sessions.delete(key);
    }
  };

  const create = (providedSecret: unknown): OwnerSessionIssued | undefined => {
    if (typeof providedSecret !== 'string' || providedSecret.length === 0) return undefined;
    if (!digestsEqual(secretDigest, digest(providedSecret))) return undefined;

    const issuedAtMs = currentTimeMs(now);
    if (issuedAtMs === undefined) return undefined;
    const expiresAtMs = issuedAtMs + sessionTtlMs;
    if (!Number.isFinite(expiresAtMs) || Math.abs(expiresAtMs) > MAX_DATE_MS) return undefined;

    sweepExpired(issuedAtMs);
    const token =
      OWNER_SESSION_TOKEN_PREFIX + randomBytes(SESSION_TOKEN_ENTROPY_BYTES).toString('hex');
    sessions.set(digestKey(token), { ownerId, expiresAtMs });
    return { token, ownerId, expiresAtUtc: new Date(expiresAtMs).toISOString() };
  };

  const authenticate = (token: unknown): OwnerSessionPrincipal | undefined => {
    if (!isTokenString(token)) return undefined;
    const key = digestKey(token);
    const session = sessions.get(key);
    if (session === undefined) return undefined;

    const currentMs = currentTimeMs(now);
    if (currentMs === undefined) return undefined;
    if (currentMs >= session.expiresAtMs) {
      sessions.delete(key);
      return undefined;
    }
    return { ownerId: session.ownerId, expiresAtUtc: new Date(session.expiresAtMs).toISOString() };
  };

  const revoke = (token: unknown): boolean => {
    if (!isTokenString(token)) return false;
    const key = digestKey(token);
    const session = sessions.get(key);
    if (session === undefined) return false;

    sessions.delete(key);
    const currentMs = currentTimeMs(now);
    return currentMs !== undefined && currentMs < session.expiresAtMs;
  };

  return { create, authenticate, revoke };
}
