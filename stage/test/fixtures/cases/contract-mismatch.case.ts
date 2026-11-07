import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { OrderService } from '../../../../examples/order-client/src/internal/order-service.ts';

it('cancels an order', async () => {
  const http = { send: mock.fn(async () => ({ ok: true })), post: mock.fn(), get: mock.fn() };
  const service = new OrderService(http);
  // @ts-expect-error 공개 계약에 없는 동작
  await service.cancelOrder('ord-1');
  assert.equal(http.send.mock.callCount(), 1);
});
