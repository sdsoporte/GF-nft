/**
 * HTTP boundary for the authoritative factory backend.
 *
 * Uses only `node:http` and `node:crypto` so the service runs on Bun without
 * extra runtime dependencies. The handler layer is transport-only: all
 * simulation authority lives in `FactoryMatch` and the engine.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { IntervalTickClock } from './clock.ts';
import type { TickClock } from './clock.ts';
import {
  ERRORS,
  FORBIDDEN_MESSAGES,
  INVALID_REQUEST_MESSAGES,
  forbidden,
  invalidRequest,
  type ErrorDefinition,
} from './errors.ts';
import {
  DEFAULT_TICK_INTERVAL_MS,
  FactoryMatch,
  PROTOCOL_VERSION,
  type ProductionRequestInput,
} from './match.ts';
import type { MatchStore } from './persistence/matchStore.ts';
import type { McpGateway } from './mcp/McpGateway.ts';
import { createMcpRuntime, type McpRuntime } from './mcpRuntime.ts';
import { handleMcpPost } from './mcp/transport.ts';
import { GrantIssueError, type GrantIssueInput } from './grantService.ts';
import { readFactoryConfig } from './config.ts';
import { IDEMPOTENCY_KEY_REGEX } from './mcp/schemas.ts';

/** Hard limit for request bodies. */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024;

export interface FactoryServerOptions {
  /** Bearer token shared with clients. Never logged or echoed. */
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  readonly tickIntervalMs?: number;
  readonly clock?: TickClock;
  readonly match?: FactoryMatch;
  readonly seed?: number;
  readonly matchId?: string;
  /**
   * Durable match state (S3/S6). Omitted leaves the server purely in memory,
   * exactly as before persistence existed. The caller owns the database handle
   * and closes it after `close()`, so the transport layer never opens files.
   */
  readonly store?: MatchStore;
  /** Explicit opt-in to single-owner administration; absent leaves legacy routes unchanged. */
  readonly ownerId?: string;
  /** Deterministic security clock for tests; production uses Date.now. */
  readonly securityNow?: () => number;
}

export interface FactoryServerAddress {
  readonly host: string;
  readonly port: number;
}

export interface FactoryServerHandle {
  readonly server: Server;
  readonly match: FactoryMatch;
  readonly clock: TickClock;
  /** Server-owned runtime, not an external MCP transport/catalog. */
  readonly mcp?: McpGateway;
  listen(options?: { host?: string; port?: number }): Promise<FactoryServerAddress>;
  close(): Promise<void>;
}

interface HandlerContext {
  readonly token: string;
  readonly match: FactoryMatch;
  readonly owner: McpRuntime | null;
}

type RouteName = 'health' | 'state' | 'production' | 'command' | 'mcp';

type ResolvedRoute =
  | { readonly kind: 'route'; readonly name: RouteName; readonly commandId?: string }
  | { readonly kind: 'method_not_allowed' }
  | { readonly kind: 'not_found' };

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

function resolveRoute(method: string, pathname: string): ResolvedRoute {
  const path = normalizePath(pathname);

  if (path === '/health') {
    return method === 'GET' ? { kind: 'route', name: 'health' } : { kind: 'method_not_allowed' };
  }
  if (path === '/v1/state') {
    return method === 'GET' ? { kind: 'route', name: 'state' } : { kind: 'method_not_allowed' };
  }
  if (path === '/v1/production') {
    return method === 'POST' ? { kind: 'route', name: 'production' } : { kind: 'method_not_allowed' };
  }

  if (path === '/mcp') {
    return method === 'POST' ? { kind: 'route', name: 'mcp' } : { kind: 'method_not_allowed' };
  }

  const commandMatch = /^\/v1\/commands\/([^/]+)$/.exec(path);
  if (commandMatch) {
    if (method !== 'GET') return { kind: 'method_not_allowed' };
    try {
      return { kind: 'route', name: 'command', commandId: decodeURIComponent(commandMatch[1]) };
    } catch {
      return { kind: 'not_found' };
    }
  }

  return { kind: 'not_found' };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-length', Buffer.byteLength(payload, 'utf8'));
  res.end(payload);
}

function sendError(res: ServerResponse, definition: ErrorDefinition): void {
  sendJson(res, definition.status, definition.body);
}

function toBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Constant-time bearer-token comparison. */
function tokensMatch(expected: string, provided: string): boolean {
  const expectedBytes = toBytes(expected);
  const providedBytes = toBytes(provided);
  if (expectedBytes.length !== providedBytes.length || expectedBytes.length === 0) {
    return false;
  }
  return timingSafeEqual(expectedBytes, providedBytes);
}

function readBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  return /^Bearer[ ]+([^ ]+)$/i.exec(header.trim())?.[1];
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const token = readBearer(req);
  return token !== undefined && tokensMatch(expectedToken, token);
}

type BodyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'too_large' | 'read_error' };

function readBody(req: IncomingMessage, limitBytes: number): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let exceeded = false;

    req.on('data', (chunk: Uint8Array) => {
      if (exceeded) return;
      size += chunk.byteLength;
      if (size > limitBytes) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) {
        resolve({ ok: false, reason: 'too_large' });
        return;
      }
      const merged = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve({ ok: true, text: new TextDecoder('utf-8').decode(merged) });
    });
    req.on('error', () => resolve({ ok: false, reason: 'read_error' }));
  });
}

async function discardBody(req: IncomingMessage): Promise<void> {
  await readBody(req, Number.MAX_SAFE_INTEGER);
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Enforce the frozen production request shape. Company IDs, ticks, sequence
 * numbers and batch counts are rejected here because they are not in the shape.
 */
function validateProductionBody(
  value: unknown,
): { ok: true; value: ProductionRequestInput } | { ok: false; message: string } {
  if (!isPlainObject(value)) {
    return { ok: false, message: INVALID_REQUEST_MESSAGES.shape };
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes('requestId') ||
    !keys.includes('lineId') ||
    !keys.includes('recipeId')
  ) {
    return { ok: false, message: INVALID_REQUEST_MESSAGES.shape };
  }
  const { requestId, lineId, recipeId } = value;
  if (typeof requestId !== 'string' || typeof lineId !== 'string' || typeof recipeId !== 'string') {
    return { ok: false, message: INVALID_REQUEST_MESSAGES.shape };
  }
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, message: INVALID_REQUEST_MESSAGES.requestId };
  }
  return { ok: true, value: { requestId, lineId, recipeId } };
}

async function handleProduction(
  req: IncomingMessage,
  res: ServerResponse,
  context: HandlerContext,
): Promise<void> {
  const contentType = req.headers['content-type'];
  const mediaType =
    typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
  if (mediaType !== 'application/json') {
    await discardBody(req);
    sendError(res, ERRORS.unsupportedMediaType);
    return;
  }

  const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
  if (!body.ok) {
    if (body.reason === 'too_large') {
      sendError(res, ERRORS.requestTooLarge);
      return;
    }
    sendError(res, invalidRequest(INVALID_REQUEST_MESSAGES.malformedJson));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    sendError(res, invalidRequest(INVALID_REQUEST_MESSAGES.malformedJson));
    return;
  }

  const validated = validateProductionBody(parsed);
  if (!validated.ok) {
    sendError(res, invalidRequest(validated.message));
    return;
  }

  const decision = context.match.requestProduction(validated.value);
  switch (decision.kind) {
    case 'unsupported_recipe':
      sendError(res, invalidRequest(INVALID_REQUEST_MESSAGES.unsupportedRecipe));
      return;
    case 'line_not_owned':
      sendError(res, forbidden(FORBIDDEN_MESSAGES.lineNotOwned));
      return;
    case 'request_id_reused':
      sendError(res, ERRORS.requestIdReused);
      return;
    case 'command_limit':
      sendError(res, ERRORS.commandLimit);
      return;
    default:
      sendJson(res, 202, { commandId: decision.commandId, status: 'queued' });
  }
}

async function handleOwnerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  context: HandlerContext,
): Promise<boolean> {
  const owner = context.owner;
  if (!owner) return false;
  const path = normalizePath(pathname);
  const login = path === '/v1/owner/sessions';
  const logout = path === '/v1/owner/sessions/current';
  const collection = path === '/v1/owner/grants';
  const item = /^\/v1\/owner\/grants\/([^/]+)$/.exec(path);
  const publication = /^\/v1\/owner\/contracts\/([^/]+)\/publish$/.exec(path);
  if (!login && !logout && !collection && !item && !publication) return false;
  const method = req.method ?? 'GET';
  const methodAllowed = login ? method === 'POST'
    : logout ? method === 'DELETE'
    : collection ? method === 'GET' || method === 'POST'
    : publication ? method === 'POST'
    : method === 'GET' || method === 'DELETE';
  if (!methodAllowed) {
    await discardBody(req); sendError(res, ERRORS.methodNotAllowed); return true;
  }
  if (login) {
    await discardBody(req);
    if (!isAuthorized(req, context.token)) { sendError(res, ERRORS.unauthorized); return true; }
    const session = owner.sessions.create(context.token);
    if (!session) sendError(res, ERRORS.unauthorized);
    else sendJson(res, 201, session);
    return true;
  }
  const bearer = readBearer(req);
  if (!owner.sessions.authenticate(bearer)) {
    await discardBody(req); sendError(res, ERRORS.unauthorized); return true;
  }
  if (logout) {
    await discardBody(req);
    sendJson(res, 200, { revoked: owner.sessions.revoke(bearer) }); return true;
  }
  if (publication) {
    const mediaType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
      await discardBody(req);
      sendJson(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The publication request must be application/json.' } });
      return true;
    }
    const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
    if (!body.ok) {
      sendError(res, body.reason === 'too_large' ? ERRORS.requestTooLarge : invalidRequest(INVALID_REQUEST_MESSAGES.malformedJson));
      return true;
    }
    let input: unknown;
    try { input = JSON.parse(body.text); }
    catch { sendError(res, invalidRequest(INVALID_REQUEST_MESSAGES.malformedJson)); return true; }
    if (!isPlainObject(input) || Object.keys(input).length !== 1 ||
      typeof input.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_REGEX.test(input.idempotency_key)) {
      sendJson(res, 400, { error: { code: 'ERR_INVALID_PAYLOAD', message: 'Invalid publication request.' } });
      return true;
    }
    let contractId: string;
    try { contractId = decodeURIComponent(publication[1]); }
    catch { sendError(res, ERRORS.notFound); return true; }
    const companyId = context.match.getServerCompany().companyId;
    const contract = context.match.engine.getContract(contractId);
    if (!contract || contract.sellerCompanyId !== companyId || contract.status !== 'DRAFT') {
      sendError(res, ERRORS.notFound); return true;
    }
    const scheduledTick = context.match.engine.getCurrentTick() + 1;
    const accepted = context.match.submitMcpCommand({
      commandId: 'owner_publish', companyId, scheduledTick,
      idempotencyKey: input.idempotency_key, type: 'PUBLISH_SUPPLY_OFFER', contractId,
    });
    if (!accepted) {
      sendJson(res, 409, { error: { code: 'ERR_DUPLICATE_IDEMPOTENCY_KEY', message: 'idempotency_key duplicate' } });
      return true;
    }
    sendJson(res, 202, { status: 'ENQUEUED_FOR_NEXT_TICK', scheduledTick, contractId });
    return true;
  }
  if (collection && method === 'GET') {
    await discardBody(req); sendJson(res, 200, { grants: owner.grants.list() }); return true;
  }
  if (collection) {
    const mediaType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
      await discardBody(req);
      sendJson(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The grant request must be application/json.' } });
      return true;
    }
    const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
    if (!body.ok) { sendError(res, body.reason === 'too_large' ? ERRORS.requestTooLarge : invalidRequest(INVALID_REQUEST_MESSAGES.malformedJson)); return true; }
    let input: unknown;
    try { input = JSON.parse(body.text); }
    catch { sendError(res, invalidRequest(INVALID_REQUEST_MESSAGES.malformedJson)); return true; }
    try { sendJson(res, 201, owner.grants.issue(input as GrantIssueInput)); }
    catch (error) {
      if (!(error instanceof GrantIssueError)) throw error;
      // Never echo attacker-supplied policy values or credentials.
      sendJson(res, 400, { error: { code: 'ERR_INVALID_PAYLOAD', message: 'Invalid grant policy.' } });
    }
    return true;
  }
  await discardBody(req);
  let grantId: string;
  try { grantId = decodeURIComponent(item![1]); }
  catch { sendError(res, ERRORS.notFound); return true; }
  if (method === 'GET') {
    const grant = owner.grants.get(grantId);
    if (grant) sendJson(res, 200, { grant });
    else sendError(res, ERRORS.notFound);
  } else if (owner.grants.revoke(grantId)) sendJson(res, 200, { revoked: true });
  else sendError(res, ERRORS.notFound);
  return true;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: HandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://server.invalid');
  if (context.owner && url.pathname.startsWith('/v1/owner/') &&
      await handleOwnerRequest(req, res, url.pathname, context)) return;
  const route = resolveRoute(req.method ?? 'GET', url.pathname);

  if (route.kind === 'not_found') {
    await discardBody(req);
    sendError(res, ERRORS.notFound);
    return;
  }
  if (route.kind === 'method_not_allowed') {
    await discardBody(req);
    sendError(res, ERRORS.methodNotAllowed);
    return;
  }

  if (route.name === 'health') {
    await discardBody(req);
    sendJson(res, 200, { status: 'ok', protocolVersion: PROTOCOL_VERSION });
    return;
  }

  // Issue #9: the external MCP transport authenticates per call with its own
  // grant tokens, so it runs before the root-token gate.
  if (route.name === 'mcp') {
    if (!context.owner) {
      await discardBody(req);
      sendError(res, ERRORS.notFound);
      return;
    }
    const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, body.reason === 'too_large' ? 413 : 400, {
        jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC request' },
      });
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body.text); } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC request' } });
      return;
    }
    const owner = context.owner;
    const response = await handleMcpPost({
      gateway: owner.gateway,
      resolveBearer: (token) => owner.grants.resolve(token) !== undefined,
      bearer: readBearer(req),
      body: parsed,
    });
    sendJson(res, response.status, response.json);
    return;
  }

  if (!isAuthorized(req, context.token)) {
    await discardBody(req);
    sendError(res, ERRORS.unauthorized);
    return;
  }

  if (route.name === 'state') {
    await discardBody(req);
    sendJson(res, 200, context.match.getStatePayload());
    return;
  }
  if (route.name === 'production') {
    await handleProduction(req, res, context);
    return;
  }

  await discardBody(req);
  const commandStatus = context.match.getCommandStatus(route.commandId ?? '');
  if (!commandStatus) {
    sendError(res, ERRORS.notFound);
    return;
  }
  sendJson(res, 200, commandStatus);
}

export function createFactoryServer(options: FactoryServerOptions): FactoryServerHandle {
  if (typeof options.token !== 'string' || options.token.length === 0) {
    throw new Error('createFactoryServer requires a non-empty bearer token');
  }

  const ownerId = options.ownerId === '' ? undefined : options.ownerId;
  if (ownerId !== undefined) {
    const validation = readFactoryConfig({ GF_API_TOKEN: options.token, GF_OWNER_ID: ownerId });
    if (!validation.ok) throw new Error(validation.errors.join(' '));
  }
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const match =
    options.match ??
    new FactoryMatch({
      seed: options.seed,
      matchId: options.matchId,
      tickIntervalMs,
      store: options.store,
    });
  const clock = options.clock ?? new IntervalTickClock(tickIntervalMs);
  const owner = ownerId === undefined ? null : createMcpRuntime({
    ownerId, ownerSecret: options.token, match, store: options.store, now: options.securityNow,
  });
  const context: HandlerContext = { token: options.token, match, owner };
  const defaultHost = options.host ?? '127.0.0.1';
  const defaultPort = options.port ?? 8787;

  const server = createServer((req, res) => {
    void handleRequest(req, res, context).catch(() => {
      if (!res.headersSent) sendError(res, ERRORS.internal);
      else res.end();
    });
  });

  let started = false;

  return {
    server,
    match,
    clock,
    ...(owner ? { mcp: owner.gateway } : {}),
    listen: (listenOptions = {}) =>
      new Promise<FactoryServerAddress>((resolve, reject) => {
        const host = listenOptions.host ?? defaultHost;
        const port = listenOptions.port ?? defaultPort;
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          const address = server.address() as AddressInfo | string | null;
          if (!started) {
            started = true;
            clock.start(() => match.advanceTicks());
          }
          if (address && typeof address === 'object') {
            resolve({ host: address.address, port: address.port });
            return;
          }
          resolve({ host, port });
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        clock.stop();
        const closed = (): void => { owner?.close(); resolve(); };
        if (!server.listening) { closed(); return; }
        server.close(closed);
      }),
  };
}
