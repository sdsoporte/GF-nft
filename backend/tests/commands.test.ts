/**
 * GET /v1/commands/<commandId>: queued, executed and rejected final statuses,
 * plus the server-tick production loop visible through HTTP.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  productionPayload,
  productionRequest,
  readCommand,
  readState,
  withTestServer,
  type TestApp,
} from './helpers.ts';

const NOT_FOUND_BODY = {
  error: { code: 'NOT_FOUND', message: 'The requested resource does not exist.' },
};

async function startBatch(
  app: TestApp,
  requestId: string,
  lineId = 'comp_metal_01_line_1',
): Promise<string> {
  const response = await productionRequest(app, productionPayload({ requestId, lineId }));
  assert.equal(response.status, 202, `unexpected production response: ${response.text}`);
  return response.json.commandId;
}

test('unknown command identifiers are not found', async () => {
  await withTestServer(async (app) => {
    const response = await readCommand(app, 'cmd_does_not_exist');
    assert.equal(response.status, 404);
    assert.deepEqual(response.json, NOT_FOUND_BODY);
  });
});

test('a command reports queued before the tick and executed after it', async () => {
  await withTestServer(async (app) => {
    const commandId = await startBatch(app, 'status-queued');

    const queued = await readCommand(app, commandId);
    assert.equal(queued.status, 200);
    assert.deepEqual(queued.json, { commandId, status: 'queued' });

    app.clock.advance(1);

    const executed = await readCommand(app, commandId);
    assert.equal(executed.status, 200);
    assert.deepEqual(executed.json, { commandId, status: 'executed', executedAtTick: 1 });

    const state = await readState(app);
    assert.equal(state.tick, 1);
    assert.equal(state.company.lines[0].status, 'RUNNING');
    assert.equal(state.company.lines[0].currentRecipeId, 'R1');
    assert.equal(state.company.lines[0].activeBatch.targetBatches, 1);
    assert.equal(state.company.inventory.RAW_ORE.available, 190);
  });
});

test('one R1 batch consumes raw ore and produces ingots on server ticks', async () => {
  await withTestServer(async (app) => {
    const commandId = await startBatch(app, 'status-production');
    app.clock.advance(10);

    const state = await readState(app);
    assert.equal(state.tick, 10);
    assert.equal(state.company.inventory.RAW_ORE.available, 195);
    assert.equal(state.company.inventory.IRON_INGOT.available, 5);
    assert.equal(state.company.lines[0].status, 'IDLE');
    assert.equal(state.company.lines[0].activeBatch, null);
    assert.equal(state.company.lines[0].totalBatchesProduced, 1);

    const command = await readCommand(app, commandId);
    assert.deepEqual(command.json, { commandId, status: 'executed', executedAtTick: 1 });
  });
});

test('burst commands on one line execute once and reject the rest as busy (issue #48)', async () => {
  await withTestServer(async (app) => {
    // 21 commands are queued for the same tick on the same line. Only the
    // first may start a batch; the rest are rejected before any deduction.
    const commandIds: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      commandIds.push(await startBatch(app, `burst-${index}`));
    }
    assert.equal(new Set(commandIds).size, 21);

    app.clock.advance(1);

    const first = await readCommand(app, commandIds[0]);
    assert.deepEqual(first.json, { commandId: commandIds[0], status: 'executed', executedAtTick: 1 });

    const second = await readCommand(app, commandIds[1]);
    assert.equal(second.status, 200);
    assert.deepEqual(second.json, {
      commandId: commandIds[1],
      status: 'rejected',
      executedAtTick: 1,
      errorCode: 'ERR_LINE_BUSY',
    });

    const state = await readState(app);
    assert.equal(state.company.lines[0].status, 'RUNNING');
    assert.equal(state.company.lines[0].activeBatch.recipeId, 'R1');
    // Only the first command deducted its 10 RAW_ORE inputs.
    assert.equal(state.company.inventory.RAW_ORE.available, 190);
    assert.equal(state.company.inventory.IRON_INGOT.available, 0);
  });
});

test('a rejected command status stays rejected on later ticks', async () => {
  await withTestServer(async (app) => {
    const commandIds: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      commandIds.push(await startBatch(app, `persist-${index}`));
    }
    app.clock.advance(1);
    const rejected = await readCommand(app, commandIds[20]);
    assert.equal(rejected.json.status, 'rejected');

    app.clock.advance(5);
    const stillRejected = await readCommand(app, commandIds[20]);
    assert.deepEqual(stillRejected.json, rejected.json);
  });
});

test('a second production command on a busy line is rejected and keeps the in-flight batch (issue #48)', async () => {
  await withTestServer(async (app) => {
    const first = await startBatch(app, 'busy-first');
    app.clock.advance(1);
    assert.deepEqual((await readCommand(app, first)).json, {
      commandId: first, status: 'executed', executedAtTick: 1,
    });
    const busyState = await readState(app);
    assert.equal(busyState.company.lines[0].status, 'RUNNING');
    assert.equal(busyState.company.inventory.RAW_ORE.available, 190);

    const second = await startBatch(app, 'busy-second');
    app.clock.advance(1);

    const rejection = await readCommand(app, second);
    assert.equal(rejection.status, 200);
    assert.deepEqual(rejection.json, {
      commandId: second,
      status: 'rejected',
      executedAtTick: 2,
      errorCode: 'ERR_LINE_BUSY',
    });

    const state = await readState(app);
    assert.equal(state.company.lines[0].status, 'RUNNING');
    assert.equal(state.company.lines[0].currentRecipeId, 'R1');
    assert.equal(state.company.lines[0].activeBatch.recipeId, 'R1');
    assert.equal(state.company.lines[0].activeBatch.completedBatches, 0);
    // The rejected request never deducted its inputs.
    assert.equal(state.company.inventory.RAW_ORE.available, 190);
  });
});
