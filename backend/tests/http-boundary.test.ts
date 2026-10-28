/**
 * Public HTTP boundary: protocol banner, bearer authentication, routing,
 * own-company state projection and the server-owned clock.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, readState, withTestServer, TEST_TOKEN } from './helpers.ts';

const UNAUTHORIZED_BODY = {
  error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' },
};

const NOT_FOUND_BODY = {
  error: { code: 'NOT_FOUND', message: 'The requested resource does not exist.' },
};

const METHOD_NOT_ALLOWED_BODY = {
  error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed for this route.' },
};

test('GET /health answers with the protocol banner and no credentials', async () => {
  await withTestServer(async (app) => {
    const response = await request(app, '/health');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { status: 'ok', protocolVersion: 1 });
    assert.equal(response.text, '{"status":"ok","protocolVersion":1}');
    assert.equal(response.contentType, 'application/json; charset=utf-8');

    const withCredentials = await request(app, '/health', { token: 'ignored-token-value' });
    assert.equal(withCredentials.status, 200);
    assert.deepEqual(withCredentials.json, { status: 'ok', protocolVersion: 1 });
  });
});

test('GET /health never reports company state', async () => {
  await withTestServer(async (app) => {
    const response = await request(app, '/health', { token: TEST_TOKEN });
    assert.equal(response.status, 200);
    for (const forbidden of ['comp_metal_01', 'matchId', 'company', 'token']) {
      assert.equal(response.text.includes(forbidden), false, `health leaked ${forbidden}`);
    }
  });
});

test('authenticated routes reject a missing bearer token with a fixed message', async () => {
  await withTestServer(async (app) => {
    const response = await request(app, '/v1/state');
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, UNAUTHORIZED_BODY);
    assert.equal(response.contentType, 'application/json; charset=utf-8');
  });
});

test('authenticated routes reject an incorrect bearer token', async () => {
  await withTestServer(async (app) => {
    const wrongToken = await request(app, '/v1/state', { token: 'not-the-right-token-0123456789abc' });
    assert.equal(wrongToken.status, 401);
    assert.deepEqual(wrongToken.json, UNAUTHORIZED_BODY);
    assert.equal(wrongToken.text.includes('not-the-right-token'), false);

    const shortToken = await request(app, '/v1/state', { token: 'abc' });
    assert.equal(shortToken.status, 401);
    assert.deepEqual(shortToken.json, UNAUTHORIZED_BODY);

    const wrongScheme = await request(app, '/v1/state', {
      headers: { authorization: `Token ${TEST_TOKEN}` },
    });
    assert.equal(wrongScheme.status, 401);
    assert.deepEqual(wrongScheme.json, UNAUTHORIZED_BODY);

    const emptyBearer = await request(app, '/v1/state', { headers: { authorization: 'Bearer ' } });
    assert.equal(emptyBearer.status, 401);
    assert.deepEqual(emptyBearer.json, UNAUTHORIZED_BODY);

    const commandWithoutToken = await request(app, '/v1/commands/anything');
    assert.equal(commandWithoutToken.status, 401);
    assert.deepEqual(commandWithoutToken.json, UNAUTHORIZED_BODY);
  });
});

test('GET /v1/state returns the own-company projection with tick and recipe data', async () => {
  await withTestServer(async (app) => {
    const state = await readState(app);

    assert.equal(state.protocolVersion, 1);
    assert.equal(state.matchId, 'match_test_fixed01');
    assert.equal(state.tick, 0);
    assert.equal(state.tickIntervalMs, 1000);

    assert.equal(state.company.companyId, 'comp_metal_01');
    assert.equal(state.company.industrialClass, 'CLASS_A_METALLURGY');
    assert.equal(state.company.credits, 10000);
    assert.equal(state.company.energy, 400);
    assert.equal(state.company.inventory.RAW_ORE.available, 200);
    assert.equal(state.company.inventory.RAW_ORE.reserved, 0);
    assert.equal(state.company.lines.length, 3);
    for (const line of state.company.lines) {
      assert.equal(line.companyId, 'comp_metal_01');
      assert.equal(line.lineId.startsWith('comp_metal_01_line_'), true);
      assert.equal(line.status, 'IDLE');
    }

    assert.deepEqual(state.recipes, [
      {
        id: 'R1',
        name: 'Lingote de Hierro (IRON_INGOT)',
        inputs: [{ itemId: 'RAW_ORE', quantity: 10 }],
        outputItem: 'IRON_INGOT',
        outputQuantity: 5,
        durationTicks: 10,
        energyCost: 20,
      },
    ]);
  });
});

test('GET /v1/state exposes only the server-selected company', async () => {
  await withTestServer(async (app) => {
    const state = await readState(app);
    const serialized = JSON.stringify(state);

    for (const forbidden of [
      'comp_metal_02',
      'comp_manuf_01',
      'comp_manuf_02',
      'Vulcan Smelting',
      'Apex Robotics',
      'contracts',
      'globalProject',
      'commandResults',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `state leaked ${forbidden}`);
    }
  });
});

test('the state snapshot is detached from the live engine state', async () => {
  await withTestServer(async (app) => {
    const first = await readState(app);
    first.company.credits = -1;
    first.company.inventory.RAW_ORE.available = -1;
    first.company.lines[0].status = 'RUNNING';

    const second = await readState(app);
    assert.equal(second.company.credits, 10000);
    assert.equal(second.company.inventory.RAW_ORE.available, 200);
    assert.equal(second.company.lines[0].status, 'IDLE');
  });
});

test('the server-owned clock advances the match independently of requests', async () => {
  await withTestServer(async (app) => {
    const initial = await readState(app);
    assert.equal(initial.tick, 0);
    assert.equal(initial.company.energy, 400);

    app.clock.advance(2);
    const advanced = await readState(app);
    assert.equal(advanced.tick, 2);
    assert.equal(advanced.company.energy, 440);
    assert.equal(advanced.matchId, initial.matchId);

    app.clock.advance(1);
    assert.equal((await readState(app)).tick, 3);
  });
});

test('unknown routes answer 404 without credentials', async () => {
  await withTestServer(async (app) => {
    const unknownV1 = await request(app, '/v1/unknown');
    assert.equal(unknownV1.status, 404);
    assert.deepEqual(unknownV1.json, NOT_FOUND_BODY);

    const tickRoute = await request(app, '/v1/tick', { method: 'POST', token: app.token });
    assert.equal(tickRoute.status, 404);
    assert.deepEqual(tickRoute.json, NOT_FOUND_BODY);

    const withBody = await request(app, '/v1/unknown', {
      method: 'POST',
      token: app.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companyId: 'comp_manuf_01' }),
    });
    assert.equal(withBody.status, 404);
    assert.deepEqual(withBody.json, NOT_FOUND_BODY);

    const root = await request(app, '/');
    assert.equal(root.status, 404);
    assert.deepEqual(root.json, NOT_FOUND_BODY);
  });
});

test('known routes reject unsupported methods with 405', async () => {
  await withTestServer(async (app) => {
    const healthPost = await request(app, '/health', { method: 'POST' });
    assert.equal(healthPost.status, 405);
    assert.deepEqual(healthPost.json, METHOD_NOT_ALLOWED_BODY);

    const statePost = await request(app, '/v1/state', { method: 'POST', token: app.token });
    assert.equal(statePost.status, 405);
    assert.deepEqual(statePost.json, METHOD_NOT_ALLOWED_BODY);

    const statePostWithBody = await request(app, '/v1/state', {
      method: 'POST',
      token: app.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'x' }),
    });
    assert.equal(statePostWithBody.status, 405);
    assert.deepEqual(statePostWithBody.json, METHOD_NOT_ALLOWED_BODY);

    const productionGet = await request(app, '/v1/production', { token: app.token });
    assert.equal(productionGet.status, 405);
    assert.deepEqual(productionGet.json, METHOD_NOT_ALLOWED_BODY);

    const commandPost = await request(app, '/v1/commands/cmd_123', {
      method: 'POST',
      token: app.token,
    });
    assert.equal(commandPost.status, 405);
    assert.deepEqual(commandPost.json, METHOD_NOT_ALLOWED_BODY);
  });
});
