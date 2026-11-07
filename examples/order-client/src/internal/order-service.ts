import { ValidationError } from '../errors.ts';
import type { HttpClient } from '../http.ts';

export type OrderStatus = 'created' | 'pending';

export interface OrderInput {
  sku: string;
  quantity: number;
}

export interface PlaceOrderOptions {
  /** 같은 키로 재요청하면 서버가 같은 주문을 돌려준다. */
  idempotencyKey?: string;
}

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
}

export interface OrderDetail {
  orderId: string;
  sku: string;
  quantity: number;
  status: OrderStatus;
}

interface OrderResponse {
  id: string;
  sku: string;
  quantity: number;
  status: OrderStatus;
}

export class OrderService {
  #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  async placeOrder(input: OrderInput, options: PlaceOrderOptions = {}): Promise<OrderResult> {
    if (!input.sku) throw new ValidationError('sku is required');
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
      throw new ValidationError('quantity must be an integer between 1 and 99');
    }
    const res = await this.#http.post<OrderResponse>(
      '/orders',
      { sku: input.sku, quantity: input.quantity },
      { idempotencyKey: options.idempotencyKey },
    );
    return { orderId: res.id, status: res.status };
  }

  async getOrder(orderId: string): Promise<OrderDetail> {
    if (!orderId) throw new ValidationError('orderId is required');
    const res = await this.#http.get<OrderResponse>(`/orders/${encodeURIComponent(orderId)}`);
    return { orderId: res.id, sku: res.sku, quantity: res.quantity, status: res.status };
  }
}
