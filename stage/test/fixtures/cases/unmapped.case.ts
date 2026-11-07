import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchHttpClient } from '../../../../examples/order-client/src/http.ts';

it('builds a client', () => {
  const client = createFetchHttpClient({ baseUrl: 'http://x.invalid' });
  assert.ok(client);
});
