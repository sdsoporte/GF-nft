/**
 * Issue #57: player line controls over additive HTTP routes.
 *
 * `POST /v1/lines/{lineId}/pause`, `POST /v1/lines/{lineId}/resume` and
 * `POST /v1/lines/{lineId}/priority` reuse the frozen `/v1/production`
 * admission path: the same request-id ledger, the same acknowledgement shape
 * (`202 {commandId, status:'queued'}`) and the same error table. Nothing here
 * mutates simulation state directly; every command reaches the engine through
 * its queue on a server-selected tick.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executionCount,
  pendingCommandCount,
  productionPayload,
  productionRequest,
  readCommand,
  readState,
  request,
  withTestServer,
  type HttpResponse,
  type RequestOptions,
  type TestApp,
} from './helpers.ts';

const LINE = 'comp_metal_01_line_1';
const OTHER_OWNED_LINE = 'comp_metal_01_line_2';
const COMMAND_ID_PATTERN = /^cmd_[0-9a-f]{24}$/;

type LineAction = 'pause' | 'resume' | 'priority';

const MESSAGES = {
  shapePause: 'The request body must contain exactly requestId.',
  shapePriority: 'The request body must contain exactly requestId and priority.',
  priorityRange: 'The priority must be an integer between 1 and 3.',
  unsupportedMediaType: 'The line control request must be application/json.',
  malformedJson: 'The request body must be valid JSON.',
  requestId: 'The requestId must be 1-64 ASCII letters, digits, underscores or dashes.',
  lineNotOwned: 'The production line is not owned by the authenticated company.',
  requestIdReused: 'This requestId was already used with a different payload.',
  requestTooLarge: 'The request body exceeds 8192 bytes.',
} as const;

function errorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

function lineControlPath(lineId: string, action: LineAction): string {
  return `/v1/lines/${encodeURIComponent(lineId)}/${action}`;
}

function lineControlRequest(
  app: TestApp,
  lineId: string,
  action: LineAction,
  payload: unknown,
  overrides: RequestOptions = {},
): Promise<HttpResponse> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return request(app, lineControlPath(lineId, action), {
    method: 'POST',
    token: app.token,
    headers: { 'content-type': 'application/json' },
    body,
    ...overrides,
  });
}

function findLine(state: any, lineId: string): any {
  return state.company.lines.find((line: any) => line.lineId === lineId);
}

/** Simulation state plus queue/history sizes, used to prove "no side effects". */
function stateFingerprint(state: any): string {
  return JSON.stringify({
    tick: state.tick,
    credits: state.company.credits,
    energy: state.company.energy,
    inventory: state.company.inventory,
    lines: state.company.lines,
  });
}

async function expectNoSideEffects(
  app: TestApp,
  response: HttpResponse,
  expectedStatus: number,
  before: string,
  expectedBody?: unknown,
): Promise<void> {
  assert.equal(response.status, expectedStatus);
  if (expectedBody !== undefined) assert.deepEqual(response.json, expectedBody);
  await expectUntouched(app, before);
}

/** The simulation, the queue and the history are exactly as they were. */
async function expectUntouched(app: TestApp, before: string): Promise<void> {
  assert.equal(stateFingerprint(await readState(app)), before);
  assert.equal(pendingCommandCount(app), 0);
  assert.equal(executionCount(app), 0);
}

test('line control routes exist, are POST-only and are authenticated', async () => {
  await withTestServer(async (app) => {
    for (const action of ['pause', 'resume', 'priority'] as const) {
      const path = lineControlPath(LINE, action);

      const getResponse = await request(app, path, { token: app.token });
      assert.equal(getResponse.status, 405, `GET ${path}`);
      assert.deepEqual(
        getResponse.json,
        errorBody('METHOD_NOT_ALLOWED', 'The method is not allowed for this route.'),
      );

      const anonymous = await request(app, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'anonymous-1', priority: 1 }),
      });
      assert.equal(anonymous.status, 401, `anonymous POST ${path}`);
      assert.equal(anonymous.json.error.code, 'UNAUTHORIZED');
    }

    assert.equal(pendingCommandCount(app), 0);
    assert.equal(executionCount(app), 0);
  });
});

test('actions outside the contract are not routed', async () => {
  await withTestServer(async (app) => {
    for (const action of ['cancel', 'stop', 'start', 'batch']) {
      const response = await request(app, `/v1/lines/${LINE}/${action}`, {
        method: 'POST',
        token: app.token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'unknown-action-1' }),
      });
      assert.equal(response.status, 404, `POST ${action}`);
      assert.equal(response.json.error.code, 'NOT_FOUND');
    }
  });
});

test('line control requires a JSON content type', async () => {
  await withTestServer(async (app) => {
    const before = stateFingerprint(await readState(app));
    const expected = errorBody('UNSUPPORTED_MEDIA_TYPE', MESSAGES.unsupportedMediaType);

    const headerCases: Array<Record<string, string>> = [{ 'content-type': 'text/plain' }, {}];
    for (const headers of headerCases) {
      const response = await lineControlRequest(
        app,
        LINE,
        'pause',
        { requestId: 'media-1' },
        { headers },
      );
      await expectNoSideEffects(app, response, 415, before, expected);
    }
  });
});

test('pause and resume accept only requestId', async () => {
  await withTestServer(async (app) => {
    const before = stateFingerprint(await readState(app));
    const expected = errorBody('INVALID_REQUEST', MESSAGES.shapePause);

    const cases: Array<unknown> = [
      {},
      { requestId: 'shape-1', lineId: LINE },
      { requestId: 'shape-1', priority: 2 },
      { requestId: 'shape-1', companyId: 'comp_metal_01' },
      { requestId: 'shape-1', scheduledTick: 9 },
      { requestId: 'shape-1', sequenceNumber: 3 },
      { requestId: 'shape-1', targetBatches: 2 },
      { requestId: 'shape-1', recipeId: 'R1' },
      { requestId: 'shape-1', extra: null },
      [],
      42,
      true,
      null,
      { requestId: 7 },
    ];

    for (const action of ['pause', 'resume'] as const) {
      for (const body of cases) {
        const response = await lineControlRequest(app, LINE, action, body);
        assert.equal(response.status, 400, `${action} with ${JSON.stringify(body)}`);
        assert.deepEqual(response.json, expected);
      }
      const malformed = await lineControlRequest(app, LINE, action, '{"requestId": ');
      assert.equal(malformed.status, 400);
      assert.deepEqual(malformed.json, errorBody('INVALID_REQUEST', MESSAGES.malformedJson));
    }

    await expectUntouched(app, before);
  });
});

test('priority accepts only requestId and an integer priority of 1..3', async () => {
  await withTestServer(async (app) => {
    const before = stateFingerprint(await readState(app));
    const shapeError = errorBody('INVALID_REQUEST', MESSAGES.shapePriority);
    const rangeError = errorBody('INVALID_REQUEST', MESSAGES.priorityRange);

    const shapeCases: Array<unknown> = [
      {},
      { requestId: 'prio-shape-1' },
      { priority: 2 },
      { requestId: 'prio-shape-1', priority: 2, lineId: LINE },
      { requestId: 'prio-shape-1', priority: 2, companyId: 'comp_metal_01' },
      { requestId: 'prio-shape-1', priority: 2, scheduledTick: 4 },
      { requestId: 'prio-shape-1', priority: 2, extra: null },
      [],
      null,
    ];
    for (const body of shapeCases) {
      const response = await lineControlRequest(app, LINE, 'priority', body);
      assert.equal(response.status, 400, `priority with ${JSON.stringify(body)}`);
      assert.deepEqual(response.json, shapeError);
    }

    const rangeCases: Array<unknown> = [0, 4, -1, 1.5, '2', null, true];
    let lastResponse: HttpResponse | undefined;
    for (const priority of rangeCases) {
      const response = await lineControlRequest(app, LINE, 'priority', {
        requestId: 'prio-range-1',
        priority,
      });
      assert.equal(response.status, 400, `priority ${JSON.stringify(priority)}`);
      assert.deepEqual(response.json, rangeError);
      lastResponse = response;
    }

    assert.ok(lastResponse);
    await expectNoSideEffects(app, lastResponse, 400, before, rangeError);
    assert.equal(findLine(await readState(app), LINE).priority, 1, 'the line keeps its priority');
  });
});

test('invalid request identifiers are refused without consuming the request ID', async () => {
  await withTestServer(async (app) => {
    const expected = errorBody('INVALID_REQUEST', MESSAGES.requestId);
    for (const requestId of ['', 'a'.repeat(65), 'a b', 'a/b', 'a.b', 'ñandú']) {
      const response = await lineControlRequest(app, LINE, 'pause', { requestId });
      assert.equal(response.status, 400, `requestId ${JSON.stringify(requestId)}`);
      assert.deepEqual(response.json, expected);
    }
    assert.equal(pendingCommandCount(app), 0);

    const accepted = await lineControlRequest(app, LINE, 'pause', { requestId: 'a'.repeat(64) });
    assert.equal(accepted.status, 202);
    assert.equal(pendingCommandCount(app), 1);
  });
});

test('lines the server company does not own are forbidden', async () => {
  await withTestServer(async (app) => {
    const before = stateFingerprint(await readState(app));
    const expected = errorBody('FORBIDDEN', MESSAGES.lineNotOwned);

    let lastResponse: HttpResponse | undefined;
    for (const lineId of [
      'comp_metal_02_line_1',
      'comp_manuf_01_line_2',
      'comp_manuf_02_line_1',
      'unknown_line_1',
      'comp%2Fmetal',
    ]) {
      for (const action of ['pause', 'resume', 'priority'] as const) {
        const body = action === 'priority'
          ? { requestId: 'foreign-1', priority: 2 }
          : { requestId: 'foreign-1' };
        const response = await lineControlRequest(app, lineId, action, body);
        assert.equal(response.status, 403, `${action} on ${lineId}`);
        assert.deepEqual(response.json, expected);
        lastResponse = response;
      }
    }

    assert.ok(lastResponse);
    await expectNoSideEffects(app, lastResponse, 403, before, expected);
  });
});

test('a pause is acknowledged as queued and only runs on the next authoritative tick', async () => {
  await withTestServer(async (app) => {
    const started = await productionRequest(app, productionPayload({ requestId: 'flow-start-1' }));
    assert.equal(started.status, 202);
    app.clock.advance(1);

    const stateBeforePause = await readState(app);
    assert.equal(findLine(stateBeforePause, LINE).status, 'RUNNING');
    const tickBeforePause = stateBeforePause.tick;

    const paused = await lineControlRequest(app, LINE, 'pause', { requestId: 'flow-pause-1' });
    assert.equal(paused.status, 202);
    assert.match(paused.json.commandId, COMMAND_ID_PATTERN);
    assert.deepEqual(paused.json, { commandId: paused.json.commandId, status: 'queued' });

    // Server-selected scheduling: nothing changed in the simulation yet.
    const afterAck = await readState(app);
    assert.equal(afterAck.tick, tickBeforePause);
    assert.equal(findLine(afterAck, LINE).status, 'RUNNING');
    assert.equal(pendingCommandCount(app), 1);

    app.clock.advance(1);
    const afterTick = await readState(app);
    assert.equal(findLine(afterTick, LINE).status, 'PAUSED');

    const status = await readCommand(app, paused.json.commandId);
    assert.equal(status.status, 200);
    assert.equal(status.json.status, 'executed');
    assert.equal(status.json.executedAtTick, tickBeforePause + 1);
  });
});

test('pause freezes the batch and resume continues it, charging inputs once', async () => {
  await withTestServer(async (app) => {
    const started = await productionRequest(app, productionPayload({ requestId: 'flow-start-2' }));
    assert.equal(started.status, 202);
    app.clock.advance(2); // the batch is RUNNING and has made progress

    const running = await readState(app);
    const runningLine = findLine(running, LINE);
    assert.equal(runningLine.status, 'RUNNING');
    const progressBeforePause = runningLine.activeBatch.progressTicks;
    assert.equal(progressBeforePause, 2);
    const rawOreAfterStart = running.company.inventory.RAW_ORE.available;

    const paused = await lineControlRequest(app, LINE, 'pause', { requestId: 'flow-pause-2' });
    assert.equal(paused.status, 202);
    app.clock.advance(3);

    const frozen = await readState(app);
    const frozenLine = findLine(frozen, LINE);
    assert.equal(frozenLine.status, 'PAUSED');
    assert.notEqual(frozenLine.activeBatch, null, 'the batch survives the pause');
    assert.equal(frozenLine.activeBatch.progressTicks, progressBeforePause, 'progress is frozen');
    assert.equal(frozenLine.totalBatchesProduced, 0);

    const resumed = await lineControlRequest(app, LINE, 'resume', { requestId: 'flow-resume-2' });
    assert.equal(resumed.status, 202);
    app.clock.advance(1);
    const afterResume = await readState(app);
    assert.equal(findLine(afterResume, LINE).status, 'RUNNING');
    assert.equal(
      findLine(afterResume, LINE).activeBatch.progressTicks,
      progressBeforePause + 1,
      'resume continues from the frozen progress',
    );
    // Resume must not deduct the recipe inputs again: raw ore only grows from
    // extraction, so a fresh 10-unit deduction would show as a negative delta.
    assert.ok(
      afterResume.company.inventory.RAW_ORE.available >= rawOreAfterStart,
      'no second input deduction on resume',
    );

    app.clock.advance(20);
    const finished = await readState(app);
    const finishedLine = findLine(finished, LINE);
    assert.equal(finishedLine.activeBatch, null);
    assert.equal(finishedLine.status, 'IDLE');
    assert.equal(finishedLine.totalBatchesProduced, 1);
    assert.equal(
      finished.company.inventory.IRON_INGOT.available,
      5,
      'the paused batch completes exactly once',
    );
  });
});

test('pausing never lets a client replace the active batch: ERR_LINE_BUSY is preserved', async () => {
  await withTestServer(async (app) => {
    const started = await productionRequest(app, productionPayload({ requestId: 'busy-start-1' }));
    assert.equal(started.status, 202);
    app.clock.advance(1);

    const paused = await lineControlRequest(app, LINE, 'pause', { requestId: 'busy-pause-1' });
    assert.equal(paused.status, 202);
    app.clock.advance(1);
    const pausedState = await readState(app);
    assert.equal(findLine(pausedState, LINE).status, 'PAUSED');
    assert.notEqual(findLine(pausedState, LINE).activeBatch, null);
    const rawOreWhilePaused = pausedState.company.inventory.RAW_ORE.available;

    // Issue #48: the guard lives in the engine, so the request is admitted and
    // refused at execution instead of being silently accepted as a new batch.
    const replacement = await productionRequest(
      app,
      productionPayload({ requestId: 'busy-replace-1' }),
    );
    assert.equal(replacement.status, 202);
    app.clock.advance(1);

    const status = await readCommand(app, replacement.json.commandId);
    assert.equal(status.status, 200);
    assert.equal(status.json.status, 'rejected');
    assert.equal(status.json.errorCode, 'ERR_LINE_BUSY');

    const afterRefusal = await readState(app);
    const line = findLine(afterRefusal, LINE);
    assert.equal(line.status, 'PAUSED');
    assert.equal(line.activeBatch.completedBatches, 0);
    assert.ok(
      afterRefusal.company.inventory.RAW_ORE.available >= rawOreWhilePaused,
      'the refused replacement deducted no inputs',
    );
  });
});

test('priority is applied by the engine queue and an exact retry keeps the original command', async () => {
  await withTestServer(async (app) => {
    const first = await lineControlRequest(app, LINE, 'priority', {
      requestId: 'prio-accept-1',
      priority: 3,
    });
    assert.equal(first.status, 202);
    assert.deepEqual(first.json, { commandId: first.json.commandId, status: 'queued' });
    assert.equal(findLine(await readState(app), LINE).priority, 1, 'not applied before the tick');

    const retry = await lineControlRequest(app, LINE, 'priority', {
      requestId: 'prio-accept-1',
      priority: 3,
    });
    assert.equal(retry.status, 202);
    assert.deepEqual(retry.json, first.json);
    assert.equal(pendingCommandCount(app), 1, 'the exact retry queues nothing new');

    app.clock.advance(1);
    assert.equal(findLine(await readState(app), LINE).priority, 3);
    assert.equal((await readCommand(app, first.json.commandId)).json.status, 'executed');
    assert.equal(executionCount(app), 4, 'the human priority command is the fourth of the tick');

    const afterTickRetry = await lineControlRequest(app, LINE, 'priority', {
      requestId: 'prio-accept-1',
      priority: 3,
    });
    assert.equal(afterTickRetry.status, 202);
    assert.deepEqual(afterTickRetry.json, first.json);
    assert.equal(executionCount(app), 4, 'the retry still executes nothing new');
  });
});

test('a reused request ID with a different payload is rejected and keeps the original command', async () => {
  await withTestServer(async (app) => {
    const first = await lineControlRequest(app, LINE, 'priority', {
      requestId: 'reuse-1',
      priority: 2,
    });
    assert.equal(first.status, 202);
    const expected = errorBody('REQUEST_ID_REUSED', MESSAGES.requestIdReused);

    const conflicts: Array<[LineAction, unknown]> = [
      ['priority', { requestId: 'reuse-1', priority: 3 }],
      ['pause', { requestId: 'reuse-1' }],
      ['resume', { requestId: 'reuse-1' }],
    ];
    for (const [action, body] of conflicts) {
      const response = await lineControlRequest(app, LINE, action, body);
      assert.equal(response.status, 409, `${action} reuse`);
      assert.deepEqual(response.json, expected);
    }

    const otherLine = await lineControlRequest(app, OTHER_OWNED_LINE, 'priority', {
      requestId: 'reuse-1',
      priority: 2,
    });
    assert.equal(otherLine.status, 409, 'the fingerprint includes the line');

    assert.equal(pendingCommandCount(app), 1);
    app.clock.advance(1);
    const human = app.handle.match.engine
      .getExecutionHistory()
      .filter((result) => result.companyId === 'comp_metal_01');
    assert.equal(human.length, 1, 'a reused request ID must not queue a second command');
    assert.equal(human[0].commandId, first.json.commandId);
    assert.equal(human[0].success, true);
    assert.equal(findLine(await readState(app), LINE).priority, 2);
  });
});

test('the request-id ledger is shared with production', async () => {
  await withTestServer(async (app) => {
    const production = await productionRequest(
      app,
      productionPayload({ requestId: 'shared-ledger-1' }),
    );
    assert.equal(production.status, 202);

    const pause = await lineControlRequest(app, LINE, 'pause', { requestId: 'shared-ledger-1' });
    assert.equal(pause.status, 409);
    assert.deepEqual(
      pause.json,
      errorBody('REQUEST_ID_REUSED', MESSAGES.requestIdReused),
    );
    assert.equal(pendingCommandCount(app), 1);
  });
});

test('body size limit and read errors apply to line controls too', async () => {
  await withTestServer(async (app) => {
    const base = JSON.stringify({ requestId: 'size-1' });
    const exact = base + ' '.repeat(8192 - base.length);
    assert.equal(exact.length, 8192);
    assert.equal((await lineControlRequest(app, LINE, 'pause', exact)).status, 202);

    const tooLarge = base + ' '.repeat(8193 - base.length);
    assert.equal(tooLarge.length, 8193);
    const rejected = await lineControlRequest(app, LINE, 'pause', tooLarge);
    assert.equal(rejected.status, 413);
    assert.deepEqual(rejected.json, errorBody('REQUEST_TOO_LARGE', MESSAGES.requestTooLarge));
    assert.equal(pendingCommandCount(app), 1);
  });
});

test('a trailing slash and an empty body do not become a silent success', async () => {
  await withTestServer(async (app) => {
    const withSlash = await request(app, `/v1/lines/${LINE}/pause/`, {
      method: 'POST',
      token: app.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'slash-1' }),
    });
    assert.equal(withSlash.status, 202);
    assert.equal(pendingCommandCount(app), 1);

    const empty = await lineControlRequest(app, OTHER_OWNED_LINE, 'pause', '');
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.json, errorBody('INVALID_REQUEST', MESSAGES.malformedJson));
    assert.equal(pendingCommandCount(app), 1);
  });
});

test('two clients observe the same paused line and the same control command', async () => {
  await withTestServer(async (app) => {
    const ack = await lineControlRequest(app, LINE, 'pause', { requestId: 'observe-1' });
    assert.equal(ack.status, 202);
    app.clock.advance(1);

    const stateA = await readState(app);
    const stateB = await readState(app);
    assert.deepEqual(stateA, stateB);
    assert.equal(findLine(stateA, LINE).status, 'PAUSED');

    const commandA = await readCommand(app, ack.json.commandId);
    const commandB = await readCommand(app, ack.json.commandId);
    assert.deepEqual(commandA.json, commandB.json);
    assert.equal(commandA.json.status, 'executed');
  });
});

test('line control rejections never advance the simulation clock', async () => {
  await withTestServer(async (app) => {
    await lineControlRequest(app, 'comp_metal_02_line_1', 'pause', { requestId: 'clock-1' });
    await lineControlRequest(app, LINE, 'priority', { requestId: 'clock-2', priority: 9 });
    await lineControlRequest(app, LINE, 'pause', { requestId: 'clock-3', extra: 1 });
    await lineControlRequest(app, LINE, 'pause', { requestId: 'bad id' });
    assert.equal((await readState(app)).tick, 0);
    assert.equal(executionCount(app), 0);
  });
});
