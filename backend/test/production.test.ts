/**
 * POST /v1/production: media type, request validation, ownership, the request
 * acknowledgement ledger and rejection side effects.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executionCount,
  pendingCommandCount,
  productionPayload,
  productionRequest,
  readState,
  request,
  withTestServer,
  type TestApp,
} from './helpers.ts';

const COMMAND_ID_PATTERN = /^cmd_[0-9a-f]{24}$/;

function stateFingerprint(state: any): string {
  return JSON.stringify({
    tick: state.tick,
    credits: state.company.credits,
    energy: state.company.energy,
    inventory: state.company.inventory,
    lines: state.company.lines,
  });
}

/** Rejections must not touch simulation state, the queue or the history. */
async function expectNoSideEffects(
  app: TestApp,
  expectedStatus: number,
  response: { status: number; json: unknown },
  before: string,
  expectedBody?: unknown,
): Promise<void> {
  assert.equal(response.status, expectedStatus);
  if (expectedBody !== undefined) assert.deepEqual(response.json, expectedBody);
  assert.equal(stateFingerprint(await readState(app)), before);
  assert.equal(pendingCommandCount(app), 0);
  assert.equal(executionCount(app), 0);
}

function errorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

test('production requires a JSON content type', async () => {
  await withTestServer(async (app) => {
    const before = stateFingerprint(await readState(app));

    const plain = await productionRequest(app, productionPayload(), {
      headers: { 'content-type': 'text/plain' },
    });
    assert.deepEqual(
      plain.json,
      errorBody('UNSUPPORTED_MEDIA_TYPE', 'The production request must be application/json.'),
    );
    await expectNoSideEffects(app, 415, plain, before);

    const missing = await productionRequest(app, productionPayload(), { headers: {} });
    assert.deepEqual(
      missing.json,
      errorBody('UNSUPPORTED_MEDIA_TYPE', 'The production request must be application/json.'),
    );
    await expectNoSideEffects(app, 415, missing, before);
  });
});

test('production accepts a JSON content type with charset parameters', async () => {
  await withTestServer(async (app) => {
    const response = await productionRequest(app, productionPayload(), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    assert.equal(response.status, 202);
    assert.equal(response.json.status, 'queued');
  });
});

test('production rejects malformed JSON without side effects', async () => {
  await withTestServer(async (app) => {
    const before = stateFingerprint(await readState(app));

    const truncated = await productionRequest(app, '{"requestId": ');
    await expectNoSideEffects(
      app,
      400,
      truncated,
      before,
      errorBody('INVALID_REQUEST', 'The request body must be valid JSON.'),
    );

    const empty = await productionRequest(app, '');
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'INVALID_REQUEST');
    assert.equal(pendingCommandCount(app), 0);
  });
});

test('production rejects fields outside the frozen request shape', async () => {
  await withTestServer(async (app) => {
    const before = stateFingerprint(await readState(app));
    const expected = errorBody(
      'INVALID_REQUEST',
      'The request body must contain exactly requestId, lineId and recipeId.',
    );

    const cases: Array<unknown> = [
      { ...productionPayload(), companyId: 'comp_manuf_01' },
      { ...productionPayload(), targetBatches: 5 },
      { ...productionPayload(), scheduledTick: 99 },
      { requestId: 'client-request-1', lineId: 'comp_metal_01_line_1' },
      { requestId: 'client-request-1', recipeId: 'R1' },
      { requestId: 'client-request-1', lineId: 'comp_metal_01_line_1', recipeId: 'R1', extra: null },
      [],
      42,
      true,
      null,
      { requestId: 7, lineId: 'comp_metal_01_line_1', recipeId: 'R1' },
      { requestId: 'client-request-1', lineId: 7, recipeId: 'R1' },
      { requestId: 'client-request-1', lineId: 'comp_metal_01_line_1', recipeId: 7 },
    ];

    for (const body of cases) {
      const response = await productionRequest(app, body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.deepEqual(response.json, expected);
    }

    await expectNoSideEffects(app, 400, { status: 400, json: expected }, before);
  });
});

test('production rejects invalid request identifiers', async () => {
  await withTestServer(async (app) => {
    const expected = errorBody(
      'INVALID_REQUEST',
      'The requestId must be 1-64 ASCII letters, digits, underscores or dashes.',
    );

    for (const requestId of ['', 'a'.repeat(65), 'a b', 'a/b', 'a.b', 'ñandú', 'a\nb']) {
      const response = await productionRequest(app, productionPayload({ requestId }));
      assert.equal(response.status, 400, `expected 400 for requestId ${JSON.stringify(requestId)}`);
      assert.deepEqual(response.json, expected);
    }

    const longest = await productionRequest(app, productionPayload({ requestId: 'a'.repeat(64) }));
    assert.equal(longest.status, 202);

    await request(app, '/v1/production', {
      method: 'POST',
      token: app.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(productionPayload({ requestId: '' })),
    });
    assert.equal(executionCount(app), 0);
    assert.equal(pendingCommandCount(app), 1);
  });
});

test('production rejects an unsupported recipe without consuming the request ID', async () => {
  await withTestServer(async (app) => {
    const before = stateFingerprint(await readState(app));
    const payload = productionPayload({ recipeId: 'R2' });

    const rejected = await productionRequest(app, payload);
    await expectNoSideEffects(
      app,
      400,
      rejected,
      before,
      errorBody('INVALID_REQUEST', 'Only recipe R1 is supported by this slice.'),
    );

    const accepted = await productionRequest(app, productionPayload({ requestId: payload.requestId }));
    assert.equal(accepted.status, 202);
    assert.equal(accepted.json.status, 'queued');
    assert.equal(pendingCommandCount(app), 1);
  });
});

test('production rejects lines that the server-selected company does not own', async () => {
  await withTestServer(async (app) => {
    const before = stateFingerprint(await readState(app));
    const expected = errorBody(
      'FORBIDDEN',
      'The production line is not owned by the authenticated company.',
    );

    for (const lineId of ['comp_metal_02_line_1', 'comp_manuf_01_line_2', 'unknown_line_1', '']) {
      const response = await productionRequest(app, productionPayload({ lineId }));
      assert.equal(response.status, 403, `expected 403 for lineId ${JSON.stringify(lineId)}`);
      assert.deepEqual(response.json, expected);
    }

    await expectNoSideEffects(app, 403, { status: 403, json: expected }, before);
  });
});

test('a valid production request returns a queued acknowledgement only', async () => {
  await withTestServer(async (app) => {
    const before = stateFingerprint(await readState(app));
    const response = await productionRequest(app, productionPayload());

    assert.equal(response.status, 202);
    assert.equal(typeof response.json.commandId, 'string');
    assert.match(response.json.commandId, COMMAND_ID_PATTERN);
    assert.deepEqual(response.json, { commandId: response.json.commandId, status: 'queued' });
    assert.equal(pendingCommandCount(app), 1);
    assert.equal(executionCount(app), 0);
    assert.equal(stateFingerprint(await readState(app)), before);
  });
});

test('an exact retry returns the same acknowledgement without another command', async () => {
  await withTestServer(async (app) => {
    const payload = productionPayload();
    const first = await productionRequest(app, payload);
    const retry = await productionRequest(app, payload);

    assert.equal(first.status, 202);
    assert.equal(retry.status, 202);
    assert.deepEqual(retry.json, first.json);
    assert.equal(pendingCommandCount(app), 1);

    app.clock.advance(1);
    assert.equal(executionCount(app), 1);

    const afterTickRetry = await productionRequest(app, payload);
    assert.equal(afterTickRetry.status, 202);
    assert.deepEqual(afterTickRetry.json, first.json);
    assert.equal(executionCount(app), 1);
  });
});

test('a reused request ID with a different payload is rejected and keeps the original command', async () => {
  await withTestServer(async (app) => {
    const first = await productionRequest(app, productionPayload());
    assert.equal(first.status, 202);

    const conflict = await productionRequest(
      app,
      productionPayload({ lineId: 'comp_metal_01_line_2' }),
    );
    assert.equal(conflict.status, 409);
    assert.deepEqual(
      conflict.json,
      errorBody('REQUEST_ID_REUSED', 'This requestId was already used with a different payload.'),
    );
    assert.equal(pendingCommandCount(app), 1);

    app.clock.advance(1);
    const history = app.handle.match.engine.getExecutionHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].commandId, first.json.commandId);
    assert.equal(history[0].success, true);
  });
});

test('body size limit is enforced at exactly 8192 bytes', async () => {
  await withTestServer(async (app) => {
    const base = JSON.stringify(productionPayload());
    const exact = base + ' '.repeat(8192 - base.length);
    assert.equal(exact.length, 8192);
    const accepted = await productionRequest(app, exact);
    assert.equal(accepted.status, 202);

    const tooLarge = base + ' '.repeat(8193 - base.length);
    assert.equal(tooLarge.length, 8193);
    const rejected = await productionRequest(app, tooLarge);
    assert.equal(rejected.status, 413);
    assert.deepEqual(
      rejected.json,
      errorBody('REQUEST_TOO_LARGE', 'The request body exceeds 8192 bytes.'),
    );
    assert.equal(pendingCommandCount(app), 1);
  });
});

test('two clients observe the same match and the same command', async () => {
  await withTestServer(async (app) => {
    const clientA = await readState(app);
    const clientB = await readState(app);
    assert.equal(clientA.matchId, clientB.matchId);
    assert.equal(clientA.tick, clientB.tick);

    const ack = await productionRequest(app, productionPayload());
    assert.equal(ack.status, 202);

    app.clock.advance(1);

    const stateA = await readState(app);
    const stateB = await readState(app);
    assert.equal(stateA.tick, 1);
    assert.deepEqual(stateA, stateB);
    assert.equal(stateA.company.lines[0].status, 'RUNNING');
    assert.equal(stateA.company.lines[0].currentRecipeId, 'R1');

    const commandA = await request(app, `/v1/commands/${ack.json.commandId}`, { token: app.token });
    const commandB = await request(app, `/v1/commands/${ack.json.commandId}`, { token: app.token });
    assert.equal(commandA.status, 200);
    assert.deepEqual(commandA.json, commandB.json);
    assert.equal(commandA.json.status, 'executed');
  });
});

test('request validation never advances the simulation clock', async () => {
  await withTestServer(async (app) => {
    await productionRequest(app, productionPayload({ lineId: 'comp_metal_02_line_1' }));
    await productionRequest(app, productionPayload({ recipeId: 'R3' }));
    await productionRequest(app, { requestId: 'x' });
    assert.equal((await readState(app)).tick, 0);
  });
});
