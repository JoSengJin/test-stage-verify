import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { OrderService } from '../src/internal/order-service.ts';
import { HttpError } from '../src/errors.ts';

const createdResponse = { id: 'ord-1001', sku: 'SKU-1', quantity: 2, status: 'created' };

describe('OrderService.placeOrder', () => {
  let http: any;
  let service: OrderService;

  beforeEach(() => {
    http = {
      post: mock.fn(async () => createdResponse),
      get: mock.fn(),
    };
    service = new OrderService(http);
  });

  it('posts the order to the http collaborator and maps the response', async () => {
    const result = await service.placeOrder({ sku: 'SKU-1', quantity: 2 }, { idempotencyKey: 'key-1' });

    assert.deepEqual(result, { orderId: 'ord-1001', status: 'created' });
    assert.equal(http.post.mock.callCount(), 1);
    assert.deepEqual(http.post.mock.calls[0].arguments, [
      '/orders',
      { sku: 'SKU-1', quantity: 2 },
      { idempotencyKey: 'key-1' },
    ]);
    assert.equal(http.get.mock.callCount(), 0);
  });

  it('rejects an invalid quantity without calling the collaborator', async () => {
    await assert.rejects(service.placeOrder({ sku: 'SKU-1', quantity: 0 }), {
      name: 'ValidationError',
      message: 'quantity must be an integer between 1 and 99',
    });
    assert.equal(http.post.mock.callCount(), 0);
  });

  it('propagates collaborator failures', async () => {
    const failingHttp = {
      post: mock.fn(async () => {
        throw new HttpError(503, 'order backend unavailable');
      }),
      get: mock.fn(),
    };
    const failingService = new OrderService(failingHttp);

    await assert.rejects(failingService.placeOrder({ sku: 'SKU-1', quantity: 1 }), HttpError);
    assert.equal(failingHttp.post.mock.callCount(), 1);
  });
});

describe('OrderService.getOrder', () => {
  it('requests the order by id and maps the detail', async () => {
    const http = {
      post: mock.fn(),
      get: mock.fn(async () => createdResponse),
    };
    const service = new OrderService(http);

    const detail = await service.getOrder('ord-1001');

    assert.deepEqual(detail, { orderId: 'ord-1001', sku: 'SKU-1', quantity: 2, status: 'created' });
    assert.deepEqual(http.get.mock.calls[0].arguments, ['/orders/ord-1001']);
  });
});
