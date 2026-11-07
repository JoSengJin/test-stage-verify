import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { OrderService } from '../../../../examples/order-client/src/internal/order-service.ts';

function makeInput() {
  return { sku: 'SKU-' + Date.now(), quantity: 1 };
}

it('uses a computed fixture', async () => {
  const http = { post: mock.fn(async () => ({ id: 'o-1', status: 'created' })), get: mock.fn() };
  const service = new OrderService(http);
  const result = await service.placeOrder(makeInput());
  assert.equal(result.orderId, 'o-1');
});
