/**
 * Owner session primitive (#7 / T3a).
 *
 * The configured single owner authenticates with the server root credential;
 * the primitive mints opaque session tokens, keeps only their hashes, and
 * exposes owner metadata without ever returning a secret after issuance.
 * Time is injected so expiry is exact and deterministic.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SESSION_TTL_MS,
  OWNER_SESSION_TOKEN_PREFIX,
  OwnerSessions,
} from '../src/ownerSessions.ts';
import type { OwnerSessionsHandle } from '../src/ownerSessions.ts';

/** Server root credential shape: printable, at least 32 characters. */
const OWNER_ID = 'owner_local_fixed01';
const OWNER_SECRET = 'owner-root-credential-0123456789abcdef';
const OTHER_SECRET = 'some-other-credential-0123456789abcd';
const MINUTE_MS = 60 * 1000;

interface ManualClock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

function manualClock(startMs: number): ManualClock {
  let currentMs = startMs;
  return {
    now: () => currentMs,
    set: (ms: number) => {
      currentMs = ms;
    },
    advance: (ms: number) => {
      currentMs += ms;
    },
  };
}

interface Harness {
  readonly sessions: OwnerSessionsHandle;
  readonly clock: ManualClock;
}

function createHarness(options: { ttlMs?: number; ownerSecret?: string } = {}): Harness {
  const clock = manualClock(1_700_000_000_000);
  const sessions = OwnerSessions({
    ownerId: OWNER_ID,
    ownerSecret: options.ownerSecret ?? OWNER_SECRET,
    ...(options.ttlMs === undefined ? {} : { sessionTtlMs: options.ttlMs }),
    now: clock.now,
  });
  return { sessions, clock };
}

/** Mint a session through the public API and fail loudly when it is refused. */
function issue(harness: Harness, secret = OWNER_SECRET) {
  const issued = harness.sessions.create(secret);
  assert.ok(issued, 'the configured owner secret must issue a session');
  return issued;
}

test('the default session lifetime is 15 minutes', () => {
  assert.equal(DEFAULT_SESSION_TTL_MS, 15 * MINUTE_MS);
  const harness = createHarness();
  const issued = issue(harness);
  assert.equal(issued.expiresAtUtc, new Date(harness.clock.now() + 15 * MINUTE_MS).toISOString());
});

test('creation returns one opaque prefixed token plus owner metadata', () => {
  const harness = createHarness({ ttlMs: 2 * MINUTE_MS });
  const issued = issue(harness);

  assert.equal(OWNER_SESSION_TOKEN_PREFIX, 'gf_owner_');
  assert.ok(issued.token.startsWith(OWNER_SESSION_TOKEN_PREFIX));
  const entropy = issued.token.slice(OWNER_SESSION_TOKEN_PREFIX.length);
  assert.match(entropy, /^[0-9a-f]{64}$/, 'the token must carry 32 random bytes as hex');
  assert.equal(issued.ownerId, OWNER_ID);
  assert.equal(issued.expiresAtUtc, new Date(harness.clock.now() + 2 * MINUTE_MS).toISOString());
  assert.deepEqual(Object.keys(issued).sort(), ['expiresAtUtc', 'ownerId', 'token']);
});

test('each creation mints a distinct token that authenticates independently', () => {
  const harness = createHarness();
  const first = issue(harness);
  const second = issue(harness);
  assert.notEqual(first.token, second.token);

  const firstPrincipal = harness.sessions.authenticate(first.token);
  const secondPrincipal = harness.sessions.authenticate(second.token);
  assert.ok(firstPrincipal);
  assert.ok(secondPrincipal);
  assert.deepEqual(firstPrincipal, secondPrincipal);

  assert.equal(harness.sessions.revoke(first.token), true);
  assert.equal(harness.sessions.authenticate(first.token), undefined);
  assert.deepEqual(harness.sessions.authenticate(second.token), secondPrincipal);
});

test('the wrong secret issues nothing and leaves existing sessions valid', () => {
  const harness = createHarness();
  const live = issue(harness);

  assert.equal(harness.sessions.create(OTHER_SECRET), undefined);
  assert.equal(harness.sessions.create(''), undefined);
  assert.equal(harness.sessions.create(undefined), undefined);
  assert.equal(harness.sessions.create(42), undefined);
  assert.equal(harness.sessions.create({ secret: OWNER_SECRET }), undefined);
  assert.equal(
    harness.sessions.create(OWNER_SECRET.slice(0, -1)),
    undefined,
    'a prefix of the secret must not authenticate',
  );

  assert.ok(harness.sessions.authenticate(live.token), 'the earlier session must survive refusals');
});

test('authentication exposes only owner metadata, never the token or its hash', () => {
  const harness = createHarness();
  const issued = issue(harness);
  const principal = harness.sessions.authenticate(issued.token);

  assert.ok(principal);
  assert.deepEqual(Object.keys(principal).sort(), ['expiresAtUtc', 'ownerId']);
  assert.equal(principal.ownerId, OWNER_ID);
  assert.equal(principal.expiresAtUtc, issued.expiresAtUtc);

  const serialized = JSON.stringify(principal);
  assert.ok(!serialized.includes(issued.token), 'the token must never come back');
  assert.ok(!serialized.includes(issued.token.slice(OWNER_SESSION_TOKEN_PREFIX.length)));
  assert.ok(!serialized.includes(OWNER_SECRET), 'the root secret must never come back');
});

test('unknown and malformed tokens never authenticate', () => {
  const harness = createHarness();
  issue(harness);

  assert.equal(harness.sessions.authenticate(`${OWNER_SESSION_TOKEN_PREFIX}${'0'.repeat(64)}`), undefined);
  assert.equal(harness.sessions.authenticate('gf_owner_deadbeef'), undefined);
  assert.equal(harness.sessions.authenticate(''), undefined);
  assert.equal(harness.sessions.authenticate(undefined), undefined);
  assert.equal(harness.sessions.authenticate(null), undefined);
  assert.equal(harness.sessions.authenticate(12345), undefined);
  assert.equal(harness.sessions.authenticate({ token: 'gf_owner_deadbeef' }), undefined);
  assert.equal(
    harness.sessions.authenticate(OWNER_SECRET),
    undefined,
    'the root secret is not a session token',
  );
});

test('a session expires exactly at its deadline, not one millisecond before', () => {
  const harness = createHarness({ ttlMs: 1_000 });
  const issued = issue(harness);
  const deadlineMs = harness.clock.now() + 1_000;
  assert.equal(issued.expiresAtUtc, new Date(deadlineMs).toISOString());

  harness.clock.set(deadlineMs - 1);
  assert.ok(harness.sessions.authenticate(issued.token), 'the last valid millisecond still works');

  harness.clock.set(deadlineMs);
  assert.equal(harness.sessions.authenticate(issued.token), undefined);

  harness.clock.set(deadlineMs + 1);
  assert.equal(harness.sessions.authenticate(issued.token), undefined);
});

test('the lifetime is measured from issuance, not from construction', () => {
  const harness = createHarness({ ttlMs: 1_000 });
  harness.clock.advance(10 * MINUTE_MS);
  const issued = issue(harness);
  assert.equal(issued.expiresAtUtc, new Date(harness.clock.now() + 1_000).toISOString());

  harness.clock.advance(999);
  assert.ok(harness.sessions.authenticate(issued.token));
  harness.clock.advance(1);
  assert.equal(harness.sessions.authenticate(issued.token), undefined);
});

test('revocation invalidates a session immediately and is idempotent', () => {
  const harness = createHarness();
  const issued = issue(harness);

  assert.equal(harness.sessions.revoke(issued.token), true);
  assert.equal(harness.sessions.authenticate(issued.token), undefined);
  assert.equal(harness.sessions.revoke(issued.token), false);
  assert.equal(harness.sessions.revoke(`${OWNER_SESSION_TOKEN_PREFIX}${'a'.repeat(64)}`), false);
  assert.equal(harness.sessions.revoke(''), false);
  assert.equal(harness.sessions.revoke(undefined), false);
  assert.equal(harness.sessions.revoke(7), false);
});

test('revoking an already expired session reports nothing live to revoke', () => {
  const harness = createHarness({ ttlMs: 500 });
  const issued = issue(harness);
  harness.clock.advance(500);

  assert.equal(harness.sessions.revoke(issued.token), false);
  assert.equal(harness.sessions.authenticate(issued.token), undefined);
});

test('sessions do not survive a fresh instance (restart or logout invalidates)', () => {
  const harness = createHarness();
  const issued = issue(harness);

  const restarted = OwnerSessions({
    ownerId: OWNER_ID,
    ownerSecret: OWNER_SECRET,
    now: harness.clock.now,
  });
  assert.equal(restarted.authenticate(issued.token), undefined);
  assert.equal(restarted.revoke(issued.token), false);
  assert.ok(harness.sessions.authenticate(issued.token), 'the original instance is untouched');
});

test('a session token is not usable as the owner secret', () => {
  const harness = createHarness();
  const issued = issue(harness);
  assert.equal(harness.sessions.create(issued.token), undefined);
});

test('non-issuance responses never carry the root secret or a session token', () => {
  const harness = createHarness({ ttlMs: 1_000 });
  const issued = issue(harness);
  const responses = [
    harness.sessions.authenticate(issued.token),
    harness.sessions.create('wrong-secret-wrong-secret-wrong-secret'),
    harness.sessions.revoke('unknown-token'),
  ];

  for (const response of responses) {
    const serialized = JSON.stringify(response) ?? 'undefined';
    assert.ok(!serialized.includes(OWNER_SECRET));
    assert.ok(!serialized.includes(issued.token));
    assert.ok(!serialized.includes(issued.token.slice(OWNER_SESSION_TOKEN_PREFIX.length)));
  }
});

test('invalid constructor values are rejected without echoing them', () => {
  const shortSecret = 'too-short-secret';
  const invalidOptions = [
    { ownerId: '', ownerSecret: OWNER_SECRET },
    { ownerId: '   ', ownerSecret: OWNER_SECRET },
    { ownerId: OWNER_ID, ownerSecret: '' },
    { ownerId: OWNER_ID, ownerSecret: shortSecret },
    { ownerId: OWNER_ID, ownerSecret: 42 as unknown as string },
    { ownerId: OWNER_ID, ownerSecret: OWNER_SECRET, sessionTtlMs: 0 },
    { ownerId: OWNER_ID, ownerSecret: OWNER_SECRET, sessionTtlMs: -1 },
    { ownerId: OWNER_ID, ownerSecret: OWNER_SECRET, sessionTtlMs: 1.5 },
    { ownerId: OWNER_ID, ownerSecret: OWNER_SECRET, sessionTtlMs: Number.NaN },
    { ownerId: OWNER_ID, ownerSecret: OWNER_SECRET, sessionTtlMs: Number.POSITIVE_INFINITY },
    { ownerId: OWNER_ID, ownerSecret: OWNER_SECRET, now: 'not-a-function' as unknown as () => number },
  ];

  for (const options of invalidOptions) {
    assert.throws(
      () => OwnerSessions(options),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'constructor failures must be Errors');
        const message = (error as Error).message;
        assert.ok(!message.includes(OWNER_SECRET), 'the message must not echo the root secret');
        assert.ok(!message.includes(shortSecret), 'the message must not echo a rejected secret');
        assert.ok(!message.includes(String(options.sessionTtlMs)), 'the message must not echo values');
        return true;
      },
      `options ${JSON.stringify(options)} must be rejected`,
    );
  }
});

test('a minimal valid configuration still issues sessions', () => {
  const sessions = OwnerSessions({ ownerId: OWNER_ID, ownerSecret: OWNER_SECRET });
  const issued = sessions.create(OWNER_SECRET);
  assert.ok(issued);
  assert.equal(issued.ownerId, OWNER_ID);
  assert.match(issued.expiresAtUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const principal = sessions.authenticate(issued.token);
  assert.ok(principal);
  assert.equal(principal.expiresAtUtc, issued.expiresAtUtc);
});
