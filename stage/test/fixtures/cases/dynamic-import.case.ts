import { it, mock } from 'node:test';
import assert from 'node:assert/strict';

it('loads the service lazily', async () => {
  const { OrderService } = await import('../../../../examples/order-client/src/internal/order-service.ts');
  const http = { post: mock.fn(), get: mock.fn(async () => ({ id: 'o-9', sku: 'B', quantity: 3, status: 'pending' })) };
  const service = new OrderService(http);
  const detail = await service.getOrder('o-9');
  assert.equal(detail.status, 'pending');
  assert.deepEqual(http.get.mock.calls[0].arguments[0], '/orders/o-9');
});
