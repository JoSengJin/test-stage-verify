import { it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { OrderService } from '../../../../examples/order-client/src/internal/order-service.ts';

before(() => {});

it('places several orders in a loop', async () => {
  const http = { post: mock.fn(async () => ({ id: 'o', status: 'created' })), get: mock.fn() };
  const service = new OrderService(http);
  for (const quantity of [1, 2, 3]) {
    await service.placeOrder({ sku: 'A', quantity });
  }
  assert.match(String(http.post.mock.callCount()), /3/);
});
