/**
 * Command acknowledgement capacity: at most 1024 unique requests per match.
 * Exact retries must keep working at the bound; a new request ID must not.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_ACKNOWLEDGED_REQUESTS } from '../src/match.ts';
import {
  pendingCommandCount,
  productionPayload,
  productionRequest,
  withTestServer,
} from './helpers.ts';

test('the acknowledgement capacity is the documented 1024 command limit', () => {
  assert.equal(MAX_ACKNOWLEDGED_REQUESTS, 1024);
});

test('the match keeps exact retries working at the limit and rejects new IDs', async () => {
  await withTestServer(async (app) => {
    let firstAck: any = null;

    for (let index = 0; index < MAX_ACKNOWLEDGED_REQUESTS; index += 1) {
      const requestId = `limit-${index}`;
      const response = await productionRequest(app, productionPayload({ requestId }));
      assert.equal(response.status, 202, `request ${requestId} failed with ${response.text}`);
      assert.equal(response.json.status, 'queued');
      if (index === 0) firstAck = response.json;
    }

    assert.equal(pendingCommandCount(app), MAX_ACKNOWLEDGED_REQUESTS);

    const retry = await productionRequest(app, productionPayload({ requestId: 'limit-0' }));
    assert.equal(retry.status, 202);
    assert.deepEqual(retry.json, firstAck);
    assert.equal(pendingCommandCount(app), MAX_ACKNOWLEDGED_REQUESTS);

    const overflow = await productionRequest(app, productionPayload({ requestId: 'limit-overflow' }));
    assert.equal(overflow.status, 429);
    assert.deepEqual(overflow.json, {
      error: { code: 'COMMAND_LIMIT', message: 'The match command acknowledgement limit was reached.' },
    });
    assert.equal(pendingCommandCount(app), MAX_ACKNOWLEDGED_REQUESTS);
  });
});
