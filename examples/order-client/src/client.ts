import { createFetchHttpClient, type FetchHttpConfig } from './http.ts';
import { OrderService } from './internal/order-service.ts';

export type OrderClientConfig = FetchHttpConfig;

/** 컨슈머 초기화 진입점: API 주소·인증을 받아 OrderService를 만든다. */
export function createOrderClient(config: OrderClientConfig): OrderService {
  return new OrderService(createFetchHttpClient(config));
}
