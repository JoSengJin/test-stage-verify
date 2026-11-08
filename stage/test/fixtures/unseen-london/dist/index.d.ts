export interface Warehouse {
  available(sku: string): number;
  reserve(sku: string, quantity: number): number;
}
export interface Reservation { sku: string; quantity: number; remaining: number; }
export type Allocation = { status: 'reserved'; remaining: number } | { status: 'unavailable' };
export declare function openStockroom(): Warehouse;
export declare function allocate(warehouse: Warehouse, notify: (event: Reservation) => void, sku: string, quantity: number): Allocation;
