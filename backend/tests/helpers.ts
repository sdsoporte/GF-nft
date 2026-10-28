/**
 * Shared helpers for the backend HTTP tests.
 *
 * Every test receives its own in-memory match and its own manual clock, so no
 * test depends on wall-clock time and no test can observe another test's state.
 */

import { createFactoryServer } from '../src/http.ts';
import type { FactoryServerHandle } from '../src/http.ts';
import { ManualTickClock } from '../src/clock.ts';
import { DEFAULT_TICK_INTERVAL_MS } from '../src/match.ts';

export const TEST_TOKEN = 'test-token-0123456789abcdef0123456789';
export const OTHER_TOKEN = 'other-token-0123456789abcdef0123456789';

export interface TestApp {
  readonly handle: FactoryServerHandle;
  readonly baseUrl: string;
  readonly clock: ManualTickClock;
  readonly token: string;
  close(): Promise<void>;
}

export interface TestServerOptions {
  token?: string;
  matchId?: string;
  seed?: number;
  tickIntervalMs?: number;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestApp> {
  const token = options.token ?? TEST_TOKEN;
  const clock = new ManualTickClock(options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
  const handle = createFactoryServer({
    token,
    clock,
    seed: options.seed ?? 42107,
    matchId: options.matchId ?? 'match_test_fixed01',
    tickIntervalMs: options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
  });
  const address = await handle.listen({ host: '127.0.0.1', port: 0 });
  return {
    handle,
    baseUrl: `http://127.0.0.1:${address.port}`,
    clock,
    token,
    close: () => handle.close(),
  };
}

export async function withTestServer(
  run: (app: TestApp) => Promise<void>,
  options: TestServerOptions = {},
): Promise<void> {
  const app = await startTestServer(options);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

export interface HttpResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly text: string;
  readonly json: any;
}

export interface RequestOptions {
  method?: string;
  token?: string | null;
  headers?: Record<string, string>;
  body?: string;
}

export async function request(
  app: TestApp,
  path: string,
  options: RequestOptions = {},
): Promise<HttpResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text,
    json,
  };
}

/** POST /v1/production as an authenticated client. */
export function productionRequest(
  app: TestApp,
  payload: unknown,
  overrides: RequestOptions = {},
): Promise<HttpResponse> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return request(app, '/v1/production', {
    method: 'POST',
    token: app.token,
    headers: { 'content-type': 'application/json' },
    body,
    ...overrides,
  });
}

export interface ProductionPayload {
  requestId: string;
  lineId: string;
  recipeId: string;
}

export function productionPayload(overrides: Partial<ProductionPayload> = {}): ProductionPayload {
  return {
    requestId: 'client-request-1',
    lineId: 'comp_metal_01_line_1',
    recipeId: 'R1',
    ...overrides,
  };
}

export function commandPath(commandId: string): string {
  return `/v1/commands/${encodeURIComponent(commandId)}`;
}

/** Read the own-company state payload through HTTP. */
export async function readState(app: TestApp): Promise<any> {
  const response = await request(app, '/v1/state', { token: app.token });
  if (response.status !== 200) {
    throw new Error(`state request failed with ${response.status}: ${response.text}`);
  }
  return response.json;
}

/** Read a command status through HTTP. */
export async function readCommand(app: TestApp, commandId: string): Promise<HttpResponse> {
  return request(app, commandPath(commandId), { token: app.token });
}

/** Pending engine command count, used to prove rejections enqueue nothing. */
export function pendingCommandCount(app: TestApp): number {
  return app.handle.match.engine.getCommandQueue().getPendingCount();
}

/** Total engine execution history length, used to prove rejections execute nothing. */
export function executionCount(app: TestApp): number {
  return app.handle.match.engine.getExecutionHistory().length;
}
