import { it, expect, vi } from 'vitest';
import { OrderService } from '../../../../examples/order-client/src/internal/order-service.ts';

it('vitest style', async () => {
  const http = { post: vi.fn(), get: vi.fn() };
  const service = new OrderService(http as any);
  expect(service).toBeTruthy();
});
